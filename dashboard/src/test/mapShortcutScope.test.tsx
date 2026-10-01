import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useKeyboardShortcuts } from "../pages/map/useKeyboardShortcuts";

function press(key: string) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

function focusIn(className: string) {
  const host = document.createElement("div");
  host.className = className;
  const button = document.createElement("button");
  host.appendChild(button);
  document.body.appendChild(host);
  button.focus();
  return () => host.remove();
}

describe("map shortcuts", () => {
  afterEach(() => document.body.replaceChildren());

  it("fire when nothing is focused", () => {
    const handler = vi.fn();
    renderHook(() => useKeyboardShortcuts({ t: handler }));
    press("t");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("fire when focus is inside the map surface", () => {
    const handler = vi.fn();
    focusIn("app map-surface");
    renderHook(() => useKeyboardShortcuts({ t: handler }));
    press("t");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("stay quiet when focus is on console chrome", () => {
    const handler = vi.fn();
    focusIn("header");
    renderHook(() => useKeyboardShortcuts({ t: handler }));
    press("t");
    expect(handler).not.toHaveBeenCalled();
  });

  // Space and Enter press whatever button or link holds focus; Space is also
  // the map's pause, and taking it there paused the feed instead.
  const element = (tag: string, attributes: Record<string, string> = {}) => () => {
    const el = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
    return el;
  };

  it.each([
    ["a button", element("button")],
    ["a badge Leaflet makes a button", element("div", { role: "button", tabindex: "0" })],
    ["a link", element("a", { href: "#x" })],
  ])("leave Space and Enter to %s inside the map", (_, make) => {
    const pause = vi.fn();
    const enter = vi.fn();
    const letter = vi.fn();
    const host = document.createElement("div");
    host.className = "app map-surface";
    const control = make();
    host.appendChild(control);
    document.body.appendChild(host);
    control.focus();
    renderHook(() => useKeyboardShortcuts({ " ": pause, Enter: enter, t: letter }));
    for (const key of [" ", "Enter", "t"]) control.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    expect(pause).not.toHaveBeenCalled();
    expect(enter).not.toHaveBeenCalled();
    expect(letter).toHaveBeenCalledOnce();
  });

  it("take a held key once, not once per repeat", () => {
    const handler = vi.fn();
    renderHook(() => useKeyboardShortcuts({ " ": handler }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, repeat: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, repeat: true }));
    expect(handler).toHaveBeenCalledOnce();
  });
});
