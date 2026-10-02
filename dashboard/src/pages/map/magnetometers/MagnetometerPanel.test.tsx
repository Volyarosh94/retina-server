import type { ReactNode } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MagnetometerPanel from "./MagnetometerPanel";
import { magEvent, network, NOW_MS, onFleetClock, withNode } from "../../../test/magnetometerNetwork";
import type { MagDetail, MagEvent } from "./types";

// Recharts measures a real layout; under jsdom there is none, so the chart
// chrome is stubbed down to what the panel hands it, and counts its draws.
// The axes and the tooltip show how they would write a value.
const draws = vi.hoisted(() => ({ count: 0 }));
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ children, data, margin }: { children: ReactNode; data: unknown[]; margin: unknown }) => {
    draws.count += 1;
    return (
      <div data-testid="chart" data-points={data.length} data-margin={JSON.stringify(margin)}>
        {children}
      </div>
    );
  },
  Line: ({ dataKey }: { dataKey: string }) => <span data-testid={`line-${dataKey}`} />,
  ReferenceLine: ({ y }: { y: number }) => <span data-testid="threshold" data-y={y} />,
  CartesianGrid: () => null,
  XAxis: ({ domain, ticks, interval }: { domain: unknown; ticks: unknown; interval: unknown }) => (
    <span data-testid="x-axis" data-domain={JSON.stringify(domain)} data-ticks={JSON.stringify(ticks)} data-interval={String(interval)} />
  ),
  YAxis: ({
    width,
    domain,
    ticks,
    interval,
    tickFormatter,
  }: {
    width: unknown;
    domain: unknown;
    ticks: unknown;
    interval: unknown;
    tickFormatter?: (value: number) => string;
  }) => (
    <span
      data-testid="y-axis"
      data-width={String(width)}
      data-domain={JSON.stringify(domain)}
      data-ticks={JSON.stringify(ticks)}
      data-interval={String(interval)}
      data-writes={tickFormatter ? tickFormatter(48_700) : ""}
    />
  ),
  Tooltip: ({ formatter }: { formatter?: (value: number, name: string) => unknown }) => {
    const written = formatter?.(48_701.3, "b");
    return <span data-testid="tooltip" data-writes={Array.isArray(written) ? String(written[0]) : String(written)} />;
  },
}));

const EARLIER = magEvent({
  event_id: "mag-evt-run-1-00000",
  active: false,
  end_ms: NOW_MS - 3_000_000,
  peak_ms: NOW_MS - 3_010_000,
  strength_nt: 78.2,
  score_sigma: 6.6,
  truth: { label: "false", provisional: false, object_id: null, true_peak_nt: 0, slant_range_km: null },
});

function detail(nodeId: string, events: MagEvent[], score: (number | null)[] = [4.2, 7.9, 9.4], t?: number[]): MagDetail {
  const times = t ?? score.map((_, i) => NOW_MS - (score.length - 1 - i) * 1000);
  return {
    node_id: nodeId,
    host_node_id: nodeId.replace(/^mag-/, ""),
    threshold_sigma: 5.5,
    sigma_nt: 15.2,
    series: {
      t: times,
      x: score.map((_, i) => i + 1),
      y: score.map((_, i) => i + 4),
      z: score.map((_, i) => i + 7),
      residual: score.map((_, i) => 8 + i),
      score,
      bx: score.map((_, i) => 21_034.5 + i),
      by: score.map((_, i) => -1_812.3 - i),
      bz: score.map((_, i) => 43_725.1 + i),
      b: score.map((_, i) => 48_564.1 + i),
    },
    events,
  };
}

/** A magnetometer still warming up: readings, but no static level, so no residual and no score. */
function warming(nodeId: string): MagDetail {
  const base = detail(nodeId, [], [null, null, null]);
  const none = base.series.t.map(() => null);
  return { ...base, sigma_nt: null, series: { ...base.series, x: none, y: none, z: none, residual: none } };
}

const DETAIL = detail("mag-synth-002", [magEvent(), EARLIER]);

let fetchMock: ReturnType<typeof vi.fn>;
/** What each magnetometer's detail request answers: a body, or a promise still out. */
let details: Record<string, MagDetail | Promise<never> | "fail">;

function detailCalls() {
  return fetchMock.mock.calls.filter(([url, opts]) => !opts?.method && /\/sim\/magnetometers\/[^/]+\?window=600$/.test(String(url)));
}

function chartNamed(name: RegExp) {
  return within(screen.getByRole("img", { name }));
}

describe("MagnetometerPanel", () => {
  beforeEach(() => {
    details = { "mag-synth-002": DETAIL, "mag-synth-001": detail("mag-synth-001", []), "mag-synth-003": warming("mag-synth-003") };
    fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      if (opts?.method === "POST") {
        return { ok: true, json: async () => ({ ok: true, flyby: { seq: 4 } }) };
      }
      const id = decodeURIComponent(String(url).split("/").pop()!.split("?")[0]);
      const answer = details[id];
      if (answer instanceof Promise) return answer;
      if (!answer || answer === "fail") {
        return { ok: false, status: answer ? 500 : 404, statusText: "Error", json: async () => ({ detail: "no such magnetometer" }) };
      }
      return { ok: true, json: async () => answer };
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the sensor, the detection in progress and the truth behind it", async () => {
    render(<MagnetometerPanel nodeId="mag-synth-002" network={network()} onClose={() => {}} />);
    expect(screen.getByRole("region", { name: "Magnetometer" })).toBeInTheDocument();
    expect(screen.getByText("synth-002")).toBeInTheDocument();
    expect(screen.getByText("Detecting")).toBeInTheDocument();
    expect(screen.getByText("9.4σ of 5.5σ")).toBeInTheDocument();
    expect(screen.getByText("9.4σ")).toBeInTheDocument();
    expect(screen.getByText("RM3100, 200 cycles")).toBeInTheDocument();
    expect(screen.getByText("Detecting now")).toBeInTheDocument();
    expect(screen.getByText("812 nT")).toBeInTheDocument();
    expect(screen.getByText("> 99.99 %")).toBeInTheDocument();
    expect(screen.getByText("less than once in a billion node-hours")).toBeInTheDocument();
    expect(screen.getByText("450 m – 1.20 km")).toBeInTheDocument();
    expect(screen.getByText("uap-flyby-1 at 0.62 km, true peak 830 nT")).toBeInTheDocument();
    await screen.findByText("78 nT, 6.6σ, false alarm");
  });

  // The map's symbol colours are measured against the tiles, not against the
  // panel, and several fall short of 4.5:1 there as text.
  it("writes the state in the console's ink, beside a badge in the state's own colour and shape", async () => {
    render(<MagnetometerPanel nodeId="mag-synth-002" network={network()} onClose={() => {}} />);
    const state = screen.getByText("Detecting");
    expect(state).toHaveClass("mag-state", "mag-state-alarm");
    expect(state).not.toHaveAttribute("style");
    expect(state.querySelector(".mag-glyph svg")).not.toBeNull();
    const live = screen.getByText("Detecting now");
    expect(live).toHaveClass("mag-live-title");
    expect(live).not.toHaveAttribute("style");
    await screen.findByText("78 nT, 6.6σ, false alarm");
  });

  it("charts the last ten minutes against the threshold, and lists what came before", async () => {
    render(<MagnetometerPanel nodeId="mag-synth-002" network={network()} onClose={() => {}} />);
    expect(await screen.findByText("78 nT, 6.6σ, false alarm")).toBeInTheDocument();
    expect(chartNamed(/^Detection score/).getByTestId("chart")).toHaveAttribute("data-points", "3");
    expect(chartNamed(/^Residual field/).getByTestId("chart")).toHaveAttribute("data-points", "3");
    expect(screen.getByTestId("threshold")).toHaveAttribute("data-y", "5.5");
    for (const key of ["score", "x", "y", "z"]) expect(screen.getByTestId(`line-${key}`)).toBeInTheDocument();
  });

  it("keys the residual chart's three axes", async () => {
    render(<MagnetometerPanel nodeId="mag-synth-002" network={network()} onClose={() => {}} />);
    await screen.findByText("78 nT, 6.6σ, false alarm");
    const key = screen.getByRole("list", { name: "Residual axes" });
    expect(within(key).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["X north", "Y east", "Z down"]);
  });

  it("charts what the sensor measured over the same ten minutes as its score and residual", async () => {
    render(<MagnetometerPanel nodeId="mag-synth-002" network={network()} onClose={() => {}} />);
    await screen.findByText("78 nT, 6.6σ, false alarm");
    const field = chartNamed(/^Measured field/);
    expect(field.getByTestId("chart")).toHaveAttribute("data-points", "3");
    expect(field.getByTestId("line-b")).toBeInTheDocument();
    expect(screen.getByText(/^What the sensor reads before anything is taken away/)).toBeInTheDocument();
  });

  // The detector never lets a window span a hole of more than 5 s, and
  // the charts do not draw a line across one either.
  it("breaks its charts where the readings stopped", async () => {
    details["mag-synth-002"] = detail("mag-synth-002", [magEvent(), EARLIER], [1, 1.2, 1.1, 0.9], [NOW_MS - 60_000, NOW_MS - 59_000, NOW_MS - 1_000, NOW_MS]);
    render(<MagnetometerPanel nodeId="mag-synth-002" network={network()} onClose={() => {}} />);
    await screen.findByText("78 nT, 6.6σ, false alarm");
    for (const name of [/^Detection score/, /^Residual field/, /^Measured field/]) {
      expect(chartNamed(name).getByTestId("chart")).toHaveAttribute("data-points", "5");
    }
  });

  // Just after a start or a restart the readings cover seconds, with no
  // whole minute in them: every tick then read the same HH:MM.
  it("draws all three charts on the same ten minutes up to the last reading, ticked on whole minutes, in the same frame", async () => {
    const last = NOW_MS - 7_000;
    details["mag-synth-002"] = detail("mag-synth-002", [magEvent(), EARLIER], [1, 1.1, 1.2], [last - 2_000, last - 1_000, last]);
    render(<MagnetometerPanel nodeId="mag-synth-002" network={network()} onClose={() => {}} />);
    await screen.findByText("78 nT, 6.6σ, false alarm");
    const charts = [/^Detection score/, /^Residual field/, /^Measured field/].map((name) => chartNamed(name));
    const xAxes = charts.map((c) => c.getByTestId("x-axis"));
    for (const axis of xAxes) {
      expect(JSON.parse(axis.getAttribute("data-domain")!)).toEqual([last - 600_000, last]);
      const ticks = JSON.parse(axis.getAttribute("data-ticks")!) as number[];
      expect(ticks.length).toBeGreaterThanOrEqual(4);
      for (const t of ticks) expect(new Date(t).getSeconds() + new Date(t).getMilliseconds()).toBe(0);
      expect(new Set(ticks.map((t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))).size).toBe(ticks.length);
      expect(axis.getAttribute("data-ticks")).toBe(xAxes[0].getAttribute("data-ticks"));
    }
    // One mouse position is one moment on all three: the same margins and
    // the same width of value axis put their plot areas in the same place.
    const margins = charts.map((c) => c.getByTestId("chart").getAttribute("data-margin"));
    expect(new Set(margins).size).toBe(1);
    const widths = charts.map((c) => c.getByTestId("y-axis").getAttribute("data-width"));
    expect(new Set(widths).size).toBe(1);
    expect(Number(widths[0])).toBeGreaterThan(0);
  });

  it("does not redraw its charts for a poll of the network that changes nothing in them", async () => {
    const { rerender } = render(<MagnetometerPanel nodeId="mag-synth-002" network={network()} onClose={() => {}} />);
    await screen.findByText("78 nT, 6.6σ, false alarm");
    const before = draws.count;
    rerender(<MagnetometerPanel nodeId="mag-synth-002" network={network()} onClose={() => {}} />);
    rerender(<MagnetometerPanel nodeId="mag-synth-002" network={withNode(network(), "mag-synth-002", { residual_nt: 12.5 })} onClose={() => {}} />);
    expect(draws.count).toBe(before);
  });

  it("says the common mode is removed only when it is", async () => {
    const base = network();
    const { rerender } = render(<MagnetometerPanel nodeId="mag-synth-002" network={base} onClose={() => {}} />);
    expect(screen.getByText(/after the static level and the network's common mode are removed\.$/)).toBeInTheDocument();

    const few = { ...base, detector: { ...base.detector, common_mode_applied: false } };
    rerender(<MagnetometerPanel nodeId="mag-synth-002" network={few} onClose={() => {}} />);
    expect(screen.getByText("What is left after the static level is removed.")).toHaveClass("mag-chart-caption");
    // Why, in the warning's ink: the muted caption's is under 4.5:1.
    const why = screen.getByText("The common mode is left in: fewer than six magnetometers are reporting.");
    expect(why).toHaveClass("mag-caveat");
    expect(why).not.toHaveClass("mag-chart-caption");

    const off = { ...few, settings: { ...base.settings, mag_common_mode: false } };
    rerender(<MagnetometerPanel nodeId="mag-synth-002" network={off} onClose={() => {}} />);
    expect(screen.getByText("The common mode is left in: it is switched off.")).toHaveClass("mag-caveat");

    // Eight placed and reporting, but the server counts only those with a
    // static level: until then it is the warm-up, not too few magnetometers.
    const warming = Array.from({ length: 8 }, (_, i) => ({ ...base.nodes[2], node_id: `mag-synth-1${i}`, host_node_id: `synth-1${i}` }));
    rerender(<MagnetometerPanel nodeId="mag-synth-002" network={{ ...few, nodes: [...base.nodes, ...warming] }} onClose={() => {}} />);
    expect(screen.getByText("The common mode is left in: it starts once the magnetometers have warmed up.")).toHaveClass("mag-caveat");
    await screen.findByText("78 nT, 6.6σ, false alarm");
  });

  it("says a magnetometer is still warming up, charts what it measures meanwhile, and warns a pass now may go unseen", async () => {
    render(<MagnetometerPanel nodeId="mag-synth-003" network={network()} onClose={() => {}} />);
    expect(screen.getByText("Warming up")).toBeInTheDocument();
    expect(screen.getByText("measuring…")).toBeInTheDocument();
    expect(screen.getByText("not scoring yet")).toBeInTheDocument();
    expect(screen.queryByText("Detecting now")).not.toBeInTheDocument();
    // What it measures is there from the first reading; residual and score are not.
    expect(await chartNamed(/^Measured field/).findByTestId("chart")).toHaveAttribute("data-points", "3");
    expect(chartNamed(/^Detection score/).getByText(/^Not scoring yet/)).toBeInTheDocument();
    expect(chartNamed(/^Residual field/).getByText(/^No residual yet/)).toBeInTheDocument();
    // As on the Physics page: a warning, not a refusal, since a pass timed
    // for after the warm-up is seen.
    expect(screen.getByRole("button", { name: "Fly a UAP past it" })).toBeEnabled();
    expect(screen.getByText("It is still warming up: a pass that arrives before it can score goes unseen.")).toBeInTheDocument();
  });

  it("flies a UAP past this magnetometer and says when it will arrive", async () => {
    render(<MagnetometerPanel nodeId="mag-synth-002" network={network()} onClose={() => {}} />);
    expect(screen.getByText("600 m to one side and 300 m up, at 120 m/s. The radar nodes see it too.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fly a UAP past it" }));
    const eta = new Date(Date.now() + 65_000);
    const message = await screen.findByText(/^UAP flyby #4 on its way past synth-002: closest approach at about /);
    // The clock time the pass is due, give or take the second the test takes.
    const due = [eta, new Date(eta.getTime() + 1000)].map((d) => d.toLocaleTimeString());
    expect(due.some((t) => message.textContent === `UAP flyby #4 on its way past synth-002: closest approach at about ${t}.`)).toBe(true);
    const post = fetchMock.mock.calls.find(([, opts]) => opts?.method === "POST");
    expect(String(post?.[0])).toMatch(/\/sim\/magnetometers\/flyby$/);
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      node_id: "mag-synth-002",
      closest_approach_m: 600,
      altitude_m: 300,
      speed_mps: 120,
      lead_s: 60,
    });
  });

  // "On its way: closest approach at about 13:56:00" still showed at 13:59:
  // the message says when the pass comes, then that it passed, then goes.
  it("says when the pass comes, then that it has passed, then goes back to the pass it flies", async () => {
    vi.useFakeTimers();
    try {
      render(<MagnetometerPanel nodeId="mag-synth-002" network={network()} onClose={() => {}} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      fireEvent.click(screen.getByRole("button", { name: "Fly a UAP past it" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const at = new Date(Date.now() + 65_000).toLocaleTimeString();
      expect(screen.getByText(`UAP flyby #4 on its way past synth-002: closest approach at about ${at}.`)).toBeInTheDocument();

      await act(async () => { await vi.advanceTimersByTimeAsync(65_000); });
      expect(screen.getByText(`UAP flyby #4 passed synth-002 at about ${at}: the summary shows whether it was detected.`)).toHaveClass(
        "mag-chart-caption",
      );

      await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
      expect(screen.queryByText(/^UAP flyby #4/)).not.toBeInTheDocument();
      expect(screen.getByText("600 m to one side and 300 m up, at 120 m/s. The radar nodes see it too.")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a flyby's message with the magnetometer it was for", async () => {
    const { rerender } = render(<MagnetometerPanel nodeId="mag-synth-002" network={network()} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Fly a UAP past it" }));
    await screen.findByText(/UAP flyby #4 on its way/);
    rerender(<MagnetometerPanel nodeId="mag-synth-001" network={network()} onClose={() => {}} />);
    expect(screen.queryByText(/UAP flyby #4 on its way/)).not.toBeInTheDocument();
    expect(await chartNamed(/^Measured field/).findByTestId("chart")).toBeInTheDocument();
  });

  it("keeps a flyby still on its way with the magnetometer it was asked for", async () => {
    let answer: (() => void) | null = null;
    fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (opts?.method === "POST") {
        return new Promise((resolve) => {
          answer = () => resolve({ ok: true, json: async () => ({ ok: true, flyby: { seq: 9 } }) });
        });
      }
      const id = decodeURIComponent(String(url).split("/").pop()!.split("?")[0]);
      return { ok: true, json: async () => details[id] };
    });
    const { rerender } = render(<MagnetometerPanel nodeId="mag-synth-002" network={network()} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Fly a UAP past it" }));
    expect(screen.getByRole("button", { name: "Requesting…" })).toBeDisabled();
    rerender(<MagnetometerPanel nodeId="mag-synth-001" network={network()} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Fly a UAP past it" })).toBeEnabled();
    await act(async () => answer?.());
    expect(screen.queryByText(/UAP flyby #9/)).not.toBeInTheDocument();
  });

  it("shows why a flyby was refused, in the form's words", async () => {
    fetchMock.mockImplementation(async (_url: string, opts?: RequestInit) =>
      opts?.method === "POST"
        ? { ok: false, status: 400, statusText: "Bad Request", json: async () => ({ detail: "lead_s must be 10–600" }) }
        : { ok: true, json: async () => DETAIL },
    );
    render(<MagnetometerPanel nodeId="mag-synth-002" network={network()} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Fly a UAP past it" }));
    const error = await screen.findByText("Error: In (s) must be 10–600");
    // In the error's own ink, not the muted caption's.
    expect(error).toHaveClass("mag-error");
    expect(error).not.toHaveClass("mag-chart-caption");
    expect(screen.getByRole("button", { name: "Fly a UAP past it" })).toBeEnabled();
  });

  it("closes", async () => {
    const onClose = vi.fn();
    render(<MagnetometerPanel nodeId="mag-synth-002" network={network()} onClose={onClose} />);
    // Its detail lands first, so nothing updates after the test is over.
    await screen.findByText("78 nT, 6.6σ, false alarm");
    fireEvent.click(screen.getByTitle("Close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("says a magnetometer the simulator took away is no longer placed, and asks nothing more for it", async () => {
    const base = network();
    const gone = { ...base, nodes: base.nodes.filter((n) => n.node_id !== "mag-synth-002") };
    render(<MagnetometerPanel nodeId="mag-synth-002" network={gone} onClose={() => {}} />);
    expect(screen.getByRole("region", { name: "Magnetometer" })).toBeInTheDocument();
    // Its events outlive it, and carry the radar node it sat beside.
    expect(screen.getByText("synth-002")).toBeInTheDocument();
    expect(screen.getByText(/^No longer placed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fly a UAP past it" })).not.toBeInTheDocument();
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(detailCalls()).toHaveLength(0);
  });

  it("drops the last magnetometer's charts and events the moment another is opened", async () => {
    const { rerender } = render(<MagnetometerPanel nodeId="mag-synth-002" network={network()} onClose={() => {}} />);
    await screen.findByText("78 nT, 6.6σ, false alarm");

    details["mag-synth-001"] = new Promise<never>(() => {});
    rerender(<MagnetometerPanel nodeId="mag-synth-001" network={network()} onClose={() => {}} />);
    expect(screen.getByText("synth-001")).toBeInTheDocument();
    expect(screen.queryByText("78 nT, 6.6σ, false alarm")).not.toBeInTheDocument();
    expect(screen.queryAllByTestId("chart")).toHaveLength(0);
    expect(screen.getAllByText("Loading the last ten minutes…").length).toBeGreaterThan(0);
  });

  it("says so when a magnetometer's last ten minutes cannot be had, and shows none of another's", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(<MagnetometerPanel nodeId="mag-synth-002" network={network()} onClose={() => {}} />);
    await screen.findByText("78 nT, 6.6σ, false alarm");

    details["mag-synth-001"] = "fail";
    rerender(<MagnetometerPanel nodeId="mag-synth-001" network={network()} onClose={() => {}} />);
    expect((await screen.findAllByText(/^Could not load the last ten minutes/)).length).toBeGreaterThan(0);
    expect(screen.queryByText("78 nT, 6.6σ, false alarm")).not.toBeInTheDocument();
    expect(screen.queryAllByTestId("chart")).toHaveLength(0);
  });

  // Put back after being taken away, a magnetometer is new to the server but
  // its old events are still on record.
  it("shows the latest past detection of a magnetometer with no event of its own, and every earlier one", async () => {
    const newer = magEvent({ event_id: "mag-evt-run-1-00007", active: false, end_ms: NOW_MS - 600_000, peak_ms: NOW_MS - 610_000, strength_nt: 111 });
    const older = magEvent({ event_id: "mag-evt-run-1-00003", active: false, end_ms: NOW_MS - 900_000, peak_ms: NOW_MS - 910_000, strength_nt: 222 });
    details["mag-synth-003"] = detail("mag-synth-003", [newer, older]);
    const net = withNode(network(), "mag-synth-003", { state: "quiet", samples: 400, sigma_nt: 15, event: null });
    render(<MagnetometerPanel nodeId="mag-synth-003" network={net} onClose={() => {}} />);
    expect(await screen.findByText("Last detection")).toBeInTheDocument();
    expect(screen.getByText("111 nT")).toBeInTheDocument();
    expect(screen.getByText("222 nT, 9.4σ, UAP")).toBeInTheDocument();
  });

  // The network and the detail are polled on separate timers, so for a moment
  // the detail can know of an event the network does not yet.
  it("never lists an open event as an earlier one, nor the one shown above it twice", async () => {
    const closed = magEvent({ event_id: "mag-evt-run-1-00005", active: false, end_ms: NOW_MS - 60_000, strength_nt: 333 });
    const opening = magEvent({ event_id: "mag-evt-run-1-00009", active: true, start_ms: NOW_MS - 5_000, strength_nt: 444 });
    details["mag-synth-002"] = detail("mag-synth-002", [opening, closed, EARLIER]);
    const net = withNode(network(), "mag-synth-002", { state: "quiet", event: closed });
    render(<MagnetometerPanel nodeId="mag-synth-002" network={net} onClose={() => {}} />);
    await screen.findByText("78 nT, 6.6σ, false alarm");
    expect(screen.getByText("Last detection")).toBeInTheDocument();
    expect(screen.getByText("333 nT")).toBeInTheDocument();
    expect(screen.queryByText(/^333 nT,/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^444 nT/)).not.toBeInTheDocument();
  });

  it("shows a detection whose magnetometer went silent as interrupted, not as live", async () => {
    const net = withNode(network(), "mag-synth-002", { state: "stale", last_ms: NOW_MS - 40_000 });
    render(<MagnetometerPanel nodeId="mag-synth-002" network={net} onClose={() => {}} />);
    expect(screen.getByText("No data")).toBeInTheDocument();
    expect(screen.queryByText("Detecting now")).not.toBeInTheDocument();
    expect(screen.getByText("Detection interrupted")).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`^No readings since ${new Date(NOW_MS - 40_000).toLocaleTimeString()}`))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fly a UAP past it" })).toBeEnabled();
    expect(screen.getByText("It has stopped reporting: a pass goes unseen until its readings resume.")).toBeInTheDocument();
    await screen.findByText("78 nT, 6.6σ, false alarm");
  });

  it("gives an event's confidence only where the noise model covers it", async () => {
    const net = withNode(network(), "mag-synth-002", { event: magEvent({ calibrated: false }) });
    render(<MagnetometerPanel nodeId="mag-synth-002" network={net} onClose={() => {}} />);
    expect(screen.queryByText("> 99.99 %")).not.toBeInTheDocument();
    expect(screen.queryByText("less than once in a billion node-hours")).not.toBeInTheDocument();
    expect(screen.getAllByText("not calibrated")).toHaveLength(2);
    // At least one of the three was missing; the event does not say which.
    const caveat = screen.getByText(
      /^The noise model holds only with the common mode subtracted, no storm and a reading a second\. This detection opened while at least one of those was missing, so it carries no confidence\.$/,
    );
    // A warning, in an ink that reads: the muted caption's is under 4.5:1.
    expect(caveat).toHaveClass("mag-caveat");
    expect(caveat).not.toHaveClass("mag-chart-caption");
    await screen.findByText("78 nT, 6.6σ, false alarm");
  });

  // The server's own reasons when they still hold, beside the general rule.
  it("says why the noise model does not hold now, where it does not", async () => {
    const base = network();
    const net = {
      ...withNode(base, "mag-synth-002", { event: magEvent({ calibrated: false }) }),
      storm: true,
      detector: {
        ...base.detector,
        reading_period_s: 1.6,
        reading_period_calibrated: false,
        false_alarm_model: { ...base.detector.false_alarm_model, calibrated: false },
      },
    };
    render(<MagnetometerPanel nodeId="mag-synth-002" network={net} onClose={() => {}} />);
    expect(screen.getByText(/so it carries no confidence\. The model does not hold now either, with a storm running and readings 1\.6 s apart, not 1 s\.$/)).toBeInTheDocument();
    await screen.findByText("78 nT, 6.6σ, false alarm");
  });

  it("writes time scales in seconds without trailing zeros", async () => {
    const net = withNode(network(), "mag-synth-002", { score_tau_s: 8.0, event: magEvent({ tau_s: 16.42 }) });
    render(<MagnetometerPanel nodeId="mag-synth-002" network={net} onClose={() => {}} />);
    expect(screen.getByText("Best time scale").nextSibling).toHaveTextContent(/^8 s$/);
    expect(screen.getByText("Time scale (distance ÷ speed)").nextSibling).toHaveTextContent(/^16\.4 s$/);
    await screen.findByText("78 nT, 6.6σ, false alarm");
  });

  // After a start, a re-placement or a hole the long scales need minutes of
  // unbroken readings: until then a quiet magnetometer is deaf to slow passes.
  it("says which time scales it searches, and when the slow ones come", async () => {
    const { rerender } = render(<MagnetometerPanel nodeId="mag-synth-002" network={withNode(network(), "mag-synth-002", { longest_scale_s: 64 })} onClose={() => {}} />);
    expect(screen.getByText("Time scales searched").nextSibling).toHaveTextContent(/^2–64 s$/);
    rerender(<MagnetometerPanel nodeId="mag-synth-002" network={withNode(network(), "mag-synth-002", { longest_scale_s: 16 })} onClose={() => {}} />);
    expect(screen.getByText("Time scales searched").nextSibling).toHaveTextContent(/^2–16 s; up to 64 s within 7 min$/);
    rerender(<MagnetometerPanel nodeId="mag-synth-003" network={network()} onClose={() => {}} />);
    expect(screen.getByText("Time scales searched").nextSibling).toHaveTextContent(/^none yet$/);
    await chartNamed(/^Measured field/).findByTestId("chart");
  });

  it("reads |B| and its north, east and down components from the same second", async () => {
    render(<MagnetometerPanel nodeId="mag-synth-002" network={withNode(network(), "mag-synth-002", { b_nt: 50_000 })} onClose={() => {}} />);
    await screen.findByText("78 nT, 6.6σ, false alarm");
    // The detail's last row: 48,566.1 measured, 21,036.5 / -1,814.3 / 43,727.1.
    expect(screen.getByText(`${(48_566).toLocaleString()} nT`)).toBeInTheDocument();
    expect(screen.getByText(`${(21_037).toLocaleString()}, ${(-1_814).toLocaleString()}, ${(43_727).toLocaleString()} nT`)).toBeInTheDocument();
    expect(screen.queryByText(`${(50_000).toLocaleString()} nT`)).not.toBeInTheDocument();
  });

  it("says when its ten minutes hold no readings", async () => {
    details["mag-synth-002"] = { ...detail("mag-synth-002", [magEvent(), EARLIER], []) };
    render(<MagnetometerPanel nodeId="mag-synth-002" network={network()} onClose={() => {}} />);
    expect((await screen.findAllByText("No readings in the last 10 minutes.")).length).toBe(3);
  });

  // A dashboard newer than its server, as during a deploy: the detail lacks
  // the measured field. It must cost that chart, not the map.
  it("charts what an older server sends and says what it does not, without failing", async () => {
    const older = detail("mag-synth-002", [magEvent(), EARLIER]);
    const series: Record<string, unknown> = { ...older.series };
    for (const key of ["bx", "by", "bz", "b"]) delete series[key];
    details["mag-synth-002"] = { ...older, series } as unknown as MagDetail;
    render(<MagnetometerPanel nodeId="mag-synth-002" network={network()} onClose={() => {}} />);
    await screen.findByText("78 nT, 6.6σ, false alarm");
    expect(chartNamed(/^Detection score/).getByTestId("chart")).toHaveAttribute("data-points", "3");
    expect(chartNamed(/^Measured field/).getByText("The server sent no measured field.")).toBeInTheDocument();
    expect(screen.getByText("North, east, down").nextSibling).toHaveTextContent("—");
  });

  // Ended at its last reading, a silent magnetometer's charts read as current
  // ones, its readings minutes old at their right edge. Now is the fleet's
  // clock, as the readings' times are, whatever the server's clock says.
  it.each([
    ["on the server's clock", 0],
    ["two minutes behind the server's", -120_000],
    ["two minutes ahead of the server's", 120_000],
  ])("charts a magnetometer that stopped reporting up to now by a fleet clock %s, so its silence shows as long as it is", async (_, offset) => {
    const last = NOW_MS + offset - 300_000;
    details["mag-synth-002"] = detail("mag-synth-002", [magEvent(), EARLIER], [1, 1.1, 1.2], [last - 2_000, last - 1_000, last]);
    // Five minutes silent; the others read a second ago, by the fleet's clock.
    const silent = withNode(onFleetClock(network(), offset), "mag-synth-002", { state: "stale", last_ms: last });
    const { rerender } = render(<MagnetometerPanel nodeId="mag-synth-002" network={silent} onClose={() => {}} />);
    await screen.findByText("78 nT, 6.6σ, false alarm");
    const ends = () =>
      [/^Detection score/, /^Residual field/, /^Measured field/].map((name) => JSON.parse(chartNamed(name).getByTestId("x-axis").getAttribute("data-domain")!)[1]);
    expect(ends()).toEqual(Array(3).fill(last + 299_000));
    // And on, as the server's clock runs on with no push.
    rerender(<MagnetometerPanel nodeId="mag-synth-002" network={{ ...silent, now_ms: NOW_MS + 4_000 }} onClose={() => {}} />);
    expect(ends()).toEqual(Array(3).fill(last + 303_000));
  });

  // Its readings keep the fleet's time, and a reporting magnetometer is
  // charted up to its last one: a fleet behind the server's clock leaves no
  // gap at the right edge.
  it("charts a reporting magnetometer up to its last reading, whatever the fleet's clock", async () => {
    const last = NOW_MS - 121_000;
    details["mag-synth-002"] = detail("mag-synth-002", [magEvent(), EARLIER], [1, 1.1, 1.2], [last - 2_000, last - 1_000, last]);
    render(<MagnetometerPanel nodeId="mag-synth-002" network={onFleetClock(network(), -120_000)} onClose={() => {}} />);
    await screen.findByText("78 nT, 6.6σ, false alarm");
    expect(JSON.parse(chartNamed(/^Detection score/).getByTestId("x-axis").getAttribute("data-domain")!)[1]).toBe(last);
  });

  // The server sends the ten minutes up to a magnetometer's own last reading:
  // one silent for longer has nothing in the charts' ten minutes.
  it("says a magnetometer silent for more than ten minutes has no readings in them", async () => {
    const last = NOW_MS - 900_000;
    details["mag-synth-002"] = detail("mag-synth-002", [magEvent(), EARLIER], [1, 1.1, 1.2], [last - 2_000, last - 1_000, last]);
    render(
      <MagnetometerPanel nodeId="mag-synth-002" network={withNode(network(), "mag-synth-002", { state: "stale", last_ms: last })} onClose={() => {}} />,
    );
    expect((await screen.findAllByText("No readings in the last 10 minutes.")).length).toBe(3);
    expect(screen.queryAllByTestId("chart")).toHaveLength(0);
  });

  // Recharts drops ticks it thinks crowd each other ("0, 10, 20, 40"), and
  // left to its own on the residual it chose uneven ones.
  it("draws every tick it is given, and the residual on an axis even about zero", async () => {
    details["mag-synth-002"] = detail("mag-synth-002", [magEvent(), EARLIER], [1, 1.1, 1.2]);
    render(<MagnetometerPanel nodeId="mag-synth-002" network={network()} onClose={() => {}} />);
    await screen.findByText("78 nT, 6.6σ, false alarm");
    for (const name of [/^Detection score/, /^Residual field/, /^Measured field/]) {
      expect(chartNamed(name).getByTestId("x-axis")).toHaveAttribute("data-interval", "0");
      expect(chartNamed(name).getByTestId("y-axis")).toHaveAttribute("data-interval", "0");
    }
    const residual = chartNamed(/^Residual field/).getByTestId("y-axis");
    const ticks = JSON.parse(residual.getAttribute("data-ticks")!) as number[];
    // The fixture's residual peaks at 9 nT on its Z axis: ±10 in steps of 5.
    expect(ticks).toEqual([-10, -5, 0, 5, 10]);
    expect(JSON.parse(residual.getAttribute("data-domain")!)).toEqual([-10, 10]);
  });

  // The axis wrote 48,700 and the tooltip 48701.3 nT.
  it("writes a field value the same way on its axis and in its tooltip", async () => {
    render(<MagnetometerPanel nodeId="mag-synth-002" network={network()} onClose={() => {}} />);
    await screen.findByText("78 nT, 6.6σ, false alarm");
    const field = chartNamed(/^Measured field/);
    expect(field.getByTestId("y-axis")).toHaveAttribute("data-writes", (48_700).toLocaleString());
    expect(field.getByTestId("tooltip")).toHaveAttribute(
      "data-writes",
      `${(48_701.3).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} nT`,
    );
    expect(field.getByTestId("tooltip").getAttribute("data-writes")).toContain((48_701).toLocaleString());
  });

  // Its score is a dash once it has stopped reporting, and so is what that
  // score was found on.
  it("says nothing of a silent magnetometer's time scales", async () => {
    const net = withNode(network(), "mag-synth-002", { state: "stale", last_ms: NOW_MS - 40_000, score_tau_s: 64, longest_scale_s: 64 });
    render(<MagnetometerPanel nodeId="mag-synth-002" network={net} onClose={() => {}} />);
    expect(screen.getByText("Detection score").nextSibling).toHaveTextContent(/^—$/);
    expect(screen.getByText("Best time scale").nextSibling).toHaveTextContent(/^—$/);
    expect(screen.getByText("Time scales searched").nextSibling).toHaveTextContent(/^—$/);
    await screen.findByText("78 nT, 6.6σ, false alarm");
  });

  // Ten seconds of readings in ten minutes of chart are a sliver at its edge.
  it("says how little it has charted while its first readings come in", async () => {
    const tenSeconds = Array.from({ length: 11 }, (_, i) => NOW_MS - (10 - i) * 1000);
    details["mag-synth-002"] = detail("mag-synth-002", [magEvent(), EARLIER], tenSeconds.map(() => 1), tenSeconds);
    const { rerender } = render(<MagnetometerPanel nodeId="mag-synth-002" network={network()} onClose={() => {}} />);
    expect(
      await screen.findByText("Only 10 s of readings so far: they sit at the right edge of the charts, which fill in as more arrive."),
    ).toHaveClass("mag-notice");

    // Nothing to say once a minute of them is in.
    const minute = Array.from({ length: 61 }, (_, i) => NOW_MS - (60 - i) * 1000);
    details["mag-synth-001"] = detail("mag-synth-001", [], minute.map(() => 1), minute);
    rerender(<MagnetometerPanel nodeId="mag-synth-001" network={network()} onClose={() => {}} />);
    await chartNamed(/^Measured field/).findByTestId("chart");
    expect(screen.queryByText(/^Only .* of readings so far/)).not.toBeInTheDocument();

    // Nor of one that has gone quiet after a few seconds: nothing more is coming in.
    rerender(
      <MagnetometerPanel nodeId="mag-synth-002" network={withNode(network(), "mag-synth-002", { state: "stale", last_ms: NOW_MS })} onClose={() => {}} />,
    );
    await chartNamed(/^Measured field/).findByTestId("chart");
    expect(screen.getByText("No data")).toBeInTheDocument();
    expect(screen.queryByText(/^Only .* of readings so far/)).not.toBeInTheDocument();
  });

  it("treats an answer without a series as a failed one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    details["mag-synth-002"] = { node_id: "mag-synth-002", events: [] } as unknown as MagDetail;
    render(<MagnetometerPanel nodeId="mag-synth-002" network={network()} onClose={() => {}} />);
    expect((await screen.findAllByText(/^Could not load the last ten minutes/)).length).toBe(3);
  });
});
