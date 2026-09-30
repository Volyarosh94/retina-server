/**
 * Words and numbers for the magnetometer layer, kept pure so they can be
 * tested without a map.
 */
import type { MagEvent, MagState, MagStats } from "./types";

export const STATE_LABEL: Record<MagState, string> = {
  warming_up: "Warming up",
  quiet: "Quiet",
  elevated: "Elevated",
  alarm: "Detecting",
  stale: "No data",
};

/** Which palette entry a state is drawn in: the map's own semantic colours. */
export function stateColourKey(state: MagState): "NODE" | "WARN" | "ANOMALY" | "INK_SUBTLE" {
  switch (state) {
    case "alarm":
      return "ANOMALY";
    case "elevated":
      return "WARN";
    case "quiet":
      return "NODE";
    default:
      return "INK_SUBTLE";
  }
}

export function formatRange(range: [number, number] | null): string {
  if (!range) return "—";
  const [near, far] = range;
  const fmt = (km: number) => (km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(km < 10 ? 2 : 1)} km`);
  return `${fmt(near)} – ${fmt(far)}`;
}

/** "once in 3.2 million node-hours": how rare noise this strong is. */
export function formatNoiseInterval(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return "—";
  if (hours >= 1e9) return "less than once in a billion node-hours";
  if (hours >= 1e6) return `once in ${(hours / 1e6).toPrecision(2)} million node-hours`;
  if (hours >= 1e3) return `once in ${Math.round(hours / 1e3)} thousand node-hours`;
  if (hours >= 1.5) return `once in ${Math.round(hours)} node-hours`;
  if (hours >= 1) return "about once a node-hour";
  return `${(1 / hours).toPrecision(2)} times a node-hour`;
}

export function formatConfidence(confidence: number): string {
  if (confidence >= 0.9999) return "> 99.99 %";
  return `${(confidence * 100).toFixed(confidence >= 0.99 ? 2 : 1)} %`;
}

/** The scorecard's false-alarm rate, with its interval, in words a person can check. */
export function formatFalseAlarmRate(stats: MagStats | null | undefined): string {
  if (!stats || stats.false_alarms_per_node_hour === null) return "measuring…";
  const rate = stats.false_alarms_per_node_hour;
  const ci = stats.false_alarms_per_node_hour_ci95;
  const interval = ci ? ` (95 %: ${ci[0].toFixed(3)}–${ci[1].toFixed(3)})` : "";
  return `${rate.toFixed(3)} per node-hour${interval}, ${stats.false_alarms} in ${stats.node_hours.toFixed(1)} node-hours`;
}

/** "3 in 240.0 node-hours": the false alarms the scorecard has counted. */
export function formatFalseAlarmCount(stats: MagStats): string {
  if (stats.false_alarms_per_node_hour === null) return "measuring…";
  return `${stats.false_alarms} in ${stats.node_hours.toFixed(1)} node-hours`;
}

/** "0.013 per node-hour, 95 %: 0.003–0.037": the rate behind that count. */
export function formatFalseAlarmInterval(stats: MagStats): string | null {
  const rate = stats.false_alarms_per_node_hour;
  if (rate === null) return null;
  const ci = stats.false_alarms_per_node_hour_ci95;
  return `${rate.toFixed(3)} per node-hour${ci ? `, 95 %: ${ci[0].toFixed(3)}–${ci[1].toFixed(3)}` : ""}`;
}

/**
 * The score chart's vertical axis: from 0 to the threshold plus one, or to the
 * peak if higher, in whole steps that stay readable however strong the peak.
 */
export function scoreAxis(thresholdSigma: number, peakSigma: number): { max: number; ticks: number[] } {
  const max = Math.max(Math.ceil(thresholdSigma + 1), Math.ceil(Number.isFinite(peakSigma) ? peakSigma : 0));
  const step = max <= 8 ? 2 : max <= 20 ? 5 : 10;
  const ticks = Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step);
  return { max, ticks };
}

/** The server clips a score at 40σ, beyond which it means nothing more. */
export const SCORE_CLIP_SIGMA = 40;

/** "7.2σ", or "≥ 40σ" at the server's clip. */
export function formatScore(scoreSigma: number): string {
  return scoreSigma >= SCORE_CLIP_SIGMA ? `≥ ${SCORE_CLIP_SIGMA}σ` : `${scoreSigma.toFixed(1)}σ`;
}

/** "1e9 A·m²" */
export function formatMoment(am2: number): string {
  return `${am2.toExponential(0).replace("e+", "e")} A·m²`;
}

export function truthText(event: MagEvent): string {
  const truth = event.truth;
  if (!truth) return "—";
  if (truth.label === "false") return truth.provisional ? "no UAP nearby so far" : "false alarm: no UAP nearby";
  const where = truth.slant_range_km === null ? "" : ` at ${truth.slant_range_km.toFixed(2)} km`;
  return `${truth.object_id ?? "UAP"}${where}, true peak ${Math.round(truth.true_peak_nt)} nT`;
}

/** One word for where an event stands: still open, or what the truth made of it. */
export function eventVerdict(event: MagEvent): string {
  if (event.active) return "detecting";
  if (!event.truth) return "closed";
  return event.truth.label === "true" ? "UAP" : "false alarm";
}

/** An event is worth drawing on the map while it is open and for a minute after. */
export function isRecent(event: MagEvent | null, nowMs: number, lingerMs = 60_000): boolean {
  if (!event) return false;
  return event.active || (event.end_ms !== null && nowMs - event.end_ms <= lingerMs);
}

/** "#dc2626" with an alpha, as rgba(): the badge's pulse fades the state colour. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * P(Z > z) for a standard normal, to ~1e-7 relative accuracy everywhere
 * (Numerical Recipes' erfcc Chebyshev fit), which matters in the far tail
 * where a threshold lives: at 6σ an absolute-error approximation would be
 * off by orders of magnitude.
 */
export function normalTail(z: number): number {
  const x = z / Math.SQRT2;
  const t = 1 / (1 + 0.5 * Math.abs(x));
  const erfc =
    t *
    Math.exp(
      -x * x -
        1.26551223 +
        t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return 0.5 * (x >= 0 ? erfc : 2 - erfc);
}

/**
 * False alarms per node-hour the server's model predicts at a threshold:
 * coefficient · z^power · P(Z > z), fitted to the detector's benchmark
 * (backend/services/sim_magnetometer.py, FALSE_ALARM_COEFFICIENT).
 */
export function predictedFalseAlarmsPerHour(
  thresholdSigma: number,
  model: { coefficient: number; power: number },
): number {
  return model.coefficient * thresholdSigma ** model.power * normalTail(thresholdSigma);
}

/** "about one every 40 hours across 8 magnetometers" */
export function fleetFalseAlarmInterval(perNodeHour: number, nodes: number): string {
  const fleet = Math.max(nodes, 1);
  const perHour = perNodeHour * fleet;
  const who = fleet === 1 ? "one magnetometer" : `${fleet} magnetometers`;
  if (!(perHour > 0)) return `never across ${who}`;
  if (perHour >= 1.5) return `about ${Math.round(perHour)} an hour across ${who}`;
  const hours = 1 / perHour;
  if (hours < 1.5) return `about one an hour across ${who}`;
  if (hours < 48) return `about one every ${Math.round(hours)} hours across ${who}`;
  if (hours < 24 * 365) return `about one every ${Math.round(hours / 24)} days across ${who}`;
  return `less than one a year across ${who}`;
}
