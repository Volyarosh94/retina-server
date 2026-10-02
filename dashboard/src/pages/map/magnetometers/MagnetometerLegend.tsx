import MagnetometerGlyph from "./MagnetometerGlyph";
import type { MagState } from "./types";
import "./magnetometers.css";

const ENTRIES: [MagState, string][] = [
  ["quiet", "Quiet"],
  ["elevated", "Elevated, near the threshold"],
  ["alarm", "Detecting"],
  ["warming_up", "Warming up"],
  ["stale", "No data"],
];

/**
 * The map legend's key to the magnetometer badges: every state the map can
 * draw, each with its own badge, grey ones included, since every magnetometer
 * spends its first minutes grey.
 */
export default function MagnetometerLegend() {
  return (
    <div className="mag-legend">
      <span className="mag-legend-title">Magnetometer</span>
      <ul className="mag-legend-list" aria-label="Magnetometer states">
        {ENTRIES.map(([state, label]) => (
          <li key={state} className="legend-item">
            <MagnetometerGlyph state={state} size={13} />
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}
