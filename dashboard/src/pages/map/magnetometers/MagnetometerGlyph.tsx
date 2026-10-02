import { usePalette } from "../useMapTheme";
import { badgeSvg } from "./badge";
import type { MagState } from "./types";
import "./magnetometers.css";

/**
 * The map's magnetometer badge, small, for the legend and the panel: the
 * same drawing as the DivIcon (badge.ts), with the detecting pulse held
 * still. Decorative wherever it appears; the words beside it carry the state.
 */
export default function MagnetometerGlyph({ state, size = 14 }: { state: MagState; size?: number }) {
  const palette = usePalette();
  return (
    <span
      className="mag-glyph"
      aria-hidden="true"
      // Built from the palette and fixed geometry only, never from data.
      dangerouslySetInnerHTML={{ __html: badgeSvg(state, palette, { size, still: true }) }}
    />
  );
}
