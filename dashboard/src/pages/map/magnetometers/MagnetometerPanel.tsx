import { memo, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useChartTheme, type ChartTheme } from "../../../utils/chartTheme";
import type { MapPalette } from "../mapPalette";
import { usePalette } from "../useMapTheme";
import {
  CHART_WINDOW_MS,
  chartRows,
  commonModeLeftIn,
  eventVerdict,
  fieldAxis,
  fleetNow,
  formatConfidence,
  formatNoiseInterval,
  formatRange,
  formatScore,
  formatSeconds,
  isKnownState,
  isLive,
  joinReasons,
  minuteTicks,
  residualAxis,
  runningModelGaps,
  scoreAxis,
  searchedScales,
  stateLabel,
  TOO_FEW_FOR_COMMON_MODE,
  truthText,
  type ChartRow,
} from "./format";
import {
  DEFAULT_PASS,
  flybyCaveat,
  flybyDue,
  flybyErrorText,
  requestFlyby,
  useFlybyMessage,
  type RequestedFlyby,
} from "./flyby";
import MagnetometerGlyph from "./MagnetometerGlyph";
import { useMagnetometerDetail } from "./useMagnetometers";
import type { MagEvent, MagNetwork, MagNode, MagState } from "./types";
import "./magnetometers.css";

/** The residual's axes, in the chart theme's first three series colours; the measured field's components wear the same. */
const AXES: ["x" | "y" | "z", "bx" | "by" | "bz", string, string][] = [
  ["x", "bx", "X north", "North"],
  ["y", "by", "Y east", "East"],
  ["z", "bz", "Z down", "Down"],
];

const time = (t: number) => new Date(t).toLocaleTimeString();
const tickTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
/** A field value in a tooltip: to a tenth of a nT, grouped as its axis is ("48,701.3 nT"). */
const nt = (value: number) => `${value.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} nT`;
/** A whole number of nT in a field, grouped as the map writes an altitude. */
const wholeNt = (value: number) => Math.round(value).toLocaleString();
/** An axis's value: grouped, as the tooltips are. */
const axisNt = (value: number) => value.toLocaleString();

/**
 * The three charts share one frame, so a moment sits at the same x on each
 * and their tooltips agree: the same margins, and value axes of one width.
 */
const CHART_MARGIN = { top: 4, right: 6, bottom: 0, left: 0 };
const VALUE_AXIS_WIDTH = 44;

/** The charts' ten minutes, and their whole-minute ticks. */
interface TimeFrame {
  domain: [number, number];
  ticks: number[];
}

/**
 * One magnetometer, beside the map: its state; the last ten minutes of its
 * detection score against the threshold, of its residual (what is left once
 * its static level and, where it is applied, the network's common mode are
 * taken away) and of the field it measured; and its events with the truth
 * behind each. A button flies a UAP past it, so a detection can be watched
 * from start to finish without leaving the map.
 *
 * The frame stays while the body is keyed by magnetometer: opening another
 * starts its body afresh (its detail, a flyby still on its way, the message
 * after one) without the panel sliding in again.
 */
export default function MagnetometerPanel({
  nodeId,
  network,
  onClose,
}: {
  nodeId: string;
  network: MagNetwork;
  onClose: () => void;
}) {
  const node = network.nodes.find((n) => n.node_id === nodeId) ?? null;
  return (
    <div className="detail-panel mag-panel" role="region" aria-label="Magnetometer">
      <div className="detail-panel-header">
        <h3>Magnetometer</h3>
        <button className="close-btn" onClick={onClose} title="Close" aria-label="Close">
          ×
        </button>
      </div>
      <div className="detail-panel-body">
        {node ? <PanelBody key={nodeId} node={node} network={network} /> : <GoneBody nodeId={nodeId} network={network} />}
      </div>
    </div>
  );
}

/** A magnetometer the simulator has taken away: nothing left to ask the server for. */
function GoneBody({ nodeId, network }: { nodeId: string; network: MagNetwork }) {
  // Its events outlive it, and say which radar node it sat beside.
  const host = network.events.find((e) => e.node_id === nodeId)?.host_node_id ?? nodeId.replace(/^mag-/, "");
  return (
    <div className="detail-section">
      <div className="detail-section-title">Sensor</div>
      <Field label="Beside radar node" value={host} />
      <p className="mag-notice">
        No longer placed: the simulator has taken this magnetometer away (fewer magnetometers, a new placement or a
        server restart), and its readings went with it.
      </p>
    </div>
  );
}

function PanelBody({ node, network }: { node: MagNode; network: MagNetwork }) {
  const palette = usePalette();
  const chart = useChartTheme();
  const { detail, failed } = useMagnetometerDetail(node.node_id);
  // The flyby asked for here, said as it stands: on its way, passed, then gone.
  const [requested, setRequested] = useState<RequestedFlyby | null>(null);
  const [flybyError, setFlybyError] = useState<string | null>(null);
  const flybyText = useFlybyMessage(requested);
  const [flying, setFlying] = useState(false);

  // Rebuilt only when a new detail lands, not at every poll of the network:
  // the charts below redraw from these alone.
  const rows = useMemo(() => chartRows(detail?.series), [detail]);
  // A magnetometer that has stopped reporting is charted up to now, so its
  // charts end in the silence rather than at its last reading, where they
  // would pass for current. Now by the fleet's clock, as its readings are: a
  // fleet minutes behind the server's would otherwise show minutes of silence
  // that are not there. While it reports, its last reading is now enough,
  // and the network's polls leave the charts alone.
  const silentUntilMs = node.state === "stale" ? fleetNow(network) : null;
  // The whole ten minutes the panel asks for, whatever stretch of it has
  // readings: after a start or a restart they cover seconds, and ticks on
  // their own span all read the same minute.
  const frame = useMemo<TimeFrame | null>(() => {
    if (!rows.length) return null;
    const end = Math.max(rows[rows.length - 1].t, silentUntilMs ?? -Infinity);
    return { domain: [end - CHART_WINDOW_MS, end], ticks: minuteTicks(end - CHART_WINDOW_MS, end) };
  }, [rows, silentUntilMs]);
  // Seconds of readings in ten minutes of chart are a sliver at its right
  // edge: said in words while the magnetometer is still filling them.
  const span = rows.length ? rows[rows.length - 1].t - rows[0].t : null;
  const collecting =
    span !== null && span < 60_000 && node.state !== "stale"
      ? span < 1_000
        ? "Only one reading so far: it sits at the right edge of the charts, which fill in as more arrive."
        : `Only ${Math.round(span / 1000)} s of readings so far: they sit at the right edge of the charts, which fill in as more arrive.`
      : null;
  const notes = useMemo(() => {
    // Until this magnetometer's own answer is in, its charts say why they
    // are empty rather than showing anything else. The server sends the ten
    // minutes up to its last reading, which for one silent longer than that
    // all fall before the charts' ten minutes.
    const detailNote = failed
      ? "Could not load the last ten minutes; trying again."
      : !detail
        ? "Loading the last ten minutes…"
        : rows.length && frame && rows[rows.length - 1].t >= frame.domain[0]
          ? null
          : "No readings in the last 10 minutes.";
    return {
      field: detailNote ?? (rows.some((r) => r.b !== null) ? null : "The server sent no measured field."),
      score:
        detailNote ??
        (rows.some((r) => r.score !== null)
          ? null
          : "Not scoring yet: the detector needs a static level, a noise estimate and a run of unbroken readings."),
      residual:
        detailNote ??
        (rows.some((r) => r.x !== null)
          ? null
          : "No residual yet: it starts once the static level is set from the first two minutes of readings."),
    };
  }, [detail, failed, rows, frame]);

  async function flyUap() {
    setFlying(true);
    try {
      const { seq } = await requestFlyby(node.node_id, DEFAULT_PASS);
      // The fleet picks the request up within one config poll and times the
      // pass from then: "about" that time, give or take the poll.
      setRequested({ seq, host: node.host_node_id, dueMs: flybyDue(Date.now(), DEFAULT_PASS.lead_s), onMap: true });
      setFlybyError(null);
    } catch (e) {
      setFlybyError(`Error: ${flybyErrorText((e as Error).message)}`);
    } finally {
      setFlying(false);
    }
  }

  const threshold = network.settings.mag_threshold_sigma;
  const leftIn = commonModeLeftIn(network);
  // The network's word on the event, which also gives the state; failing
  // that the detail's latest closed one, which a magnetometer put back after
  // being taken away has on record but not as its own.
  const current = node.event ?? detail?.events.find((e) => !e.active) ?? null;
  const live = isLive(current, node.state);
  const interrupted = Boolean(current?.active) && !live;
  // An open event is current by definition, even one the network has not
  // reported yet: the two are polled apart.
  const earlier = detail ? detail.events.filter((e) => !e.active && e.event_id !== current?.event_id).slice(0, 5) : [];
  // |B| and its components from one reading, the detail's last.
  const last = rows.length ? rows[rows.length - 1] : null;
  const caveat = flybyCaveat(node.state);
  const scoring = node.state === "quiet" || node.state === "elevated" || node.state === "alarm";
  // What it is searching says nothing once it has stopped reporting.
  const searched =
    node.state === "stale" ? "—" : (searchedScales(node.longest_scale_s, network.detector.reading_period_s)?.text ?? "none yet");

  return (
    <>
      <div className="detail-section">
        <div className="detail-section-title">Sensor</div>
        <Field label="Beside radar node" value={node.host_node_id} />
        <Field label="State" value={<StateText state={node.state} />} />
        <Field
          label="Detection score"
          value={
            scoring
              ? `${formatScore(node.score_sigma)} of ${threshold.toFixed(1)}σ`
              : node.state === "warming_up"
                ? "not scoring yet"
                : "—"
          }
        />
        <Field label="Best time scale" value={scoring && node.score_tau_s ? formatSeconds(node.score_tau_s) : "—"} />
        <Field label="Time scales searched" value={searched} />
        <Field label="|B|" value={last && last.b !== null ? `${wholeNt(last.b)} nT` : "—"} />
        <Field
          label="North, east, down"
          value={
            last && last.bx !== null && last.by !== null && last.bz !== null
              ? `${wholeNt(last.bx)}, ${wholeNt(last.by)}, ${wholeNt(last.bz)} nT`
              : "—"
          }
        />
        <Field label="Residual" value={node.residual_nt === null ? "—" : `${node.residual_nt.toFixed(1)} nT`} />
        <Field label="Noise (σ)" value={node.sigma_nt === null ? "measuring…" : `${node.sigma_nt.toFixed(1)} nT`} />
        <Field label="Sensor" value={`${network.sensor.model ?? "RM3100"}, ${network.sensor.cycle_count ?? "—"} cycles`} />
        <div className="mag-flyby">
          <button className="btn btn-secondary" onClick={flyUap} disabled={flying}>
            {flying ? "Requesting…" : "Fly a UAP past it"}
          </button>
          {caveat && <div className="mag-caveat">{caveat}</div>}
          {flybyError ? (
            <div className="mag-error">{flybyError}</div>
          ) : (
            <div className="mag-chart-caption">
              {flybyText ??
                `${DEFAULT_PASS.closest_approach_m} m to one side and ${DEFAULT_PASS.altitude_m} m up, at ${DEFAULT_PASS.speed_mps} m/s. The radar nodes see it too.`}
            </div>
          )}
        </div>
      </div>

      {collecting && <p className="mag-notice">{collecting}</p>}
      <ScoreChart rows={rows} frame={frame} threshold={threshold} note={notes.score} chart={chart} palette={palette} />
      <ResidualChart rows={rows} frame={frame} note={notes.residual} leftIn={leftIn} chart={chart} />
      <FieldChart rows={rows} frame={frame} note={notes.field} chart={chart} />

      {current && (
        <div className="detail-section">
          <div className={`detail-section-title${live ? " mag-live-title" : ""}`}>
            {live ? "Detecting now" : interrupted ? "Detection interrupted" : "Last detection"}
          </div>
          {interrupted && (
            <p className="mag-notice">
              No readings since {time(node.last_ms)}, so this detection cannot close. It will once they resume.
            </p>
          )}
          <EventFields event={current} modelNow={runningModelGaps(network)} />
        </div>
      )}

      {earlier.length > 0 && (
        <div className="detail-section">
          <div className="detail-section-title">Earlier here</div>
          {earlier.map((e) => (
            <Field
              key={e.event_id}
              label={time(e.peak_ms)}
              value={`${Math.round(e.strength_nt)} nT, ${formatScore(e.score_sigma)}, ${eventVerdict(e)}`}
            />
          ))}
        </div>
      )}
    </>
  );
}

interface ChartProps {
  rows: ChartRow[];
  /** Null only with no rows, when the chart shows its note instead. */
  frame: TimeFrame | null;
  note: string | null;
  chart: ChartTheme;
}

/** The time axis every chart shares: the frame's ten minutes, its ticks on whole minutes. */
function timeAxis(frame: TimeFrame | null, chart: ChartTheme) {
  return (
    <XAxis
      dataKey="t"
      type="number"
      domain={frame?.domain ?? ["dataMin", "dataMax"]}
      ticks={frame?.ticks}
      interval={0}
      allowDataOverflow
      tickFormatter={tickTime}
      stroke={chart.axis}
      tick={{ fontSize: 10 }}
    />
  );
}

const ScoreChart = memo(function ScoreChart({
  rows,
  frame,
  threshold,
  note,
  chart,
  palette,
}: ChartProps & { threshold: number; palette: MapPalette }) {
  const axis = scoreAxis(threshold, rows.reduce((peak, r) => Math.max(peak, r.score ?? 0), 0));
  return (
    <ChartSection
      title="Detection score, last 10 min"
      label={`Detection score over the last ten minutes, against the ${threshold.toFixed(1)}σ threshold`}
      note={note}
      caption="Dashed: the threshold. The score is the best match to a passing dipole over six time scales."
    >
      <LineChart data={rows} margin={CHART_MARGIN}>
        <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
        {timeAxis(frame, chart)}
        <YAxis
          width={VALUE_AXIS_WIDTH}
          stroke={chart.axis}
          tick={{ fontSize: 10 }}
          domain={[0, axis.max]}
          ticks={axis.ticks}
          interval={0}
          allowDataOverflow
        />
        <Tooltip
          contentStyle={chart.tooltip}
          cursor={chart.cursor}
          labelFormatter={time}
          formatter={(value: number) => [formatScore(value), "score"]}
        />
        <ReferenceLine y={threshold} stroke={palette.ANOMALY} strokeDasharray="4 3" />
        <Line type="monotone" dataKey="score" stroke={chart.series[4]} dot={false} strokeWidth={1.5} isAnimationActive={false} />
      </LineChart>
    </ChartSection>
  );
});

const ResidualChart = memo(function ResidualChart({
  rows,
  frame,
  note,
  leftIn,
  chart,
}: ChartProps & { leftIn: ReturnType<typeof commonModeLeftIn> }) {
  const axis = useMemo(() => residualAxis(rows.flatMap((r) => [r.x, r.y, r.z].filter((v): v is number => v !== null))), [rows]);
  return (
    <ChartSection
      title="Residual field, last 10 min (nT)"
      label="Residual field over the last ten minutes, north, east and down"
      note={note}
      legend={
        <ul className="mag-chart-key" aria-label="Residual axes">
          {AXES.map(([key, , label], i) => (
            <li key={key}>
              <span className="mag-key-swatch" style={{ background: chart.series[i] }} />
              {label}
            </li>
          ))}
        </ul>
      }
      caption={
        leftIn === null
          ? "What is left after the static level and the network's common mode are removed."
          : "What is left after the static level is removed."
      }
      caveat={
        leftIn === null
          ? null
          : `The common mode is left in: ${
              leftIn === "off"
                ? "it is switched off"
                : leftIn === "warming"
                  ? "it starts once the magnetometers have warmed up"
                  : `${TOO_FEW_FOR_COMMON_MODE} are reporting`
            }.`
      }
    >
      <LineChart data={rows} margin={CHART_MARGIN}>
        <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
        {timeAxis(frame, chart)}
        <YAxis
          width={VALUE_AXIS_WIDTH}
          stroke={chart.axis}
          tick={{ fontSize: 10 }}
          domain={[-axis.max, axis.max]}
          ticks={axis.ticks}
          interval={0}
          tickFormatter={axisNt}
          allowDataOverflow
        />
        <Tooltip
          contentStyle={chart.tooltip}
          cursor={chart.cursor}
          labelFormatter={time}
          formatter={(value: number, name: string) => [nt(value), name.toUpperCase()]}
        />
        {AXES.map(([key], i) => (
          <Line key={key} type="monotone" dataKey={key} stroke={chart.series[i]} dot={false} strokeWidth={1} isAnimationActive={false} />
        ))}
      </LineChart>
    </ChartSection>
  );
});

/**
 * |B| as measured, on a window framed round its readings (fieldAxis), with
 * its north, east and down components in the tooltip: drawn on one axis with
 * it they would only be three flat lines tens of thousands of nT apart.
 */
const FieldChart = memo(function FieldChart({ rows, frame, note, chart }: ChartProps) {
  const scale = useMemo(() => fieldAxis(rows.flatMap((r) => (r.b === null ? [] : [r.b]))), [rows]);
  return (
    <ChartSection
      title="Measured field |B|, last 10 min (nT)"
      label="Measured field strength over the last ten minutes"
      note={note}
      caption="What the sensor reads before anything is taken away: the Earth's field here, with the daily variation, any storm and any pass on top. Its north, east and down components are in the tooltip."
    >
      <LineChart data={rows} margin={CHART_MARGIN}>
        <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
        {timeAxis(frame, chart)}
        <YAxis
          stroke={chart.axis}
          tick={{ fontSize: 10 }}
          width={VALUE_AXIS_WIDTH}
          domain={scale ? [scale.min, scale.max] : ["auto", "auto"]}
          ticks={scale?.ticks}
          interval={0}
          tickFormatter={axisNt}
          allowDataOverflow
        />
        <Tooltip
          contentStyle={chart.tooltip}
          cursor={chart.cursor}
          labelFormatter={time}
          includeHidden
          formatter={(value: number) => nt(value)}
        />
        <Line type="monotone" dataKey="b" name="|B|" stroke={chart.series[6]} dot={false} strokeWidth={1.5} isAnimationActive={false} />
        {AXES.map(([, key, , name], i) => (
          <Line key={key} dataKey={key} name={name} stroke={chart.series[i]} hide isAnimationActive={false} />
        ))}
      </LineChart>
    </ChartSection>
  );
});

/**
 * A chart with its title, key and caption, and a caveat after the caption in
 * the warning's ink. Where it has nothing to draw it says why instead. The
 * chart is an image to a screen reader, named for what it shows.
 */
function ChartSection({
  title,
  label,
  note,
  legend,
  caption,
  caveat = null,
  children,
}: {
  title: string;
  label: string;
  note: string | null;
  legend?: ReactNode;
  caption: string;
  caveat?: string | null;
  children: ReactElement;
}) {
  return (
    <div className="detail-section">
      <div className="detail-section-title">{title}</div>
      <div className="mag-chart" role="img" aria-label={note ? `${label}: ${note}` : label}>
        {note ? (
          <div className="mag-chart-empty">{note}</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {children}
          </ResponsiveContainer>
        )}
      </div>
      {legend}
      <div className="mag-chart-caption">{caption}</div>
      {caveat && <div className="mag-caveat">{caveat}</div>}
    </div>
  );
}

/**
 * The state in words, in the console's ink for that state, beside the badge
 * the map draws for it. The map's own colours are measured against the
 * basemap, and as small text on the panel several fall short of 4.5:1.
 */
function StateText({ state }: { state: MagState }) {
  const kind = isKnownState(state) ? state : "unknown";
  return (
    <span className={`mag-state mag-state-${kind}`}>
      <MagnetometerGlyph state={state} />
      {stateLabel(state)}
    </span>
  );
}

/**
 * An event's fields. `modelNow` is why the noise model does not hold as the
 * network runs now, if it does not: the event's own flag says only that it
 * did not when the event opened, not why.
 */
function EventFields({ event, modelNow }: { event: MagEvent; modelNow: string[] }) {
  return (
    <>
      <Field label="Closest approach" value={time(event.peak_ms)} />
      <Field label="Strength" value={`${Math.round(event.strength_nt)} nT`} />
      <Field label="Score" value={formatScore(event.score_sigma)} />
      <Field label="Confidence" value={event.calibrated ? formatConfidence(event.confidence) : "not calibrated"} />
      <Field label="Noise does this" value={event.calibrated ? formatNoiseInterval(event.noise_once_per_h) : "not calibrated"} />
      <Field label="Estimated range" value={formatRange(event.range_km)} />
      <Field label="Time scale (distance ÷ speed)" value={formatSeconds(event.tau_s)} />
      <Field label="Truth" value={truthText(event)} />
      {!event.calibrated && (
        <div className="mag-caveat">
          The noise model holds only with the common mode subtracted, no storm and a reading a second. This
          detection opened while at least one of those was missing, so it carries no confidence.
          {modelNow.length ? ` The model does not hold now either, with ${joinReasons(modelNow)}.` : ""}
        </div>
      )}
    </>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="detail-field">
      <span className="detail-label">{label}</span>
      <span className="detail-value">{value}</span>
    </div>
  );
}
