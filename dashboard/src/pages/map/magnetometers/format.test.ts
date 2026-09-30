import { describe, expect, it } from "vitest";
import {
  fleetFalseAlarmInterval,
  formatConfidence,
  formatFalseAlarmCount,
  formatFalseAlarmInterval,
  formatFalseAlarmRate,
  formatMoment,
  formatNoiseInterval,
  formatRange,
  formatScore,
  eventVerdict,
  isRecent,
  normalTail,
  predictedFalseAlarmsPerHour,
  scoreAxis,
  STATE_LABEL,
  stateColourKey,
  truthText,
  withAlpha,
} from "./format";
import type { MagEvent, MagState, MagStats } from "./types";

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
    pass_min_nt: 20,
    ...patch,
  };
}

describe("state words and colours", () => {
  const states: MagState[] = ["warming_up", "quiet", "elevated", "alarm", "stale"];

  it("names every state", () => {
    for (const state of states) expect(STATE_LABEL[state]).toMatch(/\w/);
  });

  it("draws each state in the map's own semantic colour", () => {
    expect(states.map(stateColourKey)).toEqual(["INK_SUBTLE", "NODE", "WARN", "ANOMALY", "INK_SUBTLE"]);
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
    expect(formatFalseAlarmRate(stats())).toBe("0.013 per node-hour (95 %: 0.002–0.040), 3 in 240.0 node-hours");
  });

  it("says it is still measuring before the first node-hour", () => {
    expect(formatFalseAlarmRate(null)).toBe("measuring…");
    expect(formatFalseAlarmRate(stats({ false_alarms_per_node_hour: null }))).toBe("measuring…");
  });

  it("drops the interval when the server has none", () => {
    expect(formatFalseAlarmRate(stats({ false_alarms_per_node_hour_ci95: null }))).toBe(
      "0.013 per node-hour, 3 in 240.0 node-hours",
    );
  });
});

describe("the summary's false-alarm lines", () => {
  it("gives the count with its exposure, then the rate with its interval", () => {
    expect(formatFalseAlarmCount(stats())).toBe("3 in 240.0 node-hours");
    expect(formatFalseAlarmInterval(stats())).toBe("0.013 per node-hour, 95 %: 0.002–0.040");
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

describe("formatScore", () => {
  it("gives the score, and admits the server's clip", () => {
    expect(formatScore(7.24)).toBe("7.2σ");
    expect(formatScore(39.96)).toBe("40.0σ");
    expect(formatScore(40)).toBe("≥ 40σ");
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
    // The backend's false_alarm_rate(5.5) with its fitted coefficient.
    expect(predictedFalseAlarmsPerHour(5.5, { coefficient: 486, power: 2 })).toBeCloseTo(2.7917e-4, 7);
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
