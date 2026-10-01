import { describe, expect, it } from "vitest";
import { PALETTES } from "../mapPalette";
import { badgeSvg } from "./badge";
import { stateColourKey } from "./format";
import type { MagState } from "./types";

const STATES: MagState[] = ["warming_up", "quiet", "elevated", "alarm", "stale"];

/** The badge's markup as a document, to ask what it draws. */
function drawn(state: MagState, theme: "light" | "dark" = "light", opts = {}) {
  return new DOMParser().parseFromString(badgeSvg(state, PALETTES[theme], opts), "image/svg+xml").documentElement;
}

/* CIEDE2000, as mapPalette.ts measures its marks (Sharma, Wu & Dalal 2005). */
function lab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
  const y = f(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
  const z = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function deltaE2000([l1, a1, b1]: number[], [l2, a2, b2]: number[]): number {
  const rad = Math.PI / 180;
  const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const [ap1, ap2] = [(1 + g) * a1, (1 + g) * a2];
  const [cp1, cp2] = [Math.hypot(ap1, b1), Math.hypot(ap2, b2)];
  const hue = (b: number, a: number) => (b === 0 && a === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360);
  const [hp1, hp2] = [hue(b1, ap1), hue(b2, ap2)];
  let dh = cp1 * cp2 === 0 ? 0 : hp2 - hp1;
  if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin((dh * rad) / 2);
  const lBar = (l1 + l2) / 2;
  const cpBar = (cp1 + cp2) / 2;
  let hBar = hp1 + hp2;
  if (cp1 * cp2 !== 0) {
    if (Math.abs(hp1 - hp2) <= 180) hBar /= 2;
    else hBar = hp1 + hp2 < 360 ? (hBar + 360) / 2 : (hBar - 360) / 2;
  }
  const t =
    1 -
    0.17 * Math.cos((hBar - 30) * rad) +
    0.24 * Math.cos(2 * hBar * rad) +
    0.32 * Math.cos((3 * hBar + 6) * rad) -
    0.2 * Math.cos((4 * hBar - 63) * rad);
  const sl = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
  const sc = 1 + 0.045 * cpBar;
  const sh = 1 + 0.015 * cpBar * t;
  const rt = -Math.sin(2 * 30 * Math.exp(-(((hBar - 275) / 25) ** 2)) * rad) * 2 * Math.sqrt(cpBar ** 7 / (cpBar ** 7 + 25 ** 7));
  const [dl, dc, dhh] = [(l2 - l1) / sl, (cp2 - cp1) / sc, dH / sh];
  return Math.sqrt(dl ** 2 + dc ** 2 + dhh ** 2 + rt * dc * dhh);
}

describe("deltaE2000", () => {
  // Sharma, Wu & Dalal's published test pairs, so a pass below means something.
  it.each([
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  ])("reproduces %j against %j", (a, b, expected) => {
    expect(deltaE2000(a, b)).toBeCloseTo(expected, 3);
  });
});

describe("the magnetometer badge", () => {
  it("takes its colour from the state's palette entry", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const state of STATES) {
        const shape = drawn(state, theme).querySelector("[data-part='badge']");
        expect(shape?.getAttribute("fill")).toBe(PALETTES[theme][stateColourKey(state)]);
      }
    }
  });

  it("gives every state a shape of its own as well as a colour", () => {
    const quiet = drawn("quiet").querySelector("[data-part='badge']");
    expect(quiet?.getAttribute("transform")).toBeNull();
    // Elevated turns the badge into a diamond, a caution sign's shape.
    expect(drawn("elevated").querySelector("[data-part='badge']")?.getAttribute("transform")).toBe("rotate(45 9 9)");
    // No data is hollow, with a broken edge.
    const silent = drawn("stale").querySelector("[data-part='badge']");
    expect(silent?.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(Number(silent?.getAttribute("fill-opacity"))).toBeLessThan(0.5);
    // Detecting pulses on the map; where nothing moves it wears the pulse's halo.
    expect(drawn("alarm").querySelector("[data-part='halo']")).toBeNull();
    expect(drawn("alarm", "light", { still: true }).querySelector("[data-part='halo']")).not.toBeNull();
    expect(drawn("quiet", "light", { still: true }).querySelector("[data-part='halo']")).toBeNull();
  });

  it("rings the selected one", () => {
    expect(drawn("quiet").querySelector("[data-part='ring']")).toBeNull();
    expect(drawn("quiet", "light", { selected: true }).querySelector("[data-part='ring']")).not.toBeNull();
  });

  it("draws at the size asked for, from one 18-unit drawing", () => {
    const svg = drawn("quiet", "light", { size: 14 });
    expect(svg.getAttribute("width")).toBe("14");
    expect(svg.getAttribute("viewBox")).toBe("0 0 18 18");
  });

  // The palette's own bar: its worst pair of marks is 20.1 apart in light and
  // 20.0 in dark. Quiet in the node colour and elevated in WARN were 5.1 apart
  // on the dark map, the same yellow at a glance.
  it.each(["light", "dark"] as const)("keeps the four state colours at least 20 apart in %s", (theme) => {
    const colours = ["quiet", "elevated", "alarm", "warming_up"].map((s) => PALETTES[theme][stateColourKey(s as MagState)]);
    for (let i = 0; i < colours.length; i++) {
      for (let j = i + 1; j < colours.length; j++) {
        expect(deltaE2000(lab(colours[i]), lab(colours[j]))).toBeGreaterThanOrEqual(20);
      }
    }
  });
});
