/**
 * What GET /api/sim/magnetometers returns (backend/services/sim_magnetometer.py).
 * Simulation only: the route exists where the server runs a synthetic fleet.
 */

/**
 * A magnetometer's state. `warming_up` lasts until its detector can score:
 * a static level, a noise estimate and 17 unbroken readings, so it comes back
 * for 17 s after a hole in the readings and for about a minute after a new
 * cycle count or the common mode switched in or out. `stale` means the server
 * has accepted no reading for ten seconds.
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
  /** Unique across server restarts ("mag-evt-<run>-<seq>"). */
  event_id: string;
  node_id: string;
  host_node_id: string;
  start_ms: number;
  end_ms: number | null;
  peak_ms: number;
  active: boolean;
  /** Never negative. */
  score_sigma: number;
  strength_nt: number;
  confidence: number;
  noise_once_per_h: number | null;
  /**
   * Whether the noise model behind `confidence` and `noise_once_per_h`
   * covered the conditions when the event opened: the common mode
   * subtracted, no storm, and a reading a second (± 10 %), as it was fitted.
   */
  calibrated: boolean;
  /** The time scale matched to the pass (distance ÷ speed), in seconds to two places. */
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
  /** The latest measured |B|, before anything is taken away. */
  b_nt: number | null;
  /** Null until the static level is set. */
  residual_nt: number | null;
  /** Never negative. */
  score_sigma: number;
  /** The best score's time scale, in seconds to two places. */
  score_tau_s: number | null;
  /**
   * The longest time scale the search covers now, in seconds (2…64 at a
   * reading a second); null while warming up. A scale of τ readings needs
   * 8τ + 1 of them unbroken, so the slow end comes back last, minutes after
   * a start, a re-placement or a hole.
   */
  longest_scale_s: number | null;
  sigma_nt: number | null;
  event: MagEvent | null;
}

export interface MagStats {
  since_ms: number;
  /** Time searched, weighted by how much of the six-scale search was running. */
  node_hours: number;
  false_alarms: number;
  true_detections: number;
  /** Three significant figures: tiny ones too (5e-05, not 0). */
  false_alarms_per_node_hour: number | null;
  false_alarms_per_node_hour_ci95: [number, number] | null;
  /**
   * UAP passes, each counted once its field at a magnetometer rises
   * pass_min_nt above its lowest since the last pass (or since it could
   * score), and open until 256 s after the field's last new peak.
   */
  passes: number;
  /** Of those, the ones a detection the truth confirms was open during. */
  passes_detected: number;
  /**
   * Counted passes still open at a magnetometer still reporting: one not yet
   * found still may be. A silent magnetometer's pass is not counted here.
   */
  passes_open: number;
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
  /**
   * This run of the server's network. A new value means the server
   * restarted: its events and their numbering start again.
   */
  run_id: string;
  /** When the server last took in a push, by its own clock. */
  updated_ms: number;
  /**
   * The server's clock as it answered. Readings, events and `last_ms` carry
   * the fleet's clock, which may run minutes behind or ahead of it.
   */
  now_ms: number;
  settings: MagSettings;
  sensor: { model?: string; cycle_count?: number; noise_nt?: number; lsb_nt?: number };
  uap_moment_am2: number;
  storm: boolean;
  detector: {
    scales_s: number[];
    dof: number;
    /** The network's time between readings, in seconds to two places; null until known. */
    reading_period_s: number | null;
    /**
     * Whether that is near enough a second for the false-alarm model, as the
     * server judges it on the unrounded figure: out beyond 10 %, back within
     * 5 %. Never to be judged again from `reading_period_s`.
     */
    reading_period_calibrated: boolean;
    /** Pushes the server refused whole since it started: the fleet drops each, so its readings are lost. */
    pushes_refused: number;
    /**
     * Entries the server skipped since it started, though well formed: a host
     * that is not a synthetic radar node, an id not starting `mag-`, a
     * position off the globe.
     */
    entries_rejected: number;
    /**
     * Whether the network's common mode is being subtracted now: the setting
     * is on and at least six magnetometers with a static level are reporting
     * (the server's COMMON_MODE_MIN_NODES).
     */
    common_mode_applied: boolean;
    /**
     * Noise-alone excursions per node-hour at a score z: coefficient · z^power
     * · P(Z > z). `calibrated` says whether the network runs as the model was
     * fitted: the common mode subtracted, no storm, a reading a second.
     */
    false_alarm_model: { coefficient: number; power: number; calibrated: boolean };
  };
  nodes: MagNode[];
  events: MagEvent[];
  stats: MagStats;
}

/**
 * GET /api/sim/magnetometers/{node_id}?window=600: one magnetometer's last
 * ten minutes, one row per reading, every array aligned with `t`.
 */
export interface MagDetail {
  node_id: string;
  host_node_id: string;
  threshold_sigma: number;
  sigma_nt: number | null;
  series: {
    t: number[];
    /** The residual north, east and down, after the static level and (where applied) the common mode: null until the static level is set. */
    x: (number | null)[];
    y: (number | null)[];
    z: (number | null)[];
    /** The residual's magnitude, null with it. */
    residual: (number | null)[];
    /** The detection score, never negative; null while the detector cannot score. */
    score: (number | null)[];
    /** The field as measured, north, east and down, and its magnitude, in nT. */
    bx: number[];
    by: number[];
    bz: number[];
    b: number[];
  };
  events: MagEvent[];
}
