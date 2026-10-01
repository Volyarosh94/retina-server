/**
 * A /api/sim/magnetometers response for the magnetometer tests: three
 * magnetometers, one quiet with a closed false alarm, one detecting a UAP,
 * one still warming up.
 */
import type { MagEvent, MagNetwork, MagNode } from "../pages/map/magnetometers/types";

export const NOW_MS = 1_790_726_400_000;

/** The server run the fixture belongs to; event ids carry it. */
const RUN_ID = "run-1";

export function magEvent(patch: Partial<MagEvent> = {}): MagEvent {
  return {
    event_id: `mag-evt-${RUN_ID}-00002`,
    node_id: "mag-synth-002",
    host_node_id: "synth-002",
    start_ms: NOW_MS - 20_000,
    end_ms: null,
    peak_ms: NOW_MS - 8_000,
    active: true,
    score_sigma: 9.4,
    strength_nt: 812.4,
    confidence: 0.99999,
    noise_once_per_h: 3.2e9,
    calibrated: true,
    tau_s: 8,
    range_km: [0.45, 1.2],
    truth: { label: "true", provisional: false, object_id: "uap-flyby-1", true_peak_nt: 830.2, slant_range_km: 0.62 },
    ...patch,
  };
}

const FALSE_ALARM = magEvent({
  event_id: `mag-evt-${RUN_ID}-00001`,
  node_id: "mag-synth-001",
  host_node_id: "synth-001",
  start_ms: NOW_MS - 900_000,
  end_ms: NOW_MS - 880_000,
  peak_ms: NOW_MS - 890_000,
  active: false,
  score_sigma: 5.7,
  strength_nt: 31.6,
  confidence: 0.9999,
  noise_once_per_h: 1.2e4,
  tau_s: 32,
  range_km: [3.1, 4.3],
  truth: { label: "false", provisional: false, object_id: null, true_peak_nt: 0, slant_range_km: null },
});

function magNode(patch: Partial<MagNode>): MagNode {
  return {
    node_id: "mag-synth-001",
    host_node_id: "synth-001",
    lat: 34.85,
    lon: -82.39,
    state: "quiet",
    last_ms: NOW_MS - 1_000,
    samples: 3_600,
    b_nt: 48_564.1,
    residual_nt: 4.2,
    score_sigma: 1.3,
    score_tau_s: 16,
    longest_scale_s: 64,
    sigma_nt: 15.2,
    event: null,
    ...patch,
  };
}

export function network(patch: Partial<MagNetwork> = {}): MagNetwork {
  return {
    run_id: RUN_ID,
    updated_ms: NOW_MS,
    now_ms: NOW_MS,
    settings: {
      mag_enabled: true,
      mag_n_nodes: 8,
      mag_placement: "spread",
      mag_cycle_count: 200,
      mag_storm: false,
      mag_threshold_sigma: 5.5,
      mag_common_mode: true,
    },
    sensor: { model: "RM3100", cycle_count: 200, noise_nt: 15, lsb_nt: 13.3 },
    uap_moment_am2: 1e9,
    storm: false,
    detector: {
      scales_s: [2, 4, 8, 16, 32, 64],
      dof: 9,
      reading_period_s: 1,
      common_mode_applied: true,
      false_alarm_model: { coefficient: 480, power: 2, calibrated: true },
    },
    nodes: [
      magNode({ event: FALSE_ALARM }),
      magNode({
        node_id: "mag-synth-002",
        host_node_id: "synth-002",
        lat: 34.95,
        lon: -82.2,
        state: "alarm",
        score_sigma: 9.4,
        score_tau_s: 8,
        residual_nt: 640.5,
        event: magEvent(),
      }),
      magNode({
        node_id: "mag-synth-003",
        host_node_id: "synth-003",
        lat: 34.7,
        lon: -82.5,
        state: "warming_up",
        samples: 40,
        // Measured from its first reading; no residual until its static level.
        b_nt: 48_571.3,
        residual_nt: null,
        score_sigma: 0,
        score_tau_s: null,
        longest_scale_s: null,
        sigma_nt: null,
      }),
    ],
    events: [magEvent(), FALSE_ALARM],
    stats: {
      since_ms: NOW_MS - 3_600_000 * 30,
      node_hours: 240,
      false_alarms: 3,
      true_detections: 2,
      false_alarms_per_node_hour: 0.0126,
      false_alarms_per_node_hour_ci95: [0.0026, 0.0366],
      passes: 2,
      passes_detected: 2,
      passes_open: 0,
      pass_min_nt: 20,
    },
    ...patch,
  };
}

/** The fixture with one magnetometer's fields changed. */
export function withNode(base: MagNetwork, nodeId: string, patch: Partial<MagNode>): MagNetwork {
  return { ...base, nodes: base.nodes.map((n) => (n.node_id === nodeId ? { ...n, ...patch } : n)) };
}
