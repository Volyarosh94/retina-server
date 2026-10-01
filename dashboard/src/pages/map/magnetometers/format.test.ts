import { describe, expect, it } from "vitest";
import {
  chartRows,
  commonModeLeftIn,
  fieldAxis,
  fleetFalseAlarmInterval,
  formatConfidence,
  formatFalseAlarmCount,
  formatFalseAlarmInterval,
  formatFalseAlarmRate,
  formatNodeHours,
  formatPerNodeHour,
  formatSeconds,
  joinReasons,
  formatMoment,
  formatNoiseInterval,
  formatRange,
  formatScore,
  eventVerdict,
  isLive,
  isRecent,
  minuteTicks,
  modelGaps,
  normalTail,
  predictedFalseAlarmsPerHour,
  readingsGap,
  residualAxis,
  runningModelGaps,
  searchedScales,
  scoreAxis,
  STATE_LABEL,
  stateColourKey,
  stateLabel,
  truthText,
  withAlpha,
} from "./format";
import type { MagEvent, MagState, MagStats } from "./types";
import { network } from "../../../test/magnetometerNetwork";

function event(patch: Partial<MagEvent> = {}): MagEvent {
  return {
    event_id: "e1",
    node_id: "mag-synth-1",
    host_node_id: "synth-1",
    start_ms: 1_000,
    end_ms: null,
    peak_ms: 2_000,
    active: false,
    score_sigma: 7.2,
    strength_nt: 812.4,
    confidence: 0.99999,
    noise_once_per_h: 3.2e6,
    calibrated: true,
    tau_s: 8,
    range_km: [0.45, 1.2],
    truth: null,
    ...patch,
  };
}

function stats(patch: Partial<MagStats> = {}): MagStats {
  return {
    since_ms: 0,
    node_hours: 240,
    false_alarms: 3,
    true_detections: 2,
    false_alarms_per_node_hour: 0.0126,
    false_alarms_per_node_hour_ci95: [0.002, 0.04],
    passes: 2,
    passes_detected: 2,
    passes_open: 0,
    pass_min_nt: 20,
    ...patch,
  };
}

describe("state words and colours", () => {
  const states: MagState[] = ["warming_up", "quiet", "elevated", "alarm", "stale"];

  it("names every state", () => {
    for (const state of states) expect(STATE_LABEL[state]).toMatch(/\w/);
  });

  // A server that learns a new state must not take the layer down with it.
  it("names a state it does not know by the server's word for it", () => {
    expect(stateLabel("alarm")).toBe("Detecting");
    expect(stateLabel("rebooting" as MagState)).toBe("Rebooting");
    expect(stateLabel("re_placing" as MagState)).toBe("Re placing");
    expect(stateColourKey("rebooting" as MagState)).toBe("INK_SUBTLE");
  });

  it("draws each state on the map's quality scale: good, warn, anomaly, and grey for no verdict", () => {
    expect(states.map(stateColourKey)).toEqual(["INK_SUBTLE", "GOOD", "WARN", "ANOMALY", "INK_SUBTLE"]);
  });
});

describe("formatRange", () => {
  it("gives metres under a kilometre and kilometres above", () => {
    expect(formatRange([0.45, 1.2])).toBe("450 m – 1.20 km");
    expect(formatRange([12.3, 15])).toBe("12.3 km – 15.0 km");
  });

  it("has a dash for no range", () => {
    expect(formatRange(null)).toBe("—");
  });
});

describe("formatNoiseInterval", () => {
  it("says how rare noise this strong is, in the unit that reads best", () => {
    expect(formatNoiseInterval(2e9)).toBe("less than once in a billion node-hours");
    expect(formatNoiseInterval(3.2e6)).toBe("once in 3.2 million node-hours");
    expect(formatNoiseInterval(45_000)).toBe("once in 45 thousand node-hours");
    expect(formatNoiseInterval(12.4)).toBe("once in 12 node-hours");
    expect(formatNoiseInterval(1.2)).toBe("about once a node-hour");
    expect(formatNoiseInterval(0.25)).toBe("4.0 times a node-hour");
  });

  it("has a dash for nothing to say", () => {
    expect(formatNoiseInterval(null)).toBe("—");
    expect(formatNoiseInterval(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatConfidence", () => {
  it("never claims certainty and keeps the digits that matter", () => {
    expect(formatConfidence(0.99995)).toBe("> 99.99 %");
    expect(formatConfidence(0.995)).toBe("99.50 %");
    expect(formatConfidence(0.9)).toBe("90.0 %");
  });
});

describe("formatFalseAlarmRate", () => {
  it("gives the rate, its interval and the counts it came from", () => {
    expect(formatFalseAlarmRate(stats())).toBe("0.013 per node-hour (95 %: 0.002–0.04), 3 in 240 node-hours searched");
  });

  it("says it is still measuring before the first node-hour", () => {
    expect(formatFalseAlarmRate(null)).toBe("measuring…");
    expect(formatFalseAlarmRate(stats({ false_alarms_per_node_hour: null }))).toBe("measuring…");
  });

  it("drops the interval when the server has none", () => {
    expect(formatFalseAlarmRate(stats({ false_alarms_per_node_hour_ci95: null }))).toBe(
      "0.013 per node-hour, 3 in 240 node-hours searched",
    );
  });
});

// The server sends rates to three significant figures: an upper bound of
// 4.98e-05 per node-hour must not read as "4.98e-05", nor as "0.000".
describe("formatPerNodeHour", () => {
  it("writes a rate to two significant figures, as the prediction is written", () => {
    expect(formatPerNodeHour(0)).toBe("0");
    expect(formatPerNodeHour(0.0126)).toBe("0.013");
    expect(formatPerNodeHour(0.0026)).toBe("0.0026");
    expect(formatPerNodeHour(0.04)).toBe("0.04");
    expect(formatPerNodeHour(2.98)).toBe("3");
    expect(formatPerNodeHour(123)).toBe("120");
    expect(formatPerNodeHour(2.7573e-4)).toBe("0.00028");
  });

  it("writes one too small for a few decimals in powers of ten", () => {
    expect(formatPerNodeHour(4.98e-5)).toBe("5.0 × 10⁻⁵");
    expect(formatPerNodeHour(1.2e-11)).toBe("1.2 × 10⁻¹¹");
  });

  it("reads a scorecard of tiny rates", () => {
    const tiny = stats({ false_alarms: 0, false_alarms_per_node_hour: 0, false_alarms_per_node_hour_ci95: [0, 4.98e-5] });
    expect(formatFalseAlarmRate(tiny)).toBe("0 per node-hour (95 %: 0–5.0 × 10⁻⁵), 0 in 240 node-hours searched");
  });
});

describe("formatSeconds", () => {
  // The server sends time scales in seconds to two places: 8.00 at a reading a second.
  it("writes a time scale without trailing zeros", () => {
    expect(formatSeconds(8)).toBe("8 s");
    expect(formatSeconds(8.0)).toBe("8 s");
    expect(formatSeconds(8.02)).toBe("8 s");
    expect(formatSeconds(16.42)).toBe("16.4 s");
    expect(formatSeconds(0.5)).toBe("0.5 s");
  });
});

describe("searchedScales", () => {
  // Each scale needs 8τ + 1 unbroken readings: 129, 257 and 513 for 16, 32
  // and 64, so the slow end of the search comes last after a start or a hole.
  it("says which time scales a magnetometer searches, and when the rest come", () => {
    expect(searchedScales(null, 1)).toBeNull();
    expect(searchedScales(64, 1)).toEqual({ text: "2–64 s", complete: true });
    expect(searchedScales(16, 1)).toEqual({ text: "2–16 s; up to 64 s within 7 min", complete: false });
    expect(searchedScales(32, 1)).toEqual({ text: "2–32 s; up to 64 s within 5 min", complete: false });
    expect(searchedScales(2, 1)).toEqual({ text: "2 s; up to 64 s within 9 min", complete: false });
  });

  it("counts in readings, whatever their spacing", () => {
    // Half-second readings: the six scales are 1–32 s.
    expect(searchedScales(32, 0.5)).toEqual({ text: "1–32 s", complete: true });
    expect(searchedScales(8, 0.5)).toEqual({ text: "1–8 s; up to 32 s within 4 min", complete: false });
    // Spacing not yet known: taken as the nominal second.
    expect(searchedScales(16, null)).toEqual({ text: "2–16 s; up to 64 s within 7 min", complete: false });
  });
});

// The first minutes of a search are hundredths of a node-hour, which one
// decimal wrote "0 in 0.0 node-hours searched"; a long run's count went
// ungrouped ("61234.5").
describe("formatNodeHours", () => {
  it("gives the first node-hour in two significant figures, then tenths, then whole and grouped", () => {
    expect(formatNodeHours(0)).toBe("0");
    expect(formatNodeHours(0.004)).toBe("0.004");
    expect(formatNodeHours(0.0444)).toBe("0.044");
    expect(formatNodeHours(0.442)).toBe("0.44");
    expect(formatNodeHours(0.996)).toBe("1");
    expect(formatNodeHours(12.34)).toBe("12.3");
    expect(formatNodeHours(99.96)).toBe("100");
    expect(formatNodeHours(240)).toBe("240");
    expect(formatNodeHours(61_234.5)).toBe((61_235).toLocaleString());
  });

  it("never writes a search under way as none", () => {
    expect(formatFalseAlarmCount(stats({ node_hours: 0.012, false_alarms: 0, false_alarms_per_node_hour: 0 }))).toBe(
      "0 in 0.012 node-hours searched",
    );
    expect(formatFalseAlarmCount(stats({ node_hours: 61_234.5, false_alarms: 1_234 }))).toBe(
      `${(1_234).toLocaleString()} in ${(61_235).toLocaleString()} node-hours searched`,
    );
  });
});

describe("the summary's false-alarm lines", () => {
  it("gives the count with its exposure, then the rate with its interval", () => {
    expect(formatFalseAlarmCount(stats())).toBe("3 in 240 node-hours searched");
    expect(formatFalseAlarmInterval(stats())).toBe("0.013 per node-hour, 95 %: 0.002–0.04");
    expect(formatFalseAlarmInterval(stats({ false_alarms_per_node_hour_ci95: null }))).toBe("0.013 per node-hour");
  });

  it("says it is measuring, and has no rate, before any exposure", () => {
    const empty = stats({ false_alarms_per_node_hour: null, false_alarms_per_node_hour_ci95: null });
    expect(formatFalseAlarmCount(empty)).toBe("measuring…");
    expect(formatFalseAlarmInterval(empty)).toBeNull();
  });
});

describe("scoreAxis", () => {
  it("runs from 0 past the threshold in steps of two while quiet", () => {
    expect(scoreAxis(5.5, 1.3)).toEqual({ max: 7, ticks: [0, 2, 4, 6] });
    expect(scoreAxis(3, 0)).toEqual({ max: 4, ticks: [0, 2, 4] });
  });

  it("grows with a strong detection and keeps its steps readable", () => {
    expect(scoreAxis(5.5, 17.2)).toEqual({ max: 18, ticks: [0, 5, 10, 15] });
    expect(scoreAxis(5.5, 40)).toEqual({ max: 40, ticks: [0, 10, 20, 30, 40] });
  });

  it("never goes below zero or breaks on a missing peak", () => {
    expect(scoreAxis(5.5, Number.NaN)).toEqual({ max: 7, ticks: [0, 2, 4, 6] });
  });
});

// Even about zero, out to the largest excursion on any axis, on a round step
// two either side, so the chart has nothing to drop.
describe("residualAxis", () => {
  it("frames the largest excursion either way on five round ticks", () => {
    expect(residualAxis([])).toEqual({ max: 10, ticks: [-10, -5, 0, 5, 10] });
    expect(residualAxis([3, -9])).toEqual({ max: 10, ticks: [-10, -5, 0, 5, 10] });
    expect(residualAxis([12, -55])).toEqual({ max: 60, ticks: [-60, -30, 0, 30, 60] });
    expect(residualAxis([47])).toEqual({ max: 50, ticks: [-50, -25, 0, 25, 50] });
    expect(residualAxis([61])).toEqual({ max: 80, ticks: [-80, -40, 0, 40, 80] });
    expect(residualAxis([-300, 120])).toEqual({ max: 300, ticks: [-300, -150, 0, 150, 300] });
  });

  it("keeps every value inside, and ignores what is not a number", () => {
    for (const peak of [10.2, 19.9, 33, 99, 101, 2_501, 48_000]) {
      const { max, ticks } = residualAxis([peak, -peak / 2, Number.NaN, Infinity]);
      expect(max).toBeGreaterThanOrEqual(peak);
      expect(max).toBeLessThan(peak * 1.6);
      expect(ticks).toEqual([...ticks].reverse().map((t) => (t === 0 ? 0 : -t)));
      expect(ticks.length).toBeLessThanOrEqual(5);
    }
  });
});

describe("formatScore", () => {
  it("gives the score, and admits the server's clip", () => {
    expect(formatScore(7.24)).toBe("7.2σ");
    expect(formatScore(39.96)).toBe("40.0σ");
    expect(formatScore(40)).toBe("≥ 40σ");
  });

  it("never shows a detection score below zero", () => {
    expect(formatScore(-0.3)).toBe("0.0σ");
    expect(formatScore(-0.04)).toBe("0.0σ");
    expect(formatScore(0)).toBe("0.0σ");
  });
});

describe("formatMoment", () => {
  it("writes a moment the way the physics does", () => {
    expect(formatMoment(1e9)).toBe("1e9 A·m²");
    expect(formatMoment(5e8)).toBe("5e8 A·m²");
  });
});

describe("truthText", () => {
  it("names the UAP, its distance and its true peak", () => {
    const truth = { label: "true" as const, provisional: false, object_id: "uap-flyby-1", true_peak_nt: 812.4, slant_range_km: 0.62 };
    expect(truthText(event({ truth }))).toBe("uap-flyby-1 at 0.62 km, true peak 812 nT");
    expect(truthText(event({ truth: { ...truth, object_id: null, slant_range_km: null, true_peak_nt: 30 } }))).toBe(
      "UAP, true peak 30 nT",
    );
  });

  it("calls a false alarm one only once the event has closed", () => {
    const truth = { label: "false" as const, provisional: true, object_id: null, true_peak_nt: 0, slant_range_km: null };
    expect(truthText(event({ truth }))).toBe("no UAP nearby so far");
    expect(truthText(event({ truth: { ...truth, provisional: false } }))).toBe("false alarm: no UAP nearby");
    expect(truthText(event({ truth: null }))).toBe("—");
  });
});

describe("eventVerdict", () => {
  it("says an open event is detecting, and what the truth made of a closed one", () => {
    const truth = { label: "true" as const, provisional: false, object_id: "uap-1", true_peak_nt: 300, slant_range_km: 0.7 };
    expect(eventVerdict(event({ active: true, truth }))).toBe("detecting");
    expect(eventVerdict(event({ truth }))).toBe("UAP");
    expect(eventVerdict(event({ truth: { ...truth, label: "false" } }))).toBe("false alarm");
    expect(eventVerdict(event({ truth: null }))).toBe("closed");
  });

  it("says an open event on a magnetometer that went silent has no data, not that it is detecting", () => {
    const open = event({ active: true });
    expect(eventVerdict(open, isLive(open, "stale"))).toBe("no data");
    expect(eventVerdict(open, isLive(open, undefined))).toBe("no data");
    expect(eventVerdict(open, isLive(open, "alarm"))).toBe("detecting");
  });
});

describe("isLive", () => {
  it("follows an open event only while its magnetometer still reports", () => {
    expect(isLive(event({ active: true }), "alarm")).toBe(true);
    expect(isLive(event({ active: true }), "stale")).toBe(false);
    // Taken away: the server closes its event, but a stale snapshot may not have yet.
    expect(isLive(event({ active: true }), undefined)).toBe(false);
    expect(isLive(event({ active: false, end_ms: 1 }), "quiet")).toBe(false);
    expect(isLive(null, "alarm")).toBe(false);
  });
});

describe("isRecent", () => {
  const now = 1_000_000;

  it("keeps an open event, and a closed one for a minute", () => {
    expect(isRecent(event({ active: true }), now)).toBe(true);
    expect(isRecent(event({ end_ms: now - 30_000 }), now)).toBe(true);
    expect(isRecent(event({ end_ms: now - 61_000 }), now)).toBe(false);
  });

  it("drops no event, and a closed one with no end", () => {
    expect(isRecent(null, now)).toBe(false);
    expect(isRecent(event({ active: false, end_ms: null }), now)).toBe(false);
  });

  it("ends an open event at its magnetometer's last reading once it falls silent", () => {
    expect(isRecent(event({ active: true }), now, 60_000, now - 30_000)).toBe(true);
    expect(isRecent(event({ active: true }), now, 60_000, now - 61_000)).toBe(false);
    // A closed event keeps its own end.
    expect(isRecent(event({ end_ms: now - 10_000 }), now, 60_000, now - 600_000)).toBe(true);
  });
});

describe("the common mode", () => {
  it("is removed when the server says it is", () => {
    expect(commonModeLeftIn(network())).toBeNull();
  });

  it("is left in when it is switched off, or when too few magnetometers report for it", () => {
    const base = network();
    const off = { ...base, settings: { ...base.settings, mag_common_mode: false }, detector: { ...base.detector, common_mode_applied: false } };
    expect(commonModeLeftIn(off)).toBe("off");
    const few = { ...base, detector: { ...base.detector, common_mode_applied: false } };
    expect(commonModeLeftIn(few)).toBe("too-few");
  });

  // The server counts only magnetometers with a static level, which each
  // takes about two minutes to set after a start or a re-placement.
  it("is left in while enough are placed but too few have warmed up", () => {
    const base = network();
    const notApplied = { ...base.detector, common_mode_applied: false };
    const warming = (n: number) => Array.from({ length: n }, (_, i) => ({ ...base.nodes[2], node_id: `mag-w${i}`, host_node_id: `w${i}` }));
    // Two with a level and six without: eight reporting, two counted.
    expect(commonModeLeftIn({ ...base, detector: notApplied, nodes: [...base.nodes, ...warming(5)] })).toBe("warming");
    // Silent ones are not reporting at all.
    const silent = warming(5).map((n) => ({ ...n, state: "stale" as const }));
    expect(commonModeLeftIn({ ...base, detector: notApplied, nodes: [...base.nodes, ...silent] })).toBe("too-few");
    expect(runningModelGaps({ ...base, detector: { ...notApplied, false_alarm_model: { ...notApplied.false_alarm_model, calibrated: false } }, nodes: [...base.nodes, ...warming(5)] })).toEqual([
      "the magnetometers still warming up",
    ]);
  });
});

describe("where the false-alarm model holds", () => {
  const settings = network().settings;

  it("covers noise and daily variation, with the common mode removed across six or more magnetometers", () => {
    expect(modelGaps(settings)).toEqual([]);
    expect(modelGaps({ ...settings, mag_storm: true })).toEqual(["a storm"]);
    expect(modelGaps({ ...settings, mag_common_mode: false })).toEqual(["the common mode left in"]);
    // The server subtracts the common mode only with six or more reporting.
    expect(modelGaps({ ...settings, mag_n_nodes: 5 })).toEqual(["fewer than six magnetometers"]);
    expect(modelGaps({ ...settings, mag_n_nodes: 6 })).toEqual([]);
    // Every reason that holds, in one order.
    expect(modelGaps({ ...settings, mag_storm: true, mag_common_mode: false })).toEqual(["a storm", "the common mode left in"]);
  });

  // The model was fitted with the common mode subtracted, no storm and a
  // reading a second; the server says whether all three hold.
  it("takes the server's word for what is running, and gives every reason it does not hold", () => {
    const base = network();
    const uncalibrated = { ...base.detector, false_alarm_model: { ...base.detector.false_alarm_model, calibrated: false } };
    expect(runningModelGaps(base)).toEqual([]);
    expect(runningModelGaps({ ...base, storm: true, detector: uncalibrated })).toEqual(["a storm running"]);
    expect(runningModelGaps({ ...base, detector: { ...uncalibrated, common_mode_applied: false } })).toEqual([
      "fewer than six magnetometers reporting",
    ]);
    expect(
      runningModelGaps({
        ...base,
        settings: { ...base.settings, mag_common_mode: false },
        detector: { ...uncalibrated, common_mode_applied: false },
      }),
    ).toEqual(["the common mode left in"]);
    expect(runningModelGaps({ ...base, detector: { ...uncalibrated, reading_period_s: 1.6 } })).toEqual(["readings 1.6 s apart, not 1 s"]);
    expect(runningModelGaps({ ...base, detector: { ...uncalibrated, reading_period_s: null } })).toEqual(["the readings' spacing not yet measured"]);
    expect(runningModelGaps({ ...base, storm: true, detector: { ...uncalibrated, reading_period_s: 0.5 } })).toEqual([
      "a storm running",
      "readings 0.5 s apart, not 1 s",
    ]);
    // Not calibrated with nothing else amiss: a spacing sent as 1.1 was over the edge.
    expect(runningModelGaps({ ...base, detector: { ...uncalibrated, reading_period_s: 1.1 } })).toEqual(["readings 1.1 s apart, not 1 s"]);
    // Nothing it can name: it says so rather than make a reason up.
    expect(runningModelGaps({ ...base, detector: { ...uncalibrated, reading_period_s: 1 } })).toEqual(["the settings now running"]);
  });

  // The server judges the unrounded spacing, and sends it to two places.
  it("judges the readings' spacing on the server's word wherever it can", () => {
    const base = network();
    const uncalibrated = { ...base.detector, false_alarm_model: { ...base.detector.false_alarm_model, calibrated: false } };
    // Calibrated: the spacing holds, whatever it rounded to.
    expect(readingsGap({ ...base, detector: { ...base.detector, reading_period_s: 1.1 } })).toBeNull();
    // Beside another reason, the figure decides, as the server would on it.
    expect(readingsGap({ ...base, storm: true, detector: { ...uncalibrated, reading_period_s: 1.1 } })).toBeNull();
    expect(readingsGap({ ...base, storm: true, detector: { ...uncalibrated, reading_period_s: 0.9 } })).toBeNull();
    expect(readingsGap({ ...base, storm: true, detector: { ...uncalibrated, reading_period_s: 1.11 } })).toBe("readings 1.11 s apart, not 1 s");
    expect(readingsGap({ ...base, storm: true, detector: { ...uncalibrated, reading_period_s: 0.5 } })).toBe("readings 0.5 s apart, not 1 s");
    expect(readingsGap({ ...base, storm: true, detector: { ...uncalibrated, reading_period_s: null } })).toBe("the readings' spacing not yet measured");
    // The only condition left: a spacing at the edge is what fails.
    expect(readingsGap({ ...base, detector: { ...uncalibrated, reading_period_s: 1.1 } })).toBe("readings 1.1 s apart, not 1 s");
    expect(readingsGap({ ...base, detector: { ...uncalibrated, reading_period_s: 0.9 } })).toBe("readings 0.9 s apart, not 1 s");
    // Clear of the edge, the figure settles it, even then: never "1 s apart, not 1 s".
    expect(readingsGap({ ...base, detector: { ...uncalibrated, reading_period_s: 1 } })).toBeNull();
    expect(readingsGap({ ...base, detector: { ...uncalibrated, reading_period_s: 1.09 } })).toBeNull();
  });

  it("lists reasons as a sentence", () => {
    expect(joinReasons(["a storm running"])).toBe("a storm running");
    expect(joinReasons(["a", "b"])).toBe("a and b");
    expect(joinReasons(["a", "b", "c"])).toBe("a, b and c");
  });
});

describe("chartRows", () => {
  const series = {
    t: [0, 1_000, 9_000],
    x: [1, null, 3],
    y: [4, null, 6],
    z: [7, null, 9],
    residual: [8, null, 11],
    score: [null, 2, 3],
    bx: [21_000, 21_001, 21_002],
    by: [-1_800, -1_801, -1_802],
    bz: [43_700, 43_701, 43_702],
    b: [48_560, 48_561, 48_562],
  };

  it("lines the series up by second, nulls kept: no residual before the static level, no score before the detector can score", () => {
    const rows = chartRows(series);
    expect(rows[0]).toEqual({ t: 0, x: 1, y: 4, z: 7, residual: 8, score: null, bx: 21_000, by: -1_800, bz: 43_700, b: 48_560 });
    expect(rows[1]).toEqual({ t: 1_000, x: null, y: null, z: null, residual: null, score: 2, bx: 21_001, by: -1_801, bz: 43_701, b: 48_561 });
  });

  // The detector never lets a window span more than 5 s without readings;
  // nor do the charts draw across one.
  it("breaks every line where the readings stopped", () => {
    const rows = chartRows(series);
    expect(rows).toHaveLength(4);
    expect(rows[2]).toEqual({ t: 5_000, x: null, y: null, z: null, residual: null, score: null, bx: null, by: null, bz: null, b: null });
    expect(rows[3].t).toBe(9_000);
  });

  it("has nothing to chart without a series", () => {
    expect(chartRows(undefined)).toEqual([]);
  });

  // The server's HOLE_S: readings 5 s apart are still one stretch.
  it("breaks a line only where readings are more than 5 s apart", () => {
    const two = (gap: number) => chartRows({ ...series, t: [0, gap], x: [1, 2], y: [1, 2], z: [1, 2], residual: [1, 2], score: [1, 2], bx: [1, 2], by: [1, 2], bz: [1, 2], b: [1, 2] });
    expect(two(5_000)).toHaveLength(2);
    expect(two(5_001)).toHaveLength(3);
  });

  // An older server sends no measured field; nothing must read past its arrays.
  it("leaves the measured field empty where the server sends none", () => {
    const older: Record<string, unknown> = { ...series };
    for (const key of ["bx", "by", "bz", "b"]) delete older[key];
    const rows = chartRows(older as unknown as typeof series);
    expect(rows[0]).toEqual({ t: 0, x: 1, y: 4, z: 7, residual: 8, score: null, bx: null, by: null, bz: null, b: null });
  });
});

describe("minuteTicks", () => {
  const at = (h: number, m: number, s = 0) => new Date(2026, 9, 1, h, m, s).getTime();

  it("puts ticks on whole minutes, a round step apart", () => {
    expect(minuteTicks(at(16, 23, 40), at(16, 33, 40))).toEqual([at(16, 24), at(16, 26), at(16, 28), at(16, 30), at(16, 32)]);
    expect(minuteTicks(at(16, 20), at(16, 23, 30))).toEqual([at(16, 20), at(16, 21), at(16, 22), at(16, 23)]);
    expect(minuteTicks(at(9, 58, 10), at(10, 28))).toEqual([at(10, 0), at(10, 10), at(10, 20)]);
  });

  it("has none for an empty span", () => {
    expect(minuteTicks(at(16, 20), at(16, 20))).toEqual([]);
  });
});

describe("fieldAxis", () => {
  it("frames the measured field around its readings, never narrower than the sensor's noise", () => {
    expect(fieldAxis([])).toBeNull();
    // A quiet sensor: a few nT of wobble on 48,564 nT still gets a window of
    // tens of nT, not one its noise fills.
    expect(fieldAxis([48_560, 48_566, 48_563])).toEqual({
      min: 48_520,
      max: 48_600,
      ticks: [48_520, 48_540, 48_560, 48_580, 48_600],
    });
    // A pass: the window follows it, on round steps.
    expect(fieldAxis([48_560, 48_900, 48_580])).toEqual({
      min: 48_400,
      max: 49_000,
      ticks: [48_400, 48_600, 48_800, 49_000],
    });
  });
});

describe("withAlpha", () => {
  it("turns a hex colour into rgba", () => {
    expect(withAlpha("#dc2626", 0.5)).toBe("rgba(220, 38, 38, 0.5)");
    expect(withAlpha("dc2626", 0)).toBe("rgba(220, 38, 38, 0)");
  });

  it("leaves anything else alone", () => {
    expect(withAlpha("var(--node)", 0.5)).toBe("var(--node)");
    expect(withAlpha("#abc", 0.5)).toBe("#abc");
  });
});

describe("normalTail", () => {
  // scipy.stats.norm.sf at each z.
  const reference: [number, number][] = [
    [0, 0.5],
    [1, 0.15865525393145707],
    [2, 0.022750131948179198],
    [3, 0.001349898031630093],
    [4, 3.167124183311986e-5],
    [5, 2.8665157187919344e-7],
    [5.5, 1.898956246588768e-8],
    [6, 9.865876450376944e-10],
    [-1, 0.8413447460685429],
  ];

  it("is accurate relative to the value even in the far tail, where a threshold lives", () => {
    for (const [z, expected] of reference) {
      expect(Math.abs(normalTail(z) - expected) / expected).toBeLessThan(2e-7);
    }
  });

  it("predicts false alarms with the server's model, coefficient · z^power · P(Z > z)", () => {
    // The backend's false_alarm_rate(5.5) with its fitted coefficient, 480.
    expect(predictedFalseAlarmsPerHour(5.5, { coefficient: 480, power: 2 })).toBeCloseTo(2.7573e-4, 7);
    const flat = predictedFalseAlarmsPerHour(4, { coefficient: 1500, power: 0 });
    expect(Math.abs(flat - 1500 * 3.167124183311986e-5) / flat).toBeLessThan(2e-7);
  });
});

describe("fleetFalseAlarmInterval", () => {
  it("scales the per-node rate to the fleet and picks a readable unit", () => {
    expect(fleetFalseAlarmInterval(1, 8)).toBe("about 8 an hour across 8 magnetometers");
    expect(fleetFalseAlarmInterval(0.1, 8)).toBe("about one an hour across 8 magnetometers");
    expect(fleetFalseAlarmInterval(0.01, 8)).toBe("about one every 13 hours across 8 magnetometers");
    expect(fleetFalseAlarmInterval(0.001, 8)).toBe("about one every 5 days across 8 magnetometers");
    expect(fleetFalseAlarmInterval(1e-6, 1)).toBe("less than one a year across one magnetometer");
  });

  it("never divides by a zero rate, and counts an empty fleet as one", () => {
    expect(fleetFalseAlarmInterval(0, 8)).toBe("never across 8 magnetometers");
    expect(fleetFalseAlarmInterval(Number.NaN, 8)).toBe("never across 8 magnetometers");
    expect(fleetFalseAlarmInterval(2, 0)).toBe("about 2 an hour across one magnetometer");
  });
});
