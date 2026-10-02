import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MapContainer } from "react-leaflet";
import { describe, expect, it, vi } from "vitest";
import MagnetometerLayer from "./MagnetometerLayer";
import { magEvent, network, NOW_MS, onFleetClock, withNode } from "../../../test/magnetometerNetwork";
import type { MagNetwork, MagNode } from "./types";

// A band is an SVG path Leaflet can only draw with a layout; the props the
// layer hands it are what is asserted.
vi.mock("react-leaflet", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-leaflet")>();
  return {
    ...original,
    Polygon: ({ positions, className, pathOptions }: { positions: [number, number][][]; className: string; pathOptions: { fillOpacity: number } }) => (
      <span data-testid="band" className={className} data-rings={positions.length} data-fill={pathOptions.fillOpacity} />
    ),
  };
});

function renderLayer(net: MagNetwork, props: { selectedId?: string | null; onSelect?: (id: string) => void; sites?: Map<string, [number, number]> } = {}) {
  return render(
    <MapContainer center={[34.85, -82.39]} zoom={10} style={{ width: 800, height: 600 }}>
      <MagnetometerLayer
        network={net}
        sitePositions={props.sites ?? new Map()}
        selectedId={props.selectedId ?? null}
        onSelect={props.onSelect ?? (() => {})}
      />
    </MapContainer>,
  );
}

describe("MagnetometerLayer", () => {
  it("draws one badge per magnetometer, in its state, and never as a radar node", () => {
    const { container } = renderLayer(network(), { selectedId: "mag-synth-001" });
    const badges = container.querySelectorAll(".mag-marker");
    expect(badges).toHaveLength(3);
    expect(container.querySelectorAll(".node-marker")).toHaveLength(0);
    expect(container.querySelectorAll(".mag-badge.mag-alarm")).toHaveLength(1);
    expect(container.querySelectorAll(".mag-badge.mag-quiet.mag-selected")).toHaveLength(1);
    expect(container.querySelectorAll(".mag-badge.mag-warming_up")).toHaveLength(1);
    expect(container.querySelector('[aria-label^="Magnetometer beside synth-002"]')).not.toBeNull();
    // Named once: its tooltip shows on hover and focus, and a title beside
    // it only stacked a second, plainer tooltip on top.
    expect(container.querySelector(".mag-marker[title]")).toBeNull();
  });

  it("opens a magnetometer on click", () => {
    const onSelect = vi.fn();
    const { container } = renderLayer(network(), { onSelect });
    fireEvent.click(container.querySelector('[aria-label^="Magnetometer beside synth-002"]')!);
    expect(onSelect).toHaveBeenCalledWith("mag-synth-002");
  });

  it("names each badge with its state, for whoever cannot see the colour", () => {
    renderLayer(network());
    expect(screen.getByRole("button", { name: "Magnetometer beside synth-001: quiet" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Magnetometer beside synth-002: detecting" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Magnetometer beside synth-003: warming up" })).toBeInTheDocument();
  });

  it("renames a badge when its state changes", () => {
    const { rerender } = renderLayer(network());
    const badge = screen.getByRole("button", { name: "Magnetometer beside synth-001: quiet" });
    rerender(
      <MapContainer center={[34.85, -82.39]} zoom={10} style={{ width: 800, height: 600 }}>
        <MagnetometerLayer network={withNode(network(), "mag-synth-001", { state: "elevated" })} sitePositions={new Map()} selectedId={null} onSelect={() => {}} />
      </MapContainer>,
    );
    // The same element, so keyboard focus on it survives the change.
    expect(screen.getByRole("button", { name: "Magnetometer beside synth-001: elevated" })).toBe(badge);
  });

  it("opens a magnetometer from the keyboard, and keeps Space from reaching the map's shortcuts", () => {
    const onSelect = vi.fn();
    const shortcuts = vi.fn();
    window.addEventListener("keydown", shortcuts);
    renderLayer(network(), { onSelect });
    const badge = screen.getByRole("button", { name: /^Magnetometer beside synth-002/ });
    // Focus opens the badge's tooltip, a render of its own.
    act(() => badge.focus());
    fireEvent.keyDown(badge, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith("mag-synth-002");
    fireEvent.keyDown(badge, { key: " " });
    expect(onSelect).toHaveBeenCalledTimes(2);
    // A held Space is one press, not a toggle per repeat, and the repeats do
    // not reach the map's pause either.
    fireEvent.keyDown(badge, { key: " ", repeat: true });
    fireEvent.keyDown(badge, { key: " ", repeat: true });
    expect(onSelect).toHaveBeenCalledTimes(2);
    // Space is the map's pause; on a badge it is the badge's.
    expect(shortcuts).not.toHaveBeenCalledWith(expect.objectContaining({ key: " " }));
    // Any other key goes on to the map: Escape closes the panel there.
    fireEvent.keyDown(badge, { key: "Escape" });
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(shortcuts).toHaveBeenCalledWith(expect.objectContaining({ key: "Escape" }));
    window.removeEventListener("keydown", shortcuts);
  });

  it("draws the range band of an open detection, fainter for a minute after it closes, then not at all", () => {
    const open = renderLayer(network());
    const bands = open.getAllByTestId("band");
    // The false alarm on synth-001 closed fifteen minutes ago: no band.
    expect(bands).toHaveLength(1);
    expect(bands[0]).toHaveClass("mag-range-band");
    expect(bands[0]).toHaveAttribute("data-rings", "2");
    expect(bands[0]).toHaveAttribute("data-fill", "0.16");
    open.unmount();

    const closed = magEvent({ active: false, end_ms: NOW_MS - 30_000 });
    const net = network();
    const recent = renderLayer({ ...net, nodes: net.nodes.map((n) => (n.node_id === "mag-synth-002" ? { ...n, state: "quiet", event: closed } : n)) });
    expect(recent.getByTestId("band")).toHaveAttribute("data-fill", "0.07");
    recent.unmount();

    const old = magEvent({ active: false, end_ms: NOW_MS - 120_000 });
    const gone = renderLayer({ ...net, nodes: net.nodes.map((n) => (n.node_id === "mag-synth-002" ? { ...n, state: "quiet", event: old } : n)) });
    expect(gone.queryByTestId("band")).toBeNull();
  });

  // The band's minute is the fleet's, the clock its events end by: a fleet two
  // minutes behind the server's must not lose it at once, nor one ahead keep
  // it past its minute.
  it.each([
    ["behind", -120_000],
    ["ahead of", 120_000],
  ])("keeps a closed detection's band for a minute by a fleet clock %s the server's", (_, offset) => {
    const base = onFleetClock(network(), offset);
    const fleetNow = NOW_MS + offset - 1_000;
    const ended = (agoMs: number) =>
      renderLayer({
        ...base,
        nodes: base.nodes.map((n) =>
          n.node_id === "mag-synth-002" ? { ...n, state: "quiet", event: magEvent({ active: false, end_ms: fleetNow - agoMs }) } : n,
        ),
      });
    expect(ended(30_000).getByTestId("band")).toHaveAttribute("data-fill", "0.07");
    cleanup();
    expect(ended(90_000).queryByTestId("band")).toBeNull();
  });

  it("draws a state it does not know as a grey badge named by the server's word, rather than failing", () => {
    const net = withNode(network(), "mag-synth-001", { state: "re_placing" as MagNode["state"] });
    const { container } = renderLayer(net);
    expect(screen.getByRole("button", { name: "Magnetometer beside synth-001: re placing" })).toBeInTheDocument();
    expect(container.querySelector(".mag-badge.mag-unknown")).not.toBeNull();
    expect(container.innerHTML).not.toContain("mag-re_placing");
  });

  // Quiet, but deaf to slow passes until enough unbroken readings are in.
  it("says in its tooltip when a magnetometer does not yet search the slow passes", () => {
    renderLayer(withNode(network(), "mag-synth-001", { longest_scale_s: 16 }));
    act(() => screen.getByRole("button", { name: /^Magnetometer beside synth-001/ }).focus());
    expect(document.body.textContent).toContain("searching passes up to 16 s");
  });

  it("says nothing of it once the search is complete", () => {
    renderLayer(network());
    act(() => screen.getByRole("button", { name: /^Magnetometer beside synth-001/ }).focus());
    expect(document.body.textContent).toContain("Quiet · score 1.3σ");
    expect(document.body.textContent).not.toContain("searching passes");
  });

  // The server closes an event only on new readings, so one whose
  // magnetometer stopped reporting stays open there for as long as it is silent.
  it("ends the band of a detection whose magnetometer went silent at its last reading", () => {
    const net = network();
    const silent = renderLayer(withNode(net, "mag-synth-002", { state: "stale", last_ms: NOW_MS - 15_000 }));
    expect(silent.getByTestId("band")).toHaveAttribute("data-fill", "0.07");
    expect(silent.container.querySelectorAll(".mag-badge.mag-stale")).toHaveLength(1);
    silent.unmount();

    const long = renderLayer(withNode(net, "mag-synth-002", { state: "stale", last_ms: NOW_MS - 120_000 }));
    expect(long.queryByTestId("band")).toBeNull();
  });

  it("sits each badge on its radar site where the map knows it, else where the server puts it", () => {
    const pixel = (el: Element | null) => {
      const style = (el as HTMLElement).style;
      return { x: parseFloat(style.left), y: parseFloat(style.top) };
    };
    const title = (host: string) => `[aria-label^="Magnetometer beside ${host}"]`;

    // The server puts synth-002 north-east of synth-001...
    const own = renderLayer(network());
    const a = pixel(own.container.querySelector(title("synth-001")));
    const b = pixel(own.container.querySelector(title("synth-002")));
    expect(b.x).toBeGreaterThan(a.x);
    expect(b.y).toBeLessThan(a.y);
    own.unmount();

    // ...the map's own site for it is south-west, and wins.
    const sited = renderLayer(network(), { sites: new Map([["synth-002", [34.0, -83.5]]]) });
    const c = pixel(sited.container.querySelector(title("synth-001")));
    const d = pixel(sited.container.querySelector(title("synth-002")));
    expect(d.x).toBeLessThan(c.x);
    expect(d.y).toBeGreaterThan(c.y);
  });
});
