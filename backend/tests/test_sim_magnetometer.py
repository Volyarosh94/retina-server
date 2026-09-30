"""The simulated magnetometer network: the detector, its scorecard, the routes.

Readings come from the simulator's own magnetometer model
(retina_simulation.magnetometer), so what is tested here is the pipeline the
/sim map runs: WMM background, the daily variation, quantised RM3100 noise,
dipole UAPs, and the server's detection over the network. Every random draw in
that model is a function of its seed, so these runs are the same every time.
"""

import math
import os
from dataclasses import dataclass

import numpy as np
import pytest
from retina_simulation.magnetometer import (
    MagnetometerArray,
    MagnetometerSettings,
    Storm,
    build_magnetometer_push_payload,
    dipole_field_nt,
)
from scipy import stats

from core import state
from services import sim_magnetometer as sm

_KEY = {"X-API-Key": os.environ["RADAR_API_KEY"]}
T0 = 1_790_726_400.0  # 2026-09-30T00:00:00Z

FLEET = [
    {
        "node_id": f"synth-TEST-{i:02d}",
        "rx_lat": 34.85 + 0.16 * (i // 3 - 1),
        "rx_lon": -82.39 + 0.2 * (i % 3 - 1),
        "rx_alt_ft": 900.0,
    }
    for i in range(8)
]


@dataclass
class Obj:
    object_id: str
    lat: float
    lon: float
    alt_km: float


def straight_pass(node, cpa_km, altitude_km, speed_mps, heading_deg, t_cpa, oid="uap-test"):
    heading = math.radians(heading_deg)

    def at(t):
        s_km = speed_mps * (t - t_cpa) / 1000.0
        north = -math.sin(heading) * cpa_km + math.cos(heading) * s_km
        east = math.cos(heading) * cpa_km + math.sin(heading) * s_km
        lat = node.lat + math.degrees(north / 6371.0)
        lon = node.lon + math.degrees(east / (6371.0 * math.cos(math.radians(node.lat))))
        return Obj(oid, lat, lon, node.alt_m / 1000.0 + altitude_km)

    return at


class Rig:
    """A simulated network feeding a detector on a fake clock."""

    def __init__(self, seed=21, nodes=8, **settings):
        self.clock = [T0]
        self.network = sm.MagnetometerNetwork(clock=lambda: self.clock[0])
        self.array = MagnetometerArray(
            node_configs=FLEET[:nodes], center=(34.85, -82.39), seed=seed, settings=MagnetometerSettings(n_nodes=nodes)
        )
        self.settings = {**sm.SETTINGS_DEFAULTS, **settings}

    def run(self, seconds, flyers=()):
        for _ in range(seconds):
            t = self.clock[0]
            objects = [fly(t) for fly in flyers]
            payload = build_magnetometer_push_payload(self.array, [(int(t * 1000), self.array.sample(objects, t))])
            self.network.ingest(payload, self.settings)
            self.clock[0] += 1.0
        return self

    def events(self):
        return [e.as_dict() for e in self.network.events]


# ── The detector's mathematics ───────────────────────────────────────────────


class TestAndersonBasis:
    @pytest.mark.parametrize("scale", sm.SCALES, ids=lambda s: f"tau{s.tau_s:g}")
    def test_orthonormal_and_blind_to_offset_and_slope(self, scale):
        q = scale.detector
        assert q @ q.T == pytest.approx(np.eye(3), abs=1e-10)
        u = np.arange(scale.length) - scale.length // 2
        assert q @ np.ones(scale.length) == pytest.approx(np.zeros(3), abs=1e-9)
        assert q @ u == pytest.approx(np.zeros(3), abs=1e-7)

    def test_a_straight_dipole_pass_lies_in_the_span(self):
        # Every component of a straight-line dipole pass is a combination of
        # the three Anderson functions: projecting it loses (almost) nothing.
        scale = next(s for s in sm.SCALES if s.tau_s == 8)
        v, d = 125.0, 1000.0  # tau = d / v = 8 s
        times = (np.arange(scale.length) - scale.length // 2) * 1.0
        rng = np.random.default_rng(3)
        for _ in range(5):
            m = rng.normal(size=3)
            m = 1e9 * m / np.linalg.norm(m)
            field = np.array([dipole_field_nt(tuple(m), (d * 0.6, -v * t, d * 0.8)) for t in times])
            field_detrended = field - field.mean(axis=0)
            # remove the slope too, as the detector does
            u = times / np.abs(times).max()
            field_detrended -= np.outer(u, (u @ field_detrended) / (u @ u))
            captured = np.sum((scale.detector @ field_detrended) ** 2)
            assert captured / np.sum(field_detrended**2) > 0.999

    def test_noise_statistic_is_chi_square_nine(self):
        rng = np.random.default_rng(11)
        for scale in sm.SCALES[:3]:
            energies = [np.sum((scale.detector @ rng.normal(0.0, 1.0, (scale.length, 3))) ** 2) for _ in range(4000)]
            assert np.mean(energies) == pytest.approx(9.0, rel=0.05)
            assert np.mean(np.array(energies) > 21.67) == pytest.approx(0.01, abs=0.005)  # χ²₉ 99th percentile


class TestScores:
    @pytest.mark.parametrize("p", [1e-3, 1e-6, 1e-9, 1e-12])
    def test_score_has_the_statistics_tail_probability(self, p):
        assert sm.score_sigma(stats.chi2.isf(p, 9)) == pytest.approx(stats.norm.isf(p), abs=1e-6)

    def test_score_is_clipped_not_infinite(self):
        assert sm.score_sigma(1e9) == 40.0

    def test_confidence_and_noise_interval_agree(self):
        low, high = sm.confidence(4.0), sm.confidence(6.0)
        assert 0 < low < high < 1
        rate = 1.0 / sm.noise_interval_h(5.0)
        assert sm.confidence(5.0) == pytest.approx(math.exp(-rate), rel=1e-3)

    @pytest.mark.parametrize(
        ("threshold", "low", "high"),
        # The benchmark's measured 95 % intervals, per node-hour (design note).
        [
            (3.5, 1.3189, 1.4192),
            (4.0, 0.2195, 0.2618),
            (4.5, 0.0280, 0.0446),
            (5.0, 0.0008, 0.0055),
            (5.5, 0.0, 0.0017),
        ],
    )
    def test_false_alarm_model_lies_inside_the_measured_intervals(self, threshold, low, high):
        assert low <= sm.false_alarm_rate(threshold) <= high

    def test_false_alarm_model_falls_with_the_threshold(self):
        rates = [sm.false_alarm_rate(z) for z in (3.0, 4.0, 5.0, 6.0, 8.0, 12.0)]
        assert all(a > b > 0 for a, b in zip(rates, rates[1:], strict=False))

    def test_range_band_brackets_both_geometries(self):
        near, far = sm.range_band_km(100.0, 1e9)  # 1 km on the equator, 1.26 km on the axis
        assert near < 1.0 and far > 1.26
        assert sm.range_band_km(0.0, 1e9) is None


class TestSettings:
    def test_defaults_cover_every_key(self):
        assert set(sm.effective_settings({})) == set(sm.SETTINGS_DEFAULTS)

    @pytest.mark.parametrize(
        "body,fragment",
        [
            ({"mag_enabled": "yes"}, "true or false"),
            ({"mag_n_nodes": 61}, "0–60"),
            ({"mag_n_nodes": True}, "0–60"),
            ({"mag_placement": "moon"}, "spread"),
            ({"mag_cycle_count": 300}, "50, 100"),
            ({"mag_threshold_sigma": 2.0}, "3.0–12.0"),
            ({"mag_common_mode": 1}, "true or false"),
        ],
    )
    def test_bad_values_name_the_key(self, body, fragment):
        with pytest.raises(ValueError, match=fragment):
            sm.validate_settings(body)

    def test_good_values_pass(self):
        good = {
            "mag_enabled": False,
            "mag_n_nodes": 0,
            "mag_placement": "core",
            "mag_cycle_count": 800,
            "mag_threshold_sigma": 7,
            "mag_common_mode": False,
            "mag_storm": True,
        }
        assert sm.validate_settings(good) == {**good, "mag_threshold_sigma": 7.0}

    def test_flyby_validation(self):
        assert sm.validate_flyby({})["closest_approach_m"] == 600.0
        with pytest.raises(ValueError, match="node_id"):
            sm.validate_flyby({"node_id": "synth-A"})
        with pytest.raises(ValueError, match="speed_mps"):
            sm.validate_flyby({"speed_mps": 0})
        with pytest.raises(ValueError, match="heading_deg"):
            sm.validate_flyby({"heading_deg": 400})


# ── The detector on simulated data ───────────────────────────────────────────


class TestDetection:
    def test_quiet_network_raises_nothing(self):
        rig = Rig().run(3600)
        assert rig.events() == []
        card = rig.network.scorecard()
        assert card["node_hours"] == pytest.approx(8 * (3600 - sm.WARM_UP + 1) / 3600, rel=0.01)
        assert card["false_alarms"] == 0
        assert card["false_alarms_per_node_hour_ci95"][0] == 0.0

    def test_a_close_pass_is_found_once_with_its_truth(self):
        rig = Rig()
        node = rig.array.nodes[0]
        t_cpa = T0 + 1100
        flyer = straight_pass(node, cpa_km=0.7, altitude_km=0.4, speed_mps=120, heading_deg=60, t_cpa=t_cpa)
        rig.run(1500, [flyer])
        events = [e for e in rig.events() if e["node_id"] == node.node_id]
        assert len(events) == 1, events  # one pass, one event: no re-report from longer windows
        event = events[0]
        assert event["truth"]["label"] == "true" and event["truth"]["object_id"] == "uap-test"
        assert event["score_sigma"] > 10
        true_peak = event["truth"]["true_peak_nt"]
        assert event["strength_nt"] == pytest.approx(true_peak, rel=0.25)
        slant = math.hypot(0.7, 0.4)
        assert event["range_km"][0] <= slant <= event["range_km"][1]
        assert abs(event["peak_ms"] / 1000 - t_cpa) <= 10
        assert event["active"] is False and event["end_ms"] > event["start_ms"]
        card = rig.network.scorecard()
        assert card["true_detections"] >= 1 and card["false_alarms"] == 0
        assert card["passes"] >= 1 and card["passes_detected"] == card["passes"]

    @pytest.mark.parametrize(
        ("cpa_km", "altitude_km", "speed_mps"),
        [(0.6, 0.3, 120.0), (0.2, 0.15, 100.0)],
        ids=["the-flyby-default", "so-close-the-score-clips"],
    )
    def test_a_strong_pass_is_measured_at_its_best_window(self, cpa_km, altitude_km, speed_mps):
        # The score stops at 40σ; the peak must not stop with it. Strength,
        # range and time come from the window best matched to the pass.
        rig = Rig()
        node = rig.array.nodes[2]
        t_cpa = T0 + 1100
        flyer = straight_pass(
            node, cpa_km=cpa_km, altitude_km=altitude_km, speed_mps=speed_mps, heading_deg=140, t_cpa=t_cpa
        )
        rig.run(1500, [flyer])
        (event,) = [e for e in rig.events() if e["node_id"] == node.node_id]
        truth = event["truth"]
        assert truth["label"] == "true"
        assert event["strength_nt"] == pytest.approx(truth["true_peak_nt"], rel=0.15)
        assert event["range_km"][0] <= truth["slant_range_km"] <= event["range_km"][1]
        assert abs(event["peak_ms"] / 1000 - t_cpa) <= 8
        assert event["noise_once_per_h"] >= 1e9

    def test_a_distant_pass_is_not_claimed(self):
        rig = Rig()
        node = rig.array.nodes[0]
        flyer = straight_pass(node, cpa_km=6.0, altitude_km=1.0, speed_mps=200, heading_deg=0, t_cpa=T0 + 1000)
        rig.run(1300, [flyer])
        assert [e for e in rig.events() if e["node_id"] == node.node_id] == []

    def test_other_nodes_stay_quiet_while_one_sees_a_pass(self):
        rig = Rig()
        node = rig.array.nodes[3]
        flyer = straight_pass(node, cpa_km=0.5, altitude_km=0.3, speed_mps=80, heading_deg=200, t_cpa=T0 + 1000)
        rig.run(1400, [flyer])
        assert {e["node_id"] for e in rig.events()} == {node.node_id}

    def test_common_mode_keeps_a_storm_from_alarming(self):
        def storm_rig(common_mode):
            rig = Rig(mag_common_mode=common_mode)
            rig.array.storm = Storm(start=T0 + 300, dst_min_nt=-250.0, pulsation_nt=10.0, seed=5)
            return rig.run(3000)

        with_common = storm_rig(True)
        without = storm_rig(False)
        assert with_common.events() == []
        assert len(without.events()) >= 3
        assert all(e["truth"]["label"] == "false" for e in without.events())

    def test_a_gap_in_the_data_is_skipped_not_scored(self):
        # Two minutes with no data: no window that spans the hole is scored,
        # and the network picks up where it left off.
        rig = Rig(nodes=4).run(900)
        rig.clock[0] += 120
        rig.run(900)
        assert rig.events() == []
        assert all(n["state"] == "quiet" for n in rig.network.snapshot(rig.settings)["nodes"])

    def test_threshold_change_restarts_the_scorecard(self):
        rig = Rig().run(200)
        before = rig.network.scorecard()["node_hours"]
        rig.settings = {**rig.settings, "mag_threshold_sigma": 7.0}
        rig.run(10)
        assert rig.network.scorecard()["node_hours"] < before


class TestIngest:
    def test_rejects_hosts_that_are_not_synthetic(self):
        network = sm.MagnetometerNetwork()
        body = {
            "nodes": [
                {
                    "node_id": "mag-real-1",
                    "host_node_id": "nde1234",
                    "lat": 34.8,
                    "lon": -82.3,
                    "samples": [[1, 1.0, 2.0, 3.0]],
                }
            ]
        }
        result = network.ingest(body, sm.effective_settings({}))
        assert result == {"nodes": 0, "rejected": 1, "samples": 0}
        assert network.nodes == {}

    @pytest.mark.parametrize(
        "entry",
        [
            {"node_id": "mag-synth-A", "host_node_id": "synth-A", "lat": 95.0, "lon": 0.0},
            {"node_id": "mag-synth-A", "host_node_id": "synth-A", "lat": "34.8", "lon": -82.3},
            {"node_id": "mag-synth-A", "host_node_id": "synth-A", "lat": 0.0, "lon": 0.0},
            {"node_id": "synth-A", "host_node_id": "synth-A", "lat": 34.0, "lon": -82.0},
            {"node_id": "", "host_node_id": "synth-A", "lat": 34.0, "lon": -82.0},
            "not a dict",
        ],
    )
    def test_rejects_malformed_entries(self, entry):
        result = sm.MagnetometerNetwork().ingest({"nodes": [entry]}, sm.effective_settings({}))
        assert result["rejected"] == 1

    def test_body_must_list_nodes(self):
        with pytest.raises(ValueError):
            sm.MagnetometerNetwork().ingest({"nodes": "all of them"}, sm.effective_settings({}))
        with pytest.raises(ValueError):
            sm.MagnetometerNetwork().ingest({"nodes": [{}] * 101}, sm.effective_settings({}))

    def test_resent_and_out_of_order_samples_are_ignored(self):
        network = sm.MagnetometerNetwork()
        entry = {
            "node_id": "mag-synth-A",
            "host_node_id": "synth-A",
            "lat": 34.8,
            "lon": -82.3,
            "samples": [[2000, 1.0, 2.0, 3.0]],
        }
        assert network.ingest({"nodes": [entry]}, sm.effective_settings({}))["samples"] == 1
        entry["samples"] = [[2000, 1.0, 2.0, 3.0], [1000, 1.0, 2.0, 3.0]]
        assert network.ingest({"nodes": [entry]}, sm.effective_settings({}))["samples"] == 0

    def test_malformed_samples_are_skipped(self):
        network = sm.MagnetometerNetwork()
        entry = {
            "node_id": "mag-synth-A",
            "host_node_id": "synth-A",
            "lat": 34.8,
            "lon": -82.3,
            "samples": [[3000, 1.0, 2.0], [4000, "x", 2.0, 3.0], "row", [5000, 1.0, 2.0, 3.0]],
        }
        assert network.ingest({"nodes": [entry]}, sm.effective_settings({}))["samples"] == 1

    def test_a_node_the_push_no_longer_lists_is_removed(self):
        rig = Rig(nodes=4).run(5)
        assert len(rig.network.nodes) == 4
        rig.array.apply(MagnetometerSettings(n_nodes=2), T0)
        rig.run(1)
        assert len(rig.network.nodes) == 2


class TestReads:
    def test_state_of_a_node(self):
        network = sm.MagnetometerNetwork(clock=lambda: T0)
        node = sm.NodeState(node_id="mag-synth-A", host_node_id="synth-A", lat=34.8, lon=-82.3, alt_m=0.0)
        now = int(T0 * 1000)
        node.last_ms = now
        assert network._state(node, now, 5.5) == "warming_up"
        node.samples = sm.WARM_UP
        assert network._state(node, now, 5.5) == "quiet"
        node.score = 4.0  # within 1.5σ of the threshold
        assert network._state(node, now, 5.5) == "elevated"
        node.event = sm.Event(
            event_id="e", node_id=node.node_id, host_node_id="synth-A", start_ms=now, peak_ms=now,
            score_sigma=6.0, strength_nt=40.0, tau_s=8,
        )  # fmt: skip
        assert network._state(node, now, 5.5) == "alarm"
        assert network._state(node, now + int(sm.STALE_S * 1000) + 1, 5.5) == "stale"

    def test_the_snapshot_shows_a_pass_while_it_happens(self):
        rig = Rig()
        node = rig.array.nodes[0]
        t_cpa = T0 + 1100
        flyer = straight_pass(node, cpa_km=0.7, altitude_km=0.4, speed_mps=120, heading_deg=60, t_cpa=t_cpa)
        rig.run(1100 + 20, [flyer])  # just past closest approach
        snapshot = rig.network.snapshot(rig.settings)
        nodes = {n["node_id"]: n for n in snapshot["nodes"]}
        target = nodes.pop(node.node_id)
        assert target["state"] == "alarm" and target["event"]["active"] is True
        spark = target["spark"]
        assert len(spark["score"]) == 120 and spark["step_ms"] == 5000
        assert max(spark["score"]) >= rig.settings["mag_threshold_sigma"]
        assert {n["state"] for n in nodes.values()} <= {"quiet", "elevated"}
        assert snapshot["events"][0]["node_id"] == node.node_id and snapshot["events"][0]["active"] is True
        assert snapshot["detector"]["false_alarm_model"] == {
            "coefficient": sm.FALSE_ALARM_COEFFICIENT,
            "power": sm.FALSE_ALARM_POWER,
        }


# ── Routes ───────────────────────────────────────────────────────────────────


def _payload(seconds=3):
    array = MagnetometerArray(
        node_configs=FLEET[:3], center=(34.85, -82.39), seed=4, settings=MagnetometerSettings(n_nodes=3)
    )
    return build_magnetometer_push_payload(
        array, [(int((T0 + k) * 1000), array.sample([], T0 + k)) for k in range(seconds)]
    )


class TestRoutes:
    def test_push_needs_the_sim_key(self, client):
        assert client.post("/api/sim/magnetometer/push", json=_payload()).status_code == 401
        response = client.post("/api/sim/magnetometer/push", json=_payload(), headers=_KEY)
        assert response.status_code == 200
        assert response.json() == {"status": "ok", "nodes": 3, "rejected": 0, "samples": 9}

    def test_push_rejects_a_malformed_body(self, client):
        assert client.post("/api/sim/magnetometer/push", json={"nodes": 5}, headers=_KEY).status_code == 400

    def test_rejected_entries_are_counted(self, client):
        before = state.sim_magnetometer_push_rejected
        body = {"nodes": [{"node_id": "mag-x", "host_node_id": "nde0001", "lat": 1, "lon": 1}]}
        client.post("/api/sim/magnetometer/push", json=body, headers=_KEY)
        assert state.sim_magnetometer_push_rejected == before + 1

    def test_the_map_payload(self, client):
        client.post("/api/sim/magnetometer/push", json=_payload(), headers=_KEY)
        data = client.get("/api/sim/magnetometers").json()
        assert len(data["nodes"]) == 3
        node = data["nodes"][0]
        assert node["node_id"].startswith("mag-synth-TEST-") and node["state"] in ("warming_up", "stale")
        assert set(node["spark"]) == {"start_ms", "step_ms", "score"}
        assert data["settings"]["mag_threshold_sigma"] == sm.SETTINGS_DEFAULTS["mag_threshold_sigma"]
        assert data["sensor"]["model"] == "RM3100"
        assert data["detector"]["scales_s"] == list(sm.SCALES_S)
        assert "false_alarms_per_node_hour" in data["stats"]

    def test_the_routes_serve_a_running_network(self, client, monkeypatch):
        # Past warm-up, with a scorecard, an open event and then a closed one:
        # every value the routes publish must be plain JSON, which numpy's and
        # scipy's scalars are not.
        rig = Rig()
        node = rig.array.nodes[0]
        flyer = straight_pass(node, cpa_km=0.7, altitude_km=0.4, speed_mps=120, heading_deg=60, t_cpa=T0 + 1100)
        monkeypatch.setattr(sm, "network", rig.network)
        rig.run(1100 + 20, [flyer])
        response = client.get("/api/sim/magnetometers")
        assert response.status_code == 200
        data = response.json()
        assert data["stats"]["false_alarms_per_node_hour_ci95"] is not None
        target = next(n for n in data["nodes"] if n["node_id"] == node.node_id)
        assert target["event"]["active"] is True and target["b_nt"] > 40_000
        detail = client.get(f"/api/sim/magnetometers/{node.node_id}?window=600")
        assert detail.status_code == 200 and len(detail.json()["series"]["t"]) == 600

        rig.run(400, [flyer])
        data = client.get("/api/sim/magnetometers").json()
        closed = next(n for n in data["nodes"] if n["node_id"] == node.node_id)["event"]
        assert closed["active"] is False and closed["truth"]["label"] == "true"

    def test_detail_and_unknown_node(self, client):
        client.post("/api/sim/magnetometer/push", json=_payload(), headers=_KEY)
        node_id = client.get("/api/sim/magnetometers").json()["nodes"][0]["node_id"]
        detail = client.get(f"/api/sim/magnetometers/{node_id}?window=600")
        assert detail.status_code == 200 and set(detail.json()["series"]) == {"t", "x", "y", "z", "residual", "score"}
        assert client.get("/api/sim/magnetometers/mag-nope").status_code == 404

    def test_reads_are_admin_only(self, client, monkeypatch):
        import core.users as users

        monkeypatch.setattr(users, "AUTH_BYPASS", False)
        assert client.get("/api/sim/magnetometers").status_code == 401
        assert client.get("/api/sim/magnetometers/mag-x").status_code == 401
        assert client.post("/api/sim/magnetometers/flyby", json={}).status_code == 401

    def test_flyby_is_carried_to_the_fleet_once_per_request(self, client):
        before = client.get("/api/simulation/config").json()["_updated_at"]
        first = client.post("/api/sim/magnetometers/flyby", json={"closest_approach_m": 400, "speed_mps": 90}).json()[
            "flyby"
        ]
        second = client.post("/api/sim/magnetometers/flyby", json={}).json()["flyby"]
        assert second["seq"] == first["seq"] + 1
        cfg = client.get("/api/simulation/config").json()
        assert cfg["mag_flyby"]["seq"] == second["seq"] and cfg["_updated_at"] > before
        assert client.post("/api/sim/magnetometers/flyby", json={"altitude_m": 10}).status_code == 400

    def test_settings_through_the_physics_config(self, client):
        cfg = client.get("/api/simulation/config").json()
        assert cfg["mag_n_nodes"] == 8 and cfg["mag_threshold_sigma"] == sm.SETTINGS_DEFAULTS["mag_threshold_sigma"]
        response = client.put(
            "/api/simulation/config", json={"mag_n_nodes": 12, "mag_threshold_sigma": 6.5, "mag_storm": True}
        )
        assert response.status_code == 200
        assert response.json()["config"]["mag_n_nodes"] == 12
        cfg = client.get("/api/simulation/config").json()
        assert (cfg["mag_n_nodes"], cfg["mag_threshold_sigma"], cfg["mag_storm"]) == (12, 6.5, True)
        assert client.put("/api/simulation/config", json={"mag_placement": "sideways"}).status_code == 400

    def test_flyby_cannot_be_set_through_the_settings_put(self, client):
        client.put("/api/simulation/config", json={"mag_flyby": {"seq": 99}})
        assert "mag_flyby" not in client.get("/api/simulation/config").json()

    def test_without_the_fleet_flag_there_are_no_magnetometer_settings(self, client, monkeypatch):
        monkeypatch.setenv("SYNTHETIC_FLEET_ENABLED", "0")
        cfg = client.get("/api/simulation/config").json()
        assert not any(k.startswith("mag_") for k in cfg)
        response = client.put("/api/simulation/config", json={"mag_n_nodes": 3})
        assert response.status_code == 400 and "SYNTHETIC_FLEET_ENABLED" in response.json()["detail"]
