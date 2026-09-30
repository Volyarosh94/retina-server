import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MagnetometerPanel from "./MagnetometerPanel";
import { magEvent, network, NOW_MS } from "../../../test/magnetometerNetwork";

// Recharts measures a real layout; under jsdom there is none, so the chart
// chrome is stubbed down to what the panel hands it.
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ children, data }: { children: ReactNode; data: unknown[] }) => (
    <div data-testid="chart" data-points={data.length}>
      {children}
    </div>
  ),
  Line: ({ dataKey }: { dataKey: string }) => <span data-testid={`line-${dataKey}`} />,
  ReferenceLine: ({ y }: { y: number }) => <span data-testid="threshold" data-y={y} />,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
}));

const EARLIER = magEvent({
  event_id: "mag-synth-002-0",
  active: false,
  end_ms: NOW_MS - 3_000_000,
  peak_ms: NOW_MS - 3_010_000,
  strength_nt: 31.6,
  score_sigma: 5.7,
  truth: { label: "false", provisional: false, object_id: null, true_peak_nt: 0, slant_range_km: null },
});

const DETAIL = {
  node_id: "mag-synth-002",
  host_node_id: "synth-002",
  threshold_sigma: 5.5,
  sigma_nt: 15.2,
  series: {
    t: [NOW_MS - 2_000, NOW_MS - 1_000, NOW_MS],
    x: [1, 2, 3],
    y: [4, 5, 6],
    z: [7, 8, 9],
    residual: [8, 9.6, 11.2],
    score: [4.2, 7.9, 9.4],
  },
  events: [magEvent(), EARLIER],
};

let fetchMock: ReturnType<typeof vi.fn>;

describe("MagnetometerPanel", () => {
  beforeEach(() => {
    fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      if (opts?.method === "POST") {
        return { ok: true, json: async () => ({ ok: true, flyby: { seq: 4 }, updated_at: 500 }) };
      }
      return { ok: true, json: async () => DETAIL };
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

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
  });

  it("charts the last ten minutes against the threshold, and lists what came before", async () => {
    render(<MagnetometerPanel nodeId="mag-synth-002" network={network()} onClose={() => {}} />);
    expect(await screen.findByText("32 nT, 5.7σ, false alarm")).toBeInTheDocument();
    const charts = screen.getAllByTestId("chart");
    expect(charts).toHaveLength(2);
    for (const chart of charts) expect(chart).toHaveAttribute("data-points", "3");
    expect(screen.getByTestId("threshold")).toHaveAttribute("data-y", "5.5");
    for (const key of ["score", "x", "y", "z"]) expect(screen.getByTestId(`line-${key}`)).toBeInTheDocument();
  });

  it("says a magnetometer is still measuring its noise while it warms up", () => {
    render(<MagnetometerPanel nodeId="mag-synth-003" network={network()} onClose={() => {}} />);
    expect(screen.getByText("Warming up")).toBeInTheDocument();
    expect(screen.getByText("measuring…")).toBeInTheDocument();
    expect(screen.queryByText("Detecting now")).not.toBeInTheDocument();
  });

  it("flies a UAP past this magnetometer and says when it will arrive", async () => {
    render(<MagnetometerPanel nodeId="mag-synth-002" network={network()} onClose={() => {}} />);
    expect(screen.getByText("600 m to one side and 300 m up, at 120 m/s. The radar nodes see it too.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fly a UAP past it" }));
    const eta = new Date(Date.now() + 65_000);
    const message = await screen.findByText(/^UAP flyby #4 on its way: closest approach at about /);
    // The clock time the pass is due, give or take the second the test takes.
    const due = [eta, new Date(eta.getTime() + 1000)].map((d) => d.toLocaleTimeString());
    expect(due.some((t) => message.textContent === `UAP flyby #4 on its way: closest approach at about ${t}.`)).toBe(true);
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

  it("keeps a flyby's message with the magnetometer it was for", async () => {
    const { rerender } = render(<MagnetometerPanel nodeId="mag-synth-002" network={network()} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Fly a UAP past it" }));
    await screen.findByText(/UAP flyby #4 on its way/);
    rerender(<MagnetometerPanel nodeId="mag-synth-001" network={network()} onClose={() => {}} />);
    expect(screen.queryByText(/UAP flyby #4 on its way/)).not.toBeInTheDocument();
  });

  it("shows why a flyby was refused", async () => {
    fetchMock.mockImplementation(async (_url: string, opts?: RequestInit) =>
      opts?.method === "POST"
        ? { ok: false, status: 404, statusText: "Not Found", json: async () => ({ detail: "Not Found" }) }
        : { ok: true, json: async () => DETAIL },
    );
    render(<MagnetometerPanel nodeId="mag-synth-002" network={network()} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Fly a UAP past it" }));
    expect(await screen.findByText("Error: Not Found")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fly a UAP past it" })).toBeEnabled();
  });

  it("closes, and shows nothing for a magnetometer that has gone", () => {
    const onClose = vi.fn();
    const { rerender, container } = render(<MagnetometerPanel nodeId="mag-synth-002" network={network()} onClose={onClose} />);
    fireEvent.click(screen.getByTitle("Close"));
    expect(onClose).toHaveBeenCalled();
    rerender(<MagnetometerPanel nodeId="mag-gone" network={network()} onClose={onClose} />);
    expect(container).toBeEmptyDOMElement();
  });
});
