import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ShortcutHelp from "./ShortcutHelp";

function row(key: string) {
  return screen.getByText(key, { selector: "kbd" }).closest("tr")?.textContent;
}

describe("ShortcutHelp", () => {
  it("says Escape closes the aircraft panel", () => {
    render(<ShortcutHelp visible onClose={() => {}} />);
    expect(row("Escape")).toBe("EscapeClear search / close the aircraft panel");
  });

  it("says it closes the magnetometer panel too where there are magnetometers", () => {
    render(<ShortcutHelp visible magnetometersAvailable onClose={() => {}} />);
    expect(row("Escape")).toBe("EscapeClear search / close the aircraft or magnetometer panel");
  });

  it("says Space and Enter are left to a focused button or link", () => {
    render(<ShortcutHelp visible onClose={() => {}} />);
    expect(screen.getByText(/Space and Enter are left to a focused button or link\.$/)).toBeInTheDocument();
  });
});
