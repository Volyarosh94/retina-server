"""Detection for the simulated magnetometer network.

The fleet simulator (retina_simulation.magnetometer) pushes one reading per
magnetometer per second. This module turns those readings into detections of
anomalous objects passing a magnetometer, measures how often it raises false
alarms, and keeps what the admin /sim map shows. Simulation only: it is fed by
a route that exists only under SYNTHETIC_FLEET_ENABLED, and nothing on the
radar path reads it.

The method, per second of data
------------------------------
1. **Static level.** Each magnetometer sits in a ~48,600 nT field whose
   value differs by hundreds of nT from site to site. Its static level is the
   trimmed mean (the middle half) of its last 30 minutes, first set once it
   has 120 readings and refreshed every 30 s on the same second at every
   node. What is left is its deviation. A magnetometer the simulator places
   somewhere else, under the same id, starts again from nothing.
2. **Noise.** Each node measures its own noise from the last 10 minutes of
   its residual: the standard deviation of first differences (immune to slow
   drift), outliers clipped (never tighter than the sensor's own noise
   allows), divided by √2, floored at 0.3 × the sensor's datasheet figure.
   The estimate starts again whenever the residual's noise changes: a new
   sensor setting, or the common mode switched in or out. Until it has a
   minute of the new residual the node scores nothing, and until it has ten
   minutes each score allows for an estimate that is less certain
   (settled_energy).
3. **Common mode.** The daily variation, and storms when they come, are the
   same across a 100 km fleet to within a few nT, and at tens to hundreds of
   nT they would swamp a UAP at a single site. Each second, every node's
   deviation has the per-axis median of other nodes' deviations subtracted
   from it. The median, not the mean, so that a UAP near one node does not
   leak into the others; other nodes only, so that a node's own noise and its
   own UAP never pull on its own baseline. A UAP is local (its field falls as
   1/r³), so the others are those that cannot be carrying one: none with an
   event open or scoring HOT_SIGMA, and none within EXCLUDE_RADIUS_KM of
   either. When that leaves no other, a node clear of every event sets a
   score, the weakest evidence, aside first; a node at or beside an event,
   which is measuring a pass, takes clear others only. However few the
   others, the median still follows what the network does, and the score
   allows for the noise a median of few adds (median_variance). With no other
   left, a node holds its own recent common mode, for HOLD_MAX_S at most;
   where a hold ends, and where one clear of every event begins one, no
   window spans the step. A median of a few is not robust while nothing yet
   shows a pass (of two it is their mean, and half of one node's UAP reaches
   the other), so the common mode is subtracted only while at least
   COMMON_MODE_MIN_NODES magnetometers report, with mag_common_mode on.
4. **Matched filter.** A dipole passing on a straight line produces a field
   that, on each axis, is exactly a combination of three Anderson functions
   of u = (t − t0)/τ, with t0 the time of closest approach and τ = distance
   / speed: f_n(u) = uⁿ/(1+u²)^(5/2), n = 0, 1, 2 (Anderson 1949; Sheinker et
   al. 2009; the form used in magnetic anomaly detection). For each of six
   time scales τ = 2…64 s, the residual in a window of ±4τ around a candidate
   t0 is projected onto that three-function space, after removing a constant
   and a slope (whatever the common mode left of slow drift). Under noise
   alone the energy captured, divided by the window's noise variance, is
   chi-square with 9 degrees of freedom (3 functions × 3 axes). That gives
   each window a p-value, expressed as a one-sided Gaussian score in σ. A
   window must lie within one unbroken stretch of readings: a hole of more
   than HOLE_S, a restart of the noise estimate, or the fleet's clock
   stepping back begins a new stretch, and no window at any scale spans it.
5. **Events.** A node alarms when its best score crosses the threshold
   (runtime setting, in σ). The event's peak follows the unclipped statistic
   to the window best matched to the pass. The event closes once its peak's
   scale, and every shorter one, has stayed under the threshold minus one for
   five readings, and the peak's own window has passed. The longer scales are
   left out of that test because a long window goes on seeing a strong pass
   for minutes after it has gone. Afterwards, no window that overlaps the
   event may open another. The event carries the time of closest approach (t0
   at the peak); the pass's own time scale τ and its strength (the fitted
   signal's peak magnitude, in nT), both measured on the peak's window over a
   finer range of τ than the six (refine_pass), since a pass whose τ falls
   between two scales reads up to a quarter weak at either; the score, a
   confidence, and a range band from the strength, the dipole model and the
   score: a strength read just above a threshold reads high, since noise
   helped its window over it, so the band reaches further out the lower the
   score (BAND_NEAR, BAND_FAR).
6. **Scoring.** The simulator sends the truth beside each reading (the UAP
   field at the node and the nearest UAP). It never feeds detection. It labels
   each event true or false (by whether the UAP's own field could have
   contributed to the statistic that fired), so the false-alarm rate is
   measured live, per hour of search, with a confidence interval. It counts
   the significant passes, and how many of them a true event was open for.
   The scorecard describes one configuration, and starts again when the
   threshold, the common mode actually subtracted, the sensor setting or the
   storm changes.

Confidence, in words: the probability that noise alone would not produce an
event at least this strong at this node within an hour. It comes from the
rate at which noise alone reaches a score, fitted to a benchmark of the
detector over thousands of node-hours of simulated noise
(scripts/magnetometer_false_alarms.py; FALSE_ALARM_COEFFICIENT below, and the
design note for the run). That benchmark had the common mode subtracted, no
storm, and a reading a second, so the snapshot says when those conditions
hold ("calibrated").
"""

from __future__ import annotations

import logging
import math
import re
import statistics
import threading
import time
from collections import deque
from dataclasses import dataclass, field

import numpy as np
from scipy import special, stats

from services.geo import valid_latlon
from services.public_location import public_latlon
from services.tcp_handler import is_synthetic_node

log = logging.getLogger(__name__)

# ── Runtime settings (the Physics tab; GET/PUT /api/simulation/config) ────────

SETTINGS_DEFAULTS: dict = {
    # Simulator side: what the fleet places and how its sensors are set.
    "mag_enabled": True,
    "mag_n_nodes": 8,
    "mag_placement": "spread",
    "mag_cycle_count": 200,
    "mag_storm": False,
    # Server side: how the detector decides.
    "mag_threshold_sigma": 5.5,
    "mag_common_mode": True,
}
PLACEMENTS = ("spread", "core", "random")
CYCLE_COUNTS = (50, 100, 200, 400, 800)


def validate_settings(body: dict) -> dict:
    """The mag_* keys of a PUT body, checked. Raises ValueError naming the key."""
    out: dict = {}
    for key in SETTINGS_DEFAULTS:
        if key not in body:
            continue
        v = body[key]
        if key in ("mag_enabled", "mag_storm", "mag_common_mode"):
            if not isinstance(v, bool):
                raise ValueError(f"{key} must be true or false")
        elif key == "mag_n_nodes":
            if isinstance(v, bool) or not isinstance(v, int) or not 0 <= v <= 60:
                raise ValueError(f"{key} must be an integer 0–60")
        elif key == "mag_placement":
            if v not in PLACEMENTS:
                raise ValueError(f"{key} must be one of {', '.join(PLACEMENTS)}")
        elif key == "mag_cycle_count":
            if isinstance(v, bool) or v not in CYCLE_COUNTS:
                raise ValueError(f"{key} must be one of {', '.join(map(str, CYCLE_COUNTS))}")
        elif key == "mag_threshold_sigma":
            if isinstance(v, bool) or not isinstance(v, int | float) or not 3.0 <= v <= 12.0:
                raise ValueError(f"{key} must be 3.0–12.0")
            v = float(v)
        out[key] = v
    return out


def effective_settings(config: dict) -> dict:
    return {key: config.get(key, default) for key, default in SETTINGS_DEFAULTS.items()}


_FLYBY_RANGES = {
    "closest_approach_m": (0.0, 20_000.0, 600.0),
    "altitude_m": (50.0, 15_000.0, 300.0),
    "speed_mps": (5.0, 1_000.0, 120.0),
    "lead_s": (10.0, 600.0, 60.0),
}


def validate_flyby(body: dict) -> dict:
    """A UAP flyby request from the Physics tab, checked. Raises ValueError."""
    out: dict = {}
    node_id = body.get("node_id")
    if node_id is not None and (not isinstance(node_id, str) or not node_id.startswith("mag-") or len(node_id) > 80):
        raise ValueError("node_id must be a magnetometer id (mag-…) or absent for any")
    out["node_id"] = node_id
    for key, (low, high, default) in _FLYBY_RANGES.items():
        v = body.get(key, default)
        if isinstance(v, bool) or not isinstance(v, int | float) or not low <= v <= high:
            raise ValueError(f"{key} must be {low:g}–{high:g}")
        out[key] = float(v)
    heading = body.get("heading_deg")
    if heading is not None and (
        isinstance(heading, bool) or not isinstance(heading, int | float) or not 0 <= heading < 360
    ):
        raise ValueError("heading_deg must be 0–360, or absent for any")
    out["heading_deg"] = None if heading is None else float(heading)
    return out


# ── The push (POST /api/sim/magnetometer/push) ───────────────────────────────
# Everything in a push is checked before any of it is applied, and a body the
# fleet could not have sent is refused whole, naming the field. The bounds are
# what the fleet sends with room to spare, never what it could not: a reading
# stamped in the future would make every later one look like a resend, and
# the work a push costs grows with its rows.

MAX_NODES = 100  # magnetometers per push (the settings allow 60)
# Readings per magnetometer per push. The fleet sends one a second, and after
# a failed push the backlog it holds, at most ten.
MAX_ROWS = 60
MAX_ID_LENGTH = 80
# Times. A push carries its own clock (ts_ms, when the fleet built it), and its
# rows are judged against that: none may be stamped more than ROW_AFTER_PUSH_S
# after it, which is what a single bad row looks like. The push's clock may
# differ from the server's by up to MAX_SKEW_S, as two machines' clocks may.
# Without ts_ms (an older client) the rows are judged against the server's
# clock, with MAX_AHEAD_S for skew.
MAX_SKEW_S = 300.0
# A clock may step back between a reading and its push (a time sync, say). Up
# to HOLE_S that reads as a short gap, which the detector rides over, so the
# push stands; a bigger step costs that push, and the next begins a new
# stretch at every magnetometer (see MagnetometerNetwork.ingest).
ROW_AFTER_PUSH_S = 5.0
MAX_AHEAD_S = 5.0
MAX_AGE_S = 3600.0  # and none older than the hour of residual a node keeps
MAX_READING_NT = 1e6  # per axis: the RM3100's linear range is ±800,000 nT, and the fleet clips to it
# The truth is the world's field, not the sensor's: a 1e9 A·m² dipole flown
# straight over a magnetometer 50 m up (a flyby's closest) puts up to 1.6e6 nT
# on it, and the simulator's 1 m floor on distance caps one UAP at 2e11 nT.
MAX_TRUTH_NT = 1e12
SENSOR_KEYS = ("model", "cycle_count", "noise_nt", "lsb_nt")
DEFAULT_NOISE_NT = 15.0  # the RM3100 at 200 cycles, for a push that does not say
REFUSAL_KINDS = 100  # kinds of refused push the log names, once each


def _check(ok: bool, message: str) -> None:
    if not ok:
        raise ValueError(message)


def _bound(x: float) -> str:
    return f"{x:,.0f}" if abs(x) >= 1000 else f"{x:g}"


def _finite(value) -> bool:
    """A number arithmetic can use. Not a bool, which is an int to Python but
    never a number to the fleet; and not an integer too large for a float,
    which JSON parses happily (10**400) and arithmetic then overflows on."""
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return abs(value) <= 2**53
    return isinstance(value, float) and math.isfinite(value)


def _real(value, where: str, low: float, high: float) -> float:
    _check(_finite(value) and low <= value <= high, f"{where} must be a number {_bound(low)}–{_bound(high)}")
    return float(value)


def _text(value, where: str, longest: int) -> str:
    _check(isinstance(value, str) and 0 < len(value) <= longest, f"{where} must be a string of 1–{longest} characters")
    return value


def _rows(value, where: str) -> list:
    _check(isinstance(value, list) and len(value) <= MAX_ROWS, f"{where} must be a list of at most {MAX_ROWS} rows")
    return value


def _field(body: dict, key: str, default):
    """A field, with null read as absent."""
    value = body.get(key)
    return default if value is None else value


def _seconds(ms: int) -> str:
    # Integer arithmetic until here: a time of 10**400 must not overflow.
    return f"{ms / 1000.0:.3g} s" if abs(ms) < 10**18 else "over 1e15 s"


def _time_ms(value, where: str, clock: tuple[int, int, str]) -> int:
    """A row's time, against the push's clock: (reference ms, how far after it
    a row may be, in ms, and how to say so)."""
    reference_ms, after_ms, after = clock
    _check(isinstance(value, int) and not isinstance(value, bool), f"{where} must be a time in integer milliseconds")
    _check(
        value - reference_ms <= after_ms,
        f"{where} is {_seconds(value - reference_ms)} {after} (at most {_seconds(after_ms)})",
    )
    _check(
        reference_ms - value <= MAX_AGE_S * 1000,
        f"{where} is {_seconds(reference_ms - value)} old (at most {MAX_AGE_S:g} s)",
    )
    return value


def _push_clock(body: dict, now_ms: int) -> tuple[int, int, str]:
    """What the push's rows are judged against: its own ts_ms if it sent one,
    itself within MAX_SKEW_S of the server's clock, or else the server's."""
    ts_ms = body.get("ts_ms")
    if ts_ms is None:
        return now_ms, int(MAX_AHEAD_S * 1000), "ahead of the server clock"
    _check(isinstance(ts_ms, int) and not isinstance(ts_ms, bool), "ts_ms must be a time in integer milliseconds")
    skew_ms = ts_ms - now_ms
    _check(
        abs(skew_ms) <= MAX_SKEW_S * 1000,
        f"ts_ms is {_seconds(abs(skew_ms))} {'ahead of' if skew_ms > 0 else 'behind'} the server clock "
        f"(at most {MAX_SKEW_S:g} s either way)",
    )
    return ts_ms, int(ROW_AFTER_PUSH_S * 1000), "after the push's own ts_ms"


def parse_push(body, now_ms: int) -> dict:
    """A push body, checked field by field. Raises ValueError naming the field.

    Returns the sensor, the UAP moment, the storm flag, and per magnetometer
    its id, host, position, readings [(t_ms, xyz)] in time order and truth
    {t_ms: (uap_nt, object_id, slant_km)}. Whether a well-formed entry is a
    magnetometer this server will publish (a synthetic host, a usable
    position) is decided later, entry by entry.
    """
    _check(isinstance(body, dict), "body must be an object")
    entries = body.get("nodes")
    _check(isinstance(entries, list), "nodes list required")
    _check(len(entries) <= MAX_NODES, f"at most {MAX_NODES} magnetometers per push")
    clock = _push_clock(body, now_ms)
    sensor_in = _field(body, "sensor", {})
    _check(isinstance(sensor_in, dict), "sensor must be an object")
    sensor: dict = {}
    if sensor_in.get("model") is not None:
        sensor["model"] = _text(sensor_in["model"], "sensor.model", 40)
    if sensor_in.get("cycle_count") is not None:
        cycles = sensor_in["cycle_count"]
        _check(
            isinstance(cycles, int) and not isinstance(cycles, bool) and 1 <= cycles <= 65535,
            "sensor.cycle_count must be an integer 1–65535",
        )
        sensor["cycle_count"] = cycles
    for key in ("noise_nt", "lsb_nt"):
        if sensor_in.get(key) is not None:
            sensor[key] = _real(sensor_in[key], f"sensor.{key}", 0.001, 1000.0)
    moment = body.get("uap_moment_am2")
    if moment is not None:
        moment = _real(moment, "uap_moment_am2", 1.0, 1e12)
    storm = _field(body, "storm", False)
    _check(isinstance(storm, bool), "storm must be true or false")
    nodes = []
    seen: dict[str, int] = {}
    for i, entry in enumerate(entries):
        where = f"nodes[{i}]"
        _check(isinstance(entry, dict), f"{where} must be an object")
        node_id = _text(entry.get("node_id"), f"{where}.node_id", MAX_ID_LENGTH)
        # By index, not by id: the id is the fleet's own text, and a message
        # carrying it would be a new kind of fault to the log for every id.
        _check(node_id not in seen, f"{where}.node_id repeats nodes[{seen.get(node_id)}]'s")
        seen[node_id] = i
        # A magnetometer reads once at a time: two rows at one time would be
        # two readings of one instant, and the fleet never sends that.
        samples = {}
        for k, row in enumerate(_rows(_field(entry, "samples", []), f"{where}.samples")):
            at = f"{where}.samples[{k}]"
            _check(isinstance(row, list) and len(row) == 4, f"{at} must be [t_ms, x, y, z]")
            t_ms = _time_ms(row[0], f"{at} time", clock)
            _check(t_ms not in samples, f"{at} time repeats an earlier row's")
            samples[t_ms] = np.array([_real(v, f"{at} reading", -MAX_READING_NT, MAX_READING_NT) for v in row[1:]])
        truth = {}
        for k, row in enumerate(_rows(_field(entry, "truth", []), f"{where}.truth")):
            at = f"{where}.truth[{k}]"
            _check(isinstance(row, list) and len(row) == 4, f"{at} must be [t_ms, uap_nt, object_id, slant_km]")
            t_ms = _time_ms(row[0], f"{at} time", clock)
            _check(t_ms not in truth, f"{at} time repeats an earlier row's")
            uap_nt = _real(row[1], f"{at} uap_nt", 0.0, MAX_TRUTH_NT)
            object_id = None if row[2] is None else _text(row[2], f"{at} object_id", MAX_ID_LENGTH)
            slant_km = None if row[3] is None else _real(row[3], f"{at} slant_km", 0.0, 1e5)
            truth[t_ms] = (uap_nt, object_id, slant_km)
        lat, lon = entry.get("lat"), entry.get("lon")
        _check(_finite(lat), f"{where}.lat must be a number")
        _check(_finite(lon), f"{where}.lon must be a number")
        nodes.append(
            {
                "node_id": node_id,
                "host_node_id": _text(entry.get("host_node_id"), f"{where}.host_node_id", MAX_ID_LENGTH),
                "lat": float(lat),
                "lon": float(lon),
                "alt_m": _real(_field(entry, "alt_m", 0.0), f"{where}.alt_m", -1_000.0, 10_000.0),
                "samples": sorted(samples.items(), key=lambda item: item[0]),
                "truth": truth,
            }
        )
    return {"sensor": sensor, "moment": moment, "storm": storm, "nodes": nodes}


# ── The Anderson basis ───────────────────────────────────────────────────────

SAMPLE_PERIOD_S = 1.0
SCALES_S = (2, 4, 8, 16, 32, 64)
HALF_WINDOW = 4  # ±4τ: f0 is down to 0.1 % of its peak there, f2 to 1 %
DOF = 9  # 3 functions × 3 axes
# An event's τ and strength are measured on its peak's window at τ from an
# octave and a half below the peak's scale to half an octave above, in
# eighth-octave steps (refine_pass). Fitted at the nearest of the six scales,
# a pass whose τ falls between two of them reads 15 % weak in the median, and
# up to 30 %; and a longer window keeps more of a pass's energy (less of it
# goes with the window's constant and slope), so the best of the six can be
# up to three times the pass's own τ, and is seldom much shorter. The
# statistic, and so detection, stays on the six scales.
REFINE_PER_OCTAVE = 8
REFINE_BELOW, REFINE_ABOVE = 12, 4
REFINE_MIN_TAU = 1.0  # readings: nothing shorter can be resolved


def anderson_functions(u: np.ndarray) -> np.ndarray:
    """f0, f1, f2 = uⁿ/(1+u²)^(5/2) as columns."""
    d = (1.0 + u * u) ** 2.5
    return np.column_stack([1.0 / d, u / d, u * u / d])


@dataclass(frozen=True)
class Scale:
    tau_s: float
    length: int  # samples in the window, odd
    detector: np.ndarray  # (3, length): orthonormal, orthogonal to constant and slope
    nuisance: np.ndarray  # (length, 2): orthonormal constant and slope, which the detector ignores
    offsets: np.ndarray  # (length,): readings from the window's centre
    fine_taus: np.ndarray  # (n,): the τ refine_pass tries on this scale's window, in readings
    fine_bases: np.ndarray  # (n, 3, length): each one's functions, orthonormal and clear of constant and slope


def _make_scale(tau_s: float) -> Scale:
    half = int(round(HALF_WINDOW * tau_s / SAMPLE_PERIOD_S))
    offsets = np.arange(-half, half + 1) * SAMPLE_PERIOD_S
    u = offsets / tau_s
    functions = anderson_functions(u)
    nuisance = np.column_stack([np.ones_like(u), u])
    q_nuisance, _ = np.linalg.qr(nuisance)

    def basis(f: np.ndarray) -> np.ndarray:
        q, _ = np.linalg.qr(f - q_nuisance @ (q_nuisance.T @ f))
        return q.T.copy()

    fine_taus = np.array(
        [
            tau
            for j in range(-REFINE_BELOW, REFINE_ABOVE + 1)
            if (tau := tau_s * 2.0 ** (j / REFINE_PER_OCTAVE)) >= REFINE_MIN_TAU
        ]
    )
    return Scale(
        tau_s=tau_s,
        length=len(u),
        detector=basis(functions),
        nuisance=q_nuisance,
        offsets=offsets,
        fine_taus=fine_taus,
        fine_bases=np.stack([basis(anderson_functions(offsets / tau)) for tau in fine_taus]),
    )


SCALES = tuple(_make_scale(t) for t in SCALES_S)
LONGEST = max(s.length for s in SCALES)
SHORTEST = min(s.length for s in SCALES)


def fit_peak(scale: Scale, tau: float, window: np.ndarray) -> float:
    """Peak magnitude of the pass fitted at τ (readings) on this scale's
    window: least squares on the Anderson functions plus a constant and slope
    per axis, keeping the functions' part. Includes the signal's own mean,
    which the detector removes."""
    u = scale.offsets / tau
    functions = anderson_functions(u)
    coefficients, *_ = np.linalg.lstsq(np.column_stack([functions, np.ones_like(u), u]), window, rcond=None)
    return float(np.max(np.linalg.norm(functions @ coefficients[:3], axis=1)))


def refine_pass(scale: Scale, window: np.ndarray) -> tuple[float, float]:
    """The pass's τ (readings) and strength (nT) on the peak's window: of the
    τ the scale tries (fine_taus), the one whose functions keep the most of
    the window's energy, moved by a parabola through it and its neighbours,
    and the fit there. Over one window the energies compare like for like,
    which the six scales' own, over windows of different lengths, do not."""
    projection = np.einsum("jfl,la->jfa", scale.fine_bases, window)
    energy = np.sum(projection * projection, axis=(1, 2))
    j = int(np.argmax(energy))
    step = 0.0
    if 0 < j < len(energy) - 1:
        curvature = energy[j - 1] - 2.0 * energy[j] + energy[j + 1]
        if curvature < 0:
            step = min(0.5, max(-0.5, 0.5 * (energy[j - 1] - energy[j + 1]) / curvature))
    tau = float(scale.fine_taus[j] * 2.0 ** (step / REFINE_PER_OCTAVE))
    return tau, fit_peak(scale, tau, window)


def score_sigma(energy_over_variance: float) -> float:
    """χ²₉ statistic → the one-sided Gaussian score with the same tail
    probability. Clipped at 40σ, beyond which the numbers mean nothing more."""
    log_p = stats.chi2.logsf(energy_over_variance, DOF)
    if log_p < -800:
        return 40.0
    return float(min(40.0, stats.norm.isf(math.exp(log_p))))


# Below this a tail probability is carried in logarithms: a double holding it
# would underflow a few hundred decades further on.
_DEEP_TAIL = 1e-280


def _log_beta_series(z: float, a: float, b: float) -> tuple[float, float]:
    """log I_z(a, b), the regularised incomplete beta function, by its series
    I_z(a, b) = z^a (1 − z)^b / (a B(a, b)) · S, S = ₂F₁(a + b, 1; a + 1; z)
    (DLMF 8.17.8), and S itself. Exact for any z < 1, and fast where the tail
    is deep, z being small there."""
    total = term = 1.0
    k = 0
    while term > 1e-17 * total:
        term *= (a + b + k) / (a + 1.0 + k) * z
        total += term
        k += 1
    log_i = a * math.log(z) + b * math.log1p(-z) - math.log(a) - float(special.betaln(a, b)) + math.log(total)
    return log_i, total


def _log_beta_tail(z: float, a: float, b: float) -> float:
    """log I_z(a, b), carried in logarithms where I_z itself would underflow."""
    p = float(special.betainc(a, b, z))
    return math.log(p) if p > _DEEP_TAIL else _log_beta_series(z, a, b)[0]


def _beta_tail_inverse(log_p: float, a: float, b: float) -> float:
    """z with log I_z(a, b) = log_p."""
    if log_p > math.log(_DEEP_TAIL):
        return float(special.betaincinv(a, b, math.exp(log_p)))
    # Newton's method on u = log z, from the series' leading term:
    # d(log I)/du = a / ((1 − z) S).
    u = (log_p + math.log(a) + float(special.betaln(a, b))) / a
    for _ in range(100):
        z = math.exp(u)
        log_i, total = _log_beta_series(z, a, b)
        step = (log_i - log_p) * (1.0 - z) * total / a
        u -= step
        if abs(step) < 1e-13:
            break
    return math.exp(u)


def settled_energy(energy_over_variance: float, readings: int) -> float:
    """The statistic as it would read had the noise estimate rested on a full
    NOISE_WINDOW of readings, which is how the false-alarm model was fitted.

    Over an estimated variance the statistic is not χ²₉ but 9·F(9, ν), with
    ν = 2(readings − 1) for this estimator (first differences on three axes,
    clipped: measured within 2 % at 60–600 readings). The fewer the readings,
    the heavier the tail: on an estimate from 60 readings, which is where
    every restart begins, noise alone crosses what χ²₉ calls 3.5σ 2.6× as
    often as on one from 600, and 5.5σ 23× as often. So a statistic is mapped
    to the one with the same tail probability at the full window, and the
    false-alarm rate holds from the first scored minute. The tails are carried
    in logarithms, so the map stays finite, increasing and continuous however
    strong the statistic: it serves the score only, and an event's peak
    follows the statistic itself.
    """
    if readings < 2:
        raise ValueError("a noise estimate rests on two readings at least")
    if readings >= NOISE_WINDOW:
        return energy_over_variance
    nu = 2.0 * (readings - 1)
    full = 2.0 * (NOISE_WINDOW - 1)
    # F(9, ν)'s tail at x is I_z(ν/2, 9/2) at z = ν/(ν + 9x), here
    # z = ν/(ν + energy).
    log_p = _log_beta_tail(nu / (nu + energy_over_variance), nu / 2.0, DOF / 2.0)
    z = _beta_tail_inverse(log_p, full / 2.0, DOF / 2.0)
    return full * (1.0 - z) / z


def published_score(score: float) -> float:
    """A score as the API shows it. Below zero (a window quieter than noise
    usually is, p > 0.5) is a valid z-score, but on a "detection score" it
    reads as a fault, and nothing below zero is any nearer a detection."""
    return round(max(score, 0.0), 2)


# How often noise alone reaches a score of z at one magnetometer, per hour:
# FALSE_ALARM_COEFFICIENT · z² · P(Z > z). The z² is the search. The
# detector looks at every second and at six time scales, a search over two
# parameters. The rate of distinct excursions of such a search falls as
# z·φ(z) ≈ z²·P(Z > z), more slowly than the tail probability alone
# (Siegmund & Worsley, Ann. Statist. 23, 1995, for location and scale;
# Worsley, Adv. Appl. Prob. 33, 2001, for χ² fields). The coefficient is a
# Poisson maximum-likelihood fit to scripts/magnetometer_false_alarms.py:
# 3,065 node-hours searched of noise and daily variation at each of 3, 3.5,
# 4, 4.5 and 6σ, and 9,194 at 5 and 5.5σ, where false alarms are rare (the
# same simulated days, and more of them), eight magnetometers with the common
# mode subtracted and no storm: 470 (463–477 over seed-days drawn again). The
# model's rate lies inside the measured 95 % interval at every one, and a
# free exponent fits as 2.03 (1.87–2.20). Six, seven and twelve magnetometers
# alarm as eight do over the same simulated days, to within 2.2 % at 3.5σ.
# The design note has the run. Above 6σ the rate is the model's alone: noise
# gets there too rarely to count.
FALSE_ALARM_COEFFICIENT = 470.0
FALSE_ALARM_POWER = 2.0


def false_alarm_rate(score: float) -> float:
    """Excursions of noise alone to at least ``score``, per node-hour."""
    return FALSE_ALARM_COEFFICIENT * score**FALSE_ALARM_POWER * float(stats.norm.sf(score))


def confidence(score: float) -> float:
    """P(noise alone produces nothing this strong at this node within an hour)."""
    return float(math.exp(-false_alarm_rate(score)))


def garwood(k: int, exposure: float) -> tuple[float, float]:
    """The exact 95 % interval for a Poisson rate, k events over ``exposure``
    (Garwood 1936)."""
    # float(): scipy answers in numpy scalars, which the routes' orjson
    # refuses. Everything this module publishes is plain JSON.
    low = 0.0 if k == 0 else float(stats.chi2.ppf(0.025, 2 * k)) / 2.0
    high = float(stats.chi2.ppf(0.975, 2 * k + 2)) / 2.0
    return low / exposure, high / exposure


# The range band (range_band_km). A dipole of moment m gives a field between
# k·m/r³ on its equator and twice that on its axis (k = μ0/4π), so a strength S
# read exactly puts the UAP between r_eq(S) = (k·m/S)^(1/3) and 2^(1/3) of that.
# The band is drawn in x = ln(S·r³ / k·m), the strength over the equator's
# field at the distance: from BAND_NEAR to BAND_FAR, each a constant plus a
# term in 1/(score − BAND_POLE_SIGMA). How far off a strength reads depends on
# the score it came with. Just above a threshold, noise helped that window over
# it, and the least-squares fit takes the noise in with the signal: passes
# found at 5.5–6σ read a median 1.35 of their true peak field (0.86–2.06 for
# nine in ten), at 3.5–4σ 1.61, while above 15σ, measured at their own τ
# (refine_pass), they read 1.00 (0.95–1.09). These constants are fitted by
# scripts/magnetometer_false_alarms.py, to the 2,381 passes it found at 3.5, 5,
# 5.5 and 6σ: the narrowest band, on average, that keeps 98 % of every score
# bin's passes, from 3.5σ to the 40σ clip, inside each side (98 % being the
# least at which a band fitted to half the seeds held 90 % of the other half's
# in every bin; as fitted, every score bin of every one of those thresholds
# held 90 %), rounded outwards, its far end then raised by 0.005 to reach the
# axis (ln 2) at every score, as far as an exactly read strength can put the
# UAP. It holds the true slant range for 98.6 % of the passes found at 5.5σ,
# and for all 40 found just above it; for 95 % or more in every score bin at
# 3.5, 5 and 5.5σ, and for 91 % or more at 6σ (8–10σ, 30 of 33). Far over near
# is 1.29 for a strong detection, 1.69 at 5.5σ and 2.50 at 3.5σ; below 3.5σ
# the band is the fit carried on.
BAND_POLE_SIGMA = 2.0
BAND_LOWEST_SIGMA = 3.0  # the lowest threshold the settings allow
BAND_NEAR = (-0.056, -0.56)
BAND_FAR = (0.627, 2.53)


# Beyond this the interval means only "never": a score at the 40σ clip gives a
# rate that underflows to zero.
NOISE_INTERVAL_MAX_H = 1e12


def noise_interval_h(score: float) -> float:
    """Node-hours between excursions of noise alone this strong."""
    rate = false_alarm_rate(score)
    return NOISE_INTERVAL_MAX_H if rate <= 1.0 / NOISE_INTERVAL_MAX_H else float(f"{1.0 / rate:.3g}")


def band_bounds(score: float) -> tuple[float, float]:
    """The band's bounds in x (see BAND_NEAR) for an event of this score."""
    s = 1.0 / (max(score, BAND_LOWEST_SIGMA) - BAND_POLE_SIGMA)
    return BAND_NEAR[0] + BAND_NEAR[1] * s, BAND_FAR[0] + BAND_FAR[1] * s


def range_band_km(strength_nt: float, moment_am2: float, score: float) -> tuple[float, float] | None:
    """The slant ranges, in km, at which a dipole of this moment would put
    this strength on the magnetometer, allowing for how far off a strength
    read at this score may be (see BAND_NEAR)."""
    if not strength_nt or strength_nt <= 0 or not moment_am2:
        return None
    near, far = band_bounds(score)

    def distance_km(x):
        return (1e-7 * moment_am2 * 1e9 * math.exp(x) / strength_nt) ** (1.0 / 3.0) / 1000.0

    return (distance_km(near), distance_km(far))


# How strongly a magnetometer's own readings may carry something local, a
# pass, strongest last (see HOT_SIGMA and EXCLUDE_RADIUS_KM).
CLEAR, NEAR_HOT, HOT, NEAR_EVENT, EVENT = range(5)
# What common_modes gives in place of a count of others: the node's own recent
# common mode held, or no common mode it can trust this second.
HELD, NONE = 0, -1


def common_modes(deviations: np.ndarray, evidence: np.ndarray, held: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Each node's common mode, from the OTHER nodes least likely to carry a
    pass, and how many nodes each came from (HELD where it holds its own,
    NONE where it has nothing it can trust).

    ``deviations`` is (n, 3), ``evidence`` (n,) one of CLEAR…EVENT per node,
    ``held`` (n, 3) with NaN where a node holds nothing yet. The common mode
    is the per-axis median of the others' deviations this second, from the
    CLEAR ones. A node clear of every event may then set a score aside, the
    weakest evidence (noise alone reaches HOT_SIGMA about one second in a
    hundred): those at most NEAR_HOT, then at most HOT, since a magnetometer
    far off still sees what a storm does, where holding would not. A node at
    or beside an event is measuring a pass, and takes only CLEAR others: the
    ones scoring high near it are the same pass on its way, and their median
    took it whole. Over 220 passes over the cores of generated fleets (six
    magnetometers each, half the passes in a storm), nodes at or beside an
    event that set scores aside as the others do raised 19 false alarms, and
    with clear others only 3, for 823 passes found of 941 against 836 of 944;
    over 12 passes across 2 km rings of eight, 14 and 4 (in storms, which
    HOLD_MAX_S then takes care of). However few the others, the residual's
    noise grows by what their median adds (median_variance), which the score
    allows for. With no other left, a node holds its own recent common mode
    (HELD), or has none it can trust (NONE) if it holds nothing yet.
    Leave-one-out: including a node in its own median ties its residual to its
    own noise (the residual collapses to zero whenever the node is the middle
    value), which fattens the tails the threshold lives in; and a UAP at one
    node must not pull on that node's own baseline.
    """
    out = np.zeros_like(deviations)
    counts = np.zeros(len(deviations), dtype=int)
    for i in range(len(deviations)):
        for level in (CLEAR,) if evidence[i] >= NEAR_EVENT else (CLEAR, NEAR_HOT, HOT):
            others = evidence <= level
            others[i] = False
            if others.any():
                out[i] = np.median(deviations[others], axis=0)
                counts[i] = int(others.sum())
                break
        else:
            if np.isnan(held[i]).any():
                counts[i] = NONE
            else:
                out[i] = held[i]
    return out, counts


def window_variance(scale: Scale, variances: np.ndarray) -> float:
    """What a window's statistic is divided by, in units of the noise per
    reading σ was measured at: the largest eigenvalue of Σ fₜ qₜqₜᵀ, with fₜ
    each reading's variance (the latest of ``variances``) and qₜ the
    detector's three functions at it.

    Readings of variance fₜ make the window's projection p (per axis) noise
    of covariance σ²·Σ fₜ qₜqₜᵀ, and pᵀp over its largest eigenvalue is never
    more than χ²₃ per axis, whatever the noise: so the score never rises
    above what noise alone gives it. Where the variance is the same
    throughout (the usual window) that is the variance itself; one reading
    at f + Δ adds Δ·|qₜ|², its share of the functions, a fraction of a
    percent over most of a long window and a tenth at its middle. Dividing by
    the window's noisiest reading would add all of Δ, and in a dense core,
    where a second whose median comes from one or two others is common, it
    deflated most long windows: over 73 node-hours of noise it gave 55 false
    alarms at 3.5σ where the model expects 101, and the eigenvalue 93."""
    window = variances[-scale.length :]
    if window.min() == window.max():
        return float(window[0])
    covariance = (scale.detector * window) @ scale.detector.T
    return float(np.linalg.eigvalsh(covariance)[-1])


# The variance of the median of k independent unit normals (of the middle two
# averaged, for even k), by quadrature: what a common mode taken from k others
# adds to a residual's noise, in units of a magnetometer's own.
_MEDIAN_VARIANCE = (1.0, 0.5, 0.4487, 0.2982, 0.2868, 0.2147, 0.2105, 0.1682, 0.1661)


def median_variance(k: int) -> float:
    if k < 1:
        raise ValueError("a median needs one value at least")
    if k <= len(_MEDIAN_VARIANCE):
        return _MEDIAN_VARIANCE[k - 1]
    # π/2k asymptotically; these offsets hold it within 0.3 % from k = 10 on.
    return math.pi / (2.0 * (k + (0.45 if k % 2 else 1.37)))


# ── Per-node state ───────────────────────────────────────────────────────────

HISTORY = 3600  # samples of residual kept per node (an hour at 1 Hz)
OFFSET_WINDOW = 1800  # samples behind the static level (30 minutes)
NOISE_WINDOW = 600  # samples behind the noise estimate (10 minutes)
NOISE_MIN = 60  # residual samples before a noise estimate means anything
REFRESH_EVERY_S = 30  # static level and noise are refreshed on the wall clock's :00 and :30
# Samples before a node takes part: its static level is first set from
# these, and nothing earlier is ever scored. A level taken from a
# handful of samples moves by several nT as it settles, and those steps look
# like signal to the longer windows.
WARM_UP = 120
# The display history a magnetometer keeps: half an hour, at the fleet's one
# reading a second (it never reads faster).
DISPLAY_S = 1800
DISPLAY = int(DISPLAY_S / SAMPLE_PERIOD_S)
CLOSE_AFTER = 5  # readings under (threshold − 1) that end an event
# Two readings further apart than this have a hole between them, and no
# window may span it. Anything shorter is a slow or missed tick: the windows
# count readings, so a fleet that runs slow stretches each scale a little,
# where a span test (the first version skipped a window longer than 1.5×
# nominal) turned the detector off altogether once ticks passed 1.5 s. A hole
# is what a lost push or a fleet restart leaves (10 s and up), and what may
# have changed meanwhile (a level, a scene) is not in the readings.
HOLE_S = 5.0
# The time between readings is the median of a magnetometer's last
# PERIOD_READINGS steps (holes aside), and the network's is the median of
# every reporting magnetometer's: a missed reading, or one in twenty lost,
# leaves it at a second. The false-alarm model counts as calibrated while that
# is within PERIOD_TOLERANCE of a second, and once out, from when it is back
# within half that: a period near the edge does not flicker.
PERIOD_READINGS = 60
PERIOD_TOLERANCE = 0.1
# The common mode is a median of other reporting nodes, less those that may be
# carrying a pass (HOT_SIGMA, below). A median of m others ignores the nodes
# carrying a pass only while they are fewer than m/2, and a pass is felt before
# anything shows it: on its leading edge a strong pass is already tens of nT at
# a node that does not yet score high. Two magnetometers on one pass (what core
# placement is for) need five others, so six reporting. With five, the far
# nodes take half the weaker one's field until both alarm, and the step when it
# stops is itself a detection; with four they take all of it; with three, any
# pass reaches the other two at half strength (a median of two is their mean).
# Fewer than six, and the common mode is left in.
COMMON_MODE_MIN_NODES = 6
# Which others make a magnetometer's common mode (common_modes). A UAP is
# local: its field falls as 1/r³, from 100–200 nT at 1 km to 4–7 nT at 3 km and
# 1–2 nT at 5 km, while a storm or the daily variation is the same across the
# fleet. So a magnetometer with an event open or scoring HOT_SIGMA is left out
# of the others' medians, and so is every magnetometer within EXCLUDE_RADIUS_KM
# of it: a pass that lifts a magnetometer that high comes within about 2 km of
# it, and can be tens of nT at a neighbour 3 km off that does not score yet.
# Over passes across a cluster (three to six magnetometers within 1.4 km of
# each other, two to four more 20 km off; 240 passes, half of them in a storm),
# the far magnetometers raised 126 false alarms with only those with events
# left out, 67 with those scoring 3σ left out too, and none once the neighbours
# within 3 km went with them, whether the score's line was at 2σ, 3σ or 4σ and
# the passes at 30, 60 or 120 m/s. Across 1,730 generated fleets (ten metros,
# ring, dual and scatter layouts, 25 or 50 sites, 6 to 12 magnetometers) spread
# placement put the closest two 4.0–118 km apart, so there the radius never
# reaches a second one; core placement put them 0.04–23 km apart, with a pair
# within 3 km in more than half the fleets. Noise alone scores 3σ about one
# second in a hundred at each magnetometer (2σ one in eight): eight spread
# magnetometers take each median from all seven others 92 per cent of the time,
# from six 8 per cent, and never from fewer than five.
HOT_SIGMA = 3.0
EXCLUDE_RADIUS_KM = 3.0
# What a magnetometer holds when no other will do (common_modes): its common
# mode smoothed by this per reading (a time constant of four readings), so that
# it does not hold one second's noise for the whole hold.
HELD_TREND = 0.25
# Where a hold ends, and where one clear of every event begins one, a
# magnetometer's windows begin again (see _step). A lone magnetometer far from
# a cluster has only the cluster's median, which carries a pass's leading edge
# before any of the cluster scores high, and it held that for the minute or two
# the cluster's events lasted: a step of some 26 nT at either end, which its
# 32 s windows took for a pass. Over 60 such passes (five to seven
# magnetometers on a 0.7 km ring, one 20 km off, half in a storm) the far one
# raised a false alarm in 57; with no window across either end, in none. A hold
# lasts at most HOLD_MAX_S, and the magnetometer then has no common mode it can
# trust, and is not scored, until it takes a median of others again: a held
# common mode misses whatever the network has done since, which in a storm
# grows by the minute. On a 2 km ring of eight, where a pass across it keeps
# every magnetometer at or beside an event, and so holding, for minutes, six
# passes in a storm's main phase raised four false alarms (at τ = 32 and 64 s)
# with no limit, and none with this one.
HOLD_MAX_S = 180.0
# An event is true if the UAP's own field could have raised the statistic
# that fired: over the event's peak window, after the constant and slope the
# detector ignores too, the truth field must carry at least one noise
# variance of energy. Noise alone puts 9 into a window on average (χ²₉), and
# a threshold needs 32 (3.5σ) to 54 (5.5σ); a UAP adding 1 makes a crossing
# in that window 3× (3.5σ) to 8× (5.5σ) likelier than noise alone
# (non-central χ²). In seeded rigs, all 41 noise alarms raised while a UAP
# hovered 1.5 km away (up to 54 nT, but steady) or crept past 4 km away came
# to 0.000. Of 54 events peaking within 4τ of a pass's closest approach, 51
# came to 1.4 or more, and three weak ones at 3.5σ to 0.3–0.5, where the
# pass made the crossing no more than about twice as likely. (The truth is a
# magnitude, see _uap_energy, which puts these figures a quarter low.) The
# first version called an event true if any UAP put 1 nT on the node within
# its window, which took noise alarms near a distant or loitering UAP for
# detections.
TRUTH_MIN_ENERGY = 1.0
# A pass is counted when the UAP field at a magnetometer rises PASS_MIN_NT
# above the lowest it has been since the last pass (or since the magnetometer
# could score): a UAP already hovering beside it when it started watching is
# not a pass it had a chance at, and nor is the slow tail of one already
# counted. The pass stays open until PASS_GRACE_S after its field last reached
# a new peak: the detector reports up to 4τ after closest approach, 256 s at
# the longest scale, and a UAP that stops beside a magnetometer stops raising
# the peak, so its pass ends too. A pass is the field's rise at one
# magnetometer, whichever UAPs make it: two passing within PASS_GRACE_S of
# each other are one pass, while each event is a detection of its own, so true
# detections may outnumber the passes detected.
PASS_MIN_NT = 20.0
PASS_GRACE_S = float(HALF_WINDOW * max(SCALES_S))
STALE_S = 10.0
# Exposure is the time a magnetometer searched, in full six-scale searches.
# After a start, a restart or a hole its windows refill shortest first, and
# until the longest is full it searches less: noise alone raises, with only
# the shortest k scales, this share of the false alarms all six do (381
# node-hours at 3.5σ for each k, eight magnetometers, 520 false alarms with
# all six; 4σ agrees within its 93). So a second searched with the shortest k
# counts as SEARCH_SHARE[k - 1] of one, and the false-alarm rate, which the
# model gives for the full search, does not read low after every restart.
SEARCH_SHARE = (0.47, 0.73, 0.84, 0.93, 0.96, 1.0)
# A magnetometer whose position moves by more than this (in degrees; the push
# rounds to 1e-6) or whose host changes has been placed somewhere else.
MOVED_DEG = 1e-5
MOVED_ALT_M = 1.0


class Ring:
    """A fixed-capacity ring of rows whose last n rows are one contiguous slice
    (each row is written twice, at i and i + capacity)."""

    def __init__(self, capacity: int, width: int):
        self.capacity = capacity
        self.buffer = np.zeros((2 * capacity, width))
        self.count = 0
        self.head = 0

    def append(self, row) -> None:
        self.buffer[self.head] = row
        self.buffer[self.head + self.capacity] = row
        self.head = (self.head + 1) % self.capacity
        self.count = min(self.count + 1, self.capacity)

    def last(self, n: int) -> np.ndarray:
        n = min(n, self.count)
        end = self.head + self.capacity
        return self.buffer[end - n : end]


@dataclass
class Event:
    event_id: str
    node_id: str
    host_node_id: str
    start_ms: int
    peak_ms: int
    score_sigma: float
    strength_nt: float
    tau_s: float
    end_ms: int | None = None
    confidence: float = 0.0
    range_km: tuple[float, float] | None = None
    truth: dict | None = None
    # The matched filter's statistic at the peak, unclipped. The score stops
    # at 40σ, so a strong pass reaches it in its first window, usually a short
    # scale catching the leading edge. The peak (time, scale, strength) must
    # follow the statistic itself, which keeps growing until the window best
    # matched to the pass is centred on its closest approach.
    peak_energy: float = 0.0
    # The last reading of the peak's window: the window has passed once a
    # reading comes after it. From the readings' own times, so a fleet
    # running slow still closes its events.
    peak_end_ms: int = 0
    # The truth field over the peak's window, as the label weighs it (see
    # TRUTH_MIN_ENERGY).
    uap_energy: float = 0.0
    # Whether the false-alarm model, and so the confidence, applied when the
    # event opened (see MagnetometerNetwork.calibrated).
    calibrated: bool = False
    # The scorecard it opened under. It counts only there: one that restarted
    # meanwhile describes other settings.
    epoch: int = 0
    # The peak's scale as the detector indexes it (τ in readings); tau_s is the
    # pass's own τ measured on that scale's window (refine_pass), in seconds at
    # the readings' own spacing.
    scale_tau: float = 0.0
    # The passes this event made detected, while it is labelled true: an event
    # open across two passes at its magnetometer detected both.
    credited: list = field(default_factory=list, repr=False)
    _quiet: int = 0

    def as_dict(self) -> dict:
        return {
            "event_id": self.event_id,
            "node_id": self.node_id,
            "host_node_id": self.host_node_id,
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "peak_ms": self.peak_ms,
            "active": self.end_ms is None,
            "score_sigma": published_score(self.score_sigma),
            "strength_nt": round(self.strength_nt, 1),
            "confidence": round(self.confidence, 6),
            # How often noise alone would give an event this strong at one
            # node, in hours: the same number as the confidence, easier to read.
            "noise_once_per_h": noise_interval_h(self.score_sigma),
            "tau_s": self.tau_s,
            "range_km": None if self.range_km is None else [round(self.range_km[0], 3), round(self.range_km[1], 3)],
            "calibrated": self.calibrated,
            "truth": self.truth,
        }


def noise_sigma(residual: np.ndarray, nominal_sigma: float) -> float:
    """The noise per reading in a stretch of residual (n, 3), in nT."""
    # From first differences (immune to slow drift), as a standard deviation
    # after clipping outliers: a MAD of quantised differences lands on a whole
    # count and underestimates the noise, which the chi-square tail punishes
    # by orders of magnitude.
    diffs = np.diff(residual, axis=0)
    # The clip's spread is robust (a MAD), but never narrower than what the
    # sensor's own noise puts into a difference. At 50 cycles a count is 50 nT
    # against 30 nT of noise, so without the common mode most differences are
    # exactly zero, their MAD is zero, and a clip at zero kept only the zeros
    # and called the noise nil.
    spread = np.maximum(1.4826 * np.median(np.abs(diffs), axis=0), math.sqrt(2.0) * nominal_sigma)
    clipped = np.where(np.abs(diffs) <= 5.0 * spread, diffs, np.nan)
    per_axis = np.nanstd(clipped, axis=0) / math.sqrt(2.0)
    # Floored, so a stretch of identical counts cannot claim a noise of nearly
    # zero and turn every wobble into a detection.
    return float(max(np.sqrt(np.mean(per_axis**2)), 0.3 * nominal_sigma))


@dataclass
class NodeState:
    node_id: str
    host_node_id: str
    lat: float
    lon: float
    alt_m: float
    t_ms: Ring = field(default_factory=lambda: Ring(HISTORY, 1))
    raw: Ring = field(default_factory=lambda: Ring(HISTORY, 3))
    residual: Ring = field(default_factory=lambda: Ring(HISTORY, 3))
    uap: Ring = field(default_factory=lambda: Ring(HISTORY, 1))  # the truth field, beside each residual
    # Beside each residual, its noise variance in units of the sensor's own:
    # 1, plus what its common mode added (median_variance of the others it
    # came from).
    variance: Ring = field(default_factory=lambda: Ring(HISTORY, 1))
    truth: deque = field(default_factory=lambda: deque(maxlen=HISTORY))  # (t_ms, uap_nt, object_id, slant_km)
    # (t_ms, residual x, y, z, |r|, score, measured x, y, z, |B|): the residual
    # None until there is a static level, the score None while it cannot score.
    display: deque = field(default_factory=lambda: deque(maxlen=DISPLAY))
    offset: np.ndarray | None = None
    sigma_nt: float | None = None
    sigma_readings: int = 0  # the residual readings behind sigma_nt
    sigma_variance: float = 1.0  # their mean variance (see variance), which sigma_nt measured
    last_ms: int = 0  # the latest reading's own time
    heard_at: float = -math.inf  # when a reading last arrived, on the server's monotonic clock (s)
    step_s: float = 0.0  # from the previous reading to the latest
    steps: deque = field(default_factory=lambda: deque(maxlen=PERIOD_READINGS))  # the latest of them, holes aside
    period_s: float | None = None  # their median: the time between readings
    run: int = 0  # residual samples since the last hole or restart: the longest window allowed
    noise_count: int = 0  # residual samples since the noise last changed
    common: np.ndarray | None = None  # its common mode smoothed by HELD_TREND, for a hold
    holding: bool = False  # its common mode was held at the latest reading
    held_since: int | None = None  # the reading its hold began at (see HOLD_MAX_S)
    score: float = 0.0
    score_tau_s: float | None = None  # the best score's scale, in seconds
    scales: int = 0  # how many scales searched at the latest reading, shortest first
    longest_scale_s: float | None = None  # the longest of them, in seconds
    event: Event | None = None
    last_event: Event | None = None
    # No window reaching back to this reading may open an event: its last one
    # was open until then (see _detect).
    held_until_ms: int = 0
    samples: int = 0
    open_pass: dict | None = None
    pass_floor: float | None = None  # the lowest UAP field since the last pass, which the next must rise from

    @property
    def ready(self) -> bool:
        """Whether the detector can score this node: a static level, a noise
        estimate, and the shortest window's worth of unbroken residual."""
        return self.offset is not None and self.sigma_nt is not None and self.run >= SHORTEST

    def deviation(self, x: np.ndarray) -> np.ndarray:
        return x - self.offset

    def restart(self) -> None:
        """Forget the noise estimate, the stretch the windows may span and the
        common mode held: what a residual is has changed, and the residual
        before it is another series. The static level stands."""
        self.sigma_nt = None
        self.noise_count = 0
        self.run = 0
        self.common = None
        self.holding = False
        self.held_since = None

    def refresh(self, nominal_sigma: float) -> None:
        # The static level is a trimmed mean, not a median. The readings are
        # quantised (13.35 nT a count at 200 cycles), so a median sits on a
        # count and jumps a whole count when it moves, and a 13 nT step is
        # exactly the kind of thing the long windows notice. A mean of the
        # middle half moves smoothly and still ignores a passing object.
        self.offset = stats.trim_mean(self.raw.last(OFFSET_WINDOW), 0.25, axis=0)
        recent = self.residual.last(min(NOISE_WINDOW, self.noise_count))
        if len(recent) >= NOISE_MIN:
            self.sigma_nt = noise_sigma(recent, nominal_sigma)
            self.sigma_readings = len(recent)
            self.sigma_variance = float(np.mean(self.variance.last(len(recent))))


def _significant(x: float) -> float:
    """Three significant figures: a rate of 5e-05 per node-hour is not 0."""
    return float(f"{x:.3g}")


def _tau_s(scale: Scale, times: np.ndarray, readings: float | None = None) -> float:
    """A scale's τ, or ``readings`` measured on its window, in seconds: the
    detector counts readings, and a reading is whatever its window's own times
    say, a second when the fleet keeps time."""
    spacing_s = (times[-1] - times[-scale.length]) / ((scale.length - 1) * 1000.0)
    return round(float((scale.tau_s if readings is None else readings) * spacing_s), 2)


def _base36(n: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while True:
        n, k = divmod(n, 36)
        out = digits[k] + out
        if n == 0:
            return out


class MagnetometerNetwork:
    """Every simulated magnetometer, their events and the scorecard. One per
    process; route handlers call ``ingest`` and ``snapshot``."""

    def __init__(self, clock=time.time, monotonic=time.monotonic):
        # The wall clock stamps what the network publishes; silence is timed
        # on the monotonic one, which a clock set back does not stop.
        self._clock = clock
        self._monotonic = monotonic
        self._lock = threading.Lock()
        self.reset()

    def reset(self) -> None:
        with self._lock:
            # Event ids carry the run, so ids from before a server restart are
            # never reused: the map remembers which detections it has announced.
            self.run_id = _base36(int(self._clock() * 1000))
            self.nodes: dict[str, NodeState] = {}
            self.events: deque[Event] = deque(maxlen=500)
            self.sensor: dict = {}
            self.moment_am2 = 1e9
            self.storm = False
            self.common_mode_applied = False
            self.period_s: float | None = None  # the network's time between readings
            # Whether that is near enough a second (PERIOD_TOLERANCE): None
            # until the first period is measured.
            self.period_calibrated: bool | None = None
            self.updated_ms = 0
            self._event_seq = 0
            self._sensor_key: tuple | None = None
            self._scorekeeping_key: tuple | None = None
            self._scores_epoch = 0
            self._refusals_logged: set[str] = set()
            self._near_key: tuple = ()
            self._near_matrix = np.zeros((0, 0), dtype=bool)
            self._reset_scores()

    def _reset_scores(self) -> None:
        self._scores_epoch += 1
        self.scored_since_ms = int(self._clock() * 1000)
        self.exposure_s = 0.0
        self.false_alarms = 0
        self.true_detections = 0
        self.passes = 0
        self.passes_detected = 0
        # A pass under way belongs to the scorecard it began in, as an event
        # does: this one counts the next to rise PASS_MIN_NT from here.
        for node in self.nodes.values():
            if node.open_pass is not None:
                node.open_pass = None
                node.pass_floor = math.inf

    def _keep_score(self, threshold: float) -> None:
        # The false-alarm rate belongs to one configuration; mixing two would
        # describe neither.
        key = (threshold, self.common_mode_applied, self._sensor_key, self.storm)
        if key != self._scorekeeping_key:
            self._scorekeeping_key = key
            self._reset_scores()

    def _restart_detection(self) -> None:
        """Every node starts its noise estimate and its windows again, its open
        event closed: what a residual is has just changed."""
        for node in self.nodes.values():
            self._close_event(node, node.last_ms)
            node.restart()

    def _new_clock(self, node: NodeState, from_ms: int) -> None:
        """The fleet's clock has stepped back to ``from_ms``: whatever this node
        holds stamped from then on came from the clock before, and goes from
        what the map shows and from the truth the labels read; its event
        closes; no window spans the step; and its pass, if one is open, is
        left as counted. The static level and the noise estimate stand: the
        readings were real, only their times were not."""
        self._close_event(node, node.last_ms)
        while node.display and node.display[-1][0] >= from_ms:
            node.display.pop()
        while node.truth and node.truth[-1][0] >= from_ms:
            node.truth.pop()
        node.open_pass = None
        node.pass_floor = math.inf
        node.held_until_ms = 0
        node.run = 0
        node.last_ms = 0

    def _near(self, ids: list[str]) -> np.ndarray:
        """Which of these magnetometers are within EXCLUDE_RADIUS_KM of which
        (each of itself). Kept until the set of them, or a position, changes."""
        key = tuple((i, self.nodes[i].lat, self.nodes[i].lon) for i in ids)
        if key != self._near_key:
            lat = np.radians([self.nodes[i].lat for i in ids])
            lon = np.radians([self.nodes[i].lon for i in ids])
            east = (lon[:, None] - lon[None, :]) * np.cos((lat[:, None] + lat[None, :]) / 2.0)
            north = lat[:, None] - lat[None, :]
            self._near_matrix = np.hypot(east, north) * 6371.0 < EXCLUDE_RADIUS_KM
            self._near_key = key
        return self._near_matrix

    @property
    def calibrated(self) -> bool:
        """Whether the false-alarm model holds as it was fitted: the common mode
        subtracted, no storm, and a reading a second (the rate is per hour, and
        the search's is per reading)."""
        return self.common_mode_applied and not self.storm and bool(self.period_calibrated)

    # ── Ingest ───────────────────────────────────────────────────────────────

    def ingest(self, body: dict, settings: dict) -> dict:
        """Take one push. Returns counts for the response. Raises ValueError,
        naming the field, for a body the fleet could not have sent; nothing of
        it is applied then."""
        now_ms = int(self._clock() * 1000)
        try:
            push = parse_push(body, now_ms)
        except ValueError as exc:
            # Logged once per kind of fault, its numbers and indices aside (no
            # message carries the fleet's own text): a fleet that sends one
            # bad push sends it every second. The kinds are the checks' own
            # messages, about forty, and the set is capped above that all the
            # same.
            kind = re.sub(r"\[\d+\]|[-+]?\d[\d.,e+-]*", "#", str(exc))
            with self._lock:
                first = kind not in self._refusals_logged and len(self._refusals_logged) < REFUSAL_KINDS
                if first:
                    self._refusals_logged.add(kind)
            if first:
                log.warning("Magnetometer push refused: %s (each kind of fault is logged once)", exc)
            raise
        threshold = float(settings["mag_threshold_sigma"])
        common_mode = bool(settings["mag_common_mode"])
        heard = self._monotonic()
        accepted = rejected = samples_in = 0
        with self._lock:
            sensor_key = tuple(push["sensor"].get(k) for k in SENSOR_KEYS)
            if self._sensor_key is not None and sensor_key != self._sensor_key:
                # A new cycle count changes the noise and the quantisation
                # from the next reading on, and the noise estimate behind the
                # threshold would otherwise take ten minutes to catch up.
                self._restart_detection()
            self._sensor_key = sensor_key
            self.sensor = push["sensor"]
            nominal_sigma = self.sensor.get("noise_nt", DEFAULT_NOISE_NT)
            if push["moment"] is not None:
                self.moment_am2 = push["moment"]
            self.storm = push["storm"]
            self._keep_score(threshold)
            batch: dict[int, dict[str, tuple]] = {}
            seen: set[str] = set()
            for entry in push["nodes"]:
                node = self._accept_node(entry)
                if node is None:
                    rejected += 1
                    continue
                accepted += 1
                seen.add(node.node_id)
                samples = entry["samples"]
                if samples and node.last_ms and samples[-1][0] < node.last_ms - HOLE_S * 1000:
                    # Every reading more than a hole behind the latest: not a
                    # resend (the fleet resends a few seconds' backlog beside
                    # new readings) but the fleet's clock stepping back, after
                    # a push from a clock that was ahead, say. Its readings
                    # begin a new stretch, rather than all be taken for
                    # resends until the clock catches up again.
                    self._new_clock(node, samples[0][0])
                for t_ms, reading in samples:
                    if t_ms <= node.last_ms:
                        continue  # a resend, or out of order
                    batch.setdefault(t_ms, {})[node.node_id] = (reading, entry["truth"].get(t_ms))
                    node.heard_at = heard
                    samples_in += 1
            # The push lists every current magnetometer; one it no longer
            # lists was taken away by the simulator.
            for gone in set(self.nodes) - seen:
                node = self.nodes.pop(gone)
                self._close_event(node, node.last_ms)
            for t_ms in sorted(batch):
                self._step(t_ms, batch[t_ms], threshold, common_mode, nominal_sigma)
            self.updated_ms = int(self._clock() * 1000)
        return {"nodes": accepted, "rejected": rejected, "samples": samples_in}

    def _accept_node(self, entry: dict) -> NodeState | None:
        node_id, host = entry["node_id"], entry["host_node_id"]
        # Simulation only, and the host must be a synthetic radar node: this
        # path publishes a position, and must never be a way to publish a
        # real node's.
        if not is_synthetic_node(host) or not node_id.startswith("mag-"):
            return None
        lat, lon, alt = entry["lat"], entry["lon"], entry["alt_m"]
        if not valid_latlon(lat, lon) or not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
            return None
        node = self.nodes.get(node_id)
        if node is not None and (
            node.host_node_id != host
            or abs(node.lat - lat) > MOVED_DEG
            or abs(node.lon - lon) > MOVED_DEG
            or abs(node.alt_m - alt) > MOVED_ALT_M
        ):
            # The same id somewhere else: a scene change re-placed it (ids
            # follow the host's id, and a new layout moves hosts). Its static
            # level, noise and history are another site's.
            self._close_event(node, node.last_ms)
            node = None
        if node is None:
            node = NodeState(node_id=node_id, host_node_id=host, lat=lat, lon=lon, alt_m=alt)
            self.nodes[node_id] = node
        return node

    def _step(
        self, t_ms: int, readings: dict[str, tuple], threshold: float, common_mode: bool, nominal_sigma: float
    ) -> None:
        """One second of the network: deviations, common mode, detection."""
        # Every node refreshes its static level on the same second, so the
        # small step each refresh makes is the same step everywhere and the
        # common mode takes it out.
        on_the_beat = (t_ms // 1000) % REFRESH_EVERY_S == 0
        for node_id, (raw, _truth) in readings.items():
            node = self.nodes[node_id]
            node.step_s = (t_ms - node.last_ms) / 1000.0 if node.last_ms else 0.0
            if node.last_ms and node.step_s > HOLE_S:
                node.run = 0
            elif node.last_ms:
                node.steps.append(node.step_s)
                node.period_s = statistics.median(node.steps)
            node.raw.append(raw)
            node.samples += 1
            node.last_ms = t_ms
            if node.offset is None:
                if node.samples >= WARM_UP:
                    node.refresh(nominal_sigma)
            elif on_the_beat:
                node.refresh(nominal_sigma)
        # Every reporting magnetometer's, not only those reading at this time:
        # a fleet whose magnetometers kept different times would otherwise
        # read as one time or the other, second by second.
        periods = [
            n.period_s for n in self.nodes.values() if n.period_s is not None and t_ms - n.last_ms <= STALE_S * 1000
        ]
        if periods:
            self.period_s = statistics.median(periods)
            off = abs(self.period_s - SAMPLE_PERIOD_S) / SAMPLE_PERIOD_S
            if self.period_calibrated is None:
                # The first measure is judged by the tolerance itself: a fleet
                # steady at 1.07 s from the start is as near a second as one
                # that has slowed to it.
                self.period_calibrated = off <= PERIOD_TOLERANCE
            elif off > PERIOD_TOLERANCE:
                self.period_calibrated = False
            elif off <= PERIOD_TOLERANCE / 2:
                self.period_calibrated = True
        # Whether the common mode is subtracted: switching it in or out changes
        # what a residual is (and its noise by a fifth), so every node starts
        # again rather than score one series with the other's noise.
        reporting = sum(1 for n in self.nodes.values() if n.offset is not None and t_ms - n.last_ms <= STALE_S * 1000)
        applied = common_mode and reporting >= COMMON_MODE_MIN_NODES
        if applied != self.common_mode_applied:
            self.common_mode_applied = applied
            self._restart_detection()
        self._keep_score(threshold)
        ids = [node_id for node_id in readings if self.nodes[node_id].offset is not None]
        index = {node_id: k for k, node_id in enumerate(ids)}
        deviations = np.array([self.nodes[i].deviation(readings[i][0]) for i in ids]).reshape(-1, 3)
        common = np.zeros_like(deviations)
        counts = np.zeros(len(ids), dtype=int)
        if applied:
            nodes = [self.nodes[i] for i in ids]
            events = np.array([n.event is not None for n in nodes], dtype=bool)
            hot = events | np.array([n.score >= HOT_SIGMA for n in nodes], dtype=bool)
            near = self._near(ids)
            evidence = np.select(
                [events, near[:, events].any(axis=1), hot, near[:, hot].any(axis=1)],
                [EVENT, NEAR_EVENT, HOT, NEAR_HOT],
                CLEAR,
            )
            held = np.array([np.full(3, np.nan) if n.common is None else n.common for n in nodes]).reshape(-1, 3)
            common, counts = common_modes(deviations, evidence, held)
            for k, node in enumerate(nodes):
                if counts[k] != HELD:
                    node.held_since = None
                elif node.held_since is None:
                    node.held_since = t_ms
                elif t_ms - node.held_since > HOLD_MAX_S * 1000:
                    counts[k] = NONE  # held too long to be what the network still does
        for node_id, (raw, truth) in readings.items():
            node = self.nodes[node_id]
            if truth is not None:
                node.truth.append((t_ms, *truth))
            measured = (*raw.tolist(), float(np.linalg.norm(raw)))
            k = index.get(node_id)
            if k is None:
                # No static level yet, so no residual: a gap in the charts,
                # not a flat zero that looks like a quiet sensor.
                node.display.append((t_ms, None, None, None, None, None, *measured))
                continue
            others = int(counts[k]) if applied else None  # the others its common mode came from
            holding = others == HELD
            if holding != node.holding and not (holding and evidence[k] >= NEAR_EVENT):
                # A held common mode is a constant to the windows, which ignore
                # one, but where a hold begins and where it ends the residual
                # can step by whatever the held value had taken in meanwhile:
                # no window may span either. Except where a node at or beside
                # an event begins to hold: its common mode came from clear
                # magnetometers until then and carries on unchanged, and its
                # windows, which are watching the pass, carry on with it.
                node.run = 0
            node.holding = holding
            if others is not None and others > 0:
                node.common = common[k] if node.common is None else node.common + HELD_TREND * (common[k] - node.common)
            residual = deviations[k] - common[k]
            node.t_ms.append([t_ms])
            node.residual.append(residual)
            node.uap.append([truth[0] if truth else 0.0])
            # With no common mode, or a held one (a constant to the windows,
            # which ignore one), all that is left is the node's own noise.
            node.variance.append([1.0 + median_variance(others) if others is not None and others > 0 else 1.0])
            node.run += 1
            node.noise_count += 1
            if others == NONE:
                # No common mode it can trust this second: no residual to show
                # or score (a gap in the charts), and no window spans it. An
                # event open here can no longer be followed, and closes: left
                # open, it would keep every magnetometer beside it holding, or
                # untrusted, in turn.
                node.run = 0
                self._close_event(node, t_ms)
                self._detect(node, t_ms, threshold)  # clears its score: it cannot score
                node.display.append((t_ms, None, None, None, None, None, *measured))
                continue
            scored = self._detect(node, t_ms, threshold)
            node.display.append(
                (t_ms, *residual.tolist(), float(np.linalg.norm(residual)), node.score if scored else None, *measured)
            )
            # Exposure is the time the detector searched, in seconds of a full
            # search (SEARCH_SHARE): not warm-up, not the minute after a
            # restart, not the first window after a hole.
            if scored:
                self.exposure_s += min(node.step_s, HOLE_S) * SEARCH_SHARE[node.scales - 1]
            self._track_pass(node, t_ms, truth)

    # ── Detection ────────────────────────────────────────────────────────────

    def _detect(self, node: NodeState, t_ms: int, threshold: float) -> bool:
        """Score the node's latest windows, and open, follow or close its
        event. False if it could not score yet."""
        node.score, node.score_tau_s = 0.0, None
        node.scales, node.longest_scale_s = 0, None
        if not node.ready:
            return False
        times = node.t_ms.last(LONGEST)[:, 0]
        residual = node.residual.last(LONGEST)
        # sigma_nt measured the residual as its common mode was then; a window
        # whose common mode came from fewer others is noisier by as much
        # (median_variance), and is scored against that (window_variance).
        unit = node.sigma_nt**2 / node.sigma_variance
        variances = node.variance.last(LONGEST)[:, 0]
        event = node.event
        # After an event, no window that overlaps it may open another: it
        # would be looking at the same pass, and a long window goes on seeing
        # a strong pass for minutes after it has gone.
        held_until_ms = node.held_until_ms if event is None else 0
        # Every scale's statistic has the same distribution under noise
        # (χ² with 9 degrees of freedom), so the largest statistic is also the
        # best score, and only it needs converting.
        best = (0.0, None, None)
        near = 0.0  # while an event is open: the largest statistic at its scale and shorter
        for scale in SCALES:
            # A window spanning a hole, or a restart, is not the series the
            # basis assumes; and noise does not tell it apart from a pass.
            if node.run < scale.length:
                break
            node.scales += 1
            node.longest_scale_s = _tau_s(scale, times)
            if times[-scale.length] <= held_until_ms:
                continue
            window = residual[-scale.length :]
            projection = scale.detector @ window  # (3 functions, 3 axes)
            energy = float(np.sum(projection * projection)) / (unit * window_variance(scale, variances))
            if energy > best[0]:
                best = (energy, scale, int(times[-1 - scale.length // 2]))
            if event is not None and scale.tau_s <= event.scale_tau:
                near = max(near, energy)
        # The score is the statistic settled for the noise estimate's age
        # (settled_energy); the event's peak follows the statistic itself,
        # which an estimate's age does not reorder.
        energy, scale, centre_ms = best
        score = score_sigma(settled_energy(energy, node.sigma_readings)) if scale is not None else 0.0
        node.score = score
        node.score_tau_s = None if scale is None else _tau_s(scale, times)
        if event is None:
            if score >= threshold:
                self._open_event(node, scale, times, score, energy, residual)
            return True
        if energy > event.peak_energy:
            event.peak_energy = energy
            event.score_sigma = score
            event.peak_ms = centre_ms
            event.peak_end_ms = t_ms
            event.scale_tau = scale.tau_s
            tau, event.strength_nt = refine_pass(scale, residual[-scale.length :])
            event.tau_s = _tau_s(scale, times, tau)
            event.confidence = confidence(score)
            event.range_km = range_band_km(event.strength_nt, self.moment_am2, score)
            event.uap_energy = self._uap_energy(node, scale)
        # The truth so far: while the event is open the UAP may still be
        # closing in, and the panel shows this.
        event.truth = self._label(node, event, provisional=True)
        # The pass is over once the scale matched to it, and every shorter
        # one, has gone quiet. The longer scales would go on seeing it for as
        # long as their windows last.
        near_score = score_sigma(settled_energy(near, node.sigma_readings)) if near > 0 else 0.0
        event._quiet = event._quiet + 1 if near_score < threshold - 1.0 else 0
        if event._quiet >= CLOSE_AFTER and t_ms > event.peak_end_ms:
            self._close_event(node, t_ms)
        return True

    @staticmethod
    def _uap_energy(node: NodeState, scale: Scale) -> float:
        """The truth field over this scale's latest window, in units of the
        node's noise variance, after the constant and slope the detector
        ignores. The simulator sends the field's magnitude, not its direction,
        so this weighs the magnitude as one axis: for a straight pass about
        three-quarters of the field's own energy (a half to nine-tenths, nine
        passes in ten), and nothing for a UAP that does not move."""
        uap = node.uap.last(scale.length)[:, 0]
        left = uap - scale.nuisance @ (scale.nuisance.T @ uap)
        return float(left @ left) / node.sigma_nt**2

    def _open_event(
        self, node: NodeState, scale: Scale, times: np.ndarray, score: float, energy: float, residual: np.ndarray
    ) -> None:
        self._event_seq += 1
        tau, strength = refine_pass(scale, residual[-scale.length :])
        node.event = Event(
            event_id=f"mag-evt-{self.run_id}-{self._event_seq:05d}",
            node_id=node.node_id,
            host_node_id=node.host_node_id,
            start_ms=int(times[-scale.length]),
            peak_ms=int(times[-1 - scale.length // 2]),
            score_sigma=score,
            strength_nt=strength,
            tau_s=_tau_s(scale, times, tau),
            confidence=confidence(score),
            range_km=range_band_km(strength, self.moment_am2, score),
            peak_energy=energy,
            peak_end_ms=int(times[-1]),
            uap_energy=self._uap_energy(node, scale),
            calibrated=self.calibrated,
            epoch=self._scores_epoch,
            scale_tau=scale.tau_s,
        )
        node.event.truth = self._label(node, node.event, provisional=True)
        self.events.appendleft(node.event)

    def _close_event(self, node: NodeState, t_ms: int) -> None:
        event = node.event
        if event is None:
            return
        event.end_ms = t_ms
        event.truth = self._label(node, event, provisional=False)
        if event.epoch == self._scores_epoch:
            if event.truth["label"] == "true":
                self.true_detections += 1
            else:
                self.false_alarms += 1
            # As it is labelled at last: a false alarm detected nothing, even
            # a pass it was open for while it looked caused by one.
            self._credit(event)
        event.credited = []
        node.last_event = event
        node.held_until_ms = t_ms
        node.event = None

    def _label(self, node: NodeState, event: Event, *, provisional: bool) -> dict:
        """True if the UAP's own field could have contributed to the event (see
        TRUTH_MIN_ENERGY), with the strongest UAP field on this node while the
        event was open, widened by the window of its peak."""
        pad = event.peak_end_ms - event.peak_ms
        end = event.end_ms if event.end_ms is not None else node.last_ms
        best = (0.0, None, None)
        for t, uap_nt, object_id, slant_km in node.truth:
            if event.start_ms - pad <= t <= end + pad and uap_nt > best[0]:
                best = (uap_nt, object_id, slant_km)
        peak_nt, object_id, slant_km = best
        caused = event.uap_energy >= TRUTH_MIN_ENERGY
        return {
            "label": "true" if caused else "false",
            "provisional": provisional,
            "object_id": object_id if caused else None,
            "true_peak_nt": round(peak_nt, 2),
            "slant_range_km": None if slant_km is None or not caused else round(slant_km, 3),
        }

    def _track_pass(self, node: NodeState, t_ms: int, truth) -> None:
        """Count the passes a detector should have had a chance at (see
        PASS_MIN_NT) and the ones it detected: a pass counts as detected while
        an event of this scorecard, labelled true, is or was open during it."""
        if not node.ready:
            return
        uap_nt = truth[0] if truth else 0.0
        event = node.event
        ours = event is not None and event.epoch == self._scores_epoch
        current = node.open_pass
        if current is None:
            if event is not None and not ours:
                # An event of the scorecard before is open, on a pass of that
                # scorecard's too: this one counts the next pass to rise from
                # where the field is once that event has closed.
                node.pass_floor = uap_nt
            else:
                node.pass_floor = uap_nt if node.pass_floor is None else min(node.pass_floor, uap_nt)
                if uap_nt >= node.pass_floor + PASS_MIN_NT:
                    current = node.open_pass = {"peak_nt": uap_nt, "peak_ms": t_ms, "credited_by": None}
                    self.passes += 1
        elif uap_nt > current["peak_nt"]:
            current["peak_nt"], current["peak_ms"] = uap_nt, t_ms
        if ours:
            if current is not None and not any(p is current for p in event.credited):
                event.credited.append(current)
            self._credit(event)
        if current is not None and t_ms - current["peak_ms"] > PASS_GRACE_S * 1000:
            node.open_pass = None
            node.pass_floor = uap_nt

    def _credit(self, event: Event) -> None:
        """The passes an event of this scorecard was open for are detected while
        it is labelled true, and not while it is labelled false: as the UAP
        closes in a label may change, and every pass the event was open for
        changes with it. A pass another event detected stays that event's."""
        true = event.truth is not None and event.truth["label"] == "true"
        for current in event.credited:
            if true and current["credited_by"] is None:
                current["credited_by"] = event
                self.passes_detected += 1
            elif not true and current["credited_by"] is event:
                current["credited_by"] = None
                self.passes_detected -= 1

    # ── Reads ────────────────────────────────────────────────────────────────

    def _state(self, node: NodeState, now: float, threshold: float) -> str:
        # Silence by the server's own monotonic clock (``now``): a fleet clock
        # running behind or ahead must not read as a dead or a live
        # magnetometer, nor the server's own clock set back as a live one.
        if now - node.heard_at > STALE_S:
            return "stale"
        if not node.ready:
            return "warming_up"
        if node.event is not None:
            return "alarm"
        if node.score >= threshold - 1.5:
            return "elevated"
        return "quiet"

    def scorecard(self, now: float | None = None) -> dict:
        if now is None:
            now = self._monotonic()
        hours = self.exposure_s / 3600.0
        far = ci = None
        if hours > 0:
            far = self.false_alarms / hours
            ci = [_significant(bound) for bound in garwood(self.false_alarms, hours)]
        return {
            "since_ms": self.scored_since_ms,
            "node_hours": round(hours, 3),
            "false_alarms": self.false_alarms,
            "true_detections": self.true_detections,
            "false_alarms_per_node_hour": None if far is None else _significant(far),
            "false_alarms_per_node_hour_ci95": ci,
            "passes": self.passes,
            "passes_detected": self.passes_detected,
            # Counted passes still within PASS_GRACE_S of their field's last
            # peak, at a magnetometer still reporting: an event may yet open
            # for them.
            "passes_open": sum(
                1 for node in self.nodes.values() if node.open_pass is not None and now - node.heard_at <= STALE_S
            ),
            "pass_min_nt": PASS_MIN_NT,
        }

    def snapshot(self, settings: dict) -> dict:
        now_ms = int(self._clock() * 1000)
        now = self._monotonic()
        threshold = float(settings["mag_threshold_sigma"])
        with self._lock:
            nodes = []
            for node in sorted(self.nodes.values(), key=lambda n: n.node_id):
                lat, lon = public_latlon(node.lat, node.lon, node.host_node_id)
                latest = node.display[-1] if node.display else None
                event = node.event or node.last_event
                nodes.append(
                    {
                        "node_id": node.node_id,
                        "host_node_id": node.host_node_id,
                        "lat": lat,
                        "lon": lon,
                        "state": self._state(node, now, threshold),
                        "last_ms": node.last_ms,
                        "samples": node.samples,
                        "b_nt": None if node.raw.count == 0 else round(float(np.linalg.norm(node.raw.last(1)[0])), 1),
                        "residual_nt": None if latest is None or latest[4] is None else round(latest[4], 2),
                        "score_sigma": published_score(node.score),
                        "score_tau_s": node.score_tau_s,
                        # The longest scale searched at the latest reading:
                        # less than 64 s while its windows refill after a
                        # start, a restart or a hole, and slow passes go unseen.
                        "longest_scale_s": node.longest_scale_s,
                        "sigma_nt": None if node.sigma_nt is None else round(node.sigma_nt, 2),
                        "event": None if event is None else event.as_dict(),
                    }
                )
            return {
                "run_id": self.run_id,
                "updated_ms": self.updated_ms,
                "now_ms": now_ms,
                "settings": settings,
                "sensor": self.sensor,
                "uap_moment_am2": self.moment_am2,
                "storm": self.storm,
                "detector": {
                    "scales_s": list(SCALES_S),
                    "dof": DOF,
                    # Subtracted right now: the setting on, and enough
                    # magnetometers reporting for the median to hold.
                    "common_mode_applied": self.common_mode_applied,
                    # The time between readings, as the magnetometers report
                    # it: the model was fitted to a reading a second.
                    "reading_period_s": None if self.period_s is None else round(self.period_s, 2),
                    # Whether that is near enough a second for the model, as
                    # the server judges it (PERIOD_TOLERANCE, and half that
                    # to count again once out): not to be judged again from
                    # the rounded figure.
                    "reading_period_calibrated": bool(self.period_calibrated),
                    # The UI predicts a threshold's false-alarm rate as the
                    # operator moves it: coefficient · z^power · P(Z > z).
                    # Calibrated only in the conditions it was fitted in.
                    "false_alarm_model": {
                        "coefficient": FALSE_ALARM_COEFFICIENT,
                        "power": FALSE_ALARM_POWER,
                        "calibrated": self.calibrated,
                    },
                },
                "nodes": nodes,
                "events": [e.as_dict() for e in list(self.events)[:50]],
                "stats": self.scorecard(now),
            }

    def node_detail(self, node_id: str, window_s: int, settings: dict) -> dict | None:
        with self._lock:
            node = self.nodes.get(node_id)
            if node is None:
                return None
            # Back from the magnetometer's own latest reading, not the server's
            # clock: the readings carry the fleet's times, which may be behind.
            since = node.last_ms - window_s * 1000
            rows = [d for d in node.display if d[0] > since]

            def column(i, publish=lambda v: round(v, 2)):
                return [None if r[i] is None else publish(r[i]) for r in rows]

            return {
                "node_id": node.node_id,
                "host_node_id": node.host_node_id,
                "threshold_sigma": float(settings["mag_threshold_sigma"]),
                "sigma_nt": None if node.sigma_nt is None else round(node.sigma_nt, 2),
                "series": {
                    "t": [r[0] for r in rows],
                    # The residual (null before the static level is set) and
                    # its score (null while the detector cannot score).
                    "x": column(1),
                    "y": column(2),
                    "z": column(3),
                    "residual": column(4),
                    "score": column(5, published_score),
                    # The field as the magnetometer measured it, north, east
                    # and down, and its magnitude.
                    "bx": column(6),
                    "by": column(7),
                    "bz": column(8),
                    "b": column(9),
                },
                "events": [e.as_dict() for e in self.events if e.node_id == node_id][:20],
            }


network = MagnetometerNetwork()


def _reset_for_tests() -> None:
    network.reset()
