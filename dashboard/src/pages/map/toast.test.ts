import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOKENS } from "../../test/paletteTokens";

/** The module as a page first loads it: afresh, onto a page with no stack yet. */
async function load(): Promise<typeof import("./toast")> {
  vi.resetModules();
  return import("./toast");
}

const region = () => document.querySelector("[data-tf-toast]");

describe("toast", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  // A screen reader announces changes to a live region it already knows; a
  // region created with the first toast already in it is often never read
  // out, and the first toast is usually the first detection.
  it("puts its live region on the page, empty, as soon as it loads", async () => {
    await load();
    expect(region()).toHaveAttribute("role", "status");
    expect(region()).toHaveAttribute("aria-live", "polite");
    expect(region()).toHaveAttribute("aria-atomic", "false");
    expect(region()).toHaveAttribute("aria-relevant", "additions");
    expect(region()).toBeEmptyDOMElement();
  });

  it("speaks through a polite live region, each toast once, as it arrives", async () => {
    const { toast } = await load();
    vi.advanceTimersByTime(100);
    toast("first", { durationMs: 1000 });
    const first = region()?.firstElementChild;
    expect(first).toHaveTextContent("first");

    toast("second", { durationMs: 5000 });
    // The first is the same node, not a fresh copy: only the new toast is an
    // addition, so only it is read out.
    expect(region()?.firstElementChild).toBe(first);
    expect(region()?.children).toHaveLength(2);

    vi.advanceTimersByTime(1000);
    expect(region()?.children).toHaveLength(1);
    expect(region()?.firstElementChild).toHaveTextContent("second");
  });

  // A region put back as a toast arrives is just as new to a screen reader:
  // the toast waits until it has been on the page a moment.
  it("puts a region back if its old one has gone, and holds toasts back until it has settled", async () => {
    const { toast } = await load();
    vi.advanceTimersByTime(100);
    toast("one", { durationMs: 1000 });
    document.body.replaceChildren();
    toast("two", { durationMs: 1000 });
    expect(region()).toHaveAttribute("role", "status");
    expect(region()).toBeEmptyDOMElement();
    vi.advanceTimersByTime(99);
    expect(region()).toBeEmptyDOMElement();
    vi.advanceTimersByTime(1);
    expect([...(region()?.children ?? [])].map((c) => c.textContent)).toEqual(["one", "two"]);
  });

  // Over the map a translucent toast let the labels and a radar node's ring
  // show through its text. Each tone's tint is laid over the card's opaque
  // colour instead, and its text must read at 4.5:1 or better on the result.
  describe.each(["light", "dark"] as const)("in the %s theme", (theme) => {
    it.each(["info", "success", "warn", "error"] as const)("draws a %s toast opaque, its text at 4.5:1 or better", async (tone) => {
      const { toast } = await load();
      vi.advanceTimersByTime(100);
      toast("Magnetometer beside synth-002 started detecting.", { tone, durationMs: 1000 });
      const style = getComputedStyle(region()!.firstElementChild!);
      const card = colour(resolve(style.backgroundColor, theme));
      expect(card[3]).toBe(1);
      const tint = /^linear-gradient\((var\(--[a-z-]+\)), \1\)$/.exec(style.backgroundImage);
      if (tone === "info") expect(style.backgroundImage).toBe("none");
      else expect(tint).not.toBeNull();
      const shown = tint ? over(colour(resolve(tint[1], theme)), card) : card;
      expect(contrast(colour(resolve(style.color, theme)), shown)).toBeGreaterThanOrEqual(4.5);
    });
  });
});

/** A `var(--token)` as the theme declares it. */
function resolve(value: string, theme: "light" | "dark"): string {
  const name = /^var\((--[a-z-]+)\)$/.exec(value.trim());
  return name ? TOKENS[theme](name[1]) : value;
}

/** "#rrggbb" or "rgba(r, g, b, a)" as [r, g, b, a], the channels 0–255. */
function colour(css: string): [number, number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(css.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(css.trim());
  if (!rgba) throw new Error(`not a colour: ${css}`);
  const [r, g, b, a = 1] = rgba[1].split(",").map(Number);
  return [r, g, b, a];
}

/** `top` laid over the opaque `base`. */
function over(top: [number, number, number, number], base: [number, number, number, number]): [number, number, number, number] {
  const mix = (i: number) => top[i] * top[3] + base[i] * (1 - top[3]);
  return [mix(0), mix(1), mix(2), 1];
}

/** WCAG 2 contrast ratio between two opaque colours. */
function contrast(a: [number, number, number, number], b: [number, number, number, number]): number {
  const luminance = ([r, g, b]: [number, number, number, number]) => {
    const linear = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
