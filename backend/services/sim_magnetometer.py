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
   node. What is left is its deviation.
2. **Noise.** Each node measures its own noise from the last 10 minutes of
   its residual: the standard deviation of first differences (immune to slow
   drift), outliers clipped, divided by √2, floored at 0.3 × the sensor's
   datasheet figure.
3. **Common mode.** The daily variation, and storms when they come, are the
   same across a 100 km fleet to within a few nT, and at tens to hundreds of
   nT they would swamp a UAP at a single site. Each second, every node's
   deviation has the per-axis median of the other nodes' deviations
   subtracted from it. The median, not the mean, so that a UAP near one node
   does not leak into the others; the other nodes only, so that a node's own
   noise and its own UAP never pull on its own baseline. (Off when fewer than
   three nodes report, or with mag_common_mode off.)
4. **Matched filter.** A dipole passing on a straight line produces a field
   that, on each axis, is exactly a combination of three Anderson functions
   of u = (t − t0)/τ, with t0 the time of closest approach and τ = distance
   / speed: f_n(u) = uⁿ/(1+u²)^(5/2), n = 0, 1, 2 (Anderson 1949; Sheinker et
   al. 2009; the form used in magnetic anomaly detection). For each of six
   time scales τ = 2…64 s, the residual in a window of ±4τ around a candidate
   t0 is projected onto that three-function space, after removing a constant
   and a slope (whatever the common mode left of slow drift). Under noise
   alone the energy captured, divided by the noise variance, is chi-square
   with 9 degrees of freedom (3 functions × 3 axes). That gives each window a
   p-value, expressed as a one-sided Gaussian score in σ.
5. **Events.** A node alarms when its best score crosses the threshold
   (runtime setting, in σ). The event's peak follows the unclipped statistic
   to the window best matched to the pass. The event closes once its peak's
   scale, and every shorter one, has stayed under the threshold minus one for
   five seconds, and the peak's own window has passed. The longer scales are
   left out of that test because a long window goes on seeing a strong pass
   for minutes after it has gone. Afterwards, no window that overlaps the
   event may open another. The event carries the time of closest approach (t0
   at the peak), the strength (the fitted signal's peak magnitude, in nT), the
   score, a confidence, and a range estimate from the strength and the dipole
   model.
6. **Scoring.** The simulator sends the truth beside each reading (the UAP
   field at the node and the nearest UAP). It never feeds detection. It labels
   each event true or false, so the false-alarm rate is measured live, with a
   confidence interval, and counts the significant passes that were detected.

Confidence, in words: the probability that noise alone would not produce an
event at least this strong at this node within an hour. It comes from the
rate at which noise alone reaches a score, fitted to a benchmark of the
detector over thousands of node-hours of simulated noise
(scripts/magnetometer_false_alarms.py; FALSE_ALARM_COEFFICIENT below, and the
design note for the run).
"""

from __future__ import annotations

import math
import threading
import time
from collections import deque
from dataclasses import dataclass, field

import numpy as np
from scipy import stats

from config.constants import is_num
from services.geo import valid_latlon
from services.public_location import public_latlon
from services.tcp_handler import is_synthetic_node

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


# ── The Anderson basis ───────────────────────────────────────────────────────

SAMPLE_PERIOD_S = 1.0
SCALES_S = (2, 4, 8, 16, 32, 64)
HALF_WINDOW = 4  # ±4τ: f0 is down to 0.1 % of its peak there, f2 to 1 %
DOF = 9  # 3 functions × 3 axes


def anderson_functions(u: np.ndarray) -> np.ndarray:
    """f0, f1, f2 = uⁿ/(1+u²)^(5/2) as columns."""
    d = (1.0 + u * u) ** 2.5
    return np.column_stack([1.0 / d, u / d, u * u / d])


@dataclass(frozen=True)
class Scale:
    tau_s: float
    length: int  # samples in the window, odd
    detector: np.ndarray  # (3, length): orthonormal, orthogonal to constant and slope
    design: np.ndarray  # (length, 5): [f0 f1 f2 1 u], for fitting the signal
    functions: np.ndarray  # (length, 3)


def _make_scale(tau_s: float) -> Scale:
    half = int(round(HALF_WINDOW * tau_s / SAMPLE_PERIOD_S))
    offsets = np.arange(-half, half + 1) * SAMPLE_PERIOD_S
    u = offsets / tau_s
    functions = anderson_functions(u)
    nuisance = np.column_stack([np.ones_like(u), u])
    q_nuisance, _ = np.linalg.qr(nuisance)
    residual = functions - q_nuisance @ (q_nuisance.T @ functions)
    q, _ = np.linalg.qr(residual)
    return Scale(
        tau_s=tau_s,
        length=len(u),
        detector=q.T.copy(),
        design=np.column_stack([functions, nuisance]),
        functions=functions,
    )


SCALES = tuple(_make_scale(t) for t in SCALES_S)
LONGEST = max(s.length for s in SCALES)


def score_sigma(energy_over_variance: float) -> float:
    """χ²₉ statistic → the one-sided Gaussian score with the same tail
    probability. Clipped at 40σ, beyond which the numbers mean nothing more."""
    log_p = stats.chi2.logsf(energy_over_variance, DOF)
    if log_p < -800:
        return 40.0
    return float(min(40.0, stats.norm.isf(math.exp(log_p))))


# How often noise alone reaches a score of z at one magnetometer, per hour:
# FALSE_ALARM_COEFFICIENT · z² · P(Z > z). The z² is the search. The
# detector looks at every second and at six time scales, a search over two
# parameters. The rate of distinct excursions of such a search falls as
# z·φ(z) ≈ z²·P(Z > z), more slowly than the tail probability alone
# (Siegmund & Worsley, Ann. Statist. 23, 1995, for location and scale;
# Worsley, Adv. Appl. Prob. 33, 2001, for χ² fields). The coefficient is a
# Poisson maximum-likelihood fit to scripts/magnetometer_false_alarms.py:
# 2,109 node-hours of noise and daily variation at each of 3.5, 4, 4.5, 5,
# 5.5 and 6σ. The model's rate lies inside the measured 95 % interval at
# every one, and a free exponent fits as 1.95. The design note has the run.
# The fit covers 3.5–6σ; thresholds start at 3.
FALSE_ALARM_COEFFICIENT = 480.0
FALSE_ALARM_POWER = 2.0


def false_alarm_rate(score: float) -> float:
    """Excursions of noise alone to at least ``score``, per node-hour."""
    return FALSE_ALARM_COEFFICIENT * score**FALSE_ALARM_POWER * float(stats.norm.sf(score))


def confidence(score: float) -> float:
    """P(noise alone produces nothing this strong at this node within an hour)."""
    return float(math.exp(-false_alarm_rate(score)))


# The fitted strength of a strong pass comes out within ~10 % of the true peak
# field in simulation (noise, and the pass's curvature within one window);
# the range band allows for 15 % either way.
STRENGTH_TOLERANCE = 0.15


# Beyond this the interval means only "never": a score at the 40σ clip gives a
# rate that underflows to zero.
NOISE_INTERVAL_MAX_H = 1e12


def noise_interval_h(score: float) -> float:
    """Node-hours between excursions of noise alone this strong."""
    rate = false_alarm_rate(score)
    return NOISE_INTERVAL_MAX_H if rate <= 1.0 / NOISE_INTERVAL_MAX_H else float(f"{1.0 / rate:.3g}")


def range_band_km(strength_nt: float, moment_am2: float) -> tuple[float, float] | None:
    """Distances at which a dipole of this moment produces this field: from
    its equator at the strength's upper tolerance (nearest) to its axis at
    the lower (farthest). On the axis |B| = (μ0/4π)·2m/r³, on the equator half.
    """
    if not strength_nt or strength_nt <= 0 or not moment_am2:
        return None

    def equatorial_m(field_nt):
        return (1e-7 * moment_am2 * 1e9 / field_nt) ** (1.0 / 3.0)

    nearest = equatorial_m(strength_nt * (1 + STRENGTH_TOLERANCE))
    farthest = equatorial_m(strength_nt * (1 - STRENGTH_TOLERANCE)) * 2 ** (1.0 / 3.0)
    return (nearest / 1000.0, farthest / 1000.0)


# ── Per-node state ───────────────────────────────────────────────────────────

HISTORY = 3600  # samples of residual kept per node (an hour at 1 Hz)
OFFSET_WINDOW = 1800  # samples behind the static level (30 minutes)
NOISE_WINDOW = 600  # samples behind the noise estimate (10 minutes)
REFRESH_EVERY_S = 30  # static level and noise are refreshed on the wall clock's :00 and :30
# Samples before a node takes part: its static level is first set from
# these, and nothing earlier is ever scored. A level taken from a
# handful of samples moves by several nT as it settles, and those steps look
# like signal to the longer windows.
WARM_UP = 120
DISPLAY = 1800  # samples of display history (30 minutes)
CLOSE_AFTER = 5  # seconds under (threshold − 1) that end an event
TRUTH_MIN_NT = 1.0  # a UAP contributing less than this did not cause an event
PASS_MIN_NT = 20.0  # a truth pass this strong counts toward the detection rate
# A pass is scored once its field has been gone this long: the detector
# reports up to 4τ after closest approach, 256 s at the longest scale.
PASS_GRACE_S = float(HALF_WINDOW * max(SCALES_S))
STALE_S = 10.0


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
            "score_sigma": round(self.score_sigma, 2),
            "strength_nt": round(self.strength_nt, 1),
            "confidence": round(self.confidence, 6),
            # How often noise alone would give an event this strong at one
            # node, in hours: the same number as the confidence, easier to read.
            "noise_once_per_h": noise_interval_h(self.score_sigma),
            "tau_s": self.tau_s,
            "range_km": None if self.range_km is None else [round(self.range_km[0], 3), round(self.range_km[1], 3)],
            "truth": self.truth,
        }


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
    truth: deque = field(default_factory=lambda: deque(maxlen=HISTORY))  # (t_ms, uap_nt, object_id, slant_km)
    display: deque = field(default_factory=lambda: deque(maxlen=DISPLAY))  # (t_ms, x, y, z, |r|, score)
    offset: np.ndarray | None = None
    sigma_nt: float | None = None
    last_ms: int = 0
    score: float = 0.0
    score_tau: float | None = None
    event: Event | None = None
    last_event: Event | None = None
    samples: int = 0
    open_pass: dict | None = None

    def deviation(self, x: np.ndarray) -> np.ndarray:
        return x - self.offset

    def refresh(self, nominal_sigma: float) -> None:
        # The static level is a trimmed mean, not a median. The readings are
        # quantised (13.35 nT a count at 200 cycles), so a median sits on a
        # count and jumps a whole count when it moves, and a 13 nT step is
        # exactly the kind of thing the long windows notice. A mean of the
        # middle half moves smoothly and still ignores a passing object.
        self.offset = stats.trim_mean(self.raw.last(OFFSET_WINDOW), 0.25, axis=0)
        recent = self.residual.last(NOISE_WINDOW)
        if len(recent) >= 60:
            # Noise from first differences (immune to slow drift), as a
            # standard deviation after clipping outliers: a MAD of quantised
            # differences lands on a whole count and underestimates the noise,
            # which the chi-square tail punishes by orders of magnitude.
            diffs = np.diff(recent, axis=0)
            spread = 1.4826 * np.median(np.abs(diffs), axis=0) + 1e-9
            clipped = np.where(np.abs(diffs) <= 5.0 * spread, diffs, np.nan)
            per_axis = np.nanstd(clipped, axis=0) / math.sqrt(2.0)
            # Floored, so a stretch of identical counts cannot claim a noise of
            # nearly zero and turn every wobble into a detection.
            self.sigma_nt = float(max(np.sqrt(np.mean(per_axis**2)), 0.3 * nominal_sigma))


class MagnetometerNetwork:
    """Every simulated magnetometer, their events and the scorecard. One per
    process; route handlers call ``ingest`` and ``snapshot``."""

    def __init__(self, clock=time.time):
        self._clock = clock
        self._lock = threading.Lock()
        self.reset()

    def reset(self) -> None:
        with self._lock:
            self.nodes: dict[str, NodeState] = {}
            self.events: deque[Event] = deque(maxlen=500)
            self.sensor: dict = {}
            self.moment_am2 = 1e9
            self.storm = False
            self.updated_ms = 0
            self._event_seq = 0
            self._scorekeeping_key: tuple | None = None
            self._reset_scores()

    def _reset_scores(self) -> None:
        self.scored_since_ms = int(self._clock() * 1000)
        self.exposure_s = 0.0
        self.false_alarms = 0
        self.true_detections = 0
        self.passes = 0
        self.passes_detected = 0

    # ── Ingest ───────────────────────────────────────────────────────────────

    def ingest(self, body: dict, settings: dict) -> dict:
        """Take one push. Returns counts for the response."""
        nodes_in = body.get("nodes")
        if not isinstance(nodes_in, list):
            raise ValueError("nodes list required")
        if len(nodes_in) > 100:
            raise ValueError("at most 100 magnetometers per push")
        sensor = body.get("sensor") if isinstance(body.get("sensor"), dict) else {}
        nominal_sigma = float(sensor.get("noise_nt") or 15.0) if is_num(sensor.get("noise_nt")) else 15.0
        moment = body.get("uap_moment_am2")
        threshold = float(settings["mag_threshold_sigma"])
        common_mode = bool(settings["mag_common_mode"])
        accepted = rejected = samples_in = 0
        with self._lock:
            key = (threshold, common_mode)
            if key != self._scorekeeping_key:
                # The false-alarm rate belongs to one threshold; mixing two
                # would describe neither.
                self._scorekeeping_key = key
                self._reset_scores()
            self.sensor = {k: sensor[k] for k in ("model", "cycle_count", "noise_nt", "lsb_nt") if k in sensor}
            self.moment_am2 = float(moment) if is_num(moment) and moment > 0 else self.moment_am2
            self.storm = bool(body.get("storm"))
            batch: dict[int, dict[str, tuple]] = {}
            seen: set[str] = set()
            for entry in nodes_in:
                node = self._accept_node(entry)
                if node is None:
                    rejected += 1
                    continue
                accepted += 1
                seen.add(node.node_id)
                truth_by_t = {}
                for row in entry.get("truth") or []:
                    if isinstance(row, list) and len(row) == 4 and is_num(row[0]) and is_num(row[1]):
                        truth_by_t[int(row[0])] = (
                            float(row[1]),
                            row[2] if isinstance(row[2], str) else None,
                            row[3] if is_num(row[3]) else None,
                        )
                for row in entry.get("samples") or []:
                    if not (isinstance(row, list) and len(row) == 4 and all(is_num(v) for v in row)):
                        continue
                    t_ms = int(row[0])
                    if t_ms <= node.last_ms:
                        continue  # a resend, or out of order
                    batch.setdefault(t_ms, {})[node.node_id] = (np.array(row[1:4], dtype=float), truth_by_t.get(t_ms))
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

    def _accept_node(self, entry) -> NodeState | None:
        if not isinstance(entry, dict):
            return None
        node_id, host = entry.get("node_id"), entry.get("host_node_id")
        if not isinstance(node_id, str) or not isinstance(host, str) or not 0 < len(node_id) <= 80:
            return None
        # Simulation only, and the host must be a synthetic radar node: this
        # path publishes a position, and must never be a way to publish a
        # real node's.
        if not is_synthetic_node(host) or not node_id.startswith("mag-"):
            return None
        lat, lon, alt = entry.get("lat"), entry.get("lon"), entry.get("alt_m", 0.0)
        if not (is_num(lat) and is_num(lon) and is_num(alt)) or not valid_latlon(lat, lon):
            return None
        if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
            return None
        node = self.nodes.get(node_id)
        if node is None:
            node = NodeState(node_id=node_id, host_node_id=host, lat=float(lat), lon=float(lon), alt_m=float(alt))
            self.nodes[node_id] = node
        return node

    def _step(
        self, t_ms: int, readings: dict[str, tuple], threshold: float, common_mode: bool, nominal_sigma: float
    ) -> None:
        """One second of the network: deviations, common mode, detection."""
        deviations = {}
        # Every node refreshes its static level on the same second, so the
        # small step each refresh makes is the same step everywhere and the
        # common mode takes it out.
        on_the_beat = (t_ms // 1000) % REFRESH_EVERY_S == 0
        for node_id, (raw, _truth) in readings.items():
            node = self.nodes[node_id]
            node.raw.append(raw)
            node.samples += 1
            node.last_ms = t_ms
            if node.offset is None:
                if node.samples >= WARM_UP:
                    node.refresh(nominal_sigma)
            elif on_the_beat:
                node.refresh(nominal_sigma)
            if node.offset is not None:
                deviations[node_id] = node.deviation(raw)
        # Leave-one-out: each node's common mode is the median of the OTHER
        # nodes. Including a node in its own median ties its residual to its
        # own noise (the residual collapses to zero whenever the node is the
        # middle value), which fattens the tails the threshold lives in; and a
        # UAP at one node must not pull on that node's own baseline.
        stacked = np.array(list(deviations.values())) if deviations else np.zeros((0, 3))
        ids = list(deviations)
        use_common = common_mode and len(ids) >= 3
        for node_id, (_raw, truth) in readings.items():
            node = self.nodes[node_id]
            if truth is not None:
                node.truth.append((t_ms, *truth))
            deviation = deviations.get(node_id)
            if deviation is None:
                node.display.append((t_ms, 0.0, 0.0, 0.0, 0.0, 0.0))
                continue
            common = np.zeros(3)
            if use_common:
                others = np.delete(stacked, ids.index(node_id), axis=0)
                common = np.median(others, axis=0)
            residual = deviation - common
            node.t_ms.append([t_ms])
            node.residual.append(residual)
            self._detect(node, t_ms, threshold, nominal_sigma)
            node.display.append((t_ms, *residual.tolist(), float(np.linalg.norm(residual)), node.score))
            self.exposure_s += SAMPLE_PERIOD_S
            self._track_pass(node, t_ms, truth)

    # ── Detection ────────────────────────────────────────────────────────────

    def _detect(self, node: NodeState, t_ms: int, threshold: float, nominal_sigma: float) -> None:
        node.score, node.score_tau = 0.0, None
        if node.sigma_nt is None:
            return
        variance = node.sigma_nt**2
        times = node.t_ms.last(LONGEST)[:, 0]
        residual = node.residual.last(LONGEST)
        event = node.event
        # After an event, no window that overlaps it may open another: it
        # would be looking at the same pass, and a long window goes on seeing
        # a strong pass for minutes after it has gone.
        held_until_ms = node.last_event.end_ms if event is None and node.last_event is not None else None
        # Every scale's statistic has the same distribution under noise
        # (χ² with 9 degrees of freedom), so the largest statistic is also the
        # best score, and only it needs converting.
        best = (0.0, None, None)
        near = 0.0  # while an event is open: the largest statistic at its scale and shorter
        for scale in SCALES:
            if len(residual) < scale.length:
                continue
            window = residual[-scale.length :]
            span_ms = times[-1] - times[-scale.length]
            # A window that spans a hole in the data is not the shape the
            # basis assumes; skip it rather than score it.
            if span_ms > (scale.length - 1) * SAMPLE_PERIOD_S * 1000 * 1.5:
                continue
            if held_until_ms is not None and times[-scale.length] <= held_until_ms:
                continue
            projection = scale.detector @ window  # (3 functions, 3 axes)
            energy = float(np.sum(projection * projection)) / variance
            if energy > best[0]:
                best = (energy, scale, int(times[-1 - scale.length // 2]))
            if event is not None and scale.tau_s <= event.tau_s:
                near = max(near, energy)
        energy, scale, centre_ms = best
        score = score_sigma(energy) if scale is not None else 0.0
        node.score = score
        node.score_tau = None if scale is None else scale.tau_s
        if event is None:
            if score >= threshold:
                self._open_event(node, scale, centre_ms, score, energy, residual)
            return
        if energy > event.peak_energy:
            event.peak_energy = energy
            event.score_sigma = score
            event.peak_ms = centre_ms
            event.tau_s = scale.tau_s
            event.strength_nt = self._strength(scale, residual)
            event.confidence = confidence(score)
            event.range_km = range_band_km(event.strength_nt, self.moment_am2)
        # The truth so far: while the event is open the UAP may still be
        # closing in, and the panel shows this.
        event.truth = self._label(node, event, provisional=True)
        # The pass is over once the scale matched to it, and every shorter
        # one, has gone quiet. The longer scales would go on seeing it for as
        # long as their windows last.
        near_score = score_sigma(near) if near > 0 else 0.0
        event._quiet = event._quiet + 1 if near_score < threshold - 1.0 else 0
        peak_passed = t_ms - event.peak_ms > HALF_WINDOW * event.tau_s * 1000
        if event._quiet >= CLOSE_AFTER and peak_passed:
            self._close_event(node, t_ms)

    @staticmethod
    def _strength(scale: Scale, residual: np.ndarray) -> float:
        """Peak magnitude of the fitted pass: least squares on the Anderson
        functions plus a constant and slope per axis, keeping the functions'
        part. Includes the signal's own mean, which the detector removes."""
        window = residual[-scale.length :]
        coefficients, *_ = np.linalg.lstsq(scale.design, window, rcond=None)
        fitted = scale.functions @ coefficients[:3]
        return float(np.max(np.linalg.norm(fitted, axis=1)))

    def _open_event(
        self, node: NodeState, scale: Scale, centre_ms: int, score: float, energy: float, residual: np.ndarray
    ) -> None:
        self._event_seq += 1
        strength = self._strength(scale, residual)
        node.event = Event(
            event_id=f"mag-evt-{self._event_seq:05d}",
            node_id=node.node_id,
            host_node_id=node.host_node_id,
            start_ms=centre_ms - int(HALF_WINDOW * scale.tau_s * 1000),
            peak_ms=centre_ms,
            score_sigma=score,
            strength_nt=strength,
            tau_s=scale.tau_s,
            confidence=confidence(score),
            range_km=range_band_km(strength, self.moment_am2),
            peak_energy=energy,
        )
        node.event.truth = self._label(node, node.event, provisional=True)
        self.events.appendleft(node.event)

    def _close_event(self, node: NodeState, t_ms: int) -> None:
        event = node.event
        if event is None:
            return
        event.end_ms = t_ms
        event.truth = self._label(node, event, provisional=False)
        # A pass open meanwhile was marked detected by _track_pass, which sees
        # every second the event was open.
        if event.truth["label"] == "true":
            self.true_detections += 1
        else:
            self.false_alarms += 1
        node.last_event = event
        node.event = None

    def _label(self, node: NodeState, event: Event, *, provisional: bool) -> dict:
        """True if a UAP put at least TRUTH_MIN_NT on this node while the event
        was open (widened by the window of its peak scale)."""
        pad = int(HALF_WINDOW * event.tau_s * 1000)
        end = event.end_ms if event.end_ms is not None else node.last_ms
        best = (0.0, None, None)
        for t, uap_nt, object_id, slant_km in node.truth:
            if event.start_ms - pad <= t <= end + pad and uap_nt > best[0]:
                best = (uap_nt, object_id, slant_km)
        peak_nt, object_id, slant_km = best
        return {
            "label": "true" if peak_nt >= TRUTH_MIN_NT else "false",
            "provisional": provisional,
            "object_id": object_id if peak_nt >= TRUTH_MIN_NT else None,
            "true_peak_nt": round(peak_nt, 2),
            "slant_range_km": None if slant_km is None or peak_nt < TRUTH_MIN_NT else round(slant_km, 3),
        }

    def _track_pass(self, node: NodeState, t_ms: int, truth) -> None:
        """Count the passes a detector should have had a chance at: stretches
        where the true UAP field at this node exceeded PASS_MIN_NT, scored as
        detected if an event was open at any point from the pass's start to
        PASS_GRACE_S after the field died away."""
        uap_nt = truth[0] if truth else 0.0
        if node.open_pass is None:
            if uap_nt >= PASS_MIN_NT and node.samples > WARM_UP:
                node.open_pass = {
                    "start_ms": t_ms,
                    "last_strong_ms": t_ms,
                    "peak_nt": uap_nt,
                    "detected": node.event is not None,
                }
            return
        current = node.open_pass
        current["peak_nt"] = max(current["peak_nt"], uap_nt)
        if uap_nt >= PASS_MIN_NT / 2:
            current["last_strong_ms"] = t_ms
        if node.event is not None:
            current["detected"] = True
        if t_ms - current["last_strong_ms"] > PASS_GRACE_S * 1000:
            self.passes += 1
            self.passes_detected += 1 if current["detected"] else 0
            node.open_pass = None

    # ── Reads ────────────────────────────────────────────────────────────────

    def _state(self, node: NodeState, now_ms: int, threshold: float) -> str:
        if now_ms - node.last_ms > STALE_S * 1000:
            return "stale"
        if node.samples < WARM_UP:
            return "warming_up"
        if node.event is not None:
            return "alarm"
        if node.score >= threshold - 1.5:
            return "elevated"
        return "quiet"

    def scorecard(self) -> dict:
        hours = self.exposure_s / 3600.0
        far = ci = None
        if hours > 0:
            far = self.false_alarms / hours
            k = self.false_alarms
            # float(): scipy answers in numpy scalars, which the routes'
            # orjson refuses. Everything this module publishes is plain JSON.
            low = 0.0 if k == 0 else float(stats.chi2.ppf(0.025, 2 * k)) / 2.0
            high = float(stats.chi2.ppf(0.975, 2 * k + 2)) / 2.0
            ci = [round(low / hours, 4), round(high / hours, 4)]
        return {
            "since_ms": self.scored_since_ms,
            "node_hours": round(hours, 3),
            "false_alarms": self.false_alarms,
            "true_detections": self.true_detections,
            "false_alarms_per_node_hour": None if far is None else round(far, 4),
            "false_alarms_per_node_hour_ci95": ci,
            "passes": self.passes,
            "passes_detected": self.passes_detected,
            "pass_min_nt": PASS_MIN_NT,
        }

    def snapshot(self, settings: dict) -> dict:
        now_ms = int(self._clock() * 1000)
        threshold = float(settings["mag_threshold_sigma"])
        with self._lock:
            nodes = []
            for node in sorted(self.nodes.values(), key=lambda n: n.node_id):
                lat, lon = public_latlon(node.lat, node.lon, node.host_node_id)
                recent = [d for d in node.display if d[0] >= now_ms - 600_000]
                spark = _spark(recent, now_ms)
                latest = node.display[-1] if node.display else None
                event = node.event or node.last_event
                nodes.append(
                    {
                        "node_id": node.node_id,
                        "host_node_id": node.host_node_id,
                        "lat": lat,
                        "lon": lon,
                        "state": self._state(node, now_ms, threshold),
                        "last_ms": node.last_ms,
                        "samples": node.samples,
                        "b_nt": None if node.raw.count == 0 else round(float(np.linalg.norm(node.raw.last(1)[0])), 1),
                        "residual_nt": None if latest is None else round(latest[4], 2),
                        "score_sigma": round(node.score, 2),
                        "score_tau_s": node.score_tau,
                        "sigma_nt": None if node.sigma_nt is None else round(node.sigma_nt, 2),
                        "spark": spark,
                        "event": None if event is None else event.as_dict(),
                    }
                )
            return {
                "updated_ms": self.updated_ms,
                "now_ms": now_ms,
                "settings": settings,
                "sensor": self.sensor,
                "uap_moment_am2": self.moment_am2,
                "storm": self.storm,
                "detector": {
                    "scales_s": list(SCALES_S),
                    "dof": DOF,
                    # The UI predicts a threshold's false-alarm rate as the
                    # operator moves it: coefficient · z^power · P(Z > z).
                    "false_alarm_model": {"coefficient": FALSE_ALARM_COEFFICIENT, "power": FALSE_ALARM_POWER},
                },
                "nodes": nodes,
                "events": [e.as_dict() for e in list(self.events)[:50]],
                "stats": self.scorecard(),
            }

    def node_detail(self, node_id: str, window_s: int, settings: dict) -> dict | None:
        now_ms = int(self._clock() * 1000)
        with self._lock:
            node = self.nodes.get(node_id)
            if node is None:
                return None
            since = now_ms - window_s * 1000
            rows = [d for d in node.display if d[0] >= since]
            return {
                "node_id": node.node_id,
                "host_node_id": node.host_node_id,
                "threshold_sigma": float(settings["mag_threshold_sigma"]),
                "sigma_nt": node.sigma_nt,
                "series": {
                    "t": [r[0] for r in rows],
                    "x": [round(r[1], 2) for r in rows],
                    "y": [round(r[2], 2) for r in rows],
                    "z": [round(r[3], 2) for r in rows],
                    "residual": [round(r[4], 2) for r in rows],
                    "score": [round(r[5], 2) for r in rows],
                },
                "events": [e.as_dict() for e in self.events if e.node_id == node_id][:20],
            }


def _spark(rows: list, now_ms: int, step_ms: int = 5000, span_ms: int = 600_000) -> dict:
    """The last ten minutes of detection score, one point (the max) per 5 s."""
    start = now_ms - span_ms
    buckets = [0.0] * (span_ms // step_ms)
    for t, *_rest, score in rows:
        k = int((t - start) // step_ms)
        if 0 <= k < len(buckets):
            buckets[k] = max(buckets[k], score)
    return {"start_ms": start, "step_ms": step_ms, "score": [round(v, 2) for v in buckets]}


network = MagnetometerNetwork()


def _reset_for_tests() -> None:
    network.reset()
