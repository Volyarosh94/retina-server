import { useMapPreference } from "../useMapPreference";
import { usePalette } from "../useMapTheme";
import type { CSSProperties } from "react";
import {
  eventVerdict,
  fleetRefusals,
  formatFalseAlarmCount,
  formatFalseAlarmInterval,
  formatMoment,
  formatRange,
  isLive,
  joinReasons,
  runningModelGaps,
} from "./format";
import type { MagNetwork, MagState } from "./types";
import "./magnetometers.css";

/**
 * The detector reports a pass up to this many time scales after its closest
 * approach (its windows reach ±4τ), so a pass stays open this many of its
 * longest scale after its field last peaked: the server's PASS_GRACE_S,
 * 4 × 64 s = 256 s.
 */
const PASS_REACH_SCALES = 4;

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
  // Events outlive their magnetometer: the server keeps them after the
  // simulator takes it away, and a silent one leaves its event open.
  const stateOf = new Map<string, MagState>(network.nodes.map((n) => [n.node_id, n.state]));
  const stats = network.stats;
  const settings = network.settings;
  const interval = formatFalseAlarmInterval(stats);
  // The configuration, and apart from it, in the warning's ink, every reason
  // the noise model does not hold as the network runs now: events opened
  // meanwhile carry no confidence, while older ones keep theirs.
  const gaps = runningModelGaps(network);
  // What the server turned away from the fleet, for whoever is working out
  // why readings are missing; nothing at all while it has turned nothing away.
  const refusals = fleetRefusals(network.detector);
  const note =
    `Threshold ${settings.mag_threshold_sigma.toFixed(1)}σ${network.detector.common_mode_applied ? ", common mode removed" : ""}.` +
    ` RM3100 at ${network.sensor.cycle_count ?? "—"} cycles, ${network.sensor.noise_nt ?? "—"} nT noise;` +
    ` UAPs are ${formatMoment(network.uap_moment_am2)} dipoles.`;
  const longestS = Math.max(...(network.detector.scales_s?.length ? network.detector.scales_s : [64]));
  const passHelp =
    `A pass counts once the UAP's field at a magnetometer rises ${stats.pass_min_nt} nT above its lowest since that magnetometer's last pass. ` +
    `It is found if a detection the truth confirms is open during it. It stays open until ${PASS_REACH_SCALES * longestS} s after its field last peaked: ` +
    `the detector reports a pass up to ${PASS_REACH_SCALES} time scales after its closest approach, and its longest is ${longestS} s.`;

  return (
    // A region, as the live stats overlay is: a label on a plain div is not
    // read out, and the card is one a screen reader should be able to jump to.
    <div className="mag-summary" role="region" aria-label="Magnetometers">
      <button className="mag-summary-header" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        Magnetometers
        <span className={`mag-summary-count${detecting ? " mag-detecting" : ""}`}>
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
          {stats.passes_open > 0 && <div className="mag-summary-sub">{stats.passes_open} still in progress</div>}
          {/* Open to the keyboard and a screen reader, not on hover alone. */}
          <details className="mag-summary-help">
            <summary>How passes are counted</summary>
            <p>{passHelp}</p>
          </details>
          <div className="mag-summary-row">
            <span>Detections</span>
            <strong>
              {stats.true_detections} true, {stats.false_alarms} false
            </strong>
          </div>
          <div className="mag-summary-note">{note}</div>
          {gaps.length > 0 && (
            <div className="mag-caveat">
              No confidence for detections opening now: the noise model does not hold with {joinReasons(gaps)}.
            </div>
          )}
          {refusals && <div className="mag-summary-fleet">{refusals}</div>}
          {network.events.length > 0 && (
            <ul className="mag-event-list">
              {network.events.slice(0, 4).map((e) => {
                const state = stateOf.get(e.node_id);
                const placed = state !== undefined;
                const live = isLive(e, state);
                // Whether it is a detection, and whether it is still going:
                // red for a UAP, filled while live and a ring once closed, and
                // a neutral ring for anything else. Amber and grey are the
                // badges' (elevated, no verdict) and mean something else there.
                const uap = live || (!e.active && e.truth?.label === "true");
                const dot = { "--mag-dot": uap ? palette.ANOMALY : palette.INK_MUTED } as CSSProperties;
                return (
                  <li key={e.event_id}>
                    <button
                      onClick={() => onSelect(e.node_id)}
                      disabled={!placed}
                      title={placed ? "Show this magnetometer" : "This magnetometer is no longer placed"}
                    >
                      <span className={`mag-dot ${live ? "mag-dot-live" : "mag-dot-past"}`} style={dot} />
                      <span className="mag-event-host">{e.host_node_id}</span>
                      <span className="mag-event-time">{new Date(e.peak_ms).toLocaleTimeString()}</span>
                      <span className="mag-event-detail">
                        {Math.round(e.strength_nt)} nT · {formatRange(e.range_km)} · {eventVerdict(e, live)}
                        {placed ? "" : " · no longer placed"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
