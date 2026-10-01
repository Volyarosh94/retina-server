import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
});
