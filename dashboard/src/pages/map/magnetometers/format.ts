/**
 * Words and numbers for the magnetometer layer, kept pure so they can be
 * tested without a map.
 */
import type { MagDetail, MagEvent, MagNetwork, MagSettings, MagState, MagStats } from "./types";

export const STATE_LABEL: Record<MagState, string> = {
  warming_up: "Warming up",
  quiet: "Quiet",
  elevated: "Elevated",
  alarm: "Detecting",
  stale: "No data",
};

/** Whether the server's state is one this layer knows how to draw. */
export function isKnownState(state: string): state is MagState {
  return Object.prototype.hasOwnProperty.call(STATE_LABEL, state);
}

/**
 * The words for a state: its label, or for one this layer does not know yet,
 * the server's own word for it ("re_placing" reads "Re placing"), so a new
 * state on the server shows up as itself rather than taking the layer down.
 */
export function stateLabel(state: MagState): string {
  if (isKnownState(state)) return STATE_LABEL[state];
  const words = String(state).replace(/_/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Unknown";
}

/**
 * The server subtracts the network's common mode only with this many
 * magnetometers or more reporting (sim_magnetometer.py, COMMON_MODE_MIN_NODES):
 * with fewer, a median of the others lets one site's UAP into the rest.
 */
export const COMMON_MODE_MIN_NODES = 6;

/** Too few for that, in words, for every caption that says so. */
export const TOO_FEW_FOR_COMMON_MODE = "fewer than six magnetometers";

/**
 * Which palette entry a state is drawn in: the map's quality scale, GOOD,
 * WARN and ANOMALY, with grey for a magnetometer that has no verdict to give.
 *
 * Quiet used to wear the node colour, so the badge matched the radar dot
 * beside it. On the dark map that yellow sits CIEDE2000 5.1 from WARN's amber,
 * and quiet and elevated read as one colour. The quality scale keeps every
 * pair of states at least 24.8 apart in light and 37.7 in dark, past the
 * palette's own worst pair (20.1 and 20.0). The badge's shape tells the
 * states apart as well (badge.ts), for anyone who cannot tell the colours.
 */
export function stateColourKey(state: MagState): "GOOD" | "WARN" | "ANOMALY" | "INK_SUBTLE" {
  switch (state) {
    case "alarm":
      return "ANOMALY";
    case "elevated":
      return "WARN";
    case "quiet":
      return "GOOD";
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

const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹";

/**
 * A rate per node-hour, measured or predicted, to two significant figures:
 * "0.013", "0.00028", and below a ten-thousandth in powers of ten
 * ("5.0 × 10⁻⁵"), where a row of zeros stops being readable. The server
 * sends three significant figures, so a tiny bound is never a flat 0.
 */
export function formatPerNodeHour(x: number): string {
  if (x === 0) return "0";
  if (x >= 1e-4) return String(Number(x.toPrecision(2)));
  const [mantissa, exponent] = x.toExponential(1).split("e");
  const power = String(Math.abs(Number(exponent)))
    .split("")
    .map((d) => SUPERSCRIPT[Number(d)])
    .join("");
  return `${mantissa} × 10⁻${power}`;
}

/**
 * Node-hours, as many places as they need: a tenth of one is the search of a
 * few minutes, so the first hour is in two significant figures ("0.044"),
 * where one decimal wrote "0.0"; from there on to a tenth, and from a hundred
 * whole and grouped as the map writes a count ("61,235").
 */
export function formatNodeHours(hours: number): string {
  if (!(hours > 0)) return "0";
  if (hours < 1) return String(Number(hours.toPrecision(2)));
  if (hours < 99.95) return hours.toFixed(1);
  return Math.round(hours).toLocaleString();
}

/** "3 in 240 node-hours searched": the exposure, the hours the search actually ran. */
function exposure(stats: MagStats): string {
  return `${stats.false_alarms.toLocaleString()} in ${formatNodeHours(stats.node_hours)} node-hours searched`;
}

/** The scorecard's false-alarm rate, with its interval, in words a person can check. */
export function formatFalseAlarmRate(stats: MagStats | null | undefined): string {
  if (!stats || stats.false_alarms_per_node_hour === null) return "measuring…";
  const ci = stats.false_alarms_per_node_hour_ci95;
  const interval = ci ? ` (95 %: ${formatPerNodeHour(ci[0])}–${formatPerNodeHour(ci[1])})` : "";
  return `${formatPerNodeHour(stats.false_alarms_per_node_hour)} per node-hour${interval}, ${exposure(stats)}`;
}

/** "3 in 240 node-hours searched": the false alarms the scorecard has counted. */
export function formatFalseAlarmCount(stats: MagStats): string {
  if (stats.false_alarms_per_node_hour === null) return "measuring…";
  return exposure(stats);
}

/** "0.013 per node-hour, 95 %: 0.0026–0.037": the rate behind that count. */
export function formatFalseAlarmInterval(stats: MagStats): string | null {
  const rate = stats.false_alarms_per_node_hour;
  if (rate === null) return null;
  const ci = stats.false_alarms_per_node_hour_ci95;
  return `${formatPerNodeHour(rate)} per node-hour${ci ? `, 95 %: ${formatPerNodeHour(ci[0])}–${formatPerNodeHour(ci[1])}` : ""}`;
}

/** A time in seconds as the server sends it (two places): "8 s", "16.4 s". */
export function formatSeconds(seconds: number): string {
  return Math.abs(seconds - Math.round(seconds)) < 0.05 ? `${Math.round(seconds)} s` : `${seconds.toFixed(1)} s`;
}

/** The detector's six time scales, in readings: a scale of τ needs 8τ + 1 of them unbroken. */
const SCALES_READINGS = [2, 4, 8, 16, 32, 64];
const readingsFor = (tau: number) => 8 * tau + 1;

/**
 * Which time scales a magnetometer searches, from the longest the server
 * says it covers: all six once enough unbroken readings are in, and until
 * then how long the rest will take at most. Null while it is warming up and
 * searches none. Seconds, at the network's own spacing of readings.
 */
export function searchedScales(
  longestS: number | null,
  periodS: number | null,
): { text: string; complete: boolean } | null {
  if (longestS === null) return null;
  const period = periodS ?? 1;
  const longest = SCALES_READINGS.reduce((best, tau) =>
    Math.abs(tau * period - longestS) < Math.abs(best * period - longestS) ? tau : best,
  );
  const shortest = formatSeconds(SCALES_READINGS[0] * period).replace(" s", "");
  const full = SCALES_READINGS[SCALES_READINGS.length - 1];
  const range = longest === SCALES_READINGS[0] ? `${shortest} s` : `${shortest}–${formatSeconds(longestS)}`;
  if (longest === full) return { text: range, complete: true };
  const minutes = Math.ceil(((readingsFor(full) - readingsFor(longest)) * period) / 60);
  return { text: `${range}; up to ${formatSeconds(full * period)} within ${minutes} min`, complete: false };
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

/** The least of 1, 1.5, 2, 2.5, 3, 4, 5, 6 and 8 times a power of ten that is at least `least`. */
function roundStep(least: number): number {
  const power = 10 ** Math.floor(Math.log10(least));
  return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * power).find((step) => step >= least * (1 - 1e-9)) ?? 10 * power;
}

/**
 * The residual chart's vertical axis: even about zero, so a pass reads the
 * same way up on all three axes, out to the largest excursion on a round
 * step, two steps either side. Left to its own ticks the chart chose them
 * for the space and then dropped some ("−60, −30, 0, 60").
 */
export function residualAxis(values: readonly number[], leastNt = 10): { max: number; ticks: number[] } {
  let peak = leastNt;
  for (const v of values) if (Number.isFinite(v)) peak = Math.max(peak, Math.abs(v));
  const step = roundStep(peak / 2);
  const max = step * Math.ceil(peak / step - 1e-9);
  const n = Math.round(max / step);
  const ticks = Array.from({ length: 2 * n + 1 }, (_, i) => Number(((i - n) * step).toPrecision(12)));
  return { max: Number(max.toPrecision(12)), ticks };
}

/**
 * The measured-field chart's vertical axis: the readings with a tenth of
 * their spread either side, never narrower than `minSpanNt`, on ticks a round
 * step apart. A quiet sensor's few nT of noise on 48,600 nT would otherwise
 * fill the chart and look like a signal, and a fixed window left to the
 * chart's own ticks gets unevenly spaced ones.
 */
export function fieldAxis(
  values: readonly number[],
  minSpanNt = 40,
): { min: number; max: number; ticks: number[] } | null {
  if (!values.length) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const span = Math.max(hi - lo, minSpanNt) * 1.2;
  const step = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].find((s) => s >= span / 4) ?? 10_000;
  const mid = (lo + hi) / 2;
  const min = Math.floor((mid - span / 2) / step) * step;
  const max = Math.ceil((mid + span / 2) / step) * step;
  const ticks = Array.from({ length: Math.round((max - min) / step) + 1 }, (_, i) => min + i * step);
  return { min, max, ticks };
}

/** One reading as the panel charts it: the detail's series, row by row. */
export interface ChartRow {
  t: number;
  x: number | null;
  y: number | null;
  z: number | null;
  residual: number | null;
  score: number | null;
  bx: number | null;
  by: number | null;
  bz: number | null;
  b: number | null;
}

/**
 * Readings further apart than this have a hole between them: the server's
 * HOLE_S, across which no detector window reaches.
 */
const HOLE_MS = 5_000;

/** A value of a series, or null where the series has none (or is not sent at all). */
function at(values: readonly (number | null)[] | undefined, i: number): number | null {
  const v = values?.[i];
  return typeof v === "number" ? v : null;
}

/**
 * The detail's series as rows for the charts, with a row of nothing wherever
 * the readings stopped for longer than a hole, so every line breaks there
 * rather than drawing straight across it. Nulls stay null: no residual before
 * the static level, no score while the detector cannot score, and no measured
 * field from a server that does not send one.
 */
export function chartRows(series: MagDetail["series"] | undefined): ChartRow[] {
  if (!series || !Array.isArray(series.t)) return [];
  const rows: ChartRow[] = [];
  series.t.forEach((t, i) => {
    const prev = series.t[i - 1];
    if (prev !== undefined && t - prev > HOLE_MS) {
      rows.push({ t: (prev + t) / 2, x: null, y: null, z: null, residual: null, score: null, bx: null, by: null, bz: null, b: null });
    }
    rows.push({
      t,
      x: at(series.x, i),
      y: at(series.y, i),
      z: at(series.z, i),
      residual: at(series.residual, i),
      score: at(series.score, i),
      bx: at(series.bx, i),
      by: at(series.by, i),
      bz: at(series.bz, i),
      b: at(series.b, i),
    });
  });
  return rows;
}

/** The charts' time window: the ten minutes the panel asks for, up to the last reading. */
export const CHART_WINDOW_MS = 600_000;

/**
 * Ticks for a time axis, on whole local minutes a round step apart. The
 * charts label a tick HH:MM, and one that fell between minutes was labelled
 * with its minute truncated, so evenly spaced ticks read unevenly.
 */
export function minuteTicks(startMs: number, endMs: number, maxTicks = 5): number[] {
  if (!(endMs > startMs)) return [];
  const spanMin = (endMs - startMs) / 60_000;
  const step = [1, 2, 5, 10, 15, 30].find((s) => spanMin / s <= maxTicks) ?? 60;
  const first = new Date(startMs);
  first.setSeconds(0, 0);
  const minute = first.getMinutes();
  first.setMinutes(minute + ((step - (minute % step)) % step));
  if (first.getTime() < startMs) first.setMinutes(first.getMinutes() + step);
  const ticks: number[] = [];
  for (let t = first.getTime(); t <= endMs; t += step * 60_000) ticks.push(t);
  return ticks;
}

/** The server clips a score at 40σ, beyond which it means nothing more. */
export const SCORE_CLIP_SIGMA = 40;

/**
 * "7.2σ", or "≥ 40σ" at the server's clip. Never below zero: a detection
 * score says how far the data is from noise, and the server publishes none
 * below it, so a rounding -0.0 is not shown either.
 */
export function formatScore(scoreSigma: number): string {
  if (scoreSigma >= SCORE_CLIP_SIGMA) return `≥ ${SCORE_CLIP_SIGMA}σ`;
  return `${Math.max(0, scoreSigma).toFixed(1)}σ`;
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

/**
 * Whether an event is being followed right now: open, on a magnetometer that
 * is still reporting. The server closes an event only when new readings show
 * the pass is over, so one whose magnetometer fell silent (or was taken away,
 * `state` undefined) stays open there without anything watching it.
 */
export function isLive(event: MagEvent | null, state: MagState | undefined): boolean {
  return Boolean(event?.active) && state !== undefined && state !== "stale";
}

/**
 * One word for where an event stands: detecting while it is live, "no data"
 * while it is open on a silent magnetometer, and once closed what the truth
 * made of it.
 */
export function eventVerdict(event: MagEvent, live = event.active): string {
  if (live) return "detecting";
  if (event.active) return "no data";
  if (!event.truth) return "closed";
  return event.truth.label === "true" ? "UAP" : "false alarm";
}

/**
 * An event is worth drawing on the map while it is open and for a minute
 * after. One left open on a magnetometer that went silent at `silentSinceMs`
 * is taken to have ended then.
 */
export function isRecent(
  event: MagEvent | null,
  nowMs: number,
  lingerMs = 60_000,
  silentSinceMs: number | null = null,
): boolean {
  if (!event) return false;
  if (event.active && silentSinceMs === null) return true;
  const end = event.end_ms ?? silentSinceMs;
  return end !== null && nowMs - end <= lingerMs;
}

/**
 * Whether the network's common mode is being left in, and why: switched off;
 * enough magnetometers placed and reporting but too few yet with the static
 * level the server counts (each sets one in its first two minutes, so this
 * is every start and re-placement); or too few reporting at all. Null while
 * it is being removed. The server says whether; the setting alone does not.
 */
export function commonModeLeftIn(network: MagNetwork): "off" | "warming" | "too-few" | null {
  if (network.detector.common_mode_applied) return null;
  if (!network.settings.mag_common_mode) return "off";
  const reporting = network.nodes.filter((n) => n.state !== "stale");
  const levelled = reporting.filter((n) => n.residual_nt !== null);
  return reporting.length >= COMMON_MODE_MIN_NODES && levelled.length < COMMON_MODE_MIN_NODES ? "warming" : "too-few";
}

/**
 * Where settings put the detector outside its false-alarm model, every
 * reason, as words that follow "not calibrated with"; none where it holds.
 * The model was fitted to sensor noise and daily variation with the common
 * mode removed (which the server does only with COMMON_MODE_MIN_NODES or
 * more) and a reading a second, which no setting changes.
 */
export function modelGaps(settings: Pick<MagSettings, "mag_storm" | "mag_common_mode" | "mag_n_nodes">): string[] {
  const gaps: string[] = [];
  if (settings.mag_storm) gaps.push("a storm");
  if (!settings.mag_common_mode) gaps.push("the common mode left in");
  else if (settings.mag_n_nodes < COMMON_MODE_MIN_NODES) gaps.push(TOO_FEW_FOR_COMMON_MODE);
  return gaps;
}

/** The spacing of readings the model was fitted at. */
const MODEL_PERIOD_S = 1;

/**
 * Why the readings' spacing keeps the noise model from holding, in the same
 * words as the other reasons, or null if it does not. Whether it holds is the
 * server's word (reading_period_calibrated): it judges the unrounded spacing,
 * with a margin so a spacing near the edge does not flicker, and the figure
 * it sends, rounded, is only the explanation.
 */
export function readingsGap(network: Pick<MagNetwork, "detector">): string | null {
  const { reading_period_s: period, reading_period_calibrated: holds } = network.detector;
  if (holds) return null;
  if (period === null || period === undefined) return "the readings' spacing not yet measured";
  return `readings ${Number(period.toFixed(2))} s apart, not ${MODEL_PERIOD_S} s`;
}

/**
 * Every reason the network as it runs is outside the model, on the server's
 * word that it is: a storm, the common mode not subtracted (and why), the
 * readings' spacing. None while the model holds.
 */
export function runningModelGaps(network: MagNetwork): string[] {
  if (network.detector.false_alarm_model.calibrated) return [];
  const gaps: string[] = [];
  if (network.storm) gaps.push("a storm running");
  const leftIn = commonModeLeftIn(network);
  if (leftIn === "off") gaps.push("the common mode left in");
  else if (leftIn === "warming") gaps.push("the magnetometers still warming up");
  else if (leftIn === "too-few") gaps.push(`${TOO_FEW_FOR_COMMON_MODE} reporting`);
  const readings = readingsGap(network);
  if (readings) gaps.push(readings);
  // The server's word that the model does not hold, for a reason it does not name.
  return gaps.length ? gaps : ["the settings now running"];
}

/**
 * The fleet's clock now. Readings, events and `last_ms` carry the fleet's
 * time, and `now_ms` the server's, which may be minutes apart: measured
 * against the server's clock, a fleet running two minutes behind would put
 * two minutes of silence after every reading. So: the latest reading any
 * magnetometer sent, moved on by the time since the server took in the last
 * push (both of those on the server's clock).
 */
export function fleetNow(network: Pick<MagNetwork, "nodes" | "now_ms" | "updated_ms">): number {
  let latest = 0;
  for (const node of network.nodes) latest = Math.max(latest, node.last_ms || 0);
  if (!(latest > 0) || !(network.updated_ms > 0)) return network.now_ms;
  return latest + Math.max(0, network.now_ms - network.updated_ms);
}

/** "1 push", "3 pushes" */
function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/**
 * What the server has turned away from the fleet since it started, in plain
 * words, or null while it has turned nothing away. A push refused whole is
 * readings lost, since the fleet drops it; an entry skipped is a
 * magnetometer the server will not publish.
 */
export function fleetRefusals(detector: Partial<Pick<MagNetwork["detector"], "pushes_refused" | "entries_rejected">>): string | null {
  const refused = detector.pushes_refused ?? 0;
  const skipped = detector.entries_rejected ?? 0;
  if (refused <= 0 && skipped <= 0) return null;
  const parts: string[] = [];
  if (refused > 0) parts.push(`refused ${count(refused, "push", "pushes")} from the fleet (${refused === 1 ? "its" : "their"} readings are lost)`);
  if (skipped > 0) {
    parts.push(
      `skipped ${count(skipped, "entry", "entries")} it does not publish: a host that is not a synthetic radar node, an id not starting mag-, or a position off the globe`,
    );
  }
  return `Since it started, the server has ${parts.join(" and ")}.`;
}

/** "a, b and c" */
export function joinReasons(reasons: string[]): string {
  if (reasons.length <= 1) return reasons.join("");
  return `${reasons.slice(0, -1).join(", ")} and ${reasons[reasons.length - 1]}`;
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
 * (backend/services/sim_magnetometer.py, FALSE_ALARM_COEFFICIENT). It holds
 * only where the fit did: see modelGaps and runningModelGaps.
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
