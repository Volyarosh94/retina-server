/**
 * What GET /api/sim/magnetometers returns (backend/services/sim_magnetometer.py).
 * Simulation only: the route exists where the server runs a synthetic fleet.
 */

export type MagState = "warming_up" | "quiet" | "elevated" | "alarm" | "stale";

export interface MagTruth {
  label: "true" | "false";
  provisional: boolean;
  object_id: string | null;
  true_peak_nt: number;
  slant_range_km: number | null;
}

export interface MagEvent {
  event_id: string;
  node_id: string;
  host_node_id: string;
  start_ms: number;
  end_ms: number | null;
  peak_ms: number;
  active: boolean;
  score_sigma: number;
  strength_nt: number;
  confidence: number;
  noise_once_per_h: number | null;
  tau_s: number;
  range_km: [number, number] | null;
  truth: MagTruth | null;
}

export interface MagNode {
  node_id: string;
  host_node_id: string;
  lat: number;
  lon: number;
  state: MagState;
  last_ms: number;
  samples: number;
  b_nt: number | null;
  residual_nt: number | null;
  score_sigma: number;
  score_tau_s: number | null;
  sigma_nt: number | null;
  spark: { start_ms: number; step_ms: number; score: number[] };
  event: MagEvent | null;
}

export interface MagStats {
  since_ms: number;
  node_hours: number;
  false_alarms: number;
  true_detections: number;
  false_alarms_per_node_hour: number | null;
  false_alarms_per_node_hour_ci95: [number, number] | null;
  passes: number;
  passes_detected: number;
  pass_min_nt: number;
}

export interface MagSettings {
  mag_enabled: boolean;
  mag_n_nodes: number;
  mag_placement: "spread" | "core" | "random";
  mag_cycle_count: number;
  mag_storm: boolean;
  mag_threshold_sigma: number;
  mag_common_mode: boolean;
}

export interface MagNetwork {
  updated_ms: number;
  now_ms: number;
  settings: MagSettings;
  sensor: { model?: string; cycle_count?: number; noise_nt?: number; lsb_nt?: number };
  uap_moment_am2: number;
  storm: boolean;
  detector: {
    scales_s: number[];
    dof: number;
    /** Noise-alone excursions per node-hour at a score z: coefficient · z^power · P(Z > z). */
    false_alarm_model: { coefficient: number; power: number };
  };
  nodes: MagNode[];
  events: MagEvent[];
  stats: MagStats;
}

export interface MagDetail {
  node_id: string;
  host_node_id: string;
  threshold_sigma: number;
  sigma_nt: number | null;
  series: { t: number[]; x: number[]; y: number[]; z: number[]; residual: number[]; score: number[] };
  events: MagEvent[];
}
