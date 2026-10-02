"""Measure the simulated magnetometer detector: its false alarms in quiet
time, through a storm and across the day, and its detections, how often and
how well measured.

Runs the real code path, with no network in between and no clock to wait
for: the simulator's magnetometers (retina_simulation.magnetometer) produce
readings, and those readings go through services.sim_magnetometer's ingest
exactly as the live route sends them, each push stamped with its simulated
time. Six measurements:

1. **False-alarm rate against threshold.** Networks of magnetometers with no
   UAP anywhere: WMM background, the daily variation, datasheet noise. Every
   event is a false alarm. Reported per node-hour searched (the scorecard's
   exposure: the time the detector could have alarmed, in full six-scale
   searches) with a 95 % Poisson (Garwood) interval, beside the detector's
   model of that rate (sim_magnetometer.false_alarm_rate). The run also fits
   the model's coefficient afresh, which is how FALSE_ALARM_COEFFICIENT was
   set: rerun this after changing the detector, and carry the new
   coefficient over. --near-default-node-hours gives the default threshold
   and the one below it more node-hours than the rest, three times as many
   by default: false alarms there are rare, and the default is chosen
   between them. The model is fitted at --nodes magnetometers; networks of
   other sizes, whose medians are of fewer or more others, are measured
   against it at one low threshold.
2. **A storm through its whole course,** with and without the common-mode
   step, at eight magnetometers and at six and seven, the fewest the common
   mode is subtracted with: the sudden commencement, the main phase down to
   the Dst minimum six hours in, and thirty hours of recovery, each phase on
   its own. This is what subtracting the network's common mode is for.
3. **The daily cycle.** Multi-day networks on seeds of their own, the false
   alarms binned by local solar time at the network's centre (the clock the
   simulated daily variation keeps) and tested against the exposure in each
   bin: χ² over 24 hours, the first four harmonics of the day, and daytime
   against night, all three fixed before any run. Alarms can cluster in
   time, which the textbook distributions of those statistics do not allow
   for, so each p also comes from turning every run's clock by a random
   amount: that keeps any clustering and breaks only the tie to the time of
   day.
4. **Detection probability against distance.** Straight passes of a 1e9 A·m²
   dipole at a range of closest-approach distances and speeds, at the default
   threshold and either side of it, the same passes at each. Each pass has a
   random dipole direction and a random heading, and is found if its
   magnetometer has an event the truth labels true.
5. **How well a detection is measured.** For the passes found: the strength
   against the true peak field, the time of closest approach against the
   truth, and how often the range band holds the true slant range, score by
   score. A strength read just above a threshold reads high (noise helped that
   window over it), so the band depends on the score, and its constants
   (sim_magnetometer.BAND_NEAR and BAND_FAR) are fitted here, on passes at a low
   threshold as well, and checked on passes they were not fitted to.
6. **Dense cores.** Core placement can put two magnetometers within
   EXCLUDE_RADIUS_KM, where one pass is felt at both: passes over generated
   fleets' cores, quiet and in a strong storm, the passes found and the false
   alarms anywhere in the network.

Every threshold runs over the same simulated noise (the same seeds), so the
thresholds are compared on equal terms. Their counts are not independent,
which is why the fit's intervals come from drawing whole seed-days again. The
work is cut into the same jobs whatever --processes says, and everything is
seeded, so a rerun of the same code gives the same numbers. Every number the
documentation quotes comes from one run at the defaults, about an hour and
three quarters on eight processes:

    cd backend && RETINA_ENV=dev .venv/bin/python -m scripts.magnetometer_false_alarms --json magnetometers.json
    cd backend && RETINA_ENV=dev .venv/bin/python -m scripts.magnetometer_false_alarms --quick

Prints a markdown report, with progress on stderr; --json writes the numbers
too. --checkpoint keeps each finished job in a file, so a run that stops can
be started again with the same arguments and carries on where it was. The
simulation does not depend on FALSE_ALARM_COEFFICIENT or the range band's
constants, which only describe its results, so a checkpoint survives a change
to them; any other change to the detector or the simulator makes it stale.
"""

import argparse
import itertools
import json
import math
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass

import numpy as np
from retina_simulation.generator import generate_fleet
from retina_simulation.magnetometer import (
    MagnetometerArray,
    MagnetometerSettings,
    Storm,
    build_magnetometer_push_payload,
    uniform,
)
from scipy import optimize, stats

from services.sim_magnetometer import (
    BAND_FAR,
    BAND_LOWEST_SIGMA,
    BAND_NEAR,
    BAND_POLE_SIGMA,
    COMMON_MODE_MIN_NODES,
    EXCLUDE_RADIUS_KM,
    FALSE_ALARM_COEFFICIENT,
    FALSE_ALARM_POWER,
    SETTINGS_DEFAULTS,
    MagnetometerNetwork,
    band_bounds,
    confidence,
    false_alarm_rate,
    garwood,
    range_band_km,
)

T0 = 1_790_726_400.0  # 2026-09-30T00:00:00Z: a whole day, so the daily variation is in every run
CENTRE = (34.85, -82.39)
DAY_S = 86_400
PASS_ALTITUDE_KM = 0.3
SLANTS_KM = (0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5)
SPEEDS_MPS = (30.0, 100.0, 300.0)
MOMENT_AM2 = 1e9  # the simulator's UAP, and the moment the range band assumes
# The storm begins once every scale is searching (the longest window is first
# full 631 s in), so the detector sees its commencement whole.
STORM_ONSET_S = 1200
STORM_DST_NT = -150.0
# Its phases, in hours from onset. The simulated storm's main phase lasts six
# hours and ends at the Dst minimum (−142 nT, 95 % of dst_min_nt); recovery
# is exponential with a 12 h time constant, so by 36 h Dst is back to a
# twelfth of its minimum.
STORM_PHASES_H = (
    (0.0, 1.0, "commencement"),
    (1.0, 6.0, "main phase, to the Dst minimum"),
    (6.0, 18.0, "recovery, first 12 h"),
    (18.0, 36.0, "recovery, 12 to 30 h"),
)
# The daily cycle's tests, fixed before any run: daytime as the local solar
# hours in which the simulated daily variation is largest, and the harmonics
# it is built from (24, 12, 8 and 6 h).
DAYTIME_H = (6, 18)
HARMONICS = 4
ROTATIONS = 10_000
BOOTSTRAP_DRAWS = 2_000
RANDOM_SEED = 20_261_001  # for the clock rotations and the bootstrap, so they repeat too
# The range band, by score. fit_band chooses, on each side, the constant and the
# slope in 1/(score − BAND_POLE_SIGMA) that keep the band narrowest on average
# while every score bin keeps a given share of its passes inside that side;
# bins with fewer than BAND_MIN_PER_BIN passes are not held to it. The share is
# the smallest of BAND_SIDE_TARGETS at which a band fitted to either half of the
# seeds holds BAND_TARGET of the other half's passes in every score bin: a band
# fitted exactly to its own passes holds fewer of others.
SCORE_BINS = (
    (3.5, 4.0),
    (4.0, 4.5),
    (4.5, 5.0),
    (5.0, 5.5),
    (5.5, 6.0),
    (6.0, 7.0),
    (7.0, 8.0),
    (8.0, 10.0),
    (10.0, 15.0),
    (15.0, 25.0),
    (25.0, 41.0),
)
BAND_TARGET = 0.9
BAND_SIDE_TARGETS = (0.95, 0.96, 0.97, 0.98, 0.99)
BAND_MIN_PER_BIN = 20
# Then the far end moves out in steps of this until every score bin of every
# threshold measured holds BAND_TARGET: the fit pools the thresholds, whose
# bins alone are small, and one of them may fall short of the pool.
BAND_MARGIN_STEP = 0.005
# The band the score-dependent one replaced, for comparison: a strength taken
# as right to within this either way, whatever its score.
FIXED_ALLOWANCE = 0.15
# Scores to break the strength's error down by: a weak detection is one where
# noise helped the statistic over the threshold, and the least-squares fit of
# its strength takes that noise in with the signal.
SCORE_BANDS = ((0.0, 8.0), (8.0, 15.0), (15.0, 41.0))
# Passes for the range band, at a low threshold so that detections just above
# a threshold, where the strength reads high, come in every score from there
# up; at the distances where passes are found only sometimes.
BAND_SLANTS_KM = (1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0)
# Dense cores: core placement puts the magnetometers on the sites nearest the
# fleet's centre, and in a generated fleet two of those can be within
# EXCLUDE_RADIUS_KM, where one pass is felt at both and the common mode's rules
# for a magnetometer at or beside an event come in. Fleets as the /sim map
# generates them, the fewest magnetometers that take the common mode out, and a
# pass over each magnetometer that has a neighbour that close, quiet and in a
# storm stronger than the benchmark's own (Dst −250 nT, pulsations 10 nT, three
# hours into its main phase).
CORE_METROS = ("atl", "chi", "dca", "den", "gvl", "lax")
CORE_FLEET_SEEDS = tuple(range(1, 11))
CORE_FLEET_SIZE, CORE_CLUSTER, CORE_MAGNETOMETERS, CORE_SPEED_MPS = 50, 32, 6, 120.0
SEED_FAR, SEED_STORM, SEED_PASS, SEED_BAND, SEED_DIURNAL = 1000, 2000, 5000, 6000, 7000


def fleet(n: int) -> list[dict]:
    """n radar sites on a jittered grid about 20 km apart around Greenville, SC."""
    side = math.ceil(math.sqrt(n))
    return [
        {
            "node_id": f"synth-BENCH-{i:03d}",
            "rx_lat": CENTRE[0] + 0.18 * (i // side - side / 2) + 0.03 * (uniform(1, "lat", i) - 0.5),
            "rx_lon": CENTRE[1] + 0.22 * (i % side - side / 2) + 0.03 * (uniform(1, "lon", i) - 0.5),
            "rx_alt_ft": 900.0,
        }
        for i in range(n)
    ]


@dataclass
class Obj:
    object_id: str
    lat: float
    lon: float
    alt_km: float


def magnetometers(seed: int, nodes: int) -> MagnetometerArray:
    return MagnetometerArray(
        node_configs=fleet(nodes), center=CENTRE, seed=seed, settings=MagnetometerSettings(n_nodes=nodes)
    )


def run_network(seed, nodes, seconds, threshold, *, storm=None, common_mode=True, passes=(), watch=None, array=None):
    """One network, ``seconds`` long from T0, and every event it raised.

    ``array``: the magnetometers, if not the benchmark's own grid of ``nodes``.
    ``passes``: callables of t giving an Obj, or None while out of range.
    ``watch(t, network)`` runs after every second. Returns the network, with
    its events closed so they are counted; the events in the order they
    opened (the network itself keeps only the latest 500, and a long run at a
    low threshold raises thousands); and the second each one opened, by id.
    """
    clock = [T0]
    # Both of the network's clocks run on simulated time: a job the shared
    # machine stalls for a while must not make its magnetometers look silent.
    network = MagnetometerNetwork(clock=lambda: clock[0], monotonic=lambda: clock[0])
    array = array if array is not None else magnetometers(seed, nodes)
    array.storm = storm
    settings = {**SETTINGS_DEFAULTS, "mag_threshold_sigma": threshold, "mag_common_mode": common_mode}
    events, opened_at = [], {}
    for k in range(seconds):
        t = T0 + k
        clock[0] = t
        objects = [o for o in (fly(t) for fly in passes) if o is not None]
        payload = build_magnetometer_push_payload(array, [(int(t * 1000), array.sample(objects, t))])
        payload["ts_ms"] = int(t * 1000)  # the push's own clock, as the fleet's would be: simulated time here
        network.ingest(payload, settings)
        opened = list(itertools.islice(network.events, network._event_seq - len(events)))
        for event in reversed(opened):
            events.append(event)
            opened_at[event.event_id] = t
        if watch is not None:
            watch(t, network)
    for node in list(network.nodes.values()):
        network._close_event(node, node.last_ms)
    return network, events, opened_at


def counted_false_alarms(network: MagnetometerNetwork, events: list) -> list:
    """The events the scorecard counted as false alarms: closed false under its
    latest configuration (before the common mode comes in, a couple of
    minutes into a run, is another scorecard)."""
    counted = [e for e in events if e.epoch == network._scores_epoch and e.truth["label"] == "false"]
    # Whatever is binned below must add up to the scorecard's own count.
    if len(counted) != network.false_alarms:
        raise RuntimeError(f"{len(counted)} false alarms found, the scorecard counted {network.false_alarms}")
    return counted


class Exposure:
    """The scorecard's exposure, binned second by second (by the time of day,
    or by the phase of a storm): the measurements here need more than its
    total. A restart of the scorecard empties the bins, as it does the total."""

    def __init__(self, bin_of):
        self.bin_of = bin_of
        self.node_hours: Counter = Counter()
        self._epoch = None
        self._seen_s = 0.0

    def __call__(self, t: float, network: MagnetometerNetwork) -> None:
        if network._scores_epoch != self._epoch:
            self._epoch, self._seen_s = network._scores_epoch, 0.0
            self.node_hours.clear()
        self.node_hours[self.bin_of(t)] += (network.exposure_s - self._seen_s) / 3600.0
        self._seen_s = network.exposure_s


def solar_minute(t: float) -> int:
    """The minute of the local solar day at the network's centre, the clock the
    simulated daily variation keeps (sq_variation_nt: UTC + longitude / 15 h)."""
    return int((t / 60.0 + CENTRE[1] * 4.0) % 1440.0)


def storm_phase(age_s: float) -> int | None:
    hours = age_s / 3600.0
    return next((k for k, (start, end, _) in enumerate(STORM_PHASES_H) if start <= hours < end), None)


def pass_flyer(node, cpa_km: float, altitude_km: float, speed_mps: float, heading_deg: float, t_cpa: float, oid: str):
    heading = math.radians(heading_deg)
    along = (math.cos(heading), math.sin(heading))  # north, east
    right = (-math.sin(heading), math.cos(heading))

    def at(t):
        s_km = speed_mps * (t - t_cpa) / 1000.0
        north = right[0] * cpa_km + along[0] * s_km
        east = right[1] * cpa_km + along[1] * s_km
        if math.hypot(north, east) > 60:
            return None
        lat = node.lat + math.degrees(north / 6371.0)
        lon = node.lon + math.degrees(east / (6371.0 * math.cos(math.radians(node.lat))))
        return Obj(oid, lat, lon, node.alt_m / 1000.0 + altitude_km)

    return at


# ── Jobs: one network each, for the pool ─────────────────────────────────────


def far_job(job: dict) -> dict:
    network, events, _ = run_network(job["seed"], job["nodes"], job["seconds"], job["threshold"])
    alarms = counted_false_alarms(network, events)
    return {
        "node_hours": network.exposure_s / 3600.0,
        "false_alarms": len(alarms),
        # The model is calibrated for these conditions, so every alarm here
        # should have opened under them.
        "uncalibrated": sum(not e.calibrated for e in alarms),
        "by_scale": dict(Counter(f"{e.scale_tau:g}" for e in alarms)),
        # How far above the threshold each alarm's peak went: a higher
        # threshold's rate, read off this run's own alarms.
        "peaks": [round(e.score_sigma, 3) for e in alarms if e.score_sigma >= job["threshold"] + 0.5],
        # Where they are rare, each one: when (s into the run), where, at what
        # scale and how strong.
        "alarms": [
            [round(e.peak_ms / 1000.0 - T0), e.node_id, e.scale_tau, round(e.score_sigma, 3)]
            for e in alarms
            if job["threshold"] >= 4.5
        ],
    }


def storm_job(job: dict) -> dict:
    onset = T0 + STORM_ONSET_S
    exposure = Exposure(lambda t: storm_phase(t - onset))
    network, events, _ = run_network(
        job["seed"],
        job["nodes"],
        job["seconds"],
        job["threshold"],
        storm=Storm(start=onset, dst_min_nt=STORM_DST_NT, seed=job["seed"]),
        common_mode=job["common_mode"],
        watch=exposure,
    )
    by_phase = Counter(storm_phase(e.peak_ms / 1000.0 - onset) for e in counted_false_alarms(network, events))
    return {
        "phases": [
            {"node_hours": exposure.node_hours.get(k, 0.0), "false_alarms": by_phase.get(k, 0)}
            for k in range(len(STORM_PHASES_H))
        ],
        "before_onset": {"node_hours": exposure.node_hours.get(None, 0.0), "false_alarms": by_phase.get(None, 0)},
    }


def diurnal_job(job: dict) -> dict:
    exposure = Exposure(solar_minute)
    network, events, _ = run_network(job["seed"], job["nodes"], job["seconds"], job["threshold"], watch=exposure)
    return {
        "node_hours_by_minute": [exposure.node_hours.get(m, 0.0) for m in range(1440)],
        "alarm_minutes": [solar_minute(e.peak_ms / 1000.0) for e in counted_false_alarms(network, events)],
    }


def peak_field_nt(array: MagnetometerArray, index: int, flyer, t_cpa: float, tau_s: float) -> float:
    """The UAP's peak field at the magnetometer, between readings too: the
    readings, and the truth the server keeps, sample it once a second, and a
    fast close pass peaks between two of them. A dipole's field peaks within
    0.8 τ of closest approach: it is at most twice as strong on any bearing as
    on its weakest, and falls as the cube of the distance."""
    times = t_cpa + np.arange(-1.5 * tau_s, 1.5 * tau_s, tau_s / 100.0)
    return max(array.sample([flyer(t)], t)[index]["uap_nt"] for t in times)


def pass_job(job: dict) -> dict:
    seed, nodes = job["seed"], job["nodes"]
    horizontal = math.sqrt(max(job["slant_km"] ** 2 - PASS_ALTITUDE_KM**2, 0.0))
    array = magnetometers(seed, nodes)
    index = seed % nodes
    target = array.nodes[index]
    t_cpa = T0 + 900  # after warm-up and with the longest window full
    heading = 360.0 * uniform(seed, "pd-heading", 0)
    flyer = pass_flyer(target, horizontal, PASS_ALTITUDE_KM, job["speed_mps"], heading, t_cpa, f"uap-{seed}")
    network, events, opened_at = run_network(seed, nodes, 900 + 700, job["threshold"], passes=[flyer])
    tau_s = job["slant_km"] * 1000.0 / job["speed_mps"]
    found = [e for e in events if e.node_id == target.node_id and e.truth["label"] == "true"]
    out = {
        "hit": bool(found),
        "tau_s": tau_s,
        "peak_nt": peak_field_nt(array, index, flyer, t_cpa, tau_s),
        "sampled_peak_nt": max(uap for _, uap, _, _ in network.nodes[target.node_id].truth),
        # A track can cross another magnetometer of the network: a true event
        # there is a detection of the same UAP, a false one would be a leak.
        "true_elsewhere": sum(e.node_id != target.node_id and e.truth["label"] == "true" for e in events),
        "false_elsewhere": sum(e.node_id != target.node_id and e.truth["label"] == "false" for e in events),
    }
    if found:
        # The event the pass is measured by: the strongest, should one pass
        # ever raise two.
        event = max(found, key=lambda e: e.peak_energy)
        out.update(
            events=len(found),
            score_sigma=event.score_sigma,
            strength_nt=event.strength_nt,
            truth_peak_nt=event.truth["true_peak_nt"],
            truth_slant_km=event.truth["slant_range_km"],
            peak_offset_s=event.peak_ms / 1000.0 - t_cpa,
            event_tau_s=event.tau_s,
            # The raw statistic at the peak (the score stops at 40σ) and the
            # scale it came from, in readings: what a band could be built on.
            peak_energy=event.peak_energy,
            scale_tau=event.scale_tau,
            # When the alarm went up and came down, against closest approach.
            opened_s=opened_at[event.event_id] - t_cpa,
            closed_s=event.end_ms / 1000.0 - t_cpa,
        )
    return out


def core_fleet(metro: str, seed: int) -> tuple[list[dict], tuple[float, float]]:
    """A fleet as the /sim map's are generated (scatter layout), and its
    centre as the orchestrator takes it: the mean of the receive sites."""
    fleet = generate_fleet(
        n_nodes=CORE_FLEET_SIZE, seed=seed, use_tower_api=False, n_cluster=CORE_CLUSTER, metro=metro, layout="scatter"
    )
    return fleet, (sum(c["rx_lat"] for c in fleet) / len(fleet), sum(c["rx_lon"] for c in fleet) / len(fleet))


def core_array(metro: str, seed: int) -> MagnetometerArray:
    fleet, centre = core_fleet(metro, seed)
    return MagnetometerArray(
        node_configs=fleet,
        center=centre,
        seed=seed,
        settings=MagnetometerSettings(n_nodes=CORE_MAGNETOMETERS, placement="core"),
    )


def _km(a, b) -> float:
    north = math.radians(a.lat - b.lat) * 6371.0
    east = math.radians(a.lon - b.lon) * 6371.0 * math.cos(math.radians((a.lat + b.lat) / 2.0))
    return math.hypot(north, east)


def dense_targets(metro: str, seed: int) -> list[int]:
    """The magnetometers of this fleet's core that have another within
    EXCLUDE_RADIUS_KM: where a pass is felt at two of them at once."""
    nodes = core_array(metro, seed).nodes
    return [i for i, a in enumerate(nodes) if any(_km(a, b) < EXCLUDE_RADIUS_KM for b in nodes if b is not a)]


def core_job(job: dict) -> dict:
    """One pass over a magnetometer of a dense core, quiet or in a strong
    storm: the passes it found, and false alarms anywhere in the network."""
    seed = job["fleet_seed"]
    array = core_array(job["metro"], seed)
    target = array.nodes[job["target"]]
    k = job["pass_seed"]
    t_cpa = T0 + 1100
    window_s = 200.0  # the UAP is there from 200 s before closest approach to 200 s after
    flyer = pass_flyer(
        target,
        0.1 * (k % 4),
        PASS_ALTITUDE_KM,
        CORE_SPEED_MPS,
        (53 * k + 17) % 360,
        t_cpa,
        f"uap-{job['metro']}-{seed}",
    )

    def windowed(t):
        return flyer(t) if abs(t - t_cpa) <= window_s else None

    storm = Storm(start=T0 - 12_000, dst_min_nt=-250.0, pulsation_nt=10.0, seed=seed + 7919) if job["storm"] else None
    network, events, _ = run_network(
        seed,
        len(array.nodes),
        int(1100 + window_s + 900),
        job["threshold"],
        storm=storm,
        passes=[windowed],
        array=array,
    )
    card = network.scorecard()
    return {
        "found": any(e.node_id == target.node_id and e.truth["label"] == "true" for e in events),
        "true_events": sum(e.truth["label"] == "true" for e in events),
        "false_alarms": [[e.node_id, round(e.score_sigma, 2)] for e in events if e.truth["label"] == "false"],
        "passes": card["passes"],
        "passes_detected": card["passes_detected"],
        "common_mode_applied": network.common_mode_applied,
    }


JOBS = {"far": far_job, "storm": storm_job, "diurnal": diurnal_job, "pd": pass_job, "band": pass_job, "core": core_job}


def run_job(job: dict) -> dict:
    started = time.time()
    result = JOBS[job["kind"]](job)
    return {"job": job, **result, "wall_s": round(time.time() - started, 1)}


def job_key(job: dict) -> str:
    return json.dumps(job, sort_keys=True)


# ── False alarms: the model and its fit ──────────────────────────────────────


def model_weight(rows: list[dict], power: float) -> np.ndarray:
    """Per threshold, the count the model expects per unit of coefficient:
    node-hours · z^power · P(Z > z)."""
    z = np.array([r["threshold"] for r in rows])
    return np.array([r["node_hours"] for r in rows]) * z**power * stats.norm.sf(z)


def fit_coefficient(rows: list[dict]) -> float:
    """Poisson maximum likelihood for A in rate = A · z^power · P(Z > z), over
    every threshold at once. With the shape fixed it has a closed form."""
    return sum(r["false_alarms"] for r in rows) / float(model_weight(rows, FALSE_ALARM_POWER).sum())


def _profile(rows: list[dict], power: float) -> tuple[float, float]:
    """At this exponent: the best coefficient, and the log-likelihood there."""
    weight = model_weight(rows, power)
    counts = np.array([r["false_alarms"] for r in rows])
    coefficient = counts.sum() / weight.sum()
    mu = coefficient * weight
    return coefficient, float(np.sum(counts * np.log(mu) - mu))


def fit_power(rows: list[dict]) -> float:
    """The exponent's maximum likelihood, with the coefficient free too."""
    result = optimize.minimize_scalar(
        lambda p: -_profile(rows, p)[1], bounds=(0.0, 5.0), method="bounded", options={"xatol": 1e-6}
    )
    return float(result.x)


def fit_free_power(rows: list[dict]) -> dict:
    """The fit with the exponent free as well, a check on the model's shape:
    both parameters, and the exponent's 95 % profile-likelihood interval."""
    power = fit_power(rows)
    coefficient, best = _profile(rows, power)

    def outside(p):
        return 2.0 * (best - _profile(rows, p)[1]) - stats.chi2.ppf(0.95, 1)

    low = optimize.brentq(outside, power - 3.0, power) if outside(power - 3.0) > 0 else None
    high = optimize.brentq(outside, power, power + 3.0) if outside(power + 3.0) > 0 else None
    return {"coefficient": coefficient, "power": power, "power_ci95": [low, high]}


def seed_bootstrap(far_results: list[dict], thresholds: list[float], rng) -> dict:
    """Both fits again on seed-days drawn with replacement. Every threshold ran
    over the same seeds, so their counts move together and an interval that
    takes them as independent is too narrow; a seed-day is the independent
    unit. Seeds run only near the default are drawn among themselves, so each
    draw keeps the run's design."""
    seeds = sorted({r["job"]["seed"] for r in far_results})
    row = {s: k for k, s in enumerate(seeds)}
    column = {z: k for k, z in enumerate(thresholds)}
    hours = np.zeros((len(seeds), len(thresholds)))
    counts = np.zeros((len(seeds), len(thresholds)))
    for r in far_results:
        hours[row[r["job"]["seed"]], column[r["job"]["threshold"]]] += r["node_hours"]
        counts[row[r["job"]["seed"]], column[r["job"]["threshold"]]] += r["false_alarms"]
    strata = defaultdict(list)
    for k in range(len(seeds)):
        strata[tuple(hours[k] > 0)].append(k)
    coefficients, powers = [], []
    for _ in range(BOOTSTRAP_DRAWS):
        drawn = np.concatenate([rng.choice(members, size=len(members)) for members in strata.values()])
        rows = [
            {"threshold": z, "node_hours": hours[drawn, j].sum(), "false_alarms": counts[drawn, j].sum()}
            for j, z in enumerate(thresholds)
        ]
        coefficients.append(fit_coefficient(rows))
        powers.append(fit_power(rows))
    return {
        "draws": BOOTSTRAP_DRAWS,
        "coefficient_ci95": [float(x) for x in np.percentile(coefficients, [2.5, 97.5])],
        "power_ci95": [float(x) for x in np.percentile(powers, [2.5, 97.5])],
    }


def poisson_p(k: int, mu: float) -> float:
    """Two-sided exact p of k counts where mu were expected."""
    return float(min(1.0, 2.0 * min(stats.poisson.cdf(k, mu), stats.poisson.sf(k - 1, mu))))


def rate_at(z: float, coefficient: float) -> float:
    """The model's rate per node-hour at z, for a coefficient of choice."""
    return coefficient * z**FALSE_ALARM_POWER * float(stats.norm.sf(z))


# ── The daily cycle ──────────────────────────────────────────────────────────


class DailyCycle:
    """The daily cycle's three statistics, from per-run alarm minutes and
    exposure, for any turn of each run's clock."""

    def __init__(self, runs: list[dict]):
        self.exposure = np.array([r["node_hours_by_minute"] for r in runs])
        self.alarms = [np.array(r["alarm_minutes"], dtype=int) for r in runs]
        minute = np.arange(1440)
        self.daytime = (minute >= DAYTIME_H[0] * 60) & (minute < DAYTIME_H[1] * 60)
        self.phasors = np.exp(2j * np.pi * np.outer(np.arange(1, HARMONICS + 1), minute) / 1440.0)

    def pooled(self, shifts) -> tuple[np.ndarray, np.ndarray]:
        """Alarms and node-hours per minute of the day, every run's clock turned
        by its own shift."""
        counts = np.zeros(1440)
        hours = np.zeros(1440)
        for run_hours, run_alarms, shift in zip(self.exposure, self.alarms, shifts):
            counts += np.bincount((run_alarms + shift) % 1440, minlength=1440)
            hours += np.roll(run_hours, shift)
        return counts, hours

    @staticmethod
    def by_hour(counts, hours) -> tuple[np.ndarray, np.ndarray]:
        observed = counts.reshape(24, 60).sum(axis=1)
        return observed, counts.sum() * hours.reshape(24, 60).sum(axis=1) / hours.sum()

    def chi2(self, counts, hours) -> tuple[float, int]:
        observed, expected = self.by_hour(counts, hours)
        kept = expected > 0
        return float(np.sum((observed[kept] - expected[kept]) ** 2 / expected[kept])), int(kept.sum()) - 1

    def harmonics(self, counts, hours) -> tuple[float, np.ndarray]:
        """Each harmonic of the alarm rate beyond what the exposure alone gives.
        2|C|/n is its depth of modulation, and Σ 2|C|²/n is χ² with two degrees
        of freedom per harmonic under a steady Poisson rate."""
        n = counts.sum()
        c = self.phasors @ counts - n * (self.phasors @ (hours / hours.sum()))
        return float(np.sum(2.0 * np.abs(c) ** 2 / n)), c

    def day_over_night(self, counts, hours) -> float | None:
        day, night = hours[self.daytime].sum(), hours[~self.daytime].sum()
        if day <= 0 or night <= 0 or counts[~self.daytime].sum() == 0:
            return None
        return float((counts[self.daytime].sum() / day) / (counts[~self.daytime].sum() / night))


def daily_cycle(runs: list[dict], rng) -> dict:
    """The three tests of a daily cycle, each with its textbook p and its p
    with every run's clock turned by a random number of minutes."""
    cycle = DailyCycle(runs)
    counts, hours = cycle.pooled(np.zeros(len(runs), dtype=int))
    chi2, dof = cycle.chi2(counts, hours)
    harmonic, c = cycle.harmonics(counts, hours)
    ratio = cycle.day_over_night(counts, hours)
    null = {"chi2": [], "harmonic": [], "ratio": []}
    for _ in range(ROTATIONS):
        turned = cycle.pooled(rng.integers(0, 1440, len(runs)))
        null["chi2"].append(cycle.chi2(*turned)[0])
        null["harmonic"].append(cycle.harmonics(*turned)[0])
        turned_ratio = cycle.day_over_night(*turned)
        null["ratio"].append(abs(math.log(turned_ratio)) if turned_ratio else math.inf)

    def rotated_p(name, value):
        return float((1 + np.sum(np.array(null[name]) >= value)) / (1 + ROTATIONS))

    n = int(counts.sum())
    observed, expected = cycle.by_hour(counts, hours)
    split = None
    if ratio is not None:
        day_count = int(counts[cycle.daytime].sum())
        day_share = float(hours[cycle.daytime].sum() / hours.sum())
        binomial = stats.binomtest(day_count, n, day_share)
        low, high = binomial.proportion_ci(method="exact")

        def ratio_of(p):
            return float((p / (1.0 - p)) * (1.0 - day_share) / day_share) if p < 1 else None

        split = {
            "daytime_h": list(DAYTIME_H),
            "day_alarms": day_count,
            "night_alarms": n - day_count,
            "day_share_of_exposure": day_share,
            "rate_ratio": ratio,
            "rate_ratio_ci95": [ratio_of(low), ratio_of(high)],
            "p": float(binomial.pvalue),
            "p_rotation": rotated_p("ratio", abs(math.log(ratio)) if ratio else math.inf),
        }
    return {
        "runs": len(runs),
        "seeds": [runs[0]["job"]["seed"], runs[-1]["job"]["seed"]],
        "threshold": runs[0]["job"]["threshold"],
        "node_hours": float(hours.sum()),
        "false_alarms": n,
        "clock": f"local solar time at {CENTRE[1]:g}° (UTC {CENTRE[1] / 15.0:+.3f} h)",
        "by_hour": [{"hour": h, "observed": int(observed[h]), "expected": float(expected[h])} for h in range(24)],
        "chi2": {
            "statistic": chi2,
            "dof": dof,
            "p": float(stats.chi2.sf(chi2, dof)),
            "p_rotation": rotated_p("chi2", chi2),
        },
        "harmonics": {
            "periods_h": [24.0 / k for k in range(1, HARMONICS + 1)],
            "depth": [float(2.0 * abs(x) / n) for x in c],
            # The local solar hour of each harmonic's maximum.
            "peak_local_h": [float((np.angle(x) * 24.0 / (2 * np.pi * k)) % (24.0 / k)) for k, x in enumerate(c, 1)],
            "statistic": harmonic,
            "dof": 2 * HARMONICS,
            "p": float(stats.chi2.sf(harmonic, 2 * HARMONICS)),
            "p_rotation": rotated_p("harmonic", harmonic),
        },
        "day_night": split,
        "rotations": ROTATIONS,
    }


# ── Detection and measurement ────────────────────────────────────────────────


def proportion(k: int, n: int) -> dict:
    """k of n, with its exact (Clopper-Pearson) 95 % interval."""
    low, high = stats.binomtest(k, n).proportion_ci(method="exact") if n else (0.0, 1.0)
    return {"k": k, "n": n, "p": k / n if n else None, "ci95": [float(low), float(high)]}


def band_x(p: dict) -> float:
    """A pass found, as the band sees it (sim_magnetometer.BAND_NEAR): the log
    of its strength over the field the dipole gives on its equator at the true
    slant range. The band holds the truth when this lies between its bounds."""
    return math.log(p["strength_nt"] * (p["truth_slant_km"] * 1000.0) ** 3 / (1e-7 * MOMENT_AM2 * 1e9))


def band_slope_term(score: float) -> float:
    return 1.0 / (max(score, BAND_LOWEST_SIGMA) - BAND_POLE_SIGMA)


def fixed_bounds(score: float) -> tuple[float, float]:
    """The bounds, in x, of the band FIXED_ALLOWANCE gave at every score."""
    return -math.log(1.0 + FIXED_ALLOWANCE), math.log(2.0) - math.log(1.0 - FIXED_ALLOWANCE)


def band_coverage(found: list[dict], bounds) -> dict:
    """How often a band, given as its bounds in x for a score, holds the true
    slant range: in all, and score bin by score bin, with how wide it is."""

    def tally(selected):
        held = too_near = 0
        ratios = []
        for p in selected:
            near, far = bounds(p["score_sigma"])
            x = band_x(p)
            held += near <= x <= far
            too_near += x > far  # the strength read high, so the band sits too near
            ratios.append(math.exp((far - near) / 3.0))
        return {
            "holds_truth": proportion(held, len(selected)),
            "too_near": too_near,
            "too_far": len(selected) - held - too_near,
            "far_over_near": quantiles(ratios),
        }

    return {
        "all": tally(found),
        "by_score": {
            f"{low:g}-{high:g}": tally(selected)
            for low, high in SCORE_BINS
            if (selected := [p for p in found if low <= p["score_sigma"] < high])
        },
    }


def fit_band(found: list[dict], side_coverage: float) -> dict:
    """The band's constants from passes found (see SCORE_BINS): for each side,
    a constant and a slope in 1/(score − BAND_POLE_SIGMA). A score bin pools
    every threshold's passes in it: one pass makes a different event at
    another threshold, opened later and peaking elsewhere, and the band must
    hold for all of them, while a bin of one threshold alone is too small to
    hold a share to."""
    x = np.array([band_x(p) for p in found])
    s = np.array([band_slope_term(p["score_sigma"]) for p in found])
    z = np.array([p["score_sigma"] for p in found])
    bins = [members for low, high in SCORE_BINS if (members := (z >= low) & (z < high)).sum() >= BAND_MIN_PER_BIN]
    if not bins:  # too few passes to hold any bin to it (a --quick run): all of them as one
        bins = [np.ones(len(found), dtype=bool)]

    def side(slope, far):
        # The constant that keeps BAND_SIDE_COVERAGE of every bin inside this
        # side, and the band's mean bound with it.
        e = x - slope * s
        constants = []
        for members in bins:
            ordered = np.sort(e[members])
            k = math.ceil(side_coverage * len(ordered))
            constants.append(ordered[k - 1] if far else ordered[len(ordered) - k])
        constant = max(constants) if far else min(constants)
        return constant, float(np.mean(constant + slope * s))

    slopes = np.round(np.arange(-2.0, 6.0 + 1e-9, 0.01), 2)
    far_slope = min(slopes, key=lambda b: side(b, True)[1])
    near_slope = max(slopes, key=lambda b: side(b, False)[1])
    return {
        "near": [float(side(near_slope, False)[0]), float(near_slope)],
        "far": [float(side(far_slope, True)[0]), float(far_slope)],
        "passes": len(found),
        "bins": len(bins),
        "side_coverage": side_coverage,
    }


def fitted_bounds(fit: dict, margin: float = 0.0):
    def bounds(score):
        s = band_slope_term(score)
        return fit["near"][0] + fit["near"][1] * s, fit["far"][0] + margin + fit["far"][1] * s

    return bounds


def worst_threshold_bin(found: list[dict], bounds) -> float | None:
    """The lowest share held in any score bin of any one threshold's passes,
    of those bins with enough passes to say."""
    shares = [
        share
        for t in sorted({p["threshold"] for p in found})
        if (share := worst_bin(band_coverage([p for p in found if p["threshold"] == t], bounds))) is not None
    ]
    return min(shares) if shares else None


def reach_km(cells: list[dict], level: float) -> float | None:
    """The slant range at which the share of passes found falls through
    ``level``, interpolated between distances; None if it does not within
    the grid."""
    cells = sorted(cells, key=lambda c: c["slant_km"])
    for a, b in zip(cells, cells[1:]):
        pa, pb = a["detected"]["p"], b["detected"]["p"]
        if pb < level <= pa:
            return a["slant_km"] + (pa - level) / (pa - pb) * (b["slant_km"] - a["slant_km"])
    return None


def quantiles(values) -> dict | None:
    if len(values) == 0:
        return None
    q = np.percentile(values, [5, 50, 95])
    return {"n": len(values), "p5": float(q[0]), "median": float(q[1]), "p95": float(q[2])}


def measurement(found: list[dict]) -> dict:
    """How well the passes found were measured: the strength against the true
    peak (as the server's truth gives it, once a second, and between
    readings), the time of closest approach, and how often the published range
    band holds the true slant range, beside the fixed band it replaced."""
    for p in found:
        # The bounds must describe the published band itself.
        near, far = range_band_km(p["strength_nt"], MOMENT_AM2, p["score_sigma"])
        if (near <= p["truth_slant_km"] <= far) != (
            band_bounds(p["score_sigma"])[0] <= band_x(p) <= band_bounds(p["score_sigma"])[1]
        ):
            raise RuntimeError("band_x no longer describes sim_magnetometer.range_band_km")
    return {
        "passes": len(found),
        "strength_over_truth": quantiles([p["strength_nt"] / p["truth_peak_nt"] for p in found]),
        "strength_over_peak_between_readings": quantiles([p["strength_nt"] / p["peak_nt"] for p in found]),
        "strength_over_truth_by_score": {
            f"{low:g}-{high:g}": quantiles(
                [p["strength_nt"] / p["truth_peak_nt"] for p in found if low <= p["score_sigma"] < high]
            )
            for low, high in SCORE_BANDS
        },
        "peak_offset_s": quantiles([p["peak_offset_s"] for p in found]),
        "abs_peak_offset_s": quantiles([abs(p["peak_offset_s"]) for p in found]),
        "abs_peak_offset_over_tau": quantiles([abs(p["peak_offset_s"]) / p["tau_s"] for p in found]),
        # The τ an event publishes, a scale of the bank, against the pass's
        # own: closest approach over speed.
        "tau_over_truth": quantiles([p["event_tau_s"] / p["tau_s"] for p in found]),
        "opened_s": quantiles([p["opened_s"] for p in found]),
        "closed_s": quantiles([p["closed_s"] for p in found]),
        "band": band_coverage(found, band_bounds),
        "fixed_band": band_coverage(found, fixed_bounds),
    }


def band_margin(found: list[dict], fit: dict) -> float:
    """How far the fit's far end moves out for every threshold's score bins to
    hold BAND_TARGET (see BAND_MARGIN_STEP)."""
    steps = 0
    while steps < 40:
        worst = worst_threshold_bin(found, fitted_bounds(fit, steps * BAND_MARGIN_STEP))
        if worst is None or worst >= BAND_TARGET:
            break
        steps += 1
    return round(steps * BAND_MARGIN_STEP, 3)


def worst_bin(coverage: dict) -> float | None:
    """The lowest share held in any score bin with enough passes to say."""
    shares = [c["holds_truth"]["p"] for c in coverage["by_score"].values() if c["holds_truth"]["n"] >= BAND_MIN_PER_BIN]
    return min(shares) if shares else None


def band_section(passes: list[dict], default: float) -> dict:
    """The band's fit and its checks, on every pass found: at the low band
    threshold and at each detection threshold, each threshold's score bins
    held on their own. Each half of the seeds is fitted at each side share and
    checked on the other half; the smallest share that holds BAND_TARGET in
    every score bin of both is used for the fit to them all. The published
    band is checked on each threshold's passes."""
    found = [p for p in passes if p["hit"]]
    halves = [p for p in found if p["seed"] % 2 == 0], [p for p in found if p["seed"] % 2 == 1]
    trials = []
    for side in BAND_SIDE_TARGETS if all(halves) else ():
        fits = [fitted_bounds(fit_band(half, side)) for half in halves]
        checks = [band_coverage(other, bounds) for bounds, other in zip(fits, halves[::-1])]
        worst = [worst_bin(check) for check in checks]
        trials.append(
            {
                "side_coverage": side,
                "worst_bin_held_out": worst,
                "all_held_out": [c["all"]["holds_truth"]["p"] for c in checks],
                "held_out": checks,
            }
        )
    chosen = next(
        (
            t["side_coverage"]
            for t in trials
            if all(w is not None and w >= BAND_TARGET for w in t["worst_bin_held_out"])
        ),
        BAND_SIDE_TARGETS[-1],
    )
    return {
        "published": {
            "near": list(BAND_NEAR),
            "far": list(BAND_FAR),
            "pole_sigma": BAND_POLE_SIGMA,
            "lowest_sigma": BAND_LOWEST_SIGMA,
        },
        "side_coverage": chosen,
        "cross_validation": trials,
        "fit": (fit := fit_band(found, chosen) if found else None),
        "far_margin": (margin := band_margin(found, fit) if fit else None),
        "constants": None
        if fit is None
        else {
            # Rounded outwards, so that the band published is never narrower
            # than the one fitted.
            "near": [math.floor(fit["near"][0] * 1000) / 1000, fit["near"][1]],
            "far": [math.ceil((fit["far"][0] + margin) * 1000) / 1000, fit["far"][1]],
        },
        "published_coverage": {
            f"{z:g}": band_coverage(
                [p for p in passes if p["hit"] and p["threshold"] == z and p["kind"] == kind], band_bounds
            )
            for kind, z in sorted({(p["kind"], p["threshold"]) for p in passes})
        },
    }


# ── The run ──────────────────────────────────────────────────────────────────


def build_jobs(args, thresholds: list[float], default: float) -> list[dict]:
    """Every job, in the order to run them: the longest first, so the pool is
    not left waiting on one of them at the end, and the extra days near the
    default last, so that a long run is complete in every other part before
    they start."""

    def days(node_hours):
        return max(1, math.ceil(node_hours / (args.nodes * args.job_s / 3600.0)))

    def far(z, i):
        return {"kind": "far", "seed": SEED_FAR + i, "nodes": args.nodes, "seconds": args.job_s, "threshold": z}

    storms = [
        {
            "kind": "storm",
            "seed": SEED_STORM + i,
            "nodes": nodes,
            "seconds": STORM_ONSET_S + int(args.storm_hours * 3600),
            "threshold": default,
            "common_mode": common_mode,
        }
        for nodes in args.storm_nodes
        for common_mode in (True, False)
        for i in range(args.storm_runs)
    ]
    # On the main size's seeds. fleet() lays six or seven sites out as the
    # first of its eight, so those networks are the eight less a node or two,
    # with the same noise at the rest; twelve is a grid of its own. The storms
    # at each size are the same storms, for the same reason.
    sizes = [
        {"kind": "far", "seed": SEED_FAR + i, "nodes": nodes, "seconds": args.job_s, "threshold": args.size_threshold}
        for nodes in args.sizes
        for i in range(max(1, math.ceil(args.size_node_hours / (nodes * args.job_s / 3600.0))))
    ]
    cycle = [
        {
            "kind": "diurnal",
            "seed": SEED_DIURNAL + i,
            "nodes": args.nodes,
            "seconds": int(args.diurnal_days * DAY_S),
            "threshold": args.diurnal_threshold,
        }
        for i in range(args.diurnal_runs)
    ]
    passes = [
        {"kind": "pd", "seed": SEED_PASS + k, "nodes": args.nodes, "slant_km": s, "speed_mps": v, "threshold": z}
        for z in args.pd_thresholds
        for s in SLANTS_KM
        for v in SPEEDS_MPS
        for k in range(args.passes)
    ]
    passes += [
        {
            "kind": "band",
            "seed": SEED_BAND + k,
            "nodes": args.nodes,
            "slant_km": s,
            "speed_mps": v,
            "threshold": args.band_threshold,
        }
        for s in BAND_SLANTS_KM
        for v in SPEEDS_MPS
        for k in range(args.band_passes)
    ]
    passes += [
        {
            "kind": "core",
            "metro": metro,
            "fleet_seed": seed,
            "target": target,
            "pass_seed": k,
            "storm": storm,
            "nodes": CORE_MAGNETOMETERS,
            "threshold": default,
        }
        for metro in CORE_METROS[: args.core_metros]
        for seed in CORE_FLEET_SEEDS[: args.core_seeds]
        for target in dense_targets(metro, seed)
        for k in (1, 2)
        for storm in (False, True)
    ]
    base = days(args.node_hours)
    near_default = [z for z in thresholds if default - 0.5 <= z <= default]
    extra = [
        far(z, i) for z in near_default for i in range(base, days(max(args.node_hours, args.near_default_node_hours)))
    ]
    long_first = sorted(
        storms + cycle + [far(z, i) for z in thresholds for i in range(base)] + sizes, key=lambda j: -j["seconds"]
    )
    return long_first + passes + extra


def execute(jobs: list[dict], processes: int, checkpoint: str | None, started: float) -> list[dict]:
    """Run the jobs not already in the checkpoint, in the order given, and
    return every job's result in that order: sums then come out the same to
    the last bit however the pool finished them."""
    done = {}
    if checkpoint:
        try:
            with open(checkpoint) as handle:
                for line in handle:
                    if line.strip():
                        result = json.loads(line)
                        done[job_key(result["job"])] = result
        except FileNotFoundError:
            pass
    todo = [job for job in jobs if job_key(job) not in done]
    if len(todo) < len(jobs):
        print(f"{len(jobs) - len(todo)} of {len(jobs)} jobs from {checkpoint}", file=sys.stderr, flush=True)
    log = open(checkpoint, "a") if checkpoint else None  # noqa: SIM115 - appended to for the whole run
    try:
        with ProcessPoolExecutor(max_workers=processes) as pool:
            futures = [pool.submit(run_job, job) for job in todo]
            for count, future in enumerate(as_completed(futures), start=1):
                result = future.result()
                done[job_key(result["job"])] = result
                if log is not None:
                    log.write(json.dumps(result) + "\n")
                    log.flush()
                if count % max(1, len(todo) // 40) == 0 or count == len(todo):
                    print(f"{count}/{len(todo)} jobs, {time.time() - started:.0f} s", file=sys.stderr, flush=True)
    finally:
        if log is not None:
            log.close()
    return [done[job_key(job)] for job in jobs]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--thresholds", default="3.0,3.5,4.0,4.5,5.0,5.5,6.0")
    parser.add_argument("--node-hours", type=float, default=3000.0, help="per threshold, noise only")
    parser.add_argument(
        "--near-default-node-hours",
        type=float,
        default=9200.0,
        help="for the default threshold and the one 0.5σ below it, where false alarms are rare",
    )
    parser.add_argument("--nodes", type=int, default=8)
    parser.add_argument("--storm-runs", type=int, default=8, help="storms, each run through, with and without")
    parser.add_argument("--storm-nodes", default="6,7,8", help="network sizes for the storm")
    parser.add_argument("--sizes", default="6,7,12", help="other network sizes, for the noise-only rate")
    parser.add_argument("--size-node-hours", type=float, default=1000.0, help="per other size")
    parser.add_argument("--size-threshold", type=float, default=3.5, help="low, for alarms enough to compare")
    parser.add_argument("--diurnal-runs", type=int, default=16)
    parser.add_argument("--diurnal-days", type=float, default=2.0, help="per run")
    parser.add_argument("--diurnal-threshold", type=float, default=3.5, help="low, for alarms enough to bin")
    parser.add_argument("--passes", type=int, default=60, help="per distance, speed and threshold")
    parser.add_argument("--band-passes", type=int, default=60, help="per distance and speed, for the range band")
    parser.add_argument("--band-threshold", type=float, default=3.5, help="low, for detections at every score")
    parser.add_argument("--core-metros", type=int, default=len(CORE_METROS), help="metros for the dense cores")
    parser.add_argument("--core-seeds", type=int, default=len(CORE_FLEET_SEEDS), help="fleets per metro")
    parser.add_argument("--pd-thresholds", help="for the passes (default: the default threshold and 0.5σ either side)")
    parser.add_argument("--processes", type=int, default=8)
    parser.add_argument("--checkpoint", help="keep finished jobs in this file, and take any already in it")
    parser.add_argument("--quick", action="store_true", help="a small run to check the script works")
    parser.add_argument("--json", help="also write the numbers here")
    args = parser.parse_args()
    default = float(SETTINGS_DEFAULTS["mag_threshold_sigma"])
    args.job_s, args.storm_hours = DAY_S, STORM_PHASES_H[-1][1]
    args.storm_nodes = [int(n) for n in args.storm_nodes.split(",")] if args.storm_nodes else []
    args.sizes = [int(n) for n in args.sizes.split(",") if int(n) != args.nodes] if args.sizes else []
    if args.quick:
        args.node_hours = args.near_default_node_hours = args.size_node_hours = 40.0
        args.job_s, args.storm_runs, args.storm_hours = 3600, 1, 2.0
        args.diurnal_runs, args.diurnal_days, args.passes = 2, 0.5, 2
        args.band_passes, args.core_metros, args.core_seeds = 2, 1, 3
    if min([args.nodes, *args.storm_nodes, *args.sizes]) < COMMON_MODE_MIN_NODES:
        # The detector leaves the common mode in below this many, which is
        # not what the model was fitted to, nor what the storm runs compare.
        parser.error(
            f"every network needs at least {COMMON_MODE_MIN_NODES}: fewer, and the common mode is not subtracted"
        )
    thresholds = [float(t) for t in args.thresholds.split(",")]
    args.pd_thresholds = (
        [float(t) for t in args.pd_thresholds.split(",")]
        if args.pd_thresholds
        else [default - 0.5, default, default + 0.5]
    )
    if default not in thresholds or default not in args.pd_thresholds:
        parser.error(f"the thresholds must include the default, {default:g}")
    started = time.time()
    results = execute(build_jobs(args, thresholds, default), args.processes, args.checkpoint, started)
    report = analyse(results, args, thresholds, default)
    report["runtime_s"] = round(time.time() - started, 1)
    report["command"] = " ".join(["python -m scripts.magnetometer_false_alarms", *sys.argv[1:]])
    print_report(report)
    if args.json:
        with open(args.json, "w") as handle:
            json.dump(report, handle, indent=1)


def analyse(results: list[dict], args, thresholds: list[float], default: float) -> dict:
    rng = np.random.default_rng(RANDOM_SEED)
    by_kind = defaultdict(list)
    for r in results:
        by_kind[r["job"]["kind"]].append(r)
    # The model's own network size, and the others measured against it.
    other_sizes = [r for r in by_kind["far"] if r["job"]["nodes"] != args.nodes]
    by_kind["far"] = [r for r in by_kind["far"] if r["job"]["nodes"] == args.nodes]
    far_rows = [
        false_alarm_row([r for r in by_kind["far"] if r["job"]["threshold"] == z], thresholds) for z in thresholds
    ]
    coefficient = fit_coefficient(far_rows)
    total = sum(r["false_alarms"] for r in far_rows)
    fit = {
        "thresholds": thresholds,
        "coefficient": coefficient,
        # Poisson on the total, as if the thresholds were independent. They
        # are not: the interval to quote is the seed-days'.
        "coefficient_ci95_poisson": list(garwood(total, float(model_weight(far_rows, FALSE_ALARM_POWER).sum()))),
        "free": fit_free_power(far_rows),
        "bootstrap": seed_bootstrap(by_kind["far"], thresholds, rng),
        # The model the z² replaced: a fixed number of independent looks an
        # hour, P(Z > z) alone, fitted the same way. Measured over predicted,
        # threshold by threshold, shows the shape it misses.
        "fixed_looks": {
            "looks_per_hour": _profile(far_rows, 0.0)[0],
            "measured_over_predicted": {
                f"{r['threshold']:g}": r["false_alarms"] / (_profile(far_rows, 0.0)[0] * float(w))
                for r, w in zip(far_rows, model_weight(far_rows, 0.0))
            },
        },
    }
    for r in far_rows:
        r["fit_model"] = rate_at(r["threshold"], coefficient)
        r["fit_expected"] = r["fit_model"] * r["node_hours"]
        r["fit_p"] = poisson_p(r["false_alarms"], r["fit_expected"])

    passes = [
        {k: r["job"][k] for k in ("kind", "threshold", "slant_km", "speed_mps", "seed")}
        | {k: v for k, v in r.items() if k not in ("job", "wall_s")}
        for r in by_kind["pd"] + by_kind["band"]
    ]
    grid = [p for p in passes if p["kind"] == "pd"]
    detection, reach, accuracy = {}, {}, {}
    for z in args.pd_thresholds if grid else ():
        key = f"{z:g}"
        detection[key] = [
            detection_cell([p for p in grid if p["threshold"] == z and p["slant_km"] == s and p["speed_mps"] == v])
            for s in SLANTS_KM
            for v in SPEEDS_MPS
        ]
        reach[key] = {
            f"{v:g}": {
                "r90_km": reach_km([c for c in detection[key] if c["speed_mps"] == v], 0.9),
                "r50_km": reach_km([c for c in detection[key] if c["speed_mps"] == v], 0.5),
            }
            for v in SPEEDS_MPS
        }
        found = [p for p in grid if p["threshold"] == z and p["hit"]]
        accuracy[key] = measurement(found) | {
            "by_row": {
                f"{s:g}": measurement(row) for s in SLANTS_KM if (row := [p for p in found if p["slant_km"] == s])
            }
        }

    trade_off = []
    for z in (default - 0.5, default, default + 0.5):
        row = next((r for r in far_rows if r["threshold"] == z), None)
        rate = rate_at(z, coefficient)
        trade_off.append(
            {
                "threshold": z,
                "model_per_node_hour": rate,
                "per_day_across_nodes": rate * args.nodes * 24.0,
                "days_between": 1.0 / (rate * args.nodes * 24.0),
                "confidence_at_threshold": math.exp(-rate),
                "measured": None
                if row is None
                else {"false_alarms": row["false_alarms"], "node_hours": row["node_hours"], "ci95": row["ci95"]},
                "detected": None
                if f"{z:g}" not in detection
                else {
                    f"{s:g} km": {
                        f"{c['speed_mps']:g} m/s": c["detected"] for c in detection[f"{z:g}"] if c["slant_km"] == s
                    }
                    for s in (1.0, 1.5)
                },
                "reach": reach.get(f"{z:g}"),
            }
        )

    seconds = Counter()
    for r in results:
        seconds[r["job"]["kind"]] += r["wall_s"]
    return {
        "default_threshold": default,
        "nodes": args.nodes,
        "arguments": {k: v for k, v in vars(args).items() if k not in ("json", "checkpoint", "processes")},
        "seeds": {
            "false_alarms": SEED_FAR,
            "storm": SEED_STORM,
            "passes": SEED_PASS,
            "daily_cycle": SEED_DIURNAL,
            "rotations_and_bootstrap": RANDOM_SEED,
        },
        "job_seconds_by_kind": dict(seconds),
        "model": {
            "coefficient": FALSE_ALARM_COEFFICIENT,
            "power": FALSE_ALARM_POWER,
            "rate_at_default": false_alarm_rate(default),
            "confidence_at_default": confidence(default),
        },
        "fit": fit,
        "false_alarms": far_rows,
        "trade_off": trade_off,
        "storm": [
            rows
            for nodes in args.storm_nodes
            for cm in (True, False)
            if (
                rows := storm_rows(
                    [r for r in by_kind["storm"] if r["job"]["nodes"] == nodes and r["job"]["common_mode"] is cm]
                )
            )
        ],
        "sizes": size_rows(other_sizes, by_kind["far"], coefficient),
        "daily_cycle": daily_cycle(by_kind["diurnal"], rng) if by_kind["diurnal"] else None,
        "detection": detection,
        "reach": reach,
        "accuracy": accuracy,
        "band": band_section(passes, default) if passes else None,
        "core": core_rows(by_kind["core"]),
        "passes": passes,
    }


def false_alarm_row(selected: list[dict], thresholds: list[float]) -> dict:
    z = selected[0]["job"]["threshold"]
    hours = sum(r["node_hours"] for r in selected)
    falses = sum(r["false_alarms"] for r in selected)
    scales = Counter()
    for r in selected:
        scales.update(r["by_scale"])
    return {
        "threshold": z,
        "seeds": [selected[0]["job"]["seed"], selected[-1]["job"]["seed"]],
        "node_hours": hours,
        "false_alarms": falses,
        "far": falses / hours,
        "ci95": list(garwood(falses, hours)),
        "model": false_alarm_rate(z),
        "model_expected": false_alarm_rate(z) * hours,
        "uncalibrated": sum(r["uncalibrated"] for r in selected),
        "by_scale_s": {k: scales[k] for k in sorted(scales, key=float)},
        # Alarms here whose peak passed each higher threshold: that
        # threshold's count, read off this run.
        "peaks_above": {
            f"{above:g}": sum(p >= above for r in selected for p in r["peaks"])
            for above in thresholds
            if above >= z + 0.5
        },
    }


def storm_rows(selected: list[dict]) -> dict | None:
    if not selected:
        return None
    # The storm's north component without its pulsations, to describe each
    # phase: the commencement's rise, then 0.72 · Dst.
    quiet = Storm(start=0.0, dst_min_nt=STORM_DST_NT, pulsation_nt=0.0)
    # An alarm goes in the phase of its peak, the centre of the window that
    # matched best. The long windows that see the commencement's rise are
    # centred up to four minutes before it, so the minutes before onset hold
    # alarms the storm raised, and they count with it.
    before = {
        "phase": "before onset",
        "hours": [-STORM_ONSET_S / 3600.0, 0.0],
        "x_nt": [0.0, 0.0],
        "node_hours": sum(r["before_onset"]["node_hours"] for r in selected),
        "false_alarms": sum(r["before_onset"]["false_alarms"] for r in selected),
    }
    phases = (
        [
            before
            | {
                "far": before["false_alarms"] / before["node_hours"],
                "ci95": list(garwood(before["false_alarms"], before["node_hours"])),
            }
        ]
        if before["node_hours"] > 0
        else []
    )
    for k, (start, end, name) in enumerate(STORM_PHASES_H):
        hours = sum(r["phases"][k]["node_hours"] for r in selected)
        falses = sum(r["phases"][k]["false_alarms"] for r in selected)
        if hours <= 0:
            continue
        x = [quiet(h * 3600.0)[0] for h in np.linspace(start, end, 721)]
        phases.append(
            {
                "phase": name,
                "hours": [start, end],
                "x_nt": [float(min(x)), float(max(x))],
                "node_hours": hours,
                "false_alarms": falses,
                "far": falses / hours,
                "ci95": list(garwood(falses, hours)),
            }
        )
    hours = sum(p["node_hours"] for p in phases)
    falses = sum(p["false_alarms"] for p in phases)
    return {
        "nodes": selected[0]["job"]["nodes"],
        "common_mode": selected[0]["job"]["common_mode"],
        "runs": len(selected),
        "seeds": [selected[0]["job"]["seed"], selected[-1]["job"]["seed"]],
        "node_hours": hours,
        "false_alarms": falses,
        "far": falses / hours,
        "ci95": list(garwood(falses, hours)),
        "phases": phases,
    }


def size_rows(other_sizes: list[dict], main: list[dict], coefficient: float) -> list[dict]:
    """The noise-only rate at other network sizes, against the model fitted at
    the main size, and beside the main size's own count over the same seeds."""
    rows = []
    for nodes in sorted({r["job"]["nodes"] for r in other_sizes}):
        selected = [r for r in other_sizes if r["job"]["nodes"] == nodes]
        z = selected[0]["job"]["threshold"]
        seeds = {r["job"]["seed"] for r in selected}
        paired = [r for r in main if r["job"]["threshold"] == z and r["job"]["seed"] in seeds]
        hours = sum(r["node_hours"] for r in selected)
        falses = sum(r["false_alarms"] for r in selected)
        weight = hours * z**FALSE_ALARM_POWER * float(stats.norm.sf(z))
        rows.append(
            {
                "nodes": nodes,
                "threshold": z,
                "seeds": [min(seeds), max(seeds)],
                "node_hours": hours,
                "false_alarms": falses,
                "far": falses / hours,
                "ci95": list(garwood(falses, hours)),
                "fit_expected": rate_at(z, coefficient) * hours,
                "fit_p": poisson_p(falses, rate_at(z, coefficient) * hours),
                # The coefficient this size alone would fit, with its exact interval.
                "coefficient": falses / weight,
                "coefficient_ci95": list(garwood(falses, weight)),
                "uncalibrated": sum(r["uncalibrated"] for r in selected),
                "main_size_same_seeds": None
                if not paired
                else {
                    "node_hours": sum(r["node_hours"] for r in paired),
                    "false_alarms": sum(r["false_alarms"] for r in paired),
                },
            }
        )
    return rows


def core_rows(results: list[dict]) -> list[dict]:
    """The dense cores, quiet and in the storm: passes found, and false alarms
    anywhere in the network."""
    rows = []
    for storm in (False, True):
        selected = [r for r in results if r["job"]["storm"] is storm]
        if not selected:
            continue
        rows.append(
            {
                "storm": storm,
                "passes": len(selected),
                "fleets": len({(r["job"]["metro"], r["job"]["fleet_seed"]) for r in selected}),
                "magnetometers_over": len(
                    {(r["job"]["metro"], r["job"]["fleet_seed"], r["job"]["target"]) for r in selected}
                ),
                "found": proportion(sum(r["found"] for r in selected), len(selected)),
                "true_events": sum(r["true_events"] for r in selected),
                "false_alarms": sum(len(r["false_alarms"]) for r in selected),
                "passes_with_false_alarms": sum(bool(r["false_alarms"]) for r in selected),
                "false_alarm_fleets": sorted(
                    {f"{r['job']['metro']} {r['job']['fleet_seed']}" for r in selected if r["false_alarms"]}
                ),
                "scorecard_passes": sum(r["passes"] for r in selected),
                "scorecard_passes_detected": sum(r["passes_detected"] for r in selected),
                "common_mode_applied": all(r["common_mode_applied"] for r in selected),
            }
        )
    return rows


def detection_cell(cell: list[dict]) -> dict:
    found = [p for p in cell if p["hit"]]
    return {
        "slant_km": cell[0]["slant_km"],
        "speed_mps": cell[0]["speed_mps"],
        "detected": proportion(len(found), len(cell)),
        "strength_over_truth": quantiles([p["strength_nt"] / p["truth_peak_nt"] for p in found]),
        "abs_peak_offset_s": quantiles([abs(p["peak_offset_s"]) for p in found]),
        "true_elsewhere": sum(p["true_elsewhere"] for p in cell),
        "false_elsewhere": sum(p["false_elsewhere"] for p in cell),
    }


# ── The report ───────────────────────────────────────────────────────────────


def print_report(report):
    default = report["default_threshold"]
    model, fit = report["model"], report["fit"]
    boot, free = fit["bootstrap"], fit["free"]
    print(f"# Magnetometer detector: measured ({report['runtime_s']:.0f} s)\n")
    print(f"`{report['command']}`\n")
    print(
        f"Model: {model['coefficient']:g} · z^{model['power']:g} · P(Z > z) false alarms per node-hour; "
        f"default threshold {default:g}σ.\n"
    )
    print(
        f"Fitted afresh from this run: coefficient **{fit['coefficient']:.1f}** with the exponent at "
        f"{model['power']:g} (95 %: {boot['coefficient_ci95'][0]:.1f}–{boot['coefficient_ci95'][1]:.1f} over seed-days "
        f"drawn again; {fit['coefficient_ci95_poisson'][0]:.1f}–{fit['coefficient_ci95_poisson'][1]:.1f} were the "
        f"thresholds independent). With the exponent free: {free['coefficient']:.1f} · z^{free['power']:.3f} "
        f"(95 %: {_num(free['power_ci95'][0], '.3f')}–{_num(free['power_ci95'][1], '.3f')} by profile likelihood, "
        f"{boot['power_ci95'][0]:.3f}–{boot['power_ci95'][1]:.3f} over seed-days).\n"
    )
    looks = fit["fixed_looks"]
    ratios = ", ".join(f"{z}σ {x:.2f}" for z, x in looks["measured_over_predicted"].items())
    print(
        f"A fixed number of independent looks an hour, fitted the same way ({looks['looks_per_hour']:,.0f} · P(Z > z)), "
        f"measured over predicted: {ratios}.\n"
    )
    print("## False alarms, noise and daily variation only\n")
    print(
        "| Threshold (σ) | Seeds | Node-hours | False alarms | Per node-hour | 95 % interval | Model | Model expects | "
        "Refit expects | p (refit) |"
    )
    print("| ---: | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |")
    for r in report["false_alarms"]:
        print(
            f"| {r['threshold']:g} | {r['seeds'][0]}–{r['seeds'][1]} | {r['node_hours']:,.0f} | {r['false_alarms']:,} | "
            f"{r['far']:.3g} | {r['ci95'][0]:.3g}–{r['ci95'][1]:.3g} | {r['model']:.3g} | "
            f"{r['model_expected']:,.1f} | {r['fit_expected']:,.1f} | {r['fit_p']:.2f} |"
        )
    print("\nBy the time scale that raised them, and how many peaked above each higher threshold:\n")
    for r in report["false_alarms"]:
        scales = ", ".join(f"{k} s {v}" for k, v in r["by_scale_s"].items())
        peaks = ", ".join(f"≥ {k}σ {v}" for k, v in r["peaks_above"].items()) or "—"
        print(f"- {r['threshold']:g}σ: {scales}. Peaks {peaks}. Opened uncalibrated: {r['uncalibrated']}.")

    print(f"\n## The default against its neighbours (model refit; {report['nodes']} magnetometers)\n")
    print("| Threshold | Per node-hour | Per day | One every | Confidence at the threshold | Measured |")
    print("| ---: | ---: | ---: | ---: | ---: | --- |")
    for t in report["trade_off"]:
        m = t["measured"]
        measured = (
            "—"
            if m is None
            else f"{m['false_alarms']} in {m['node_hours']:,.0f} node-h ({m['ci95'][0]:.2g}–{m['ci95'][1]:.2g})"
        )
        print(
            f"| {t['threshold']:g}σ | {t['model_per_node_hour']:.3g} | {t['per_day_across_nodes']:.3g} | "
            f"{_days(t['days_between'])} | {t['confidence_at_threshold']:.5f} | {measured} |"
        )
    print("\n| Found | " + " | ".join(f"{s} at {v:g} m/s" for s in ("1 km", "1.5 km") for v in SPEEDS_MPS) + " |")
    print("| ---: | " + " | ".join("---:" for _ in range(6)) + " |")
    for t in report["trade_off"]:
        if t["detected"] is not None:
            cells = [t["detected"][s][f"{v:g} m/s"] for s in ("1 km", "1.5 km") for v in SPEEDS_MPS]
            print(f"| {t['threshold']:g}σ | " + " | ".join(f"{c['k']}/{c['n']}" for c in cells) + " |")

    if report["sizes"]:
        print("\nOther network sizes, noise only, against the model refit at the main size:\n")
        print(
            "| Magnetometers | Threshold | Node-hours | False alarms | Per node-hour | 95 % interval | Refit expects | "
            "p | Coefficient alone (95 %) | Main size, same seeds |"
        )
        print("| ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- | --- |")
        for r in report["sizes"]:
            main = r["main_size_same_seeds"]
            same = "—" if main is None else f"{main['false_alarms']} in {main['node_hours']:,.0f} node-h"
            print(
                f"| {r['nodes']} | {r['threshold']:g}σ | {r['node_hours']:,.0f} | {r['false_alarms']:,} | "
                f"{r['far']:.3g} | {r['ci95'][0]:.3g}–{r['ci95'][1]:.3g} | {r['fit_expected']:,.1f} | {r['fit_p']:.2f} | "
                f"{r['coefficient']:.0f} ({r['coefficient_ci95'][0]:.0f}–{r['coefficient_ci95'][1]:.0f}) | {same} |"
            )

    print("\n## A storm through its whole course, at the default threshold\n")
    print(
        "| Magnetometers | Common mode | Phase | X, without pulsations (nT) | Node-hours | False alarms | Per node-hour "
        "| 95 % interval |"
    )
    print("| ---: | --- | --- | --- | ---: | ---: | ---: | --- |")
    for s in report["storm"]:
        label = "removed" if s["common_mode"] else "not removed"
        for p in s["phases"]:
            print(
                f"| {s['nodes']} | {label} | {p['phase']} ({p['hours'][0]:.2g}–{p['hours'][1]:.2g} h) | "
                f"{p['x_nt'][0]:.0f} to {p['x_nt'][1]:.0f} | {p['node_hours']:,.0f} | {p['false_alarms']} | "
                f"{p['far']:.3g} | {p['ci95'][0]:.3g}–{p['ci95'][1]:.3g} |"
            )
        print(
            f"| {s['nodes']} | {label} | **whole storm**, {s['runs']} runs | | {s['node_hours']:,.0f} | "
            f"{s['false_alarms']} | {s['far']:.3g} | {s['ci95'][0]:.3g}–{s['ci95'][1]:.3g} |"
        )

    cycle = report["daily_cycle"]
    if cycle:
        print(
            f"\n## The daily cycle at {cycle['threshold']:g}σ ({cycle['runs']} runs, {cycle['node_hours']:,.0f} "
            f"node-hours, {cycle['false_alarms']:,} false alarms; {cycle['clock']})\n"
        )
        chi2, harmonics, split = cycle["chi2"], cycle["harmonics"], cycle["day_night"]
        print(
            f"- χ² over the hours: {chi2['statistic']:.1f} on {chi2['dof']} degrees of freedom, p = {chi2['p']:.3f}; "
            f"with the clocks turned at random, p = {chi2['p_rotation']:.3f}."
        )
        depths = ", ".join(
            f"{period:g} h {100 * depth:.1f} % (highest at {peak:.1f} h)"
            for period, depth, peak in zip(harmonics["periods_h"], harmonics["depth"], harmonics["peak_local_h"])
        )
        print(
            f"- Harmonics of the day: {depths}; together {harmonics['statistic']:.1f} on {harmonics['dof']} degrees "
            f"of freedom, p = {harmonics['p']:.3f}; clocks turned, p = {harmonics['p_rotation']:.3f}."
        )
        if split:
            print(
                f"- Daytime ({split['daytime_h'][0]}–{split['daytime_h'][1]} h) against night: {split['day_alarms']:,} "
                f"against {split['night_alarms']:,} alarms, rate ratio {split['rate_ratio']:.3f} "
                f"({_num(split['rate_ratio_ci95'][0], '.3f')}–{_num(split['rate_ratio_ci95'][1], '.3f')}), "
                f"p = {split['p']:.3f}; clocks turned, p = {split['p_rotation']:.3f}."
            )
        print("\n| Local solar hour | " + " | ".join(str(h["hour"]) for h in cycle["by_hour"]) + " |")
        print("| --- | " + " | ".join("---:" for _ in cycle["by_hour"]) + " |")
        print("| Observed | " + " | ".join(str(h["observed"]) for h in cycle["by_hour"]) + " |")
        print("| Expected | " + " | ".join(f"{h['expected']:.0f}" for h in cycle["by_hour"]) + " |")

    for z, cells in report["detection"].items():
        print(
            f"\n## Detection probability at {z}σ: 1e9 A·m², {PASS_ALTITUDE_KM * 1000:g} m above the sensor, "
            f"{cells[0]['detected']['n']} passes per cell\n"
        )
        print("| Slant range at closest approach | " + " | ".join(f"{v:g} m/s" for v in SPEEDS_MPS) + " |")
        print("| ---: | " + " | ".join("---:" for _ in SPEEDS_MPS) + " |")
        for s in SLANTS_KM:
            row = [next(c for c in cells if c["slant_km"] == s and c["speed_mps"] == v) for v in SPEEDS_MPS]
            print(f"| {s:g} km | " + " | ".join(f"{c['detected']['k']}/{c['detected']['n']}" for c in row) + " |")
        reach = report["reach"][z]
        print(
            "\nSlant range at which 90 % and 50 % are found: "
            + "; ".join(
                f"{v} m/s {_num(r['r90_km'], '.2f')} and {_num(r['r50_km'], '.2f')} km" for v, r in reach.items()
            )
            + f". Events at other magnetometers the tracks crossed: {sum(c['true_elsewhere'] for c in cells)} true, "
            f"{sum(c['false_elsewhere'] for c in cells)} false."
        )

    if f"{default:g}" not in report["accuracy"]:
        return
    accuracy = report["accuracy"][f"{default:g}"]
    print(f"\n## How well a detection is measured, at {default:g}σ ({accuracy['passes']} passes found)\n")
    for name, key in (
        ("Strength ÷ true peak, as the server's truth has it (once a second)", "strength_over_truth"),
        ("Strength ÷ true peak between readings", "strength_over_peak_between_readings"),
        ("Closest approach, event − truth (s)", "peak_offset_s"),
        ("|Closest approach error| ÷ τ", "abs_peak_offset_over_tau"),
        ("Published τ ÷ true τ", "tau_over_truth"),
        ("Alarm up, against closest approach (s)", "opened_s"),
        ("Alarm down, against closest approach (s)", "closed_s"),
    ):
        q = accuracy[key]
        print(f"- {name}: median {q['median']:.3g}, 5–95 % {q['p5']:.3g} to {q['p95']:.3g}.")
    by_score = "; ".join(
        f"{band}σ: {q['median']:.2f} ({q['p5']:.2f}–{q['p95']:.2f}, {q['n']} passes)"
        for band, q in accuracy["strength_over_truth_by_score"].items()
        if q is not None
    )
    print(f"- Strength ÷ truth by score, median (5–95 %): {by_score}.")
    print("\n| Distance | Speed | Found | Strength ÷ truth, median (5–95 %) | abs(time error), median (95 %) |")
    print("| ---: | ---: | ---: | --- | --- |")
    for c in report["detection"][f"{default:g}"]:
        q, t = c["strength_over_truth"], c["abs_peak_offset_s"]
        if q is not None:
            print(
                f"| {c['slant_km']:g} km | {c['speed_mps']:g} m/s | {c['detected']['k']}/{c['detected']['n']} | "
                f"{q['median']:.2f} ({q['p5']:.2f}–{q['p95']:.2f}) | {t['median']:.1f} s ({t['p95']:.1f} s) |"
            )
    band = report["band"]
    if band:
        print_band(band, accuracy, default)
    if report["core"]:
        print_core(report["core"])


def _coverage_cells(coverage: dict) -> str:
    cells = []
    for low, high in SCORE_BINS:
        cell = coverage["by_score"].get(f"{low:g}-{high:g}")
        cells.append("—" if cell is None else f"{100 * cell['holds_truth']['p']:.0f} % ({cell['holds_truth']['n']})")
    held = coverage["all"]["holds_truth"]
    return " | ".join(cells) + f" | {100 * held['p']:.1f} % ({held['n']})"


def print_band(band: dict, accuracy: dict, default: float) -> None:
    print("\n## The range band, by score\n")
    published, fit = band["published"], band["fit"]
    print(
        f"Published: BAND_NEAR = ({published['near'][0]:.3f}, {published['near'][1]:.3f}), "
        f"BAND_FAR = ({published['far'][0]:.3f}, {published['far'][1]:.3f}), "
        f"each over 1/(score − {published['pole_sigma']:g}σ), scores below {published['lowest_sigma']:g}σ as at it."
    )
    for t in band["cross_validation"]:
        worst = " and ".join(_num(w, ".3f") for w in t["worst_bin_held_out"])
        print(
            f"- Fitted at {t['side_coverage']:.0%} a side on one half of the seeds: the worst score bin of the "
            f"other half holds {worst}; all of it {' and '.join(f'{a:.3f}' for a in t['all_held_out'])}."
        )
    if fit:
        constants = band["constants"]
        print(
            f"\nFitted afresh at {band['side_coverage']:.0%} a side ({fit['passes']} passes found, {fit['bins']} score "
            f"bins): near ({fit['near'][0]:.4f}, {fit['near'][1]:.2f}), far ({fit['far'][0]:.4f}, {fit['far'][1]:.2f}); "
            f"the far end out by {band['far_margin']:g} for every threshold's score bins to hold {BAND_TARGET:.0%}. "
            f"Rounded outwards: BAND_NEAR = ({constants['near'][0]:.3f}, {constants['near'][1]:.2f}), "
            f"BAND_FAR = ({constants['far'][0]:.3f}, {constants['far'][1]:.2f})."
        )
    header = " | ".join(f"{low:g}–{high:g}σ" for low, high in SCORE_BINS)
    print("\nShare of passes found whose band holds the true slant range, by score (passes):\n")
    print(f"| Band, passes | {header} | All |")
    print("| --- | " + " | ".join("---:" for _ in SCORE_BINS) + " | ---: |")
    chosen = next((t for t in band["cross_validation"] if t["side_coverage"] == band["side_coverage"]), None)
    if chosen:
        for name, check in zip(("odd seeds, fitted on the even", "even seeds, fitted on the odd"), chosen["held_out"]):
            print(f"| {name} | {_coverage_cells(check)} |")
    for key, coverage in band["published_coverage"].items():
        print(f"| published, found at {key}σ | {_coverage_cells(coverage)} |")
    print(f"| fixed ±{FIXED_ALLOWANCE:.0%}, found at {default:g}σ | {_coverage_cells(accuracy['fixed_band'])} |")
    print("\nThe band's width, far ÷ near, median by score (published, at the default threshold):\n")
    widths = accuracy["band"]["by_score"]
    print(
        "; ".join(
            f"{key}σ {cell['far_over_near']['median']:.2f}" for key, cell in widths.items() if cell["far_over_near"]
        )
        + "."
    )


def print_core(rows: list[dict]) -> None:
    print("\n## Dense cores (core placement, a neighbour within the exclusion radius)\n")
    print("| | Passes | Fleets | Found | False alarms | Passes with one | Their fleets |")
    print("| --- | ---: | ---: | ---: | ---: | ---: | --- |")
    for r in rows:
        found = r["found"]
        print(
            f"| {'storm' if r['storm'] else 'quiet'} | {r['passes']} | {r['fleets']} | {found['k']}/{found['n']} | "
            f"{r['false_alarms']} | {r['passes_with_false_alarms']} | {', '.join(r['false_alarm_fleets']) or '—'} |"
        )


def _num(x, spec: str) -> str:
    return "—" if x is None else format(x, spec)


def _days(days: float) -> str:
    return f"{days:.1f} days" if days < 1000 else f"{days / 365.25:,.0f} years"


if __name__ == "__main__":
    main()
