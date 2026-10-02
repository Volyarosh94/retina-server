import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactElement } from "react";
import LiveAircraftMap from "./LiveAircraftMap";
import { MapThemeProvider } from "./useMapTheme";
import { ThemeProvider, useTheme } from "../../context/ThemeContext";
import { stubMatchMedia } from "../../test/matchMedia";
import { network as magnetometerNetwork } from "../../test/magnetometerNetwork";

// Leaflet layers need a browser layout. Keep the real map controller, toolbar,
// playback and feed lifecycle; geometry and layer helpers have their own tests.
vi.mock("react-leaflet", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-leaflet")>();
  return {
    ...original,
    MapContainer: ({ children }) => (
      <div data-testid="map">
        {Children.toArray(children)
          .filter((child) => isValidElement(child) && child.type === original.Polyline && String(child.key).includes("trail-"))
          .map((child: ReactElement<{ positions: number[][] }>) => (
            <span key={child.key} data-testid="selected-trail" data-positions={JSON.stringify(child.props.positions)} />
          ))}
      </div>
    ),
  };
});

// The map reads identity from the console's AuthProvider; every case starts
// signed in.
const SIGNED_IN = { email: "owner@example.invalid", name: "Owner" };
const owner = vi.hoisted(() => ({
  user: null as { email: string; name: string } | null,
  loading: false,
  syntheticFleet: false,
}));
vi.mock("../../context/AuthContext", () => ({ useAuth: () => owner }));

// Every case renders the whole map tree, which alone takes most of the default.
vi.setConfig({ testTimeout: 20_000 });

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(public url: string) { Socket.instances.push(this); }
  close() { this.readyState = 3; this.onclose?.(); }
}

beforeEach(() => {
  owner.user = SIGNED_IN;
  owner.syntheticFleet = false;
  window.history.replaceState(null, "", "/");
  Socket.instances = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true,
    json: async () => url.endsWith("/auth/me/nodes") ? [{ node_ref: "mine" }] : {},
  })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("drops paused playback and old history when the owner feed is selected", async () => {
  render(<MapThemeProvider><LiveAircraftMap /></MapThemeProvider>);
  await screen.findByRole("checkbox", { name: "My nodes only" });
  act(() => {
    Socket.instances[0].readyState = Socket.OPEN;
    Socket.instances[0].onopen?.();
    Socket.instances[0].onmessage?.({ data: JSON.stringify({
      aircraft: [{ hex: "public", lat: 51, lon: -1 }],
    }) });
  });
  fireEvent.click(screen.getByRole("button", { name: /Pause/ }));
  expect(screen.getByRole("button", { name: /Resume/ })).toBeInTheDocument();
  expect(document.querySelector(".playback-bar")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("checkbox", { name: "My nodes only" }));
  expect(screen.getByRole("checkbox", { name: "My nodes only" })).toBeChecked();
  expect(screen.getByRole("button", { name: /Pause/ })).toBeInTheDocument();
  expect(document.querySelector(".playback-bar")).not.toBeInTheDocument();
  expect(Socket.instances[Socket.instances.length - 1].url).toContain("/ws/aircraft/owner");
});

it("offers a signed-in owner no toggle where the page withholds the owner view", async () => {
  render(<MapThemeProvider><LiveAircraftMap feed="synthetic" ownerView={false} /></MapThemeProvider>);
  await screen.findByRole("button", { name: /Pause/ });
  // Long enough for the ownership answer the stub gives at once to land.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(screen.queryByRole("checkbox", { name: "My nodes only" })).not.toBeInTheDocument();
  expect(Socket.instances.map((s) => s.url)).not.toContainEqual(expect.stringContaining("/owner"));
});

it("returns to the public feed when the owner signs out on the map", async () => {
  const { rerender } = render(<MapThemeProvider><LiveAircraftMap /></MapThemeProvider>);
  fireEvent.click(await screen.findByRole("checkbox", { name: "My nodes only" }));
  const ownerFeed = Socket.instances[Socket.instances.length - 1];
  expect(ownerFeed.url).toContain("/ws/aircraft/owner");

  owner.user = null;
  rerender(<MapThemeProvider><LiveAircraftMap /></MapThemeProvider>);

  expect(screen.queryByRole("checkbox", { name: "My nodes only" })).not.toBeInTheDocument();
  expect(ownerFeed.readyState).toBe(3);
  expect(Socket.instances[Socket.instances.length - 1].url).not.toContain("/owner");

  // Signing in again offers the filter without applying it.
  owner.user = SIGNED_IN;
  rerender(<MapThemeProvider><LiveAircraftMap /></MapThemeProvider>);
  expect(await screen.findByRole("checkbox", { name: "My nodes only" })).not.toBeChecked();
  expect(Socket.instances[Socket.instances.length - 1].url).not.toContain("/owner");
});

it("forgets rendered tracks in both directions even before the new feed responds", async () => {
  render(<MapThemeProvider><LiveAircraftMap /></MapThemeProvider>);
  await screen.findByRole("checkbox", { name: "My nodes only" });
  const deliver = (flight: string) => {
    act(() => Socket.instances[Socket.instances.length - 1].onmessage?.({ data: JSON.stringify({
      aircraft: [{ hex: "abc123", flight, lat: 51, lon: -1, position_source: "adsb_single_node" }],
    }) }));
    act(() => {
      for (let i = 0; i < 30; i++) {
        const calls = vi.mocked(requestAnimationFrame).mock.calls;
        calls[calls.length - 1][0](i * 16);
      }
    });
  };
  deliver("PUBLIC TRACK");
  expect(screen.getByText("PUBLIC TRACK")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: "My nodes only" }));
  expect(screen.queryByText("PUBLIC TRACK")).not.toBeInTheDocument();
  deliver("OWNER TRACK");
  expect(screen.getByText("OWNER TRACK")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: "My nodes only" }));
  expect(screen.queryByText("OWNER TRACK")).not.toBeInTheDocument();
  expect(screen.queryByText("PUBLIC TRACK")).not.toBeInTheDocument();
});

it("toggles pause and resume repeatedly with the space shortcut", async () => {
  render(<MapThemeProvider><LiveAircraftMap /></MapThemeProvider>);
  await screen.findByRole("checkbox", { name: "My nodes only" });
  fireEvent.keyDown(window, { key: " " });
  expect(screen.getByRole("button", { name: /Resume/ })).toBeInTheDocument();
  fireEvent.keyDown(window, { key: " " });
  expect(screen.getByRole("button", { name: /Pause/ })).toBeInTheDocument();
});

it("updates the selected trail as new positions arrive without changing selection", async () => {
  window.history.replaceState(null, "", "/#hex=abc123");
  render(<MapThemeProvider><LiveAircraftMap /></MapThemeProvider>);
  await screen.findByRole("checkbox", { name: "My nodes only" });
  const deliver = (lat: number, positions: number[][]) => {
    act(() => Socket.instances[0].onmessage?.({ data: JSON.stringify({
      aircraft: [{ hex: "abc123", lat, lon: -1, recent_positions: positions }],
    }) }));
  };
  const drawnPositions = () => screen.getAllByTestId("selected-trail")
    .flatMap((el) => JSON.parse(el.getAttribute("data-positions")!));

  deliver(51.001, [[51, -1, 1000, 1], [51.001, -1, 1000, 2]]);
  expect(drawnPositions()).toContainEqual([51.001, -1]);
  deliver(51.002, [[51.002, -1, 1000, 3]]);
  expect(drawnPositions()).toContainEqual([51.002, -1]);
});

it("asks no /api/test/ endpoint when a multi-node aircraft is selected", async () => {
  // The display list is rebuilt from the animation loop, so drive its frames.
  let frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", vi.fn((cb: FrameRequestCallback) => frames.push(cb)));
  const runFrames = () => act(() => {
    for (let i = 0; i < 30; i++) {
      const due = frames;
      frames = [];
      due.forEach((cb) => cb(performance.now()));
    }
  });
  window.history.replaceState(null, "", "/#hex=mn1");
  const { container } = render(<MapThemeProvider><LiveAircraftMap /></MapThemeProvider>);
  await screen.findByRole("checkbox", { name: "My nodes only" });
  act(() => Socket.instances[0].onmessage?.({ data: JSON.stringify({
    aircraft: [{ hex: "mn1", lat: 51, lon: -1, position_source: "multinode_solve", seen: 2, n_nodes: 3 }],
  }) }));
  runFrames();
  expect(container.querySelector(".detail-panel")).not.toBeNull();
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

  const asked = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
  expect(asked.filter((url) => url.includes("/api/test/"))).toEqual([]);
});

it("draws its live stats in the aircraft list, not floating over the map", () => {
  const { container } = render(<MapThemeProvider><LiveAircraftMap /></MapThemeProvider>);
  expect(container.querySelector(".live-map-top-right-stack")).toBeNull();
  expect(container.querySelector(".aircraft-list-panel .stats-panel")).not.toBeNull();
});

it("moves its default basemap with the console's theme", () => {
  // Console starts light, so the default basemap is Positron.
  localStorage.setItem("retina.theme", "light");
  stubMatchMedia();
  function Flip() {
    const { setPreference } = useTheme();
    return <button onClick={() => setPreference("dark")}>flip</button>;
  }
  render(
    <ThemeProvider>
      <Flip />
      <MapThemeProvider><LiveAircraftMap /></MapThemeProvider>
    </ThemeProvider>,
  );
  fireEvent.click(screen.getByText("flip"));
  expect(window.localStorage.getItem("retina.map.tile.theme")).toBe(JSON.stringify("voyager"));
});

function mountUnderStoredTheme(theme: string, tile: string, chosenBy: string, prefix = "retina.map.") {
  localStorage.setItem("retina.theme", theme);
  localStorage.setItem(`${prefix}tile.theme`, JSON.stringify(tile));
  localStorage.setItem(`${prefix}tile.chosenBy`, JSON.stringify(chosenBy));
  stubMatchMedia();
  render(
    <ThemeProvider>
      <MapThemeProvider><LiveAircraftMap /></MapThemeProvider>
    </ThemeProvider>,
  );
}

it("mounts onto its own theme's basemap when the theme that chose it has since changed", () => {
  // Dark chose Voyager; the console went light while the map was not mounted.
  mountUnderStoredTheme("light", "voyager", "dark");
  expect(window.localStorage.getItem("retina.map.tile.theme")).toBe(JSON.stringify("positron"));
});

it("keeps a hand-picked basemap when it mounts", () => {
  mountUnderStoredTheme("light", "osm", "hand");
  expect(window.localStorage.getItem("retina.map.tile.theme")).toBe(JSON.stringify("osm"));
});

it("keeps a hand-picked basemap that happens to be the other theme's default", () => {
  // Voyager is dark's default and also a stop on the cycle control; picked by
  // hand under a light console, it is the user's choice, not dark's.
  mountUnderStoredTheme("light", "voyager", "hand");
  expect(window.localStorage.getItem("retina.map.tile.theme")).toBe(JSON.stringify("voyager"));
});

it("keeps a basemap picked under the standalone map's storage keys", () => {
  mountUnderStoredTheme("light", "osm", "hand", "tf.");
  expect(window.localStorage.getItem("retina.map.tile.theme")).toBe(JSON.stringify("osm"));
  expect(window.localStorage.getItem("retina.map.tile.chosenBy")).toBe(JSON.stringify("hand"));
});

/** One simulated spawn with a transponder, as the fleet's truth snapshot carries it. */
function deliverSimTruth() {
  act(() => {
    Socket.instances[0].readyState = Socket.OPEN;
    Socket.instances[0].onopen?.();
    Socket.instances[0].onmessage?.({ data: JSON.stringify({
      aircraft: [],
      ground_truth: { abc123: [[51, -1, 3000, 1]] },
      ground_truth_meta: { abc123: { object_type: "aircraft", has_adsb: true, source: "sim" } },
    }) });
  });
  act(() => {
    for (let i = 0; i < 30; i++) {
      const calls = vi.mocked(requestAnimationFrame).mock.calls;
      calls[calls.length - 1][0](i * 16);
    }
  });
}

it("offers no ground truth where the server runs no synthetic fleet", async () => {
  render(<MapThemeProvider><LiveAircraftMap /></MapThemeProvider>);
  await screen.findByRole("checkbox", { name: "My nodes only" });
  deliverSimTruth();
  expect(screen.queryByRole("button", { name: "Debug Truth" })).not.toBeInTheDocument();
  expect(screen.queryByText(/^Truth:/)).not.toBeInTheDocument();
  fireEvent.keyDown(window, { key: "?" });
  expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  expect(screen.queryByText("Toggle ground-truth overlay")).not.toBeInTheDocument();
});

it("keys only the truth classes the fleet is actually sending", async () => {
  owner.syntheticFleet = true;
  render(<MapThemeProvider><LiveAircraftMap feed="synthetic" /></MapThemeProvider>);
  await screen.findByRole("checkbox", { name: "My nodes only" });
  expect(screen.getByRole("button", { name: "Debug Truth" })).toBeInTheDocument();
  deliverSimTruth();
  expect(screen.getByText("Truth: sim ADS-B")).toBeInTheDocument();
  expect(screen.queryByText("Truth: sim dark")).not.toBeInTheDocument();
  expect(screen.queryByText(/Truth: live/)).not.toBeInTheDocument();
});

it("offers no ground truth on the real-only feed even beside a fleet", async () => {
  owner.syntheticFleet = true;
  render(<MapThemeProvider><LiveAircraftMap feed="real" /></MapThemeProvider>);
  await screen.findByRole("checkbox", { name: "My nodes only" });
  expect(screen.queryByRole("button", { name: "Debug Truth" })).not.toBeInTheDocument();
});

it("offers the magnetometers on /sim beside a synthetic fleet, and hides them on request", async () => {
  owner.syntheticFleet = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true,
    json: async () =>
      url.endsWith("/sim/magnetometers") ? magnetometerNetwork()
        : url.endsWith("/auth/me/nodes") ? [{ node_ref: "mine" }]
          : {},
  })));
  render(<MapThemeProvider><LiveAircraftMap feed="synthetic" /></MapThemeProvider>);
  const toggle = await screen.findByRole("button", { name: "Magnetometers" });
  expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(await screen.findByText("3 placed · 1 detecting")).toBeInTheDocument();

  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(screen.queryByText("3 placed · 1 detecting")).not.toBeInTheDocument();
  // The poll that stopped settles inside the test, not after it.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
});

it("offers no magnetometers, and asks for none, off /sim or without a fleet", async () => {
  owner.syntheticFleet = true;
  const real = render(<MapThemeProvider><LiveAircraftMap feed="real" /></MapThemeProvider>);
  await screen.findByRole("checkbox", { name: "My nodes only" });
  expect(screen.queryByRole("button", { name: "Magnetometers" })).not.toBeInTheDocument();
  real.unmount();

  owner.syntheticFleet = false;
  render(<MapThemeProvider><LiveAircraftMap feed="synthetic" /></MapThemeProvider>);
  await screen.findByRole("button", { name: /Pause/ });
  expect(screen.queryByRole("button", { name: "Magnetometers" })).not.toBeInTheDocument();
  expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).not.toContainEqual(
    expect.stringContaining("/sim/magnetometers"),
  );
});

/** The /sim map beside a fleet, with the magnetometer routes answering. */
function renderSimWithMagnetometers() {
  owner.syntheticFleet = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true,
    json: async () =>
      url.endsWith("/sim/magnetometers") ? magnetometerNetwork()
        : url.includes("/sim/magnetometers/mag-synth-002?") ? {
          node_id: "mag-synth-002",
          host_node_id: "synth-002",
          threshold_sigma: 5.5,
          sigma_nt: 15.2,
          series: { t: [], x: [], y: [], z: [], residual: [], score: [], bx: [], by: [], bz: [], b: [] },
          events: [],
        }
          : url.endsWith("/auth/me/nodes") ? [{ node_ref: "mine" }]
            : {},
  })));
  // Inside the surface, as MapPage mounts it: the map's shortcuts answer only
  // to keys pressed there.
  return render(
    <div className="app map-surface">
      <MapThemeProvider><LiveAircraftMap feed="synthetic" /></MapThemeProvider>
    </div>,
  );
}

it("shares the side panel between a magnetometer and an aircraft, and Escape closes either", async () => {
  const { container } = renderSimWithMagnetometers();
  await screen.findByText("3 placed · 1 detecting");
  act(() => {
    Socket.instances[0].readyState = Socket.OPEN;
    Socket.instances[0].onopen?.();
    Socket.instances[0].onmessage?.({ data: JSON.stringify({
      // Claimed by a synthetic node: /sim shows the simulated fleet's tracks only.
      aircraft: [{ hex: "abc123", flight: "TEST1", lat: 51, lon: -1, position_source: "adsb_single_node", node_ref: "synth-001" }],
    }) });
  });
  act(() => {
    for (let i = 0; i < 30; i++) {
      const calls = vi.mocked(requestAnimationFrame).mock.calls;
      calls[calls.length - 1][0](i * 16);
    }
  });
  const magnetometerPanel = () => screen.queryByRole("region", { name: "Magnetometer" });
  const aircraftPanel = () => container.querySelector(".detail-panel:not(.mag-panel)");

  fireEvent.click(screen.getByRole("button", { name: /synth-002/ }));
  expect(magnetometerPanel()).toBeInTheDocument();

  // An aircraft takes the panel...
  fireEvent.click(screen.getByText("TEST1"));
  expect(magnetometerPanel()).not.toBeInTheDocument();
  expect(aircraftPanel()).not.toBeNull();

  // ...and a magnetometer takes it back.
  fireEvent.click(screen.getByRole("button", { name: /synth-002/ }));
  expect(magnetometerPanel()).toBeInTheDocument();
  expect(aircraftPanel()).toBeNull();

  fireEvent.keyDown(window, { key: "Escape" });
  expect(magnetometerPanel()).not.toBeInTheDocument();
  expect(aircraftPanel()).toBeNull();
});

it("closes the magnetometer panel with the layer, and does not bring it back with it", async () => {
  renderSimWithMagnetometers();
  fireEvent.click(await screen.findByRole("button", { name: /synth-002/ }));
  expect(screen.getByRole("region", { name: "Magnetometer" })).toBeInTheDocument();

  const toggle = screen.getByRole("button", { name: "Magnetometers" });
  fireEvent.click(toggle);
  expect(screen.queryByRole("region", { name: "Magnetometer" })).not.toBeInTheDocument();
  fireEvent.click(toggle);
  await screen.findByText("3 placed · 1 detecting");
  expect(screen.queryByRole("region", { name: "Magnetometer" })).not.toBeInTheDocument();
});

// Space is the map's pause, and was taken from whatever button held focus.
it("lets Space press a focused button on the map rather than pause the feed", async () => {
  renderSimWithMagnetometers();
  const entry = await screen.findByRole("button", { name: /synth-002/ });
  entry.focus();
  fireEvent.keyDown(entry, { key: " " });
  expect(screen.getByRole("button", { name: /Pause/ })).toBeInTheDocument();
  // With nothing focused it is still the pause.
  entry.blur();
  fireEvent.keyDown(window, { key: " " });
  expect(screen.getByRole("button", { name: /Resume/ })).toBeInTheDocument();
});

it("says in its shortcut help that Escape closes a magnetometer's panel too", async () => {
  renderSimWithMagnetometers();
  await screen.findByText("3 placed · 1 detecting");
  fireEvent.keyDown(window, { key: "?" });
  expect(within(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).getByText("Clear search / close the aircraft or magnetometer panel")).toBeInTheDocument();
});

it("keys every magnetometer badge in the legend, grey ones included", async () => {
  renderSimWithMagnetometers();
  await screen.findByText("3 placed · 1 detecting");
  const legend = within(screen.getByRole("list", { name: "Magnetometer states" }));
  expect(legend.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    "Quiet",
    "Elevated, near the threshold",
    "Detecting",
    "Warming up",
    "No data",
  ]);
});
