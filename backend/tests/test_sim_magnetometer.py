"""The simulated magnetometer network: the detector, its scorecard, the routes.

Readings come from the simulator's own magnetometer model
(retina_simulation.magnetometer), so what is tested here is the pipeline the
/sim map runs: WMM background, the daily variation, quantised RM3100 noise,
dipole UAPs, and the server's detection over the network. Every random draw in
that model is a function of its seed, so these runs are the same every time.
"""

import math
import os
import time
from dataclasses import dataclass
from types import SimpleNamespace

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
from services.public_location import public_latlon

_KEY = {"X-API-Key": os.environ["RADAR_API_KEY"]}
T0 = 1_790_726_400.0  # 2026-09-30T00:00:00Z
T0_MS = int(T0 * 1000)

FLEET = [
    {
        "node_id": f"synth-TEST-{i:02d}",
        "rx_lat": 34.85 + 0.16 * (i // 3 - 1),
        "rx_lon": -82.39 + 0.2 * (i % 3 - 1),
        "rx_alt_ft": 900.0,
    }
    for i in range(8)
]


def _offset(lat, lon, north_km, east_km):
    return (
        lat + math.degrees(north_km / 6371.0),
        lon + math.degrees(east_km / (6371.0 * math.cos(math.radians(lat)))),
    )


def two_on_one_pass(n_far):
    """Two magnetometers 1 km apart, A and B, and n_far more 20 km and further west."""
    sites = [("synth-PAIR-A", _offset(34.85, -82.39, 0.0, -0.5)), ("synth-PAIR-B", _offset(34.85, -82.39, 0.0, 0.5))]
    sites += [
        (f"synth-FAR-{k}", _offset(34.85, -82.39, 12.0 * (k - (n_far - 1) / 2), -22.0 - 3.0 * k)) for k in range(n_far)
    ]
    return [{"node_id": host, "rx_lat": lat, "rx_lon": lon, "rx_alt_ft": 900.0} for host, (lat, lon) in sites]


def cluster(n_near, n_far):
    """n_near magnetometers on a ring 0.7 km round the centre, n_far more 20 km
    and further west: a dense core, as core placement makes, and the rest."""
    near = [
        _offset(
            34.85,
            -82.39,
            0.7 * math.cos(2 * math.pi * k / n_near + 0.3),
            0.7 * math.sin(2 * math.pi * k / n_near + 0.3),
        )
        for k in range(n_near)
    ]
    far = [_offset(34.85, -82.39, 12.0 * (k - (n_far - 1) / 2), -22.0 - 3.0 * k) for k in range(n_far)]
    return [
        {"node_id": f"synth-{name}-{k}", "rx_lat": lat, "rx_lon": lon, "rx_alt_ft": 900.0}
        for name, sites in (("NEAR", near), ("FAR", far))
        for k, (lat, lon) in enumerate(sites)
    ]


def over_the_cluster(rig, seed):
    """A pass over a cluster's centre, its track and closest approach drawn
    from the seed, within 18 km of the centre from 150 s before closest
    approach (T0 + 1100 s) to 150 s after."""
    centre = SimpleNamespace(lat=34.85, lon=-82.39, alt_m=rig.array.nodes[0].alt_m)
    t_cpa = T0 + 1100
    fly = straight_pass(
        centre, cpa_km=0.1 * (seed % 4), altitude_km=0.3, speed_mps=120, heading_deg=(37 * seed) % 360, t_cpa=t_cpa
    )
    return lambda t: fly(t) if abs(t - t_cpa) < 150 else None


def ring(radius_km, n):
    """n magnetometers on a ring radius_km round the centre."""
    sites = [
        _offset(
            34.85,
            -82.39,
            radius_km * math.cos(2 * math.pi * k / n + 0.3),
            radius_km * math.sin(2 * math.pi * k / n + 0.3),
        )
        for k in range(n)
    ]
    return [
        {"node_id": f"synth-NEAR-{k}", "rx_lat": lat, "rx_lon": lon, "rx_alt_ft": 900.0}
        for k, (lat, lon) in enumerate(sites)
    ]


def across_the_ring(rig, seed):
    """A pass across a ring's middle, its track and closest approach drawn from
    the seed, within 30 km of the middle from 250 s before closest approach
    (T0 + 1100 s) to 250 s after."""
    centre = SimpleNamespace(lat=34.85, lon=-82.39, alt_m=rig.array.nodes[0].alt_m)
    t_cpa = T0 + 1100
    fly = straight_pass(
        centre, cpa_km=0.15 * (seed % 5), altitude_km=0.3, speed_mps=120, heading_deg=(37 * seed) % 360, t_cpa=t_cpa
    )
    return lambda t: fly(t) if abs(t - t_cpa) < 250 else None


# The six magnetometers core placement put in the middle of a generated
# Atlanta fleet (scatter layout, 50 sites, seed 9): 0.4–4.9 km apart.
ATLANTA_CORE = [
    {"node_id": host, "rx_lat": lat, "rx_lon": lon, "rx_alt_ft": alt_ft}
    for host, lat, lon, alt_ft in (
        ("synth-ATL-SCAT-0030", 33.758568, -84.376125, 1384.7),
        ("synth-ATL-SCAT-0031", 33.75736, -84.383158, 234.5),
        ("synth-ATL-SCAT-0022", 33.752112, -84.34404, 684.0),
        ("synth-ATL-SCAT-0007", 33.74137, -84.395263, 1453.0),
        ("synth-ATL-SCAT-0017", 33.729177, -84.372162, 758.3),
        ("synth-ATL-SCAT-0026", 33.725953, -84.374975, 561.3),
    )
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

    def __init__(self, seed=21, nodes=8, fleet=None, center=(34.85, -82.39), **settings):
        self.clock = [T0]
        self.network = sm.MagnetometerNetwork(clock=lambda: self.clock[0])
        fleet = fleet or FLEET[:nodes]
        self.array = MagnetometerArray(
            node_configs=fleet, center=center, seed=seed, settings=MagnetometerSettings(n_nodes=len(fleet))
        )
        self.settings = {**sm.SETTINGS_DEFAULTS, **settings}
        # Applied to each push before it is sent, to lose or change readings.
        self.transform = None

    def run(self, seconds, flyers=(), period_s=1.0):
        for _ in range(seconds):
            t = self.clock[0]
            objects = [o for o in (fly(t) for fly in flyers) if o is not None]  # a flyer may be away (None)
            payload = build_magnetometer_push_payload(self.array, [(int(t * 1000), self.array.sample(objects, t))])
            payload["ts_ms"] = int(t * 1000)  # the push's own clock: the fake one here
            if self.transform is not None:
                payload = self.transform(payload, t)
            self.network.ingest(payload, self.settings)
            self.clock[0] += period_s
        return self

    def events(self):
        return [e.as_dict() for e in self.network.events]

    def snapshot(self):
        return self.network.snapshot(self.settings)


@pytest.fixture(scope="module")
def close_pass():
    """One close pass at a magnetometer, closest approach at T0 + 1100 s, with
    the snapshot after every second from a minute before it to 400 s after."""
    rig = Rig()
    node = rig.array.nodes[0]
    t_cpa = T0 + 1100
    flyer = straight_pass(node, cpa_km=0.7, altitude_km=0.4, speed_mps=120, heading_deg=60, t_cpa=t_cpa)
    rig.run(1100 - 60, [flyer])
    snapshots = {}
    for _ in range(460):
        second = round(rig.clock[0] - T0)
        rig.run(1, [flyer])
        snapshots[second] = rig.snapshot()
    return SimpleNamespace(rig=rig, node=node, t_cpa=t_cpa, flyer=flyer, snapshots=snapshots)


def _target(snapshot, node):
    return next(n for n in snapshot["nodes"] if n["node_id"] == node.node_id)


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

    def test_a_published_score_is_never_below_zero(self):
        # A window quieter than noise usually is scores below zero; as a
        # detection score that reads as a fault.
        assert sm.score_sigma(5.0) < 0
        assert sm.published_score(sm.score_sigma(5.0)) == 0.0
        assert sm.published_score(6.237) == 6.24

    def test_confidence_and_noise_interval_agree(self):
        low, high = sm.confidence(4.0), sm.confidence(6.0)
        assert 0 < low < high < 1
        rate = 1.0 / sm.noise_interval_h(5.0)
        assert sm.confidence(5.0) == pytest.approx(math.exp(-rate), rel=1e-3)

    @pytest.mark.parametrize(
        ("threshold", "low", "high"),
        # The benchmark's measured 95 % intervals, per node-hour, rounded
        # outwards (scripts/magnetometer_false_alarms.py at its defaults:
        # eight magnetometers, 3,065 node-hours at each threshold and 9,194
        # at 5 and 5.5σ).
        [
            (3.0, 5.611, 5.782),
            (3.5, 1.317, 1.401),
            (4.0, 0.2168, 0.2515),
            (4.5, 0.02861, 0.04220),
            (5.0, 0.001759, 0.004015),
            (5.5, 0.0000027, 0.0006061),
            (6.0, 0.0, 0.001204),
        ],
    )
    def test_false_alarm_model_lies_inside_the_measured_intervals(self, threshold, low, high):
        assert low <= sm.false_alarm_rate(threshold) <= high

    def test_false_alarm_model_falls_with_the_threshold(self):
        rates = [sm.false_alarm_rate(z) for z in (3.0, 4.0, 5.0, 6.0, 8.0, 12.0)]
        assert all(a > b > 0 for a, b in zip(rates, rates[1:], strict=False))

    @pytest.mark.parametrize(
        ("k", "low", "high"),
        # Garwood's exact interval in total counts: chi-square quantiles over two.
        [(0, 0.0, 3.6889), (1, 0.0253, 5.5716), (5, 1.6235, 11.6683), (100, 81.3640, 121.6268)],
    )
    def test_the_interval_on_a_rate_is_garwoods(self, k, low, high):
        assert sm.garwood(k, 1.0) == pytest.approx((low, high), abs=1e-4)
        assert sm.garwood(k, 4.0) == pytest.approx((low / 4, high / 4), abs=1e-4)

    def test_range_band_brackets_both_geometries(self):
        # 100 nT is what a 1e9 A·m² dipole gives 1 km off on its equator, or
        # 1.26 km off on its axis. A strong detection's strength reads close
        # to the truth (0.77–1.11 of it for nine in ten above 15σ), so its
        # band is narrow, and holds both.
        near, far = sm.range_band_km(100.0, 1e9, 40.0)
        assert near < 1.0 and far > 2 ** (1 / 3)
        assert (near, far) == pytest.approx((0.954, 1.268), abs=1e-3)
        assert sm.range_band_km(0.0, 1e9, 40.0) is None

    @pytest.mark.parametrize(
        ("score", "low", "high"),
        # How strengths read in the benchmark (scripts/magnetometer_false_alarms.py
        # at its defaults): for the passes found in a score bin, at 3.5σ and at
        # the default threshold, the bin's median score and the 5th and 95th
        # percentiles of ln(strength · r³ / k·m), r the true slant range. A
        # strength read exactly lies between 0 (the UAP on the dipole's equator)
        # and ln 2 (on its axis); just above a threshold it reads high, so the
        # band must reach out to where such a pass really was.
        [(3.69, 0.066, 1.426), (5.76, -0.081, 1.173), (9.02, -0.004, 0.787), (40.0, -0.105, 0.667)],
        ids=["just-above-3.5", "just-above-5.5", "8-10", "at-the-clip"],
    )
    def test_the_range_band_holds_how_strengths_read_at_each_score(self, score, low, high):
        near, far = sm.band_bounds(score)
        assert near <= low and high <= far

    def test_the_range_band_narrows_as_the_score_rises(self):
        scores = (3.0, 3.5, 4.5, 5.5, 7.0, 10.0, 20.0, 40.0)
        widths = [math.exp((far - near) / 3.0) for near, far in map(sm.band_bounds, scores)]  # far over near
        assert all(a > b for a, b in zip(widths, widths[1:], strict=False))
        assert widths[-1] < 1.35  # narrower than the fixed ±15 % band's 1.39 for a strong detection
        assert sm.band_bounds(2.0) == sm.band_bounds(sm.BAND_LOWEST_SIGMA)  # no pole below the lowest threshold

    @pytest.mark.parametrize("readings", [60, 150, 599])
    def test_a_young_noise_estimate_keeps_each_scores_tail_probability(self, readings):
        # Over a variance estimated from n readings the statistic is
        # 9·F(9, 2(n − 1)); mapped to what it would be over ten minutes of
        # readings (2 × 599 degrees of freedom), it keeps its tail probability.
        for energy in (20.0, 54.0, 120.0, 400.0):
            settled = sm.settled_energy(energy, readings)
            assert settled < energy
            assert stats.f.sf(settled / 9, 9, 1198) == pytest.approx(
                stats.f.sf(energy / 9, 9, 2 * (readings - 1)), rel=1e-6
            )
        assert sm.settled_energy(54.0, 600) == 54.0
        assert sm.score_sigma(sm.settled_energy(1e9, 60)) == 40.0

    @pytest.mark.parametrize("readings", [60, 300, 599])
    def test_a_young_noise_estimate_maps_the_strongest_statistic_too(self, readings):
        # Where the tail probability underflows a double (from 3,162 at 599
        # readings, 3.2e7 at 60) the map once gave infinity; it now stays
        # finite and increasing, and at 599 readings within a hair of the
        # statistic itself, as at 600.
        energies = [1e2, 1e3, 3.16e3, 3.17e3, 7.94e3, 1e5, 3.2e7, 1e12, 1e100]
        settled = [sm.settled_energy(e, readings) for e in energies]
        assert (
            all(math.isfinite(e) for e in settled) and settled == sorted(settled) and len(set(settled)) == len(settled)
        )
        if readings == 599:
            assert settled[2] == pytest.approx(3.16e3, rel=0.01) and settled[3] == pytest.approx(3.17e3, rel=0.01)

    def test_a_noise_estimate_or_a_median_of_nothing_is_refused(self):
        with pytest.raises(ValueError, match="two readings"):
            sm.settled_energy(10.0, 1)
        with pytest.raises(ValueError, match="one value"):
            sm.median_variance(0)

    def test_noise_reaches_a_score_as_often_on_a_minute_of_readings_as_on_ten(self):
        # The detector's own noise estimate, from 60 readings (a restart's
        # first) and from 600: noise alone must reach 2σ as often either way.
        # On the raw statistic it did a third more often from 60.
        rng = np.random.default_rng(17)
        scale = sm.SCALES[2]
        threshold = stats.chi2.isf(stats.norm.sf(2.0), 9)

        def share(readings, trials=20_000):
            hits = 0
            for _ in range(trials):
                sigma = sm.noise_sigma(rng.normal(0.0, 16.5, (readings, 3)), 15.0)
                energy = np.sum((scale.detector @ rng.normal(0.0, 16.5, (scale.length, 3))) ** 2) / sigma**2
                hits += sm.settled_energy(energy, readings) >= threshold
            return hits / trials

        assert share(60) == pytest.approx(stats.norm.sf(2.0), rel=0.12)
        assert share(600) == pytest.approx(stats.norm.sf(2.0), rel=0.12)

    def test_the_noise_clip_is_never_narrower_than_the_sensor_allows(self):
        # 50 cycles: 30 nT of noise, 50 nT counts. Nine differences in ten are
        # zero and the rest four counts (200 nT), within five times what the
        # sensor's noise puts into a difference (√2 × 30 nT): noise, kept.
        rng = np.random.default_rng(2)
        residual = np.cumsum(np.where(rng.random((600, 3)) < 0.1, rng.choice([-200.0, 200.0], (600, 3)), 0.0), axis=0)
        every_difference = np.diff(residual, axis=0).std(axis=0) / math.sqrt(2.0)
        assert sm.noise_sigma(residual, 30.0) == pytest.approx(np.sqrt(np.mean(every_difference**2)))


def _nothing_held(n):
    return np.full((n, 3), np.nan)


def _common_modes(deviations, evidence, held):
    return sm.common_modes(deviations, evidence, held)


C, NH, H, NE, E = sm.CLEAR, sm.NEAR_HOT, sm.HOT, sm.NEAR_EVENT, sm.EVENT


def _sites(*offsets_km):
    """Positions (north, east) km from the centre."""
    return [_offset(34.85, -82.39, north, east) for north, east in offsets_km]


def _far_apart(n):
    """n positions 22 km apart, as spread placement puts magnetometers."""
    return _sites(*((22.0 * k, 0.0) for k in range(n)))


class Steady:
    """Magnetometers reading a steady field, plus what a test adds (white
    noise, a field common to all), pushed straight into a detector on a fake
    clock, a reading a second."""

    def __init__(self, sites, noise_nt=0.0, seed=7, **settings):
        self.clock = [T0]
        self.network = sm.MagnetometerNetwork(clock=lambda: self.clock[0])
        self.sites = sites
        self.noise_nt = noise_nt
        self.rng = np.random.default_rng(seed)
        self.settings = {**sm.SETTINGS_DEFAULTS, **settings}
        self.second = 0

    def push(self, common=lambda second: 0.0):
        """One second, with ``common(second)`` nT at every magnetometer, mostly
        on x."""
        t_ms = T0_MS + 1000 * self.second
        self.clock[0] = T0 + self.second
        shared = common(self.second)
        nodes = []
        for i, (lat, lon) in enumerate(self.sites):
            reading = np.array([20_000.0 + 50.0 * i + shared, -1_000.0 + 0.5 * shared, 45_000.0 - 0.3 * shared])
            if self.noise_nt:
                reading += self.rng.normal(0.0, self.noise_nt, 3)
            nodes.append(
                {
                    "node_id": f"mag-synth-{i}",
                    "host_node_id": f"synth-{i}",
                    "lat": lat,
                    "lon": lon,
                    "samples": [[t_ms, *reading.tolist()]],
                }
            )
        self.network.ingest({"sensor": {"noise_nt": 15.0}, "ts_ms": t_ms, "nodes": nodes}, self.settings)
        self.second += 1
        return self

    def run(self, seconds, **kwargs):
        for _ in range(seconds):
            self.push(**kwargs)
        return self

    def node(self, i):
        return self.network.nodes[f"mag-synth-{i}"]

    def open_event(self, i):
        node = self.node(i)
        node.event = sm.Event(
            event_id=f"e{i}", node_id=node.node_id, host_node_id=node.host_node_id, start_ms=node.last_ms,
            peak_ms=node.last_ms, score_sigma=6.0, strength_nt=40.0, tau_s=8, peak_end_ms=node.last_ms,
            scale_tau=8, epoch=self.network._scores_epoch,
        )  # fmt: skip

    def others_in_median(self):
        """How many others each magnetometer's latest common mode came from
        (0: held), read back from the noise the residual carries."""
        out = []
        for i in range(len(self.sites)):
            extra = self.node(i).variance.last(1)[0, 0] - 1.0
            out.append(next((k for k in range(1, 60) if sm.median_variance(k) == pytest.approx(extra)), 0))
        return out


class TestCommonMode:
    def test_a_node_never_enters_its_own_median(self):
        # With itself in the median the middle node's residual would be zero.
        deviations = np.array([[0.0], [1.0], [10.0], [11.0], [12.0]]) * np.ones(3)
        common, counts = _common_modes(deviations, np.full(5, C), _nothing_held(5))
        assert list(counts) == [4] * 5
        assert common[2] == pytest.approx([6.0] * 3)  # the median of 0, 1, 11, 12
        assert common[0] == pytest.approx([10.5] * 3)  # of 1, 10, 11, 12

    @pytest.mark.parametrize("evidence", [NH, H, NE, E], ids=["near-hot", "hot", "near-an-event", "an-event"])
    def test_a_node_that_may_carry_a_pass_enters_no_other_median(self, evidence):
        # Node 4 carries a pass: 500 nT. Leaving it out, the others' medians
        # come from the clear nodes alone.
        deviations = np.array([[0.0], [1.0], [2.0], [3.0], [500.0]]) * np.ones(3)
        common, counts = _common_modes(deviations, np.array([C, C, C, C, evidence]), _nothing_held(5))
        assert common[0] == pytest.approx([2.0] * 3)  # median of 1, 2, 3
        assert common[1] == pytest.approx([2.0] * 3)  # of 0, 2, 3
        assert common[4] == pytest.approx([1.5] * 3)  # its own baseline: all four others
        assert list(counts) == [3, 3, 3, 3, 4]

    def test_with_no_clear_other_the_weakest_evidence_is_set_aside_first(self):
        # A score is weak evidence, an event strong: a magnetometer far off
        # that merely scores high still sees what a storm does, and holding
        # would not. However few the others, the median follows them.
        deviations = np.array([[0.0], [10.0], [20.0], [30.0], [40.0]]) * np.ones(3)
        common, counts = _common_modes(deviations, np.array([C, NH, H, NE, E]), _nothing_held(5))
        assert common[0] == pytest.approx([10.0] * 3) and counts[0] == 1  # nothing clear: the one near-hot
        assert common[1] == pytest.approx([0.0] * 3) and counts[1] == 1  # the one clear
        common, counts = _common_modes(deviations, np.array([C, H, H, NE, E]), _nothing_held(5))
        assert common[0] == pytest.approx([15.0] * 3) and counts[0] == 2  # then the hot ones

    def test_a_node_at_or_beside_an_event_takes_only_clear_others(self):
        # It is measuring a pass, and the magnetometers scoring high near it
        # are the same pass on its way: their median would take it whole.
        deviations = np.array([[0.0], [10.0], [20.0], [30.0], [40.0]]) * np.ones(3)
        held = np.array([[5.0, 6.0, 7.0]] * 5)
        common, counts = _common_modes(deviations, np.array([NE, H, NH, C, E]), held)
        assert common[0] == pytest.approx([30.0] * 3) and counts[0] == 1  # the clear one, not the near-hot
        assert common[4] == pytest.approx([30.0] * 3) and counts[4] == 1
        common, counts = _common_modes(deviations, np.array([NE, H, NH, NE, E]), held)
        assert common[0] == pytest.approx([5.0, 6.0, 7.0]) and counts[0] == sm.HELD  # none clear: it holds
        assert common[1] == pytest.approx([20.0] * 3) and counts[1] == 1  # a hot one sets the score aside

    def test_with_no_other_left_a_node_holds_or_has_no_common_mode(self):
        # Every other node has an event open or is beside one. What a node
        # holds is its own recent common mode; with nothing held yet (the first
        # second after a restart, say) it has none it can trust.
        deviations = np.array([[0.0], [100.0], [200.0], [300.0]]) * np.ones(3)
        held = np.array([[5.0, 6.0, 7.0]] * 4)
        for evidence in (C, NE, E):
            common, counts = _common_modes(deviations, np.array([evidence, E, NE, E]), held)
            assert common[0] == pytest.approx([5.0, 6.0, 7.0]) and counts[0] == sm.HELD
        _common, counts = _common_modes(deviations[:3], np.array([C, E, E]), _nothing_held(3))
        assert counts[0] == sm.NONE
        _common, counts = _common_modes(deviations[:1], np.array([C]), held[:1])  # a magnetometer on its own
        assert counts[0] == sm.HELD

    @pytest.mark.parametrize("k", [1, 2, 3, 4, 7, 8, 11, 12, 40])
    def test_what_a_median_of_k_others_adds_to_the_noise(self, k):
        medians = np.median(np.random.default_rng(k).standard_normal((200_000, k)), axis=1)
        assert sm.median_variance(k) == pytest.approx(medians.var(), rel=0.015)

    @pytest.mark.parametrize(
        ("score", "event", "others"),
        [
            (2.99, False, [7] * 8),
            (3.0, False, [6, 6, 5, 5, 5, 5, 5, 5]),
            (0.0, True, [6, 6, 5, 5, 5, 5, 5, 5]),
        ],
        ids=["under-three-sigma", "three-sigma", "an-event"],
    )
    def test_a_magnetometer_that_may_carry_a_pass_is_left_out_with_any_within_three_km(self, score, event, others):
        # Node 1 is 2.9 km from node 0, node 2 3.1 km; the rest are 22 km
        # apart. Scoring 3σ, or with an event open, node 0 may be carrying a
        # pass, and so may node 1: both are left out of every other median.
        # Node 2 is far enough that a pass lifting node 0 barely reaches it.
        steady = Steady(_sites((0.0, 0.0), (0.0, 2.9), (0.0, 3.1), *((22.0 * k, -22.0) for k in range(1, 6))))
        steady.run(200)
        steady.node(0).score = score
        if event:
            steady.open_event(0)
        steady.push()
        assert steady.others_in_median() == others

    def test_a_hold_carries_the_last_seconds_of_the_common_mode(self):
        # The whole network steps 300 nT (a storm's sudden commencement), and
        # twenty seconds on every node but one opens an event. The one left
        # holds what the network did over its last few seconds, not over
        # minutes, or it would see the step as its own.
        steady = Steady(_far_apart(6)).run(200)
        steady.run(20, common=lambda second: 300.0)
        for i in range(1, 6):
            steady.open_event(i)
        steady.push(common=lambda second: 300.0)
        assert steady.others_in_median()[0] == 0  # held
        assert steady.node(0).residual.last(1)[0] == pytest.approx([0.0] * 3, abs=1.0)

    def test_a_restart_forgets_the_held_common_mode(self):
        # What a residual is has changed, and so has its common mode.
        steady = Steady(_far_apart(6)).run(200)
        node = steady.node(0)
        assert node.common is not None and node.sigma_nt is not None
        node.restart()
        assert (node.common, node.sigma_nt, node.run, node.noise_count) == (None, None, 0, 0)

    def test_a_window_is_divided_by_the_largest_eigenvalue_of_its_noise(self):
        # Readings of variance f make the window's projection noise of
        # covariance Σ f q qᵀ (q: the three functions at each reading). Its
        # largest eigenvalue is the least divisor that keeps the statistic
        # within χ²: the window's own variance where that is the same
        # throughout; and one reading at f + Δ adds exactly Δ·|q|² there, its
        # share of the functions (a rank-one update): 0.2 % a quarter of the
        # way along a 16 s window and 9 % at its middle, where dividing by the
        # window's noisiest reading would take all of it.
        scale = sm.SCALES[3]  # τ = 16 s, 129 readings
        same = np.full(sm.LONGEST, 1.3)
        assert sm.window_variance(scale, same) == pytest.approx(1.3)
        q = scale.detector
        for at, most in ((scale.length // 4, 1.003), (scale.length // 2, 1.1)):
            one = same.copy()
            one[-scale.length + at] = 2.6
            assert sm.window_variance(scale, one) == pytest.approx(1.3 + 1.3 * np.sum(q[:, at] ** 2))
            assert sm.window_variance(scale, one) < 1.3 * most

    def test_a_noisier_stretch_inside_a_window_is_allowed_for_and_no_more(self):
        # Noise whose variance doubles for ten seconds inside a τ = 16 s
        # window: over the eigenvalue the statistic stays within χ²₉ (its 99th
        # percentile crossed no more than 1 % of the time), and is deflated no
        # further: a mean of 3·tr/λ, where dividing by the window's noisiest
        # reading would give 3·tr/2.6.
        rng = np.random.default_rng(23)
        scale = sm.SCALES[3]
        variances = np.full(scale.length, 1.3)
        variances[55:65] = 2.6
        divisor = sm.window_variance(scale, np.concatenate([np.full(sm.LONGEST - scale.length, 1.3), variances]))
        noise = rng.normal(size=(20_000, scale.length, 3)) * np.sqrt(variances)[None, :, None]
        statistic = np.sum(np.einsum("fl,nla->nfa", scale.detector, noise) ** 2, axis=(1, 2)) / divisor
        assert np.mean(statistic > stats.chi2.ppf(0.99, 9)) <= 0.01 + 0.002
        expected = 3 * np.trace((scale.detector * variances) @ scale.detector.T) / divisor
        assert np.mean(statistic) == pytest.approx(expected, rel=0.02)
        assert expected > 1.1 * 3 * np.trace((scale.detector * variances) @ scale.detector.T) / 2.6

    def test_an_event_closes_on_the_footing_it_opened_on(self):
        # Within ten minutes of a restart a statistic is settled before it is
        # scored, in closing an event as in opening one. The pass's own scale
        # (τ = 2 s here) reads 4.6σ on the raw χ²: over the threshold less one
        # (4.5σ), the event would stay open; settled on an estimate from 60
        # readings it is 4.0σ, and the event closes after five readings.
        network = sm.MagnetometerNetwork(clock=lambda: T0)
        node = sm.NodeState(node_id="mag-synth-A", host_node_id="synth-A", lat=34.8, lon=-82.3, alt_m=0.0)
        node.offset, node.sigma_nt, node.sigma_readings = np.zeros(3), 10.0, 60
        scale = sm.SCALES[0]
        energy = stats.chi2.isf(stats.norm.sf(4.6), 9)
        residual = np.zeros((sm.LONGEST, 3))
        residual[-scale.length :, 0] = 10.0 * math.sqrt(energy) * scale.detector[0]
        for k in range(sm.LONGEST):
            node.t_ms.append([T0_MS + 1000 * k])
            node.residual.append(residual[k])
            node.variance.append([1.0])
        node.run = sm.LONGEST
        node.event = sm.Event(
            event_id="e", node_id=node.node_id, host_node_id="synth-A", start_ms=T0_MS, peak_ms=T0_MS,
            score_sigma=8.0, strength_nt=40.0, tau_s=2, peak_end_ms=T0_MS, scale_tau=2, peak_energy=1e9,
        )  # fmt: skip
        assert sm.score_sigma(sm.settled_energy(energy, 60)) < 4.5 < sm.score_sigma(energy)
        for _ in range(sm.CLOSE_AFTER):
            network._detect(node, T0_MS + 1000 * sm.LONGEST, 5.5)
        assert node.event is None and node.last_event.end_ms == T0_MS + 1000 * sm.LONGEST

    def test_a_window_is_scored_against_the_noise_it_carries(self):
        # sigma_nt measured the residual with its usual common mode, from the
        # others it usually comes from. A window whose common mode came from
        # one other carries twice the node's own noise; and a noise estimate
        # from a minute of readings is less certain than one from ten.
        network = sm.MagnetometerNetwork(clock=lambda: T0)
        residual = np.random.default_rng(3).normal(0.0, 11.0, (sm.LONGEST, 3))

        def score(variances, readings=600):
            node = sm.NodeState(node_id="mag-synth-A", host_node_id="synth-A", lat=34.8, lon=-82.3, alt_m=0.0)
            node.offset, node.sigma_nt, node.sigma_readings, node.sigma_variance = np.zeros(3), 11.0, readings, 1.21
            for k in range(sm.LONGEST):
                node.t_ms.append([T0_MS + 1000 * k])
                node.residual.append(residual[k])
                node.variance.append([variances[k]])
            node.run = sm.LONGEST
            network._detect(node, T0_MS + 1000 * (sm.LONGEST - 1), 99.0)
            return node.score

        usual = score([1.21] * sm.LONGEST)
        energy = stats.chi2.isf(stats.norm.sf(usual), 9)
        following_one = score([2.0] * sm.LONGEST)  # every window's common mode from one other
        assert following_one == pytest.approx(sm.score_sigma(energy * 1.21 / 2.0), abs=1e-6)
        assert score([1.21] * sm.LONGEST, readings=60) == pytest.approx(
            sm.score_sigma(sm.settled_energy(energy, 60)), abs=1e-6
        )


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
        # Scored from the first noise estimate on (the first :00 or :30 with a
        # minute of residual behind it, 180 s in), each second weighed by the
        # share of the full search its scales make: the residual began at
        # 119 s, and a scale searches once its window is full of it.
        share = (0.47, 0.73, 0.84, 0.93, 0.96, 1.0)  # SEARCH_SHARE, as measured
        searched = sum(share[sum(s.length <= t - 118 for s in sm.SCALES) - 1] for t in range(180, 3600))
        assert card["node_hours"] == pytest.approx(8 * searched / 3600, abs=1e-3)
        assert card["false_alarms"] == 0
        assert card["false_alarms_per_node_hour_ci95"][0] == 0.0

    @pytest.mark.parametrize("nodes", [8, 6])
    def test_false_alarms_match_the_model_behind_every_confidence(self, nodes):
        # At 3σ noise alone alarms about 5.7 times a node-hour, some ninety
        # times in two hours of eight magnetometers, enough to count: the
        # count must lie in the 99 % Poisson band of the fitted model, the
        # calibration every confidence and noise_once_per_h rests on. Here
        # that admits a coefficient of 427 to 712; at 3.5σ, with a fifth of
        # the alarms, it admitted 251 to 812. Six is the fewest magnetometers
        # that take the common mode out, and leave the fewest others for each
        # one's median.
        rig = Rig(nodes=nodes, mag_threshold_sigma=3.0).run(2 * 3600)
        for node in rig.network.nodes.values():
            rig.network._close_event(node, node.last_ms)
        card = rig.network.scorecard()
        expected = sm.false_alarm_rate(3.0) * card["node_hours"]
        low, high = stats.poisson.ppf([0.005, 0.995], expected)
        assert low <= card["false_alarms"] <= high, (card["false_alarms"], expected)
        assert card["true_detections"] == 0

    def test_a_close_pass_is_found_once_with_its_truth(self, close_pass):
        events = [e for e in close_pass.rig.events() if e["node_id"] == close_pass.node.node_id]
        assert len(events) == 1, events  # one pass, one event: no re-report from longer windows
        event = events[0]
        assert event["truth"]["label"] == "true" and event["truth"]["object_id"] == "uap-test"
        assert event["truth"]["provisional"] is False
        assert event["score_sigma"] > 10
        true_peak = event["truth"]["true_peak_nt"]
        assert event["strength_nt"] == pytest.approx(true_peak, rel=0.25)
        slant = math.hypot(0.7, 0.4)
        assert event["range_km"][0] <= slant <= event["range_km"][1]
        assert abs(event["peak_ms"] / 1000 - close_pass.t_cpa) <= 10
        assert event["active"] is False and event["end_ms"] > event["start_ms"]
        card = close_pass.rig.network.scorecard()
        assert card["true_detections"] == 1 and card["false_alarms"] == 0
        assert card["passes"] == 1 and card["passes_detected"] == 1

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

    def test_three_magnetometers_do_without_the_common_mode(self):
        # The median of the two others is their mean: half of the pass at one
        # node would be taken from the other two, as a pass of their own.
        rig = Rig(nodes=3)
        node = rig.array.nodes[0]
        flyer = straight_pass(node, cpa_km=0.6, altitude_km=0.3, speed_mps=120, heading_deg=60, t_cpa=T0 + 1100)
        rig.run(1500, [flyer])
        assert {e["node_id"] for e in rig.events()} == {node.node_id}
        detector = rig.snapshot()["detector"]
        assert detector["common_mode_applied"] is False
        assert detector["false_alarm_model"]["calibrated"] is False
        assert rig.events()[0]["calibrated"] is False

    @pytest.mark.parametrize("n_far", [2, 4], ids=["four-magnetometers", "six-magnetometers"])
    def test_two_magnetometers_on_one_pass_leak_into_no_other(self, n_far):
        # A and B, 1 km apart, both see the pass; the rest are 20 km away.
        # With four reporting the common mode is left in (a median of three
        # with two of them on the pass is the pass); with six it is taken
        # out, and A and B are left out of the others' medians once they
        # alarm.
        rig = Rig(fleet=two_on_one_pass(n_far))
        a, b = (next(n for n in rig.array.nodes if n.host_node_id == f"synth-PAIR-{x}") for x in "AB")
        between = SimpleNamespace(lat=(a.lat + b.lat) / 2, lon=(a.lon + b.lon) / 2, alt_m=a.alt_m)
        flyer = straight_pass(between, cpa_km=0.0, altitude_km=0.3, speed_mps=120, heading_deg=0, t_cpa=T0 + 1100)
        rig.run(1600, [flyer])
        assert {e["host_node_id"] for e in rig.events()} == {"synth-PAIR-A", "synth-PAIR-B"}
        assert all(e["truth"]["label"] == "true" for e in rig.events())
        assert rig.snapshot()["detector"]["common_mode_applied"] is (2 + n_far >= sm.COMMON_MODE_MIN_NODES)

    def test_a_hole_is_spanned_by_no_window_at_any_scale(self):
        # One magnetometer loses two minutes of readings and comes back 40 nT
        # off its old level, as a site does when what happened meanwhile (a
        # fleet restarted with another seed, say) is not in the readings. A
        # window across the hole would see a 40 nT step; the long scales'
        # windows (8τ of 256 and 512 s) are longer than the hole, so skipping
        # only windows that are much longer than nominal misses it.
        rig = Rig().run(800)
        target = rig.array.nodes[0].node_id
        hole = (rig.clock[0], rig.clock[0] + 120)

        def lose_and_shift(payload, t):
            for entry in payload["nodes"]:
                if entry["node_id"] != target:
                    continue
                if t < hole[1]:
                    entry["samples"], entry["truth"] = [], []
                else:
                    entry["samples"] = [[row[0], row[1] + 40.0, row[2], row[3]] for row in entry["samples"]]
            return payload

        rig.transform = lose_and_shift
        rig.run(121)
        back = _target(rig.snapshot(), rig.array.nodes[0])["state"]
        rig.run(900)
        assert rig.events() == []
        assert back == "warming_up"  # its windows refilling
        assert _target(rig.snapshot(), rig.array.nodes[0])["state"] in ("quiet", "elevated")

    def test_a_search_refilling_after_a_hole_counts_its_share(self):
        # Every magnetometer misses ten readings. Its windows refill shortest
        # first, and a second searched with the shortest k scales counts as
        # the share of a full search's false alarms those k raise.
        rig = Rig().run(900)
        before = rig.network.exposure_s

        def lose_ten(payload, t):
            for entry in payload["nodes"]:
                entry["samples"], entry["truth"] = [], []
            return payload

        rig.transform = lose_ten
        rig.run(10)
        rig.transform = None
        rig.run(600)
        share = (0.47, 0.73, 0.84, 0.93, 0.96, 1.0)  # SEARCH_SHARE, as measured
        readings = {1: 16, 2: 32, 3: 64, 4: 128, 5: 256, 6: 88}  # of the 600, by scales searched
        assert rig.network.exposure_s - before == pytest.approx(8 * sum(n * share[k - 1] for k, n in readings.items()))

    def test_a_fleet_running_slow_is_still_watched(self):
        # Readings 1.6 s apart, as an overloaded fleet stretches its ticks.
        # The windows count readings: each scale is stretched by 1.6 and the
        # pass is still found, where a window-span test skipped every window.
        period_s = 1.6
        rig = Rig()
        node = rig.array.nodes[0]
        t_cpa = T0 + 1100 * period_s
        flyer = straight_pass(node, cpa_km=0.7, altitude_km=0.4, speed_mps=120, heading_deg=60, t_cpa=t_cpa)
        rig.run(1500, [flyer], period_s=period_s)
        (event,) = rig.events()
        assert event["node_id"] == node.node_id and event["truth"]["label"] == "true"
        assert event["score_sigma"] > 10 and abs(event["peak_ms"] / 1000 - t_cpa) <= 10 * period_s
        assert event["active"] is False
        # Times in seconds: a scale of k readings is 1.6 k s here. The pass's
        # own τ is 806 m / 120 m/s = 6.7 s.
        assert event["tau_s"] / period_s == pytest.approx(min(sm.SCALES_S, key=lambda k: abs(k * period_s - 6.7)))
        snapshot = rig.snapshot()
        assert [n["longest_scale_s"] for n in snapshot["nodes"]] == [pytest.approx(64 * period_s)] * 8
        # Exposure is time, not readings: 8 magnetometers searching from some
        # minutes in until the end, 1500 readings 1.6 s apart (counted in
        # readings, it could not pass 8 × 1500 s).
        assert 8 * 1200 * period_s / 3600 < snapshot["stats"]["node_hours"] < 8 * 1500 * period_s / 3600
        # The model is a rate per hour of readings a second apart.
        assert snapshot["detector"]["false_alarm_model"]["calibrated"] is False

    def test_threshold_change_restarts_the_scorecard(self):
        rig = Rig().run(200)
        before = rig.network.scorecard()["node_hours"]
        rig.settings = {**rig.settings, "mag_threshold_sigma": 7.0}
        rig.run(10)
        assert rig.network.scorecard()["node_hours"] < before

    def test_an_event_counts_in_the_scorecard_it_opened_under(self):
        # A threshold change mid-event starts a new scorecard; the event was
        # found under the old threshold and counts in neither.
        rig = Rig()
        node = rig.array.nodes[0]
        flyer = straight_pass(node, cpa_km=0.7, altitude_km=0.4, speed_mps=120, heading_deg=60, t_cpa=T0 + 1100)
        rig.run(1110, [flyer])
        assert _target(rig.snapshot(), node)["state"] == "alarm"
        rig.settings = {**rig.settings, "mag_threshold_sigma": 6.0}
        rig.run(400, [flyer])
        (event,) = rig.events()
        assert event["active"] is False and event["truth"]["label"] == "true"
        card = rig.network.scorecard()
        assert (card["true_detections"], card["false_alarms"]) == (0, 0)
        # Nor does the pass it was found in, which began under the old one.
        assert (card["passes"], card["passes_detected"], card["passes_open"]) == (0, 0, 0)

    def test_a_new_cycle_count_restarts_the_noise_estimate(self):
        # 200 → 50 cycles doubles the noise from the next reading. Scored on
        # the old estimate, which caught up only over ten minutes, every
        # magnetometer raised false alarms within the minute.
        rig = Rig().run(900)
        since = rig.network.scorecard()["since_ms"]
        rig.array.apply(MagnetometerSettings(n_nodes=8, cycle_count=50), rig.clock[0])
        rig.run(1)
        changed = rig.snapshot()
        rig.run(700)
        assert rig.events() == []
        assert changed["sensor"]["cycle_count"] == 50
        assert {n["state"] for n in changed["nodes"]} == {"warming_up"}
        assert changed["stats"]["since_ms"] > since and changed["stats"]["node_hours"] == 0
        nodes = rig.snapshot()["nodes"]
        assert {n["state"] for n in nodes} <= {"quiet", "elevated"}
        assert all(n["sigma_nt"] > 30 for n in nodes)  # the 50-cycle noise, measured afresh

    def test_a_magnetometer_placed_elsewhere_starts_afresh(self):
        # A scene change restarts the fleet with a new layout, and a
        # magnetometer's id follows its host's, so the same id can come back
        # 44 km away. Its old static level is another site's.
        rig = Rig().run(900)
        moved = {"synth-TEST-01", "synth-TEST-04", "synth-TEST-06"}
        layout = [{**cfg, "rx_lat": cfg["rx_lat"] + 0.4} if cfg["node_id"] in moved else cfg for cfg in FLEET]
        after = Rig(fleet=layout)
        after.network, after.clock = rig.network, rig.clock
        after.clock[0] += 90  # the fleet restarting
        after.run(1)
        nodes = {n["host_node_id"]: n for n in after.snapshot()["nodes"]}
        for cfg in layout:
            published = (nodes[cfg["node_id"]]["lat"], nodes[cfg["node_id"]]["lon"])
            assert published == public_latlon(round(cfg["rx_lat"], 6), round(cfg["rx_lon"], 6), cfg["node_id"])
            if cfg["node_id"] in moved:
                assert nodes[cfg["node_id"]]["samples"] == 1 and nodes[cfg["node_id"]]["state"] == "warming_up"
        after.run(1500)
        assert after.events() == []

    def test_switching_the_common_mode_restarts_every_node(self):
        # In or out, it changes what a residual is: the daily variation goes
        # in or out of it, and its noise moves by a fifth. Neither may be
        # scored against the other's noise estimate.
        rig = Rig().run(900)
        for common_mode in (False, True):
            rig.settings = {**rig.settings, "mag_common_mode": common_mode}
            rig.run(1)
            snapshot = rig.snapshot()
            assert snapshot["detector"]["common_mode_applied"] is common_mode
            assert {n["state"] for n in snapshot["nodes"]} == {"warming_up"}
            assert snapshot["stats"]["node_hours"] == 0
            rig.run(700)
        assert rig.events() == []

    def test_identical_counts_cannot_claim_no_noise(self):
        # A stuck sensor repeats one count: its measured noise is zero, which
        # would make every wobble a detection. The datasheet floor holds it.
        network = sm.MagnetometerNetwork(clock=lambda: T0 + 300)
        for k in range(300):
            nodes = [
                {
                    "node_id": f"mag-synth-{i}",
                    "host_node_id": f"synth-{i}",
                    "lat": 34.8 + 0.1 * i,
                    "lon": -82.3,
                    "samples": [[T0_MS + 1000 * k, 20_000.0, -1_000.0, 45_000.0]],
                }
                for i in range(6)
            ]
            network.ingest({"sensor": {"noise_nt": 15.0}, "nodes": nodes}, sm.effective_settings({}))
        assert [node.sigma_nt for node in network.nodes.values()] == [pytest.approx(0.3 * 15.0)] * 6
        assert {n["state"] for n in network.snapshot(sm.effective_settings({}))["nodes"]} == {"quiet"}

    def test_noise_near_a_uap_that_does_not_move_is_not_a_detection(self):
        # A UAP hovering 1.5 km away puts ~40 nT on the magnetometer, but a
        # steady field is invisible to a detector that removes a constant, so
        # an event there is noise. Counting it as a detection would bias the
        # measured false-alarm rate low.
        rig = Rig(seed=101, mag_threshold_sigma=3.5)
        node = rig.array.nodes[1]
        lat, lon = _offset(node.lat, node.lon, 1.5, 0.0)
        rig.run(3600, [lambda t: Obj("uap-hover", lat, lon, node.alt_m / 1000.0 + 0.3)])
        events = [e for e in rig.events() if e["node_id"] == node.node_id]
        assert events
        assert all(e["truth"]["true_peak_nt"] > 20 for e in events)
        assert all(e["truth"]["label"] == "false" and e["truth"]["object_id"] is None for e in events)
        # Nor is it a pass: it was there before the magnetometer could watch.
        card = rig.network.scorecard()
        assert (card["passes"], card["passes_detected"], card["passes_open"]) == (0, 0, 0)

    @pytest.mark.parametrize(
        ("nodes", "common_mode"), [(4, True), (8, False)], ids=["four-magnetometers", "common-mode-off"]
    )
    def test_coarse_counts_without_the_common_mode_keep_their_noise(self, nodes, common_mode):
        # At 50 cycles a count is 50 nT and the noise 30 nT. Without the common
        # mode (four magnetometers are too few for it; or switched off) most
        # first differences are exactly zero, and a clip that went by their
        # median kept only the zeros: the noise came out low and noise alone
        # alarmed.
        rig = Rig(nodes=nodes, mag_common_mode=common_mode)
        rig.array.apply(MagnetometerSettings(n_nodes=nodes, cycle_count=50), T0)
        rig.run(2400)
        assert rig.network.common_mode_applied is False
        assert rig.events() == []
        assert [n.sigma_nt for n in rig.network.nodes.values()] == [pytest.approx(30.0, rel=0.1)] * nodes

    def test_a_pass_four_of_six_magnetometers_see_leaks_into_neither_other(self):
        # Four within a kilometre of the track, two 20 km off. Before the four
        # alarm, the far ones' medians are mostly the pass. The four are left
        # out as soon as one of them scores 3σ (they are within 3 km of each
        # other), and each far one follows the other meanwhile.
        near = [
            _offset(34.85, -82.39, north, east) for north, east in ((-0.5, -0.5), (0.5, 0.5), (-0.5, 0.5), (0.5, -0.5))
        ]
        far = [_offset(34.85, -82.39, 12.0 * (k - 0.5), -22.0 - 3.0 * k) for k in range(2)]
        fleet = [
            {"node_id": f"synth-{name}-{k}", "rx_lat": lat, "rx_lon": lon, "rx_alt_ft": 900.0}
            for name, sites in (("NEAR", near), ("FAR", far))
            for k, (lat, lon) in enumerate(sites)
        ]
        rig = Rig(fleet=fleet)
        centre = SimpleNamespace(lat=34.85, lon=-82.39, alt_m=rig.array.nodes[0].alt_m)
        flyer = straight_pass(centre, cpa_km=0.0, altitude_km=0.3, speed_mps=120, heading_deg=10, t_cpa=T0 + 1100)
        rig.run(1700, [flyer])
        assert rig.network.common_mode_applied is True
        assert sorted(e["host_node_id"] for e in rig.events()) == [f"synth-NEAR-{k}" for k in range(4)]
        assert all(e["truth"]["label"] == "true" for e in rig.events())

    @pytest.mark.parametrize(("n_near", "n_far"), [(4, 2), (5, 2), (6, 2), (5, 1), (6, 1)])
    def test_a_pass_over_a_cluster_leaks_into_no_far_magnetometer(self, n_near, n_far):
        # Four to six magnetometers on a 0.7 km ring under the track, the rest
        # 20 km and more away. A far magnetometer whose median took the
        # cluster's field before it alarmed, or that held its common mode for
        # minutes afterwards, raised an alarm of its own. A lone far one has
        # only the cluster to take its median from: it holds what that had
        # become, and where the hold began and ended its residual stepped by
        # some 26 nT, a box its 32 s windows took for a pass.
        rig = Rig(seed=1, fleet=cluster(n_near, n_far))
        rig.run(1800, [over_the_cluster(rig, seed=1)])
        assert rig.network.common_mode_applied is True
        assert {e["host_node_id"] for e in rig.events()} == {f"synth-NEAR-{k}" for k in range(n_near)}
        assert all(e["truth"]["label"] == "true" for e in rig.events())

    @pytest.mark.parametrize("heading_deg", [20, 140, 260])
    def test_a_close_pass_on_a_young_noise_estimate_is_measured_at_its_best_window(self, heading_deg):
        # Closest approach 400 s in, while the noise estimate rests on some
        # 220 readings (the common mode came in at 120 s, and every estimate
        # started again). A close pass's statistic soon reaches where its
        # tail probability underflows; settled to infinity there, the event's
        # peak stopped following it: 9–10 s early, at τ = 2 s, with a tenth to
        # a third of the field. The peak follows the statistic itself.
        rig = Rig()
        node = rig.array.nodes[2]
        t_cpa = T0 + 400
        fly = straight_pass(node, cpa_km=0.2, altitude_km=0.15, speed_mps=120, heading_deg=heading_deg, t_cpa=t_cpa)
        rig.run(900, [lambda t: fly(t) if abs(t - t_cpa) < 250 else None])
        (event,) = [e for e in rig.events() if e["node_id"] == node.node_id]
        assert abs(event["peak_ms"] / 1000 - t_cpa) <= 3
        assert event["strength_nt"] == pytest.approx(event["truth"]["true_peak_nt"], rel=0.25)

    @pytest.mark.parametrize(("n_near", "seed"), [(4, 6), (5, 1)])
    def test_a_pass_over_a_cluster_in_a_storm_leaks_into_no_far_magnetometer(self, n_near, seed):
        # As above, in a storm's main phase. A far magnetometer must follow
        # the storm through the one other far one while the cluster is left
        # out: holding, it took the storm for a pass.
        rig = Rig(seed=seed, fleet=cluster(n_near, 2))
        rig.array.storm = Storm(start=T0 - 12_000, dst_min_nt=-150.0, pulsation_nt=6.0, seed=seed + 7919)
        rig.run(1800, [over_the_cluster(rig, seed)])
        assert {e["host_node_id"] for e in rig.events()} == {f"synth-NEAR-{k}" for k in range(n_near)}
        assert all(e["truth"]["label"] == "true" for e in rig.events())

    @pytest.mark.parametrize(("seed", "storm"), [(1, False), (5, True)], ids=["quiet", "in-a-storm"])
    def test_a_pass_across_a_ring_raises_no_false_alarm(self, seed, storm):
        # Eight magnetometers on a ring 2 km round the track's middle: the pass
        # reaches every one, and keeps them at or beside an event for minutes.
        # Those beside one took the median of the ones scoring high nearby,
        # which was the same pass on its way, and alarmed on its field there;
        # holding instead, for as long as the events lasted in a storm's main
        # phase, they took in the storm.
        rig = Rig(seed=seed, fleet=ring(2.0, 8))
        if storm:
            rig.array.storm = Storm(start=T0 - 3 * 3600, dst_min_nt=-250.0, pulsation_nt=10.0, seed=seed + 7919)
        rig.run(2200, [across_the_ring(rig, seed)])
        for node in rig.network.nodes.values():
            rig.network._close_event(node, node.last_ms)
        assert [e for e in rig.events() if e["truth"]["label"] == "false"] == []
        assert {e["node_id"] for e in rig.events()} == set(rig.network.nodes)
        card = rig.network.scorecard()
        assert card["passes_detected"] == card["passes"] > 0

    @pytest.mark.parametrize("storm", [False, True])
    def test_a_pass_over_a_dense_core_raises_no_false_alarm(self, storm):
        # The six magnetometers core placement put in the middle of a
        # generated Atlanta fleet, and a pass over one of them on to another
        # 4.9 km off. Three beside the first one's event took their median from
        # the one the pass was coming on to, then from it scoring high, and
        # alarmed at 10–11σ on its field there.
        rig = Rig(seed=9, fleet=ATLANTA_CORE, center=(33.75838186, -84.371755))
        if storm:
            rig.array.storm = Storm(start=T0 - 12_000, dst_min_nt=-250.0, pulsation_nt=10.0, seed=9 + 7919)
        target = next(n for n in rig.array.nodes if n.host_node_id == "synth-ATL-SCAT-0007")
        fly = straight_pass(target, cpa_km=0.1, altitude_km=0.3, speed_mps=120, heading_deg=70, t_cpa=T0 + 1100)
        rig.run(2200, [lambda t: fly(t) if abs(t - T0 - 1100) < 200 else None])
        for node in rig.network.nodes.values():
            rig.network._close_event(node, node.last_ms)
        assert [e for e in rig.events() if e["truth"]["label"] == "false"] == []
        found = {e["host_node_id"][-4:] for e in rig.events()}
        assert {"0007", "0022"} <= found  # the one passed over, and the one it flew on to

    def test_a_hold_begins_a_new_stretch_unless_a_pass_is_being_watched(self):
        # A held common mode is a constant to the windows, but where a hold
        # begins and ends the residual can step: no window spans either. A
        # node at or beside an event goes on watching it: its windows carry on
        # where its hold begins, and begin again only where it ends.
        steady = Steady(_far_apart(6)).run(700)
        for i in range(1, 6):
            steady.open_event(i)
        steady.push()
        assert steady.others_in_median()[0] == 0 and steady.node(0).run == 1  # clear of events: held, anew
        for i in range(1, 6):
            steady.network._close_event(steady.node(i), steady.node(i).last_ms)
        steady.push()
        assert steady.others_in_median()[0] == 5 and steady.node(0).run == 1  # the hold over: anew again
        # Every node at or beside an event: they hold, and watch on.
        steady = Steady(_sites((0.0, 0.0), (0.0, 1.0), (0.0, 2.0), (22.0, 0.0), (22.0, 1.0), (22.0, 2.0))).run(700)
        runs = [steady.node(i).run for i in range(6)]
        steady.open_event(0)
        steady.open_event(3)
        steady.push()
        assert steady.others_in_median() == [0] * 6
        assert [steady.node(i).run for i in range(6)] == [r + 1 for r in runs]

    def test_a_hold_lasts_three_minutes_at_most(self):
        # Then the magnetometer has no common mode it can trust: it is not
        # scored, and no window spans what it held, until it has others again.
        steady = Steady(_far_apart(6)).run(700)
        seconds = []
        for _ in range(200):
            for i in range(1, 6):
                if steady.node(i).event is None:
                    steady.open_event(i)
            steady.push()
            seconds.append((steady.node(0).run, steady.node(0).display[-1][5] is not None))
        # Held from the first second, its windows begun again and scored once
        # the shortest is full; held no more after three minutes.
        assert seconds[:181] == [(k + 1, k + 1 >= sm.SHORTEST) for k in range(181)]
        assert seconds[181:] == [(0, False)] * 19

    def test_an_event_that_can_no_longer_be_followed_closes(self):
        # A magnetometer with an event open, the others all at events of
        # their own: it holds, and after three minutes has no common mode it
        # can trust. Its event closes then, rather than stay open unfollowed
        # and keep the others beside an event, and so holding, in turn.
        steady = Steady(_far_apart(6)).run(700)
        steady.open_event(0)
        steady.node(0).event.peak_end_ms = T0_MS + 10_000_000  # it would not close of itself
        for _ in range(200):
            for i in range(1, 6):
                if steady.node(i).event is None:
                    steady.open_event(i)
            steady.push()
        node = steady.node(0)
        assert node.event is None and node.last_event.event_id == "e0"
        assert node.last_event.end_ms == T0_MS + 1000 * (700 + 181)

    def test_holds_cannot_keep_one_another_going(self):
        # Every magnetometer with an event at once, in a storm: none has another
        # to take its common mode from, so all hold and take in the storm,
        # which keeps their events open, which keeps them holding. A hold
        # lasts three minutes at most, an event that can no longer be followed
        # closes, and then each has the others again and the storm comes out.
        def pulsation(second):
            return 25.0 * math.sin(2 * math.pi * second / 60.0) if second > 600 else 0.0

        steady = Steady(_far_apart(6), noise_nt=15.0).run(900, common=pulsation)
        for i in range(6):
            steady.open_event(i)
        steady.run(200, common=pulsation)
        opened = steady.network._event_seq
        steady.run(600, common=pulsation)
        assert all(n.event is None for n in steady.network.nodes.values())
        assert steady.network._event_seq == opened  # nothing more alarmed
        assert all(n.variance.last(590).min() > 1.0 for n in steady.network.nodes.values())  # nor held

    @pytest.mark.parametrize(("hot", "seconds"), [(3, 1), (4, 600)], ids=["three-for-a-second", "four-for-ten-minutes"])
    def test_magnetometers_scoring_high_together_do_not_lock_the_rest_out_of_a_storm(self, hot, seconds):
        # Six magnetometers 22 km apart, and a storm's 25 nT pulsation, the
        # same at all of them. Some score 3σ at once (noise does, now and
        # then): left out, they leave each of the rest a median of one or two,
        # which still follows the storm. Holding instead, the rest took in the
        # storm, scored high in turn, and all six held for minutes.
        def pulsation(second):
            return 25.0 * math.sin(2 * math.pi * second / 60.0) if second > 600 else 0.0

        steady = Steady(_far_apart(6), noise_nt=15.0).run(900, common=pulsation)
        for _ in range(seconds):
            for i in range(hot):
                steady.node(i).score = sm.HOT_SIGMA
            steady.push(common=pulsation)
        steady.run(2400 - steady.second, common=pulsation)
        assert list(steady.network.events) == []
        assert all(n.variance.last(1500).min() > 1.0 for n in steady.network.nodes.values())  # never held

    @pytest.mark.parametrize("nodes", [6, 7])
    def test_a_storm_at_six_and_seven_magnetometers_raises_nothing(self, nodes):
        # The fewest magnetometers that take the common mode out, three hours
        # into a strong storm's main phase, and two minutes in which all but
        # three of them score 3σ. Holding through those, the three took in
        # the storm's pulsations and alarmed, and the rest after them.
        rig = Rig(nodes=nodes)
        rig.array.storm = Storm(start=T0 - 3 * 3600, dst_min_nt=-250.0, pulsation_nt=10.0, seed=5)
        rig.run(900)
        for _ in range(120):
            for node in list(rig.network.nodes.values())[3:]:
                node.score = sm.HOT_SIGMA
            rig.run(1)
        rig.run(1500)
        assert rig.network.common_mode_applied is True
        assert rig.events() == []
        assert all(n.variance.last(1500).min() > 1.0 for n in rig.network.nodes.values())  # never held


def _watching(clock=None):
    """A network with one magnetometer that can score, for counting passes."""
    network = sm.MagnetometerNetwork(clock=clock or (lambda: T0))
    node = sm.NodeState(node_id="mag-synth-A", host_node_id="synth-A", lat=34.8, lon=-82.3, alt_m=0.0)
    node.offset, node.sigma_nt, node.run = np.zeros(3), 15.0, sm.SHORTEST
    network.nodes[node.node_id] = node
    return network, node


def _event(network, node, label="true", epoch=None, uap_energy=0.0):
    """An event open at the node, labelled as given (uap_energy decides how it
    is labelled when it closes)."""
    node.event = sm.Event(
        event_id=f"e{network._event_seq}", node_id=node.node_id, host_node_id=node.host_node_id, start_ms=T0_MS,
        peak_ms=T0_MS, score_sigma=6.0, strength_nt=40.0, tau_s=8, peak_end_ms=T0_MS, scale_tau=8,
        epoch=network._scores_epoch if epoch is None else epoch, uap_energy=uap_energy,
    )  # fmt: skip
    network._event_seq += 1
    node.event.truth = {"label": label}
    return node.event


class TestPasses:
    def test_a_pass_ends_its_grace_after_its_peak_and_counts_once(self):
        # Up to 40 nT and staying there (a UAP that stops beside it): one pass,
        # over 256 s after the field stopped rising. Then a fall and a rise
        # again: a second pass.
        network, node = _watching()
        fields = [0.0] * 5 + [10.0, 25.0, 40.0] + [40.0] * 400 + [5.0] * 5 + [30.0] * 5
        open_at = []
        for k, field in enumerate(fields):
            network._track_pass(node, T0_MS + 1000 * k, (field, "uap-1", 1.5))
            open_at.append(node.open_pass is not None)
        assert network.passes == 2 and network.passes_detected == 0
        assert open_at.index(True) == 6  # 25 nT: 20 above the floor of 0
        assert open_at[7 + 256] and not open_at[8 + 256]  # 4τ at the longest scale, 64 s
        assert open_at[-1]  # the second pass, rising from the 5 nT floor

    def test_a_field_there_before_it_could_watch_is_not_a_pass(self):
        network, node = _watching()
        for k in range(600):
            network._track_pass(node, T0_MS + 1000 * k, (40.0, "uap-1", 1.5))
        assert (network.passes, node.open_pass) == (0, None)

    def test_only_a_true_event_of_this_scorecard_detects_a_pass(self):
        network, node = _watching()
        clock = iter(range(T0_MS, T0_MS + 10_000_000, 1000))

        def second(field=30.0):
            network._track_pass(node, next(clock), (field, "uap-1", 1.0))

        def labelled(label):
            node.event.truth = {**(node.event.truth or {}), "label": label}

        second(0.0)
        second()
        assert (network.passes, network.passes_detected) == (1, 0)
        node.event = sm.Event(
            event_id="e", node_id=node.node_id, host_node_id="synth-A", start_ms=T0_MS, peak_ms=T0_MS,
            score_sigma=6.0, strength_nt=40.0, tau_s=8, peak_end_ms=T0_MS, scale_tau=8, epoch=network._scores_epoch,
        )  # fmt: skip
        labelled("false")
        second()
        assert network.passes_detected == 0  # a false alarm detects nothing
        labelled("true")
        second()
        assert network.passes_detected == 1
        labelled("false")  # its provisional label turned
        second()
        assert network.passes_detected == 0
        labelled("true")
        second()
        assert network.passes_detected == 1
        network._close_event(node, next(clock))  # its truth carries no UAP energy: it closes false
        assert node.last_event.truth["label"] == "false" and network.passes_detected == 0
        node.event = sm.Event(
            event_id="f", node_id=node.node_id, host_node_id="synth-A", start_ms=T0_MS, peak_ms=T0_MS,
            score_sigma=6.0, strength_nt=40.0, tau_s=8, peak_end_ms=T0_MS, scale_tau=8, epoch=network._scores_epoch - 1,
        )  # fmt: skip
        labelled("true")
        second()
        assert network.passes_detected == 0  # an event from another scorecard

    def test_a_pass_under_way_when_the_scorecard_restarts_is_missed_by_neither(self):
        # The threshold changes while a UAP is closing in and its event is
        # open: the pass belongs to the scorecard before, as the event does.
        # The new one must not count it, as it goes on rising, as one it
        # missed; it counts the next pass, from where the field falls to.
        network, node = _watching()
        clock = iter(range(T0_MS, T0_MS + 10_000_000, 1000))

        def second(field):
            network._track_pass(node, next(clock), (field, "uap-1", 1.0))

        second(0.0)
        _event(network, node)
        second(25.0)
        assert (network.passes, network.passes_detected) == (1, 1)
        network._reset_scores()  # the threshold changed
        for field in (40.0, 60.0, 80.0, 100.0, 60.0, 30.0, 10.0):
            second(field)
        assert (network.passes, network.passes_detected) == (0, 0)
        network._close_event(node, next(clock))
        for field in (5.0, 5.0, 30.0):
            second(field)
        assert (network.passes, network.passes_detected) == (1, 0)

    def test_an_event_open_across_two_passes_detects_both_or_neither(self):
        network, node = _watching()
        clock = iter(range(T0_MS, T0_MS + 10_000_000, 1000))

        def second(field):
            network._track_pass(node, next(clock), (field, "uap-1", 1.0))

        event = _event(network, node)
        second(0.0)
        second(30.0)  # the first pass
        for _ in range(300):
            second(5.0)  # it fades, and its 256 s run out
        second(30.0)  # the second, the event still open
        assert (network.passes, network.passes_detected) == (2, 2)
        event.truth = {"label": "false"}  # its provisional label turned
        second(30.0)
        assert network.passes_detected == 0
        event.truth = {"label": "true"}
        second(30.0)
        assert network.passes_detected == 2
        network._close_event(node, next(clock))  # no UAP energy: it closes false
        assert node.last_event.truth["label"] == "false" and network.passes_detected == 0

    def test_two_uaps_within_the_grace_are_one_pass_and_two_detections(self):
        # The pass is the field's rise at the magnetometer, whichever UAPs make
        # it; each event is a detection of its own.
        network, node = _watching()
        clock = iter(range(T0_MS, T0_MS + 10_000_000, 1000))

        def second(field):
            network._track_pass(node, next(clock), (field, "uap-1", 1.0))

        second(0.0)
        _event(network, node, uap_energy=5.0)
        second(30.0)
        network._close_event(node, next(clock))
        for _ in range(60):
            second(10.0)
        _event(network, node, uap_energy=5.0)
        second(40.0)  # the second UAP: a new peak of the same pass
        network._close_event(node, next(clock))
        assert (network.passes, network.passes_detected, network.true_detections) == (1, 1, 2)

    def test_a_silent_magnetometer_has_no_pass_open(self):
        # No event can open for a pass at a magnetometer that has stopped
        # reporting: it is not "open" while the magnetometer is silent.
        now = [T0]
        network, node = _watching(lambda: now[0])
        network._monotonic = lambda: now[0]
        network._track_pass(node, T0_MS, (0.0, None, None))
        network._track_pass(node, T0_MS + 1000, (30.0, "uap-1", 1.0))
        node.heard_at = T0 + 1
        now[0] = T0 + 5
        assert network.scorecard()["passes_open"] == 1
        now[0] = T0 + 12
        assert network.scorecard()["passes_open"] == 0
        assert network.snapshot(sm.effective_settings({}))["stats"]["passes_open"] == 0

    def test_a_pass_no_event_was_open_for_counts_as_missed(self):
        # 37 nT at 1.5 km, but past at 300 m/s: too brief to reach 5.5σ.
        rig = Rig()
        node = rig.array.nodes[0]
        flyer = straight_pass(node, cpa_km=1.5, altitude_km=0.3, speed_mps=300, heading_deg=60, t_cpa=T0 + 1000)
        rig.run(1400, [flyer])
        assert rig.events() == []
        card = rig.network.scorecard()
        assert (card["passes"], card["passes_detected"], card["passes_open"]) == (1, 0, 0)

    def test_a_pass_counts_as_it_happens(self, close_pass):
        # Counted when its field first reaches pass_min_nt, detected as soon
        # as an event is open, and open until 256 s after its field fades.
        timeline = sorted(close_pass.snapshots.items())
        counted = next(s for s, snap in timeline if snap["stats"]["passes"] == 1)
        detected = next(s for s, snap in timeline if snap["stats"]["passes_detected"] == 1)
        opened = next(s for s, snap in timeline if _target(snap, close_pass.node)["state"] == "alarm")
        assert counted <= opened == detected
        assert close_pass.snapshots[counted]["stats"]["passes_open"] == 1
        assert close_pass.snapshots[counted - 1]["stats"]["passes"] == 0
        closed = next(s for s, snap in timeline if s > detected and snap["stats"]["passes_open"] == 0)
        assert close_pass.snapshots[closed]["stats"]["passes"] == 1
        assert close_pass.snapshots[closed]["stats"]["passes_detected"] == 1
        assert closed - close_pass.t_cpa + T0 > sm.PASS_GRACE_S

    def test_the_truth_of_an_open_event_follows_the_approach(self, close_pass):
        # While the event is open the UAP may still be closing in: the truth
        # shown is provisional and follows it, until the event closes.
        open_truths = [
            (second, _target(snap, close_pass.node)["event"]["truth"])
            for second, snap in sorted(close_pass.snapshots.items())
            if _target(snap, close_pass.node)["state"] == "alarm"
        ]
        assert len(open_truths) > 20
        assert all(truth["provisional"] is True and truth["label"] == "true" for _, truth in open_truths)
        peaks = [truth["true_peak_nt"] for _, truth in open_truths]
        ranges = [truth["slant_range_km"] for _, truth in open_truths]
        # It opened on the way in, a few seconds before closest approach.
        assert open_truths[0][0] < close_pass.t_cpa - T0
        assert peaks == sorted(peaks) and peaks[-1] > 1.5 * peaks[0]
        # The range is the strongest field's, which a dipole puts near, not
        # exactly at, closest approach.
        assert ranges[-1] < ranges[0] and ranges[-1] == pytest.approx(math.hypot(0.7, 0.4), abs=0.03)
        final = close_pass.rig.events()[0]["truth"]
        assert final["provisional"] is False and final["true_peak_nt"] == peaks[-1]


class TestIngest:
    @staticmethod
    def network():
        return sm.MagnetometerNetwork(clock=lambda: T0)

    @staticmethod
    def entry(**fields):
        return {"node_id": "mag-synth-A", "host_node_id": "synth-A", "lat": 34.8, "lon": -82.3, **fields}

    def test_rejects_hosts_that_are_not_synthetic(self):
        network = self.network()
        body = {"nodes": [self.entry(node_id="mag-real-1", host_node_id="nde1234", samples=[[T0_MS, 1.0, 2.0, 3.0]])]}
        result = network.ingest(body, sm.effective_settings({}))
        assert result == {"nodes": 0, "rejected": 1, "samples": 0}
        assert network.nodes == {}

    @pytest.mark.parametrize(
        "fields",
        [{"lat": 95.0}, {"lat": 0.0, "lon": 0.0}, {"node_id": "synth-A"}, {"host_node_id": "nde0001"}],
        ids=["off-the-globe", "null-island", "not-a-magnetometer-id", "not-a-synthetic-host"],
    )
    def test_an_entry_this_server_will_not_publish_is_counted_and_skipped(self, fields):
        result = self.network().ingest({"nodes": [self.entry(**fields)]}, sm.effective_settings({}))
        assert result["rejected"] == 1

    @pytest.mark.parametrize(
        ("body", "fragment"),
        [
            ({"nodes": "all of them"}, "nodes list required"),
            ({"nodes": [{}] * 101}, "at most 100"),
            ({"nodes": ["not a dict"]}, r"nodes\[0\] must be an object"),
            ({"nodes": [{"lat": 34.8, "lon": -82.3, "host_node_id": "synth-A"}]}, r"nodes\[0\].node_id"),
            ({"nodes": [{"node_id": "", "host_node_id": "synth-A", "lat": 34.8, "lon": -82.3}]}, "node_id"),
            ({"nodes": [{"node_id": "mag-" + "x" * 80, "host_node_id": "synth-A", "lat": 1, "lon": 1}]}, "node_id"),
            (
                {"nodes": [{"node_id": "mag-a", "host_node_id": "synth-" + "x" * 80, "lat": 1, "lon": 1}]},
                "host_node_id",
            ),
            (
                {"nodes": [{"node_id": "mag-a", "host_node_id": "synth-a", "lat": 1, "lon": 1}] * 2},
                r"nodes\[1\].node_id repeats nodes\[0\]'s",
            ),
            ({"samples": 5}, r"nodes\[0\].samples must be a list"),
            ({"samples": True}, r"nodes\[0\].samples must be a list"),
            ({"truth": 7}, r"nodes\[0\].truth must be a list"),
            ({"samples": [[T0_MS + k * 1000, 1.0, 2.0, 3.0] for k in range(61)]}, "at most 60 rows"),
            ({"samples": [[T0_MS, 1.0, 2.0]]}, r"samples\[0\] must be \[t_ms, x, y, z\]"),
            ({"samples": [[T0_MS, "x", 2.0, 3.0]]}, r"samples\[0\] reading"),
            ({"samples": [[T0_MS, float("nan"), 2.0, 3.0]]}, "reading"),
            ({"samples": [[T0_MS, 1.0, float("inf"), 3.0]]}, "reading"),
            ({"samples": [[T0_MS, 1.0, 2.0, 2e6]]}, "reading"),
            ({"samples": [[T0_MS + 365 * 86_400_000, 1.0, 2.0, 3.0]]}, "ahead of the server clock"),
            ({"samples": [[10**20, 1.0, 2.0, 3.0]]}, "ahead of the server clock"),
            ({"samples": [[T0_MS - 7_200_000, 1.0, 2.0, 3.0]]}, "s old"),
            ({"samples": [[float(T0_MS), 1.0, 2.0, 3.0]]}, "integer milliseconds"),
            ({"samples": [[True, 1.0, 2.0, 3.0]]}, "integer milliseconds"),
            ({"samples": [[T0_MS, 1.0, 2.0, 3.0], [T0_MS, 1.0, 2.0, 3.0]]}, r"samples\[1\] time repeats"),
            ({"truth": [[T0_MS, 1.0, None, None], [T0_MS, 2.0, None, None]]}, r"truth\[1\] time repeats"),
            ({"samples": [[10**400, 1.0, 2.0, 3.0]]}, "ahead of the server clock"),
            ({"samples": [[T0_MS, 10**400, 2.0, 3.0]]}, "reading"),
            ({"lat": 10**400}, r"nodes\[0\].lat"),
            ({"ts_ms": T0_MS + 301_000}, "ts_ms is 301 s ahead of the server clock"),
            ({"ts_ms": T0_MS - 301_000}, "ts_ms is 301 s behind the server clock"),
            ({"ts_ms": float(T0_MS)}, "ts_ms must be a time in integer milliseconds"),
            ({"ts_ms": T0_MS - 10_000}, "after the push's own ts_ms"),
            ({"truth": [[T0_MS, -1.0, None, None]]}, "uap_nt"),
            ({"truth": [[T0_MS, 1e13, "uap-1", 0.0]]}, "uap_nt"),
            ({"truth": [[T0_MS, 5.0, "x" * 81, 1.0]]}, "object_id"),
            ({"truth": [[T0_MS, 5.0, "uap-1", -1.0]]}, "slant_km"),
            ({"lat": "34.8"}, r"nodes\[0\].lat"),
            ({"lon": True}, r"nodes\[0\].lon"),
            ({"alt_m": 1e9}, "alt_m"),
            ({"sensor": "RM3100"}, "sensor must be an object"),
            ({"sensor": {"noise_nt": -1}}, "sensor.noise_nt"),
            ({"sensor": {"noise_nt": 0}}, "sensor.noise_nt"),
            ({"sensor": {"cycle_count": True}}, "sensor.cycle_count"),
            ({"sensor": {"model": "x" * 41}}, "sensor.model"),
            ({"storm": "yes"}, "storm"),
            ({"uap_moment_am2": -5}, "uap_moment_am2"),
        ],
    )
    def test_a_malformed_push_is_refused_whole_naming_the_field(self, body, fragment):
        # Entry-level fields go into one otherwise good entry, beside a second
        # good one; body-level ones beside a good entry. Nothing is applied.
        if "nodes" not in body:
            entry_keys = {"samples", "truth", "lat", "lon", "alt_m"}
            entry = self.entry(**{k: v for k, v in body.items() if k in entry_keys})
            good = self.entry(node_id="mag-synth-B", host_node_id="synth-B", samples=[[T0_MS, 1.0, 2.0, 3.0]])
            body = {**{k: v for k, v in body.items() if k not in entry_keys}, "nodes": [entry, good]}
        network = self.network()
        with pytest.raises(ValueError, match=fragment):
            network.ingest(body, sm.effective_settings({}))
        assert network.nodes == {}

    def test_a_reading_from_the_future_does_not_freeze_a_magnetometer(self):
        # One reading a year ahead used to be accepted, and every real one
        # after it dropped as a resend. A few seconds of clock skew is fine.
        network = self.network()
        settings = sm.effective_settings({})
        assert network.ingest({"nodes": [self.entry(samples=[[T0_MS, 1.0, 2.0, 3.0]])]}, settings)["samples"] == 1
        with pytest.raises(ValueError, match="ahead"):
            network.ingest({"nodes": [self.entry(samples=[[T0_MS + 31_536_000_000, 1.0, 2.0, 3.0]])]}, settings)
        assert (
            network.ingest({"nodes": [self.entry(samples=[[T0_MS + 3000, 1.0, 2.0, 3.0]])]}, settings)["samples"] == 1
        )
        assert network.nodes["mag-synth-A"].last_ms == T0_MS + 3000

    def test_resent_and_out_of_order_samples_are_ignored(self):
        network = self.network()
        entry = self.entry(samples=[[T0_MS, 1.0, 2.0, 3.0]])
        assert network.ingest({"nodes": [entry]}, sm.effective_settings({}))["samples"] == 1
        entry["samples"] = [[T0_MS, 1.0, 2.0, 3.0], [T0_MS - 1000, 1.0, 2.0, 3.0]]
        assert network.ingest({"nodes": [entry]}, sm.effective_settings({}))["samples"] == 0

    def test_null_lists_and_altitude_read_as_absent(self):
        result = self.network().ingest(
            {"sensor": None, "storm": None, "nodes": [self.entry(samples=None, truth=None, alt_m=None)]},
            sm.effective_settings({}),
        )
        assert result == {"nodes": 1, "rejected": 0, "samples": 0}

    def test_null_sensor_fields_read_as_absent(self):
        network = self.network()
        sensor = {"model": None, "cycle_count": None, "noise_nt": None, "lsb_nt": 13.35}
        network.ingest({"sensor": sensor, "nodes": [self.entry()]}, sm.effective_settings({}))
        assert network.sensor == {"lsb_nt": 13.35}

    def test_readings_are_judged_by_the_push_own_clock(self):
        # ts_ms ten seconds ago: a reading stamped now is 10 s after it, which
        # no fleet sends, though it is the server's own time. Up to 5 s after
        # it is a clock that stepped back between reading and push, and the
        # detector rides over a gap that short.
        network = self.network()
        late = {"ts_ms": T0_MS - 10_000, "nodes": [self.entry(samples=[[T0_MS - 10_500, 1.0, 2.0, 3.0]])]}
        assert network.ingest(late, sm.effective_settings({}))["samples"] == 1
        stepped = {**late, "nodes": [self.entry(samples=[[T0_MS - 5_000, 1.0, 2.0, 3.0]])]}
        assert network.ingest(stepped, sm.effective_settings({}))["samples"] == 1
        with pytest.raises(ValueError, match=r"is 10 s after the push's own ts_ms \(at most 5 s\)"):
            network.ingest({**late, "nodes": [self.entry(samples=[[T0_MS, 1.0, 2.0, 3.0]])]}, sm.effective_settings({}))

    def test_a_push_from_a_clock_ahead_does_not_freeze_the_magnetometers(self):
        # One push from a clock five minutes ahead, which MAX_SKEW_S allows,
        # then the right clock again. Its readings stood as the latest, and
        # every right one after them was taken for a resend, for five minutes.
        rig = Rig().run(900)
        ahead = 299_000

        def from_ahead(payload, t):
            payload["ts_ms"] += ahead
            for entry in payload["nodes"]:
                for row in entry["samples"] + entry["truth"]:
                    row[0] += ahead
            return payload

        rig.transform = from_ahead
        rig.run(1)
        rig.transform = None
        before = {n.node_id: n.samples for n in rig.network.nodes.values()}
        rig.run(10)
        for node in rig.network.nodes.values():
            assert node.samples == before[node.node_id] + 10
            assert node.last_ms == T0_MS + 910_000 and max(row[0] for row in node.display) == node.last_ms
            assert node.run == 10  # a new stretch: no window spans the step
        rig.run(900)
        assert rig.events() == []
        assert {n["state"] for n in rig.snapshot()["nodes"]} <= {"quiet", "elevated"}

    def test_resends_beside_a_new_reading_are_not_a_clock_step(self):
        # After a push it took for lost, the fleet sends its last ten readings
        # again beside a new one: the new one is taken, the rest ignored, and
        # the stretch goes on.
        rig = Rig().run(300)
        runs = {n.node_id: n.run for n in rig.network.nodes.values()}

        def with_backlog(payload, t):
            for entry in payload["nodes"]:
                row = entry["samples"][0]
                entry["samples"] = [[row[0] - 1000 * k, *row[1:]] for k in range(10, 0, -1)] + [row]
            return payload

        rig.transform = with_backlog
        rig.run(1)
        assert all(n.run == runs[n.node_id] + 1 for n in rig.network.nodes.values())

    def test_a_kind_of_fault_is_remembered_once_and_the_kinds_are_capped(self, caplog):
        # The ids a fault names are the fleet's own text, and a log line per id
        # would be a line a second; and what the log remembers cannot grow
        # with what a fleet sends.
        network = self.network()
        for node_id in ("mag-a", "mag-b", "mag-c"):
            body = {"nodes": [{"node_id": node_id, "host_node_id": "synth-a", "lat": 1, "lon": 1}] * 2}
            with pytest.raises(ValueError, match="repeats"):
                network.ingest(body, sm.effective_settings({}))
        assert len([r for r in caplog.records if "Magnetometer push refused" in r.getMessage()]) == 1
        network._refusals_logged = {f"kind {k}" for k in range(sm.REFUSAL_KINDS)}
        with pytest.raises(ValueError):
            network.ingest({"nodes": 5}, sm.effective_settings({}))
        assert len(network._refusals_logged) == sm.REFUSAL_KINDS
        assert len([r for r in caplog.records if "Magnetometer push refused" in r.getMessage()]) == 1

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
        heard = 500.0  # the server's monotonic clock, in seconds
        node.last_ms, node.heard_at = now, heard
        assert network._state(node, heard, 5.5) == "warming_up"
        node.offset = np.zeros(3)
        node.sigma_nt = 15.0
        assert network._state(node, heard, 5.5) == "warming_up"  # the shortest window not yet full
        node.run = sm.SHORTEST
        assert network._state(node, heard, 5.5) == "quiet"
        node.score = 4.0  # within 1.5σ of the threshold
        assert network._state(node, heard, 5.5) == "elevated"
        node.event = sm.Event(
            event_id="e", node_id=node.node_id, host_node_id="synth-A", start_ms=now, peak_ms=now,
            score_sigma=6.0, strength_nt=40.0, tau_s=8,
        )  # fmt: skip
        assert network._state(node, heard, 5.5) == "alarm"
        assert network._state(node, heard + sm.STALE_S + 0.001, 5.5) == "stale"
        # Silence is judged by the server's clock, not the readings' own times.
        node.last_ms = now - 3_600_000
        assert network._state(node, heard, 5.5) == "alarm"

    def test_warming_up_until_the_detector_can_score(self):
        # A static level after 120 readings; a noise estimate at the next :00
        # or :30 with a minute of residual behind it. Not "quiet" before then:
        # the detector is blind.
        rig = Rig()
        states = {}
        for second in range(200):
            rig.run(1)
            states[second] = {n["state"] for n in rig.snapshot()["nodes"]}
        assert states[150] == {"warming_up"} and states[179] == {"warming_up"}
        assert states[180] <= {"quiet", "elevated"}
        assert all(n["sigma_nt"] is not None for n in rig.snapshot()["nodes"])

    def test_the_longest_scale_searched_grows_as_its_windows_fill(self):
        # The residual begins at 119 s; a scale searches once its window of
        # 8τ + 1 readings is full of it, so slow passes go unseen until then.
        rig = Rig()
        longest = {}
        for second in range(700):
            rig.run(1)
            longest[second] = {n["longest_scale_s"] for n in rig.snapshot()["nodes"]}
        assert longest[179] == {None}  # warming up
        assert longest[180] == {4.0}  # 62 readings: τ = 2 and 4 s
        assert longest[246] == {8.0} and longest[247] == {16.0}
        assert longest[630] == {32.0} and longest[631] == {64.0}

    def test_the_snapshot_shows_a_pass_while_it_happens(self, close_pass):
        snapshot = close_pass.snapshots[1120]  # just past closest approach
        nodes = {n["node_id"]: n for n in snapshot["nodes"]}
        target = nodes.pop(close_pass.node.node_id)
        assert target["state"] == "alarm" and target["event"]["active"] is True
        assert "spark" not in target
        assert {n["state"] for n in nodes.values()} <= {"quiet", "elevated"}
        assert snapshot["events"][0]["node_id"] == close_pass.node.node_id and snapshot["events"][0]["active"] is True
        assert snapshot["events"][0]["event_id"] == f"mag-evt-{snapshot['run_id']}-00001"
        assert snapshot["events"][0]["calibrated"] is True
        assert snapshot["detector"]["common_mode_applied"] is True
        assert snapshot["detector"]["false_alarm_model"] == {
            "coefficient": sm.FALSE_ALARM_COEFFICIENT,
            "power": sm.FALSE_ALARM_POWER,
            "calibrated": True,
        }

    def test_the_model_is_calibrated_only_in_the_conditions_it_was_fitted_in(self):
        # Fitted with the common mode subtracted and no storm. Six magnetometers
        # subtract it once they have a static level (120 readings).
        rig = Rig(nodes=6).run(1)
        assert rig.snapshot()["detector"]["false_alarm_model"]["calibrated"] is False
        quiet = rig.run(129).snapshot()["detector"]
        assert quiet["common_mode_applied"] is True and quiet["false_alarm_model"]["calibrated"] is True
        storm = Rig(nodes=6)
        storm.array.storm = Storm(start=T0)
        stormy = storm.run(130).snapshot()["detector"]
        assert stormy["common_mode_applied"] is True and stormy["false_alarm_model"]["calibrated"] is False
        off = Rig(nodes=6, mag_common_mode=False).run(130).snapshot()["detector"]
        assert off["common_mode_applied"] is False and off["false_alarm_model"]["calibrated"] is False

    def test_a_missed_reading_or_a_few_leave_the_model_calibrated(self):
        # One reading in twenty lost, as a busy fleet loses them, and then
        # every other one for twenty seconds: the time between readings is
        # still a second. Smoothed over the last ten or so, one missed reading
        # made it 1.1 s, and the model uncalibrated.
        rig = Rig(nodes=6).run(200)

        def lose_some(payload, t):
            second = round(t - T0)
            if second % 20 == 0 or (500 <= second < 520 and second % 2):
                for entry in payload["nodes"]:
                    entry["samples"], entry["truth"] = [], []
            return payload

        rig.transform = lose_some
        seen = set()
        for _ in range(600):
            detector = rig.run(1).snapshot()["detector"]
            seen.add((detector["reading_period_s"], detector["false_alarm_model"]["calibrated"]))
        assert seen == {(1.0, True)}

    def test_a_fleet_whose_magnetometers_keep_different_times_reads_as_most_do(self):
        # Five of eight read every other second. Taken over the magnetometers
        # reading at each second alone, the time between readings was 2 s and
        # 1 s by turns.
        rig = Rig().run(200)

        def five_every_other_second(payload, t):
            if round(t - T0) % 2:
                for entry in payload["nodes"][:5]:
                    entry["samples"], entry["truth"] = [], []
            return payload

        rig.transform = five_every_other_second
        rig.run(120)
        assert {rig.run(1).snapshot()["detector"]["reading_period_s"] for _ in range(20)} == {2.0}

    def test_near_the_edge_the_model_stays_calibrated_or_not(self):
        # Calibrated within 10 % of a second; once out, from within 5 %: a
        # fleet running near 10 % slow does not flicker in and out.
        rig = Rig(nodes=6).run(200)

        def calibrated_after(period_s):
            detector = rig.run(120, period_s=period_s).snapshot()["detector"]
            assert detector["reading_period_calibrated"] is detector["false_alarm_model"]["calibrated"]
            return detector["false_alarm_model"]["calibrated"]

        assert [calibrated_after(p) for p in (1.08, 1.12, 1.08, 1.04)] == [True, False, False, True]

    @pytest.mark.parametrize(("period_s", "calibrated"), [(1.07, True), (1.12, False)])
    def test_the_first_period_measured_is_judged_by_the_tolerance_itself(self, period_s, calibrated):
        # A fleet steady at 1.07 s from the server's start is as near a second
        # as one that has slowed to it. Judged only by the margin for coming
        # back (5 %), it read uncalibrated for good.
        detector = Rig(nodes=6).run(200, period_s=period_s).snapshot()["detector"]
        assert detector["reading_period_calibrated"] is calibrated
        assert detector["false_alarm_model"]["calibrated"] is calibrated

    def test_a_server_clock_set_back_does_not_hide_silence(self):
        # The server's clock goes back an hour: every push is now an hour
        # ahead of it, and refused. Timed on that clock the silence did not
        # show, and every magnetometer read "quiet" for the hour; on the
        # monotonic clock it is silence.
        rig = Rig(nodes=6)
        rig.network._monotonic = lambda: rig.clock[0]
        rig.run(300)
        rig.network._clock = lambda: rig.clock[0] - 3600.0
        for _ in range(30):
            with pytest.raises(ValueError, match="ahead of the server clock"):
                rig.run(1)
            rig.clock[0] += 1.0
        assert {n["state"] for n in rig.snapshot()["nodes"]} == {"stale"}

    def test_the_detail_window_runs_back_from_the_latest_reading(self):
        # The fleet's clock two minutes behind the server's: its readings carry
        # its own times, and a window back from the server's held none of them.
        rig = Rig(nodes=6)
        rig.network._clock = lambda: rig.clock[0] + 120.0
        rig.run(300)
        node = rig.network.nodes[rig.array.nodes[0].node_id]
        series = rig.network.node_detail(node.node_id, 60, rig.settings)["series"]
        assert len(series["t"]) == 60 and series["t"][-1] == node.last_ms

    def test_scores_below_zero_are_published_as_zero(self):
        network = sm.MagnetometerNetwork(clock=lambda: T0)
        node = sm.NodeState(node_id="mag-synth-A", host_node_id="synth-A", lat=34.8, lon=-82.3, alt_m=0.0)
        node.score = -0.7
        node.display.append((T0_MS, 1.0, 2.0, 3.0, 3.7, -0.7, 20_000.0, -1_000.0, 45_000.0, 49_250.0))
        network.nodes[node.node_id] = node
        settings = sm.effective_settings({})
        assert network.snapshot(settings)["nodes"][0]["score_sigma"] == 0.0
        assert network.node_detail(node.node_id, 600, settings)["series"]["score"] == [0.0]
        assert node.score == -0.7  # the internal value stands

    def test_a_rate_keeps_three_significant_figures(self):
        # 74,000 node-hours without a false alarm: the interval's upper bound
        # is 3.69 / 74,000, not 0.
        network = sm.MagnetometerNetwork(clock=lambda: T0)
        network.exposure_s = 74_000 * 3600.0
        card = network.scorecard()
        assert card["false_alarms_per_node_hour"] == 0.0
        assert card["false_alarms_per_node_hour_ci95"] == [0.0, 4.98e-05]
        network.false_alarms = 7
        assert network.scorecard()["false_alarms_per_node_hour"] == 9.46e-05

    def test_event_ids_differ_between_runs(self):
        first = sm.MagnetometerNetwork(clock=lambda: T0)
        second = sm.MagnetometerNetwork(clock=lambda: T0 + 60)
        assert first.run_id != second.run_id
        assert first.snapshot(sm.effective_settings({}))["run_id"] == first.run_id


# ── Routes ───────────────────────────────────────────────────────────────────


def _payload(seconds=3):
    # Stamped by the real clock: the route's network checks readings against it.
    now = time.time()
    array = MagnetometerArray(
        node_configs=FLEET[:3], center=(34.85, -82.39), seed=4, settings=MagnetometerSettings(n_nodes=3)
    )
    return build_magnetometer_push_payload(
        array, [(int((now - seconds + k) * 1000), array.sample([], now - seconds + k)) for k in range(seconds)]
    )


class TestRoutes:
    def test_push_needs_the_sim_key(self, client):
        assert client.post("/api/sim/magnetometer/push", json=_payload()).status_code == 401
        response = client.post("/api/sim/magnetometer/push", json=_payload(), headers=_KEY)
        assert response.status_code == 200
        assert response.json() == {"status": "ok", "nodes": 3, "rejected": 0, "samples": 9}

    def test_push_rejects_a_malformed_body(self, client, caplog):
        refused = state.sim_magnetometer_push_refused
        assert client.post("/api/sim/magnetometer/push", json={"nodes": 5}, headers=_KEY).status_code == 400
        body = _payload()
        body["nodes"][1]["samples"] = 5
        response = client.post("/api/sim/magnetometer/push", json=body, headers=_KEY)
        assert response.status_code == 400 and "nodes[1].samples" in response.json()["detail"]
        for _ in range(2):
            body = _payload()
            body["nodes"][0]["samples"][0][0] += 3_600_000
            response = client.post("/api/sim/magnetometer/push", json=body, headers=_KEY)
            assert response.status_code == 400 and "after the push's own ts_ms" in response.json()["detail"]
        assert client.get("/api/sim/magnetometers").json()["nodes"] == []
        # Counted, and logged once per kind of fault: the fleet would send
        # the same one every second.
        assert state.sim_magnetometer_push_refused == refused + 4
        logged = [r.getMessage() for r in caplog.records if "Magnetometer push refused" in r.getMessage()]
        assert len(logged) == 3 and "ts_ms" in logged[-1]

    def test_what_the_push_turned_away_is_published(self, client):
        # In the snapshot's detector block: pushes refused whole (readings
        # lost) and entries skipped, since the server started.
        refused, rejected = state.sim_magnetometer_push_refused, state.sim_magnetometer_push_rejected
        client.post("/api/sim/magnetometer/push", json={"nodes": 5}, headers=_KEY)
        skipped = {"nodes": [{"node_id": "mag-x", "host_node_id": "nde0001", "lat": 1, "lon": 1}]}
        client.post("/api/sim/magnetometer/push", json=skipped, headers=_KEY)
        detector = client.get("/api/sim/magnetometers").json()["detector"]
        assert (detector["pushes_refused"], detector["entries_rejected"]) == (refused + 1, rejected + 1)

    @pytest.mark.parametrize("field", ["time", "lat", "reading"])
    def test_a_number_too_large_for_a_float_is_a_400(self, client, field):
        # JSON carries 10**400 as an integer; arithmetic on it overflows.
        big = "1" + "0" * 400
        now_ms = str(int(time.time() * 1000))
        row = {
            "time": f"[{big}, 1.0, 2.0, 3.0]",
            "lat": f"[{now_ms}, 1.0, 2.0, 3.0]",
            "reading": f"[{now_ms}, {big}, 2.0, 3.0]",
        }
        lat = big if field == "lat" else "34.8"
        content = (
            '{"nodes": [{"node_id": "mag-synth-A", "host_node_id": "synth-A", "lat": ' + lat + ', "lon": -82.3, '
            '"samples": [' + row[field] + "]}]}"
        )
        headers = {**_KEY, "Content-Type": "application/json"}
        response = client.post("/api/sim/magnetometer/push", content=content, headers=headers)
        assert response.status_code == 400 and "nodes[0]" in response.json()["detail"]

    def test_a_fleet_clock_ahead_of_the_server_is_judged_by_its_own(self, client):
        # Two minutes ahead, readings and push alike: what the ADS-B push
        # clamps, this one accepts. Ten minutes ahead is a clock to fix.
        body = _payload()
        for entry in body["nodes"]:
            for row in entry["samples"] + entry["truth"]:
                row[0] += 120_000
        body["ts_ms"] += 120_000
        response = client.post("/api/sim/magnetometer/push", json=body, headers=_KEY)
        assert response.status_code == 200 and response.json()["samples"] == 9
        body["ts_ms"] += 480_000
        response = client.post("/api/sim/magnetometer/push", json=body, headers=_KEY)
        assert response.status_code == 400
        assert response.json()["detail"].startswith("ts_ms is 600 s ahead of the server clock")

    def test_a_flyby_overhead_is_accepted_at_full_scale(self, client):
        # The closest flyby there is (straight over, 50 m up) puts 1.6e6 nT
        # of true field on the magnetometer, twice what the sensor can read:
        # the reading clips at its full scale, the truth does not.
        body = _payload(seconds=1)
        entry = body["nodes"][0]
        t_ms = entry["samples"][0][0]
        overhead = dipole_field_nt((0.0, 0.0, -1e9), (0.0, 0.0, 50.0))
        assert math.hypot(*overhead) == pytest.approx(1.6e6)
        entry["samples"] = [[t_ms, 800_000.0, -800_000.0, 800_000.0]]
        entry["truth"] = [[t_ms, math.hypot(*overhead), "uap-00001", 0.05]]
        response = client.post("/api/sim/magnetometer/push", json=body, headers=_KEY)
        assert response.status_code == 200 and response.json()["samples"] == 3

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
        assert node["node_id"].startswith("mag-synth-TEST-") and node["state"] == "warming_up"
        assert "spark" not in node
        assert isinstance(data["run_id"], str) and data["run_id"]
        assert data["settings"]["mag_threshold_sigma"] == sm.SETTINGS_DEFAULTS["mag_threshold_sigma"]
        assert data["sensor"]["model"] == "RM3100"
        assert data["detector"]["scales_s"] == list(sm.SCALES_S)
        assert data["detector"]["common_mode_applied"] is False
        assert data["detector"]["false_alarm_model"]["calibrated"] is False
        assert "false_alarms_per_node_hour" in data["stats"] and data["stats"]["passes_open"] == 0

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
        assert data["stats"]["passes"] == 1 and data["stats"]["passes_open"] == 1
        assert data["detector"]["common_mode_applied"] is True
        assert data["detector"]["false_alarm_model"]["calibrated"] is True
        assert all(n["score_sigma"] >= 0 for n in data["nodes"])
        target = next(n for n in data["nodes"] if n["node_id"] == node.node_id)
        assert target["event"]["active"] is True and target["b_nt"] > 40_000
        assert target["event"]["event_id"].startswith(f"mag-evt-{data['run_id']}-")
        assert target["event"]["calibrated"] is True
        detail = client.get(f"/api/sim/magnetometers/{node.node_id}?window=600")
        assert detail.status_code == 200 and len(detail.json()["series"]["t"]) == 600
        assert detail.json()["sigma_nt"] == round(detail.json()["sigma_nt"], 2) == target["sigma_nt"]
        assert target["score_tau_s"] in (None, *map(float, sm.SCALES_S)) and target["longest_scale_s"] == 64.0
        assert min(detail.json()["series"]["score"]) >= 0

        rig.run(400, [flyer])
        data = client.get("/api/sim/magnetometers").json()
        closed = next(n for n in data["nodes"] if n["node_id"] == node.node_id)["event"]
        assert closed["active"] is False and closed["truth"]["label"] == "true"
        detail = client.get(f"/api/sim/magnetometers/{node.node_id}?window=1800")
        assert detail.status_code == 200 and len(detail.json()["series"]["t"]) == 1520

    @pytest.mark.parametrize("period_s", [1.0, 1.6])
    def test_the_reading_period_is_published(self, client, monkeypatch, period_s):
        # Why the model may not be calibrated: it was fitted to a reading a
        # second, and a fleet that runs slow reads less often.
        detector = client.get("/api/sim/magnetometers").json()["detector"]
        assert detector["reading_period_s"] is None and detector["reading_period_calibrated"] is False
        rig = Rig(nodes=6)
        monkeypatch.setattr(sm, "network", rig.network)
        rig.run(1)
        assert client.get("/api/sim/magnetometers").json()["detector"]["reading_period_s"] is None
        rig.run(200, period_s=period_s)
        detector = client.get("/api/sim/magnetometers").json()["detector"]
        assert detector["reading_period_s"] == period_s
        assert detector["reading_period_calibrated"] is detector["false_alarm_model"]["calibrated"] is (period_s == 1.0)

    def test_detail_and_unknown_node(self, client):
        client.post("/api/sim/magnetometer/push", json=_payload(), headers=_KEY)
        node_id = client.get("/api/sim/magnetometers").json()["nodes"][0]["node_id"]
        detail = client.get(f"/api/sim/magnetometers/{node_id}?window=600")
        assert detail.status_code == 200
        assert set(detail.json()["series"]) == {"t", "x", "y", "z", "residual", "score", "bx", "by", "bz", "b"}
        assert client.get("/api/sim/magnetometers/mag-nope").status_code == 404

    def test_a_warming_up_and_a_warmed_up_magnetometer_both_serve_their_readings(self, client, monkeypatch):
        # Seven magnetometers for ten minutes, then an eighth: its residual and
        # score are gaps (null), not zeros, while its measured field is real.
        rig = Rig()
        rig.array.apply(MagnetometerSettings(n_nodes=7), T0)
        rig.run(600)
        rig.array.apply(MagnetometerSettings(n_nodes=8), rig.clock[0])
        rig.run(30)
        monkeypatch.setattr(sm, "network", rig.network)
        nodes = {n["node_id"]: n for n in client.get("/api/sim/magnetometers").json()["nodes"]}
        new = next(node_id for node_id, n in nodes.items() if n["samples"] == 30)
        old = next(node_id for node_id, n in nodes.items() if n["samples"] == 630)
        assert nodes[new]["state"] == "warming_up" and nodes[new]["residual_nt"] is None
        assert nodes[old]["state"] in ("quiet", "elevated")

        fresh = client.get(f"/api/sim/magnetometers/{new}?window=60").json()["series"]
        assert len(fresh["t"]) == 30
        for key in ("x", "y", "z", "residual", "score"):
            assert fresh[key] == [None] * 30
        for key in ("bx", "by", "bz", "b"):
            assert all(isinstance(v, float) for v in fresh[key])
        assert fresh["b"][-1] == pytest.approx(math.hypot(fresh["bx"][-1], fresh["by"][-1], fresh["bz"][-1]), abs=0.02)
        assert 40_000 < fresh["b"][-1] < 60_000

        warm = client.get(f"/api/sim/magnetometers/{old}?window=300").json()["series"]
        assert len(warm["t"]) == 300
        assert all(
            isinstance(v, float) for key in ("x", "y", "z", "residual", "bx", "by", "bz", "b") for v in warm[key]
        )
        assert all(isinstance(v, float) and v >= 0 for v in warm["score"])
        # Its own first minutes are gaps too: no residual before its static
        # level (119 s), no score before its noise estimate (180 s).
        whole = client.get(f"/api/sim/magnetometers/{old}?window=1800").json()["series"]
        assert whole["residual"][:119] == [None] * 119 and isinstance(whole["residual"][119], float)
        assert whole["score"][:180] == [None] * 180 and isinstance(whole["score"][180], float)

    @pytest.mark.parametrize(("window", "status"), [(59, 422), (60, 200), (1800, 200), (1801, 422)])
    def test_the_detail_window_is_what_is_kept(self, client, window, status):
        # Thirty minutes of history is kept; a longer window would silently
        # come back shorter.
        client.post("/api/sim/magnetometer/push", json=_payload(), headers=_KEY)
        response = client.get(f"/api/sim/magnetometers/mag-synth-TEST-00?window={window}")
        assert response.status_code == status

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
        assert cfg["mag_flyby"]["seq"] == second["seq"] and cfg["_updated_at"] == before
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
