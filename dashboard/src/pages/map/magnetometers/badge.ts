/**
 * The magnetometer badge, drawn once for every place it appears: the map's
 * DivIcon, the legend and the panel's state, so the three never disagree.
 *
 * Each state has a shape as well as a colour, so the badge still reads where
 * the colour does not, at 18 px on either basemap and to anyone who does not
 * see the hues apart:
 *
 *   quiet       a square, GOOD
 *   elevated    the square turned 45°, WARN: a caution sign's diamond
 *   detecting   a square, ANOMALY, that pulses on the map (a halo where
 *               nothing moves: the legend, the panel, reduced motion)
 *   warming up  a square, grey
 *   no data     a hollow square with a broken edge, grey
 *
 * The glyph inside is a horseshoe magnet. Everything is drawn on an 18-unit
 * grid and scaled to `size`.
 */
import type { MapPalette } from "../mapPalette";
import { stateColourKey } from "./format";
import type { MagState } from "./types";

export type BadgeInk = Pick<MapPalette, "GOOD" | "WARN" | "ANOMALY" | "INK_SUBTLE" | "INK_MUTED" | "ICON_HALO">;

const HORSESHOE = "M6.2 5.8 v4.1 a2.8 2.8 0 0 0 5.6 0 v-4.1";

export function badgeSvg(
  state: MagState,
  ink: BadgeInk,
  { selected = false, size = 18, still = false }: { selected?: boolean; size?: number; still?: boolean } = {},
): string {
  const colour = ink[stateColourKey(state)];
  const halo = ink.ICON_HALO;
  // The selection ring sits clear of both the square's corners and the
  // diamond's points.
  const ring = selected
    ? `<circle data-part="ring" cx="9" cy="9" r="8.4" fill="none" stroke="${colour}" stroke-width="1.2"/>`
    : "";
  const pulse =
    still && state === "alarm"
      ? `<rect data-part="halo" x="0.6" y="0.6" width="16.8" height="16.8" rx="5" fill="${colour}" fill-opacity="0.3"/>`
      : "";
  let badge: string;
  let glyph: string;
  if (state === "elevated") {
    // A smaller square turned on its centre: its points reach as far as the
    // square's corners and stay inside the selection ring. The horseshoe
    // shrinks to fit it.
    badge = `<rect data-part="badge" x="4" y="4" width="10" height="10" rx="2" transform="rotate(45 9 9)" fill="${colour}" fill-opacity="0.92" stroke="${halo}" stroke-width="1.2"/>`;
    glyph = `<path d="${HORSESHOE}" transform="translate(9 9) scale(0.74) translate(-9 -9.25)" fill="none" stroke="${halo}" stroke-width="1.8" stroke-linecap="round"/>`;
  } else if (state === "stale") {
    // Hollow and broken-edged: the sensor is there, its readings are not.
    badge = `<rect data-part="badge" x="3" y="3" width="12" height="12" rx="3" fill="${colour}" fill-opacity="0.3" stroke="${ink.INK_MUTED}" stroke-width="1.2" stroke-dasharray="2.4 1.6"/>`;
    glyph = `<path d="${HORSESHOE}" fill="none" stroke="${ink.INK_MUTED}" stroke-width="1.5" stroke-linecap="round"/>`;
  } else {
    badge = `<rect data-part="badge" x="3" y="3" width="12" height="12" rx="3" fill="${colour}" fill-opacity="0.92" stroke="${halo}" stroke-width="1.2"/>`;
    glyph = `<path d="${HORSESHOE}" fill="none" stroke="${halo}" stroke-width="1.5" stroke-linecap="round"/>`;
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 18 18" aria-hidden="true" focusable="false">${pulse}${ring}${badge}${glyph}</svg>`;
}
