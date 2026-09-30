import { fireEvent, render } from "@testing-library/react";
import { MapContainer } from "react-leaflet";
import { describe, expect, it, vi } from "vitest";
import MagnetometerLayer from "./MagnetometerLayer";
import { magEvent, network, NOW_MS } from "../../../test/magnetometerNetwork";
import type { MagNetwork } from "./types";

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
    expect(container.querySelector('[title="Magnetometer beside synth-002"]')).not.toBeNull();
  });

  it("opens a magnetometer on click", () => {
    const onSelect = vi.fn();
    const { container } = renderLayer(network(), { onSelect });
    fireEvent.click(container.querySelector('[title="Magnetometer beside synth-002"]')!);
    expect(onSelect).toHaveBeenCalledWith("mag-synth-002");
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

  it("sits each badge on its radar site where the map knows it, else where the server puts it", () => {
    const pixel = (el: Element | null) => {
      const style = (el as HTMLElement).style;
      return { x: parseFloat(style.left), y: parseFloat(style.top) };
    };
    const title = (host: string) => `[title="Magnetometer beside ${host}"]`;

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
