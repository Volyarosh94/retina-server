import { useState, type ReactNode } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useChartTheme } from "../../../utils/chartTheme";
import { usePalette } from "../useMapTheme";
import {
  formatConfidence,
  formatNoiseInterval,
  formatRange,
  formatScore,
  scoreAxis,
  STATE_LABEL,
  stateColourKey,
  truthText,
} from "./format";
import { DEFAULT_PASS, FLEET_POLL_S, requestFlyby } from "./flyby";
import { useMagnetometerDetail } from "./useMagnetometers";
import type { MagEvent, MagNetwork } from "./types";
import "./magnetometers.css";

/**
 * One magnetometer, beside the map: its state, the last ten minutes of its
 * residual (what is left once its static level and the network's common mode
 * are taken away) and of its detection score against the threshold, and its
 * events with the truth behind each. A button flies a UAP past it, so a
 * detection can be watched from start to finish without leaving the map.
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
  const palette = usePalette();
  const chart = useChartTheme();
  const detail = useMagnetometerDetail(nodeId);
  const [flyby, setFlyby] = useState<{ nodeId: string; message: string } | null>(null);
  const [flying, setFlying] = useState(false);
  const node = network.nodes.find((n) => n.node_id === nodeId);
  if (!node) return null;

  async function flyUap() {
    setFlying(true);
    try {
      const { seq } = await requestFlyby(nodeId, DEFAULT_PASS);
      // The fleet picks the request up within one config poll and times the
      // pass from then: "about" this time, give or take that poll.
      const eta = new Date(Date.now() + (DEFAULT_PASS.lead_s + FLEET_POLL_S) * 1000);
      setFlyby({
        nodeId,
        message: `UAP flyby #${seq ?? "?"} on its way: closest approach at about ${eta.toLocaleTimeString()}.`,
      });
    } catch (e) {
      setFlyby({ nodeId, message: `Error: ${(e as Error).message}` });
    } finally {
      setFlying(false);
    }
  }

  const series = detail?.series;
  const rows = series
    ? series.t.map((t, i) => ({
        t,
        x: series.x[i],
        y: series.y[i],
        z: series.z[i],
        residual: series.residual[i],
        score: series.score[i],
      }))
    : [];
  const threshold = network.settings.mag_threshold_sigma;
  const axis = scoreAxis(threshold, rows.reduce((peak, r) => Math.max(peak, r.score), 0));
  const event = node.event;
  const tickTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const tooltipTime = (t: number) => new Date(t).toLocaleTimeString();

  return (
    <div className="detail-panel mag-panel" role="region" aria-label="Magnetometer">
      <div className="detail-panel-header">
        <h3>Magnetometer</h3>
        <button className="close-btn" onClick={onClose} title="Close">
          ×
        </button>
      </div>
      <div className="detail-panel-body">
        <div className="detail-section">
          <div className="detail-section-title">Sensor</div>
          <Field label="Beside radar node" value={node.host_node_id} />
          <Field
            label="State"
            value={<span style={{ color: palette[stateColourKey(node.state)] }}>{STATE_LABEL[node.state]}</span>}
          />
          <Field label="Detection score" value={`${formatScore(node.score_sigma)} of ${threshold.toFixed(1)}σ`} />
          <Field label="Best time scale" value={node.score_tau_s ? `${node.score_tau_s} s` : "—"} />
          <Field label="|B|" value={node.b_nt === null ? "—" : `${Math.round(node.b_nt).toLocaleString()} nT`} />
          <Field label="Residual" value={node.residual_nt === null ? "—" : `${node.residual_nt.toFixed(1)} nT`} />
          <Field label="Noise (σ)" value={node.sigma_nt === null ? "measuring…" : `${node.sigma_nt.toFixed(1)} nT`} />
          <Field
            label="Sensor"
            value={`${network.sensor.model ?? "RM3100"}, ${network.sensor.cycle_count ?? "—"} cycles`}
          />
          <div className="mag-flyby">
            <button className="btn btn-secondary" onClick={flyUap} disabled={flying}>
              {flying ? "Requesting…" : "Fly a UAP past it"}
            </button>
            <div className="mag-chart-caption">
              {flyby?.nodeId === nodeId
                ? flyby.message
                : `${DEFAULT_PASS.closest_approach_m} m to one side and ${DEFAULT_PASS.altitude_m} m up, at ${DEFAULT_PASS.speed_mps} m/s. The radar nodes see it too.`}
            </div>
          </div>
        </div>

        <div className="detail-section">
          <div className="detail-section-title">Detection score, last 10 min</div>
          <div className="mag-chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows} margin={{ top: 4, right: 6, bottom: 0, left: -18 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
                <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={tickTime} stroke={chart.axis} tick={{ fontSize: 10 }} />
                <YAxis stroke={chart.axis} tick={{ fontSize: 10 }} domain={[0, axis.max]} ticks={axis.ticks} allowDataOverflow />
                <Tooltip
                  contentStyle={chart.tooltip}
                  cursor={chart.cursor}
                  labelFormatter={tooltipTime}
                  formatter={(value: number) => [formatScore(value), "score"]}
                />
                <ReferenceLine y={threshold} stroke={palette.ANOMALY} strokeDasharray="4 3" />
                <Line type="monotone" dataKey="score" stroke={chart.series[4]} dot={false} strokeWidth={1.5} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="mag-chart-caption">Dashed: the threshold. The score is the best match to a passing dipole over six time scales.</div>
        </div>

        <div className="detail-section">
          <div className="detail-section-title">Residual field, last 10 min (nT)</div>
          <div className="mag-chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows} margin={{ top: 4, right: 6, bottom: 0, left: -12 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
                <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={tickTime} stroke={chart.axis} tick={{ fontSize: 10 }} />
                <YAxis stroke={chart.axis} tick={{ fontSize: 10 }} />
                <Tooltip
                  contentStyle={chart.tooltip}
                  cursor={chart.cursor}
                  labelFormatter={tooltipTime}
                  formatter={(value: number, name: string) => [`${value.toFixed(1)} nT`, name.toUpperCase()]}
                />
                <Line type="monotone" dataKey="x" stroke={chart.series[0]} dot={false} strokeWidth={1} isAnimationActive={false} />
                <Line type="monotone" dataKey="y" stroke={chart.series[1]} dot={false} strokeWidth={1} isAnimationActive={false} />
                <Line type="monotone" dataKey="z" stroke={chart.series[2]} dot={false} strokeWidth={1} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="mag-chart-caption">
            {"North (X), east (Y) and down (Z), after the static level and the network's common mode are removed."}
          </div>
        </div>

        {event && (
          <div className="detail-section">
            <div className="detail-section-title" style={{ color: event.active ? palette.ANOMALY : undefined }}>
              {event.active ? "Detecting now" : "Last detection"}
            </div>
            <EventFields event={event} />
          </div>
        )}

        {detail && detail.events.length > 1 && (
          <div className="detail-section">
            <div className="detail-section-title">Earlier here</div>
            {detail.events.slice(1, 6).map((e) => (
              <Field
                key={e.event_id}
                label={new Date(e.peak_ms).toLocaleTimeString()}
                value={`${Math.round(e.strength_nt)} nT, ${formatScore(e.score_sigma)}, ${e.truth?.label === "true" ? "UAP" : "false alarm"}`}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EventFields({ event }: { event: MagEvent }) {
  return (
    <>
      <Field label="Closest approach" value={new Date(event.peak_ms).toLocaleTimeString()} />
      <Field label="Strength" value={`${Math.round(event.strength_nt)} nT`} />
      <Field label="Score" value={formatScore(event.score_sigma)} />
      <Field label="Confidence" value={formatConfidence(event.confidence)} />
      <Field label="Noise does this" value={formatNoiseInterval(event.noise_once_per_h)} />
      <Field label="Estimated range" value={formatRange(event.range_km)} />
      <Field label="Time scale (distance ÷ speed)" value={`${event.tau_s} s`} />
      <Field label="Truth" value={truthText(event)} />
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
