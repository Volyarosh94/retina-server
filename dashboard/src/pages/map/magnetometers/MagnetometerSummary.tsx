import { useMapPreference } from "../useMapPreference";
import { usePalette } from "../useMapTheme";
import { eventVerdict, formatFalseAlarmCount, formatFalseAlarmInterval, formatMoment, formatRange } from "./format";
import type { MagNetwork } from "./types";
import "./magnetometers.css";

/**
 * The network at a glance, top right of the /sim map: how many magnetometers,
 * how many are detecting, the live false-alarm rate with its 95 % interval
 * (the simulator knows the truth, so every event is scored), how many
 * significant UAP passes were caught, and the latest events. Collapses to its
 * header for anyone who only wants the badges.
 */
export default function MagnetometerSummary({
  network,
  onSelect,
}: {
  network: MagNetwork;
  onSelect: (nodeId: string) => void;
}) {
  const palette = usePalette();
  const [open, setOpen] = useMapPreference("magSummaryOpen", true);
  const detecting = network.nodes.filter((n) => n.state === "alarm").length;
  const stats = network.stats;
  const settings = network.settings;
  const interval = formatFalseAlarmInterval(stats);

  return (
    <div className="mag-summary" aria-label="Magnetometers">
      <button className="mag-summary-header" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        Magnetometers
        <span className="mag-summary-count" style={detecting ? { color: palette.ANOMALY } : undefined}>
          {network.nodes.length} placed{detecting ? ` · ${detecting} detecting` : ""}
        </span>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="mag-summary-body">
          <div className="mag-summary-row">
            <span>False alarms</span>
            <strong>{formatFalseAlarmCount(stats)}</strong>
          </div>
          {interval && <div className="mag-summary-sub">{interval}</div>}
          <div className="mag-summary-row">
            <span>UAP passes ≥ {stats.pass_min_nt} nT</span>
            <strong>
              {stats.passes_detected} of {stats.passes} detected
            </strong>
          </div>
          <div className="mag-summary-row">
            <span>Detections</span>
            <strong>
              {stats.true_detections} true, {stats.false_alarms} false
            </strong>
          </div>
          <div className="mag-summary-note">
            Threshold {settings.mag_threshold_sigma.toFixed(1)}σ, common mode {settings.mag_common_mode ? "removed" : "not removed"}
            {network.storm ? "; a geomagnetic storm is running" : ""}. RM3100 at {network.sensor.cycle_count ?? "—"} cycles,
            {" "}{network.sensor.noise_nt ?? "—"} nT noise; UAPs are {formatMoment(network.uap_moment_am2)} dipoles.
          </div>
          {network.events.length > 0 && (
            <ul className="mag-event-list">
              {network.events.slice(0, 4).map((e) => (
                <li key={e.event_id}>
                  <button onClick={() => onSelect(e.node_id)} title="Show this magnetometer">
                    <span
                      className="mag-dot"
                      style={{ background: e.active ? palette.ANOMALY : e.truth?.label === "true" ? palette.WARN : palette.INK_SUBTLE }}
                    />
                    <span className="mag-event-host">{e.host_node_id}</span>
                    <span className="mag-event-time">{new Date(e.peak_ms).toLocaleTimeString()}</span>
                    <span className="mag-event-detail">
                      {Math.round(e.strength_nt)} nT · {formatRange(e.range_km)} · {eventVerdict(e)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
