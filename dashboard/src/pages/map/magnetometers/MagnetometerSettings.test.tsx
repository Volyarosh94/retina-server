import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MagnetometerSettings from "./MagnetometerSettings";
import { network, withNode } from "../../../test/magnetometerNetwork";
import type { MagNetwork } from "./types";

const MAG_KEYS = [
  "mag_common_mode",
  "mag_cycle_count",
  "mag_enabled",
  "mag_n_nodes",
  "mag_placement",
  "mag_storm",
  "mag_threshold_sigma",
];

/** GET /api/simulation/config where the server runs a fleet. */
const CONFIG = { frac_anomalous: 0.05, frac_drone: 0.1, _updated_at: 100, ...network().settings };

let fetchMock: ReturnType<typeof vi.fn>;

/** What GET /api/sim/magnetometers answers; a test may swap it between polls. */
let running: MagNetwork;

function installFetch({ putStatus = 200, flyby }: { putStatus?: number; flyby?: () => Promise<unknown> } = {}) {
  running = network();
  fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
    const u = String(url);
    const method = opts?.method ?? "GET";
    if (u.endsWith("/sim/magnetometers") && method === "GET") {
      return { ok: true, json: async () => running };
    }
    if (u.endsWith("/simulation/config") && method === "PUT") {
      if (putStatus !== 200) {
        return { ok: false, status: putStatus, statusText: "Bad Request", json: async () => ({ detail: "Magnetometer settings need SYNTHETIC_FLEET_ENABLED" }) };
      }
      return { ok: true, json: async () => ({ ok: true, config: { ...CONFIG, ...JSON.parse(String(opts?.body)), _updated_at: 200 } }) };
    }
    if (u.endsWith("/sim/magnetometers/flyby") && method === "POST") {
      if (flyby) return flyby();
      return { ok: true, json: async () => ({ ok: true, flyby: { ...JSON.parse(String(opts?.body)), seq: 3, requested_at: 1_790_726_400 } }) };
    }
    return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
}

function sent(method: string, path: string) {
  const call = fetchMock.mock.calls.find(([u, o]) => String(u).endsWith(path) && (o?.method ?? "GET") === method);
  return call ? JSON.parse(String(call[1].body)) : undefined;
}

function posts(path: string) {
  return fetchMock.mock.calls.filter(([u, o]) => String(u).endsWith(path) && o?.method === "POST").length;
}

/** The section once the network has answered, so the flyby button can be used. */
async function renderReady(props: Partial<Parameters<typeof MagnetometerSettings>[0]> = {}) {
  const view = render(<MagnetometerSettings config={CONFIG} {...props} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Fly a UAP past it" })).toBeEnabled());
  return view;
}

/** Runs the clock on by `ms` (fake timers) and lets what it set off settle. */
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe("MagnetometerSettings", () => {
  beforeEach(() => installFetch());
  afterEach(() => vi.unstubAllGlobals());

  it("shows nothing, and asks for nothing, where the server runs no fleet", async () => {
    const { container } = render(<MagnetometerSettings config={{ frac_anomalous: 0.05 }} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the running network and what the threshold predicts beside what is measured", async () => {
    render(<MagnetometerSettings config={CONFIG} />);
    expect(await screen.findByText(/^Running: 3 magnetometers · 1 detecting · 0\.013 per node-hour/)).toBeInTheDocument();
    expect(
      screen.getByText(/^Predicted: 0\.00028 false alarms per node-hour, about one every 50 days across 3 magnetometers\. Measured: 0\.013/),
    ).toBeInTheDocument();
  });

  // The page settles the section's write as its own, from the reply.
  it("applies only its own keys, and hands the page the reply", async () => {
    const onApplied = vi.fn();
    render(<MagnetometerSettings config={CONFIG} onApplied={onApplied} />);
    fireEvent.change(await screen.findByRole("slider", { name: "Detection threshold" }), { target: { value: "6.2" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Placement" }), { target: { value: "core" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply magnetometer settings" }));

    await waitFor(() => expect(onApplied).toHaveBeenCalledOnce());
    expect(onApplied).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ _updated_at: 200 }) }), false);
    const body = sent("PUT", "/simulation/config");
    expect(Object.keys(body).sort()).toEqual(MAG_KEYS);
    expect(body.mag_threshold_sigma).toBe(6.2);
    expect(body.mag_placement).toBe("core");
    expect(screen.getByText(/^Applied — the server's detector takes the threshold and the common mode at once, and the simulator the rest at its next poll, within ~5 s\./)).toBeInTheDocument();
  });

  it("hands the page nothing when its Apply is refused", async () => {
    installFetch({ putStatus: 400 });
    const onApplied = vi.fn();
    render(<MagnetometerSettings config={CONFIG} onApplied={onApplied} />);
    fireEvent.change(await screen.findByRole("slider", { name: "Detection threshold" }), { target: { value: "6.4" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply magnetometer settings" }));
    await screen.findByText(/^Error/);
    expect(onApplied).not.toHaveBeenCalled();
    expect(screen.getByText("Unapplied changes")).toBeInTheDocument();
  });

  // Until the page's next poll lands, the config it holds is the one from
  // before the Apply: the form must not flick back to its values meanwhile.
  it("holds what it applied until the next config arrives, then follows the config", async () => {
    const { rerender } = render(<MagnetometerSettings config={CONFIG} />);
    const slider = await screen.findByRole("slider", { name: "Detection threshold" });
    fireEvent.change(slider, { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply magnetometer settings" }));
    await screen.findByText(/^Applied/);
    expect(slider).toHaveValue("7");
    expect(screen.queryByText("Unapplied changes")).not.toBeInTheDocument();

    rerender(<MagnetometerSettings config={{ ...CONFIG, mag_threshold_sigma: 7, _updated_at: 200 }} />);
    expect(slider).toHaveValue("7");
    // Somebody else's change after it: nothing here is unapplied, so the form takes it.
    rerender(<MagnetometerSettings config={{ ...CONFIG, mag_threshold_sigma: 4, _updated_at: 300 }} />);
    expect(slider).toHaveValue("4");
  });

  it("keeps an unapplied edit when the config polls again, and follows the server once applied", async () => {
    const { rerender } = render(<MagnetometerSettings config={CONFIG} />);
    const slider = await screen.findByRole("slider", { name: "Detection threshold" });
    fireEvent.change(slider, { target: { value: "4.5" } });
    rerender(<MagnetometerSettings config={{ ...CONFIG, _updated_at: 150 }} />);
    expect(screen.getByRole("slider", { name: "Detection threshold" })).toHaveValue("4.5");

    fireEvent.click(screen.getByRole("button", { name: "Apply magnetometer settings" }));
    await screen.findByText(/^Applied/);
    rerender(<MagnetometerSettings config={{ ...CONFIG, mag_threshold_sigma: 7, _updated_at: 400 }} />);
    expect(screen.getByRole("slider", { name: "Detection threshold" })).toHaveValue("7");
  });

  it("shows the server's refusal", async () => {
    installFetch({ putStatus: 400 });
    render(<MagnetometerSettings config={CONFIG} />);
    fireEvent.click(await screen.findByRole("button", { name: "Apply magnetometer settings" }));
    expect(await screen.findByText("Error: Magnetometer settings need SYNTHETIC_FLEET_ENABLED")).toBeInTheDocument();
  });

  it("flies a UAP past the magnetometer chosen, with the pass as set", async () => {
    render(<MagnetometerSettings config={CONFIG} />);
    const fly = await screen.findByRole("button", { name: "Fly a UAP past it" });
    await waitFor(() => expect(fly).toBeEnabled());
    fireEvent.change(screen.getByRole("combobox", { name: "Magnetometer" }), { target: { value: "mag-synth-002" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Closest approach (m)" }), { target: { value: "800" } });
    fireEvent.click(fly);

    await screen.findByText(/^UAP flyby #3 requested/);
    expect(sent("POST", "/sim/magnetometers/flyby")).toEqual({
      node_id: "mag-synth-002",
      closest_approach_m: 800,
      altitude_m: 300,
      speed_mps: 120,
      lead_s: 60,
    });
    expect(screen.getByText("UAP flyby #3 requested: it passes synth-002 about 65 s from now. Watch it on the /sim map.")).toBeInTheDocument();
  });

  it("lets the simulator pick the magnetometer when none is chosen", async () => {
    render(<MagnetometerSettings config={CONFIG} />);
    const fly = await screen.findByRole("button", { name: "Fly a UAP past it" });
    await waitFor(() => expect(fly).toBeEnabled());
    fireEvent.click(fly);
    await screen.findByText(/passes a magnetometer the simulator picks/);
    expect(sent("POST", "/sim/magnetometers/flyby")).not.toHaveProperty("node_id");
  });

  // ── The flyby form ───────────────────────────────────────────────────

  it("falls back to Any when the chosen magnetometer is taken away, and asks for what it shows", async () => {
    vi.useFakeTimers();
    try {
      render(<MagnetometerSettings config={CONFIG} />);
      await advance(0);
      const select = screen.getByRole("combobox", { name: "Magnetometer" });
      fireEvent.change(select, { target: { value: "mag-synth-002" } });
      expect(select).toHaveValue("mag-synth-002");

      // The next of the section's 2 s polls no longer lists it.
      running = { ...running, nodes: running.nodes.filter((n) => n.node_id !== "mag-synth-002") };
      await advance(2_000);
      expect(select).toHaveValue("");
      expect(screen.getByText("The magnetometer beside synth-002 is no longer placed: the simulator will pick one.")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Fly a UAP past it" }));
      await advance(0);
      expect(screen.getByText(/passes a magnetometer the simulator picks/)).toBeInTheDocument();
      expect(sent("POST", "/sim/magnetometers/flyby")).not.toHaveProperty("node_id");
    } finally {
      vi.useRealTimers();
    }
  });

  it("names each magnetometer by the radar node it sits beside, and says which cannot see a pass yet", async () => {
    running = withNode(network(), "mag-synth-001", { state: "stale" });
    await renderReady();
    const select = screen.getByRole("combobox", { name: "Magnetometer" });
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Any",
      "beside synth-001 (no data)",
      "beside synth-002",
      "beside synth-003 (warming up)",
    ]);
    fireEvent.change(select, { target: { value: "mag-synth-003" } });
    expect(screen.getByText(/^It is still warming up: a pass that arrives before it can score goes unseen\./)).toBeInTheDocument();
  });

  it("keeps a cleared field empty, says what it must hold, and sends nothing until it does", async () => {
    await renderReady();
    const lead = screen.getByRole("spinbutton", { name: "In (s)" });
    fireEvent.change(lead, { target: { value: "" } });
    expect(lead).toHaveValue(null);
    expect(lead).toHaveAttribute("aria-invalid", "true");
    expect(lead).toHaveAccessibleDescription("Enter a number, 10–600");
    const fly = screen.getByRole("button", { name: "Fly a UAP past it" });
    expect(fly).toBeDisabled();

    fireEvent.change(lead, { target: { value: "5" } });
    expect(lead).toHaveAccessibleDescription("Must be 10–600");
    expect(fly).toBeDisabled();

    fireEvent.change(lead, { target: { value: "90" } });
    expect(lead).toHaveAttribute("aria-invalid", "false");
    expect(fly).toBeEnabled();
    fireEvent.click(fly);
    await screen.findByText(/about 95 s from now/);
    expect(sent("POST", "/sim/magnetometers/flyby").lead_s).toBe(90);
  });

  it("names the form's field, not the API's key, when the server refuses a pass", async () => {
    installFetch({
      flyby: async () => ({ ok: false, status: 400, statusText: "Bad Request", json: async () => ({ detail: "speed_mps must be 5–1000" }) }),
    });
    await renderReady();
    fireEvent.click(screen.getByRole("button", { name: "Fly a UAP past it" }));
    expect(await screen.findByText("Error: Speed (m/s) must be 5–1000")).toBeInTheDocument();
  });

  it("sends one request however often it is clicked while one is on its way", async () => {
    let answer: (() => void) | null = null;
    installFetch({
      flyby: () =>
        new Promise((resolve) => {
          answer = () => resolve({ ok: true, json: async () => ({ ok: true, flyby: { seq: 8 } }) });
        }),
    });
    await renderReady();
    const fly = screen.getByRole("button", { name: "Fly a UAP past it" });
    fireEvent.click(fly);
    fireEvent.click(fly);
    expect(screen.getByRole("button", { name: "Requesting…" })).toBeDisabled();
    await act(async () => answer?.());
    await screen.findByText(/^UAP flyby #8 requested/);
    expect(posts("/sim/magnetometers/flyby")).toBe(1);
    expect(screen.getByRole("button", { name: "Fly a UAP past it" })).toBeEnabled();
  });

  // ── What the threshold predicts ──────────────────────────────────────

  it("runs the threshold over the server's whole range, 3–12σ", async () => {
    render(<MagnetometerSettings config={{ ...CONFIG, mag_threshold_sigma: 10 }} />);
    const slider = await screen.findByRole("slider", { name: "Detection threshold" });
    expect(slider).toHaveAttribute("min", "3");
    expect(slider).toHaveAttribute("max", "12");
    expect(slider).toHaveValue("10");
    expect(slider.style.getPropertyValue("--fill-pct")).toBe(`${(7 / 9) * 100}%`);
  });

  it("predicts across the number of magnetometers being set, not only those running", async () => {
    render(<MagnetometerSettings config={CONFIG} />);
    await screen.findByText(/^Predicted: 0\.00028 false alarms per node-hour, about one every 50 days across 3 magnetometers/);
    fireEvent.change(screen.getByRole("slider", { name: "Number of magnetometers" }), { target: { value: "20" } });
    expect(screen.getByText(/about one every 8 days across 20 magnetometers/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /Put an RM3100 beside some of the radar sites/ }));
    expect(screen.getByText(/^Predicted false alarms: none, with no magnetometers placed\./)).toBeInTheDocument();
  });

  it("predicts nothing where the noise model was not fitted: a storm, the common mode left in, too few magnetometers", async () => {
    render(<MagnetometerSettings config={CONFIG} />);
    await screen.findByText(/^Predicted: 0\.00028/);
    const storm = screen.getByRole("checkbox", { name: /Geomagnetic storm/ });
    fireEvent.click(storm);
    expect(screen.getByText(/^Predicted: not calibrated with a storm\. The model covers sensor noise and daily variation, with the common mode removed and a reading a second\. Measured: 0\.013/)).toBeInTheDocument();
    fireEvent.click(storm);
    fireEvent.click(screen.getByRole("checkbox", { name: /Remove the network's common mode/ }));
    expect(screen.getByText(/^Predicted: not calibrated with the common mode left in\./)).toBeInTheDocument();
  });

  // "measuring…" at the end of the sentence read "measuring….".
  it("says the false-alarm rate is not measured yet, once", async () => {
    const base = network();
    running = { ...base, stats: { ...base.stats, node_hours: 0, false_alarms: 0, false_alarms_per_node_hour: null, false_alarms_per_node_hour_ci95: null } };
    render(<MagnetometerSettings config={CONFIG} />);
    const prediction = await screen.findByText(/^Predicted: 0\.00028 false alarms per node-hour/);
    expect(prediction.textContent).toMatch(/ Measured: not yet\.$/);
  });

  it("takes the server's word that the running network is outside the model", async () => {
    const base = network();
    installFetch();
    running = {
      ...base,
      detector: { ...base.detector, common_mode_applied: false, false_alarm_model: { ...base.detector.false_alarm_model, calibrated: false } },
    };
    render(<MagnetometerSettings config={CONFIG} />);
    expect(await screen.findByText(/^Predicted: not calibrated with fewer than six magnetometers reporting\./)).toBeInTheDocument();
  });

  // ── What an Apply sets warming up again ─────────────────────────────

  /** The network with `count` magnetometers placed and scoring, the common mode subtracted. */
  function placed(count: number, patch: Partial<MagNetwork["nodes"][number]> = {}): MagNetwork {
    const base = network();
    const nodes = Array.from({ length: count }, (_, i) => ({ ...base.nodes[0], node_id: `mag-synth-1${i}`, host_node_id: `synth-1${i}`, event: null, ...patch }));
    return { ...base, nodes };
  }

  async function applied(change: () => void, config = CONFIG) {
    render(<MagnetometerSettings config={config} />);
    await screen.findByText(/^Running: \d+ magnetometers/);
    change();
    fireEvent.click(screen.getByRole("button", { name: "Apply magnetometer settings" }));
    return (await screen.findByText(/^Applied/)).textContent ?? "";
  }

  const relearn = /every magnetometer's noise estimate again: they read warming up for up to a minute and a half\./;
  const newSites = "Magnetometers placed at new sites start from nothing: they read warming up for about three minutes.";

  it("says when what it applies sets every magnetometer warming up again", async () => {
    const message = await applied(() => fireEvent.change(screen.getByRole("combobox", { name: "Cycle count" }), { target: { value: "400" } }));
    expect(message).toMatch(/ A new cycle count starts every magnetometer's noise estimate again: they read warming up for up to a minute and a half\.$/);
    expect(message).not.toContain(newSites);
  });

  // The setting switches the common mode in or out only where six or more
  // magnetometers are placed; elsewhere it changes nothing the detector does.
  it("promises a re-warm for the common mode only where switching it changes what is subtracted", async () => {
    const base = network();
    const commonModeOff = () => fireEvent.click(screen.getByRole("checkbox", { name: /Remove the network's common mode/ }));

    running = { ...base, detector: { ...base.detector, common_mode_applied: false } };
    const few = render(<MagnetometerSettings config={CONFIG} />);
    await screen.findByText(/^Running: 3 magnetometers/);
    commonModeOff();
    fireEvent.click(screen.getByRole("button", { name: "Apply magnetometer settings" }));
    expect(await screen.findByText(/^Applied/)).not.toHaveTextContent(relearn);
    few.unmount();

    running = placed(6);
    expect(await applied(commonModeOff)).toMatch(/ Leaving the common mode in starts every magnetometer's noise estimate again/);
  });

  // During the start-up warm-up the server subtracts no common mode yet, and
  // will once enough have a static level, whatever is applied meanwhile.
  it("promises no re-warm for a threshold applied while the magnetometers are still warming up", async () => {
    const warmingUp = placed(8, { state: "warming_up", residual_nt: null, score_tau_s: null, longest_scale_s: null, sigma_nt: null });
    running = { ...warmingUp, detector: { ...warmingUp.detector, common_mode_applied: false, false_alarm_model: { ...warmingUp.detector.false_alarm_model, calibrated: false } } };
    const message = await applied(() => fireEvent.change(screen.getByRole("slider", { name: "Detection threshold" }), { target: { value: "6.5" } }));
    expect(message).not.toMatch(/warming up/);
  });

  // The simulator places its magnetometers afresh, and one at a new site has
  // no static level and no noise estimate: about three minutes before it scores.
  it("says magnetometers at new sites warm up again when the placement changes or more are placed", async () => {
    running = placed(8);
    const moved = await applied(() => fireEvent.change(screen.getByRole("combobox", { name: "Placement" }), { target: { value: "core" } }));
    expect(moved).toContain(newSites);
    expect(moved).not.toMatch(relearn);
    cleanup();

    running = placed(8);
    expect(await applied(() => fireEvent.change(screen.getByRole("slider", { name: "Number of magnetometers" }), { target: { value: "12" } }))).toContain(newSites);
    cleanup();

    // Fewer, from the same placement: those that stay keep their sites.
    running = placed(8);
    const fewer = await applied(() => fireEvent.change(screen.getByRole("slider", { name: "Number of magnetometers" }), { target: { value: "6" } }));
    expect(fewer).not.toMatch(/warming up/);
  });

  // Down to four the common mode goes out, and every magnetometer's noise
  // estimate starts again.
  it("bases the re-warm note on the settings being applied, not on what reports now", async () => {
    running = placed(8);
    const message = await applied(() => fireEvent.change(screen.getByRole("slider", { name: "Number of magnetometers" }), { target: { value: "4" } }));
    expect(message).toMatch(/ Leaving the common mode in, with fewer than six magnetometers, starts every magnetometer's noise estimate again: they read warming up for up to a minute and a half\.$/);
    expect(message).not.toContain(newSites);
  });

  // ── Unapplied edits ──────────────────────────────────────────────────

  // The edit made while the Apply was out never went with it.
  it("keeps an edit made while its Apply is on its way, and tells the page it is still unapplied", async () => {
    let answer: (() => void) | null = null;
    const put = fetchMock.getMockImplementation() as (url: string, opts?: RequestInit) => Promise<unknown>;
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (String(url).endsWith("/simulation/config") && opts?.method === "PUT") {
        return new Promise((resolve) => {
          answer = () => resolve(put(url, opts));
        });
      }
      return put(url, opts);
    });
    const onDirtyChange = vi.fn();
    const onApplied = vi.fn();
    render(<MagnetometerSettings config={CONFIG} onDirtyChange={onDirtyChange} onApplied={onApplied} />);
    const slider = await screen.findByRole("slider", { name: "Detection threshold" });
    fireEvent.change(slider, { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply magnetometer settings" }));
    fireEvent.change(slider, { target: { value: "8" } });
    await act(async () => answer?.());
    await screen.findByText(/^Applied/);
    expect(slider).toHaveValue("8");
    expect(screen.getByText("Unapplied changes")).toBeInTheDocument();
    expect(onApplied).toHaveBeenCalledWith(expect.anything(), true);
    expect(onDirtyChange).not.toHaveBeenCalledWith(false);
    expect(sent("PUT", "/simulation/config").mag_threshold_sigma).toBe(7);
  });

  // Discarded while its Apply was out, the form's later edit went with it.
  it("tells the page nothing is unapplied when its Apply answers after the page discarded it", async () => {
    let answer: (() => void) | null = null;
    const put = fetchMock.getMockImplementation() as (url: string, opts?: RequestInit) => Promise<unknown>;
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (String(url).endsWith("/simulation/config") && opts?.method === "PUT") {
        return new Promise((resolve) => {
          answer = () => resolve(put(url, opts));
        });
      }
      return put(url, opts);
    });
    const onApplied = vi.fn();
    const { rerender } = render(<MagnetometerSettings config={CONFIG} discard={0} onApplied={onApplied} />);
    const slider = await screen.findByRole("slider", { name: "Detection threshold" });
    fireEvent.change(slider, { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply magnetometer settings" }));
    fireEvent.change(slider, { target: { value: "8" } });
    rerender(<MagnetometerSettings config={CONFIG} discard={1} onApplied={onApplied} />);
    await act(async () => answer?.());
    expect(onApplied).toHaveBeenCalledWith(expect.anything(), false);
    expect(screen.getByRole("slider", { name: "Detection threshold" })).toHaveValue("5.5");
  });

  it("predicts nothing while the readings are not a second apart, and names every reason", async () => {
    const base = network();
    running = {
      ...base,
      detector: {
        ...base.detector,
        reading_period_s: 1.6,
        reading_period_calibrated: false,
        false_alarm_model: { ...base.detector.false_alarm_model, calibrated: false },
      },
    };
    render(<MagnetometerSettings config={CONFIG} />);
    expect(await screen.findByText(/^Predicted: not calibrated with readings 1\.6 s apart, not 1 s\. The model covers sensor noise and daily variation, with the common mode removed and a reading a second\./)).toBeInTheDocument();
    // A storm being switched on adds its own reason to the readings'.
    fireEvent.click(screen.getByRole("checkbox", { name: /Geomagnetic storm/ }));
    expect(screen.getByText(/^Predicted: not calibrated with a storm and readings 1\.6 s apart, not 1 s\./)).toBeInTheDocument();
  });

  it("says the prediction waits for the warm-up when enough are placed but few have a static level", async () => {
    const base = network();
    const warming = Array.from({ length: 5 }, (_, i) => ({ ...base.nodes[2], node_id: `mag-w${i}`, host_node_id: `w${i}` }));
    running = {
      ...base,
      nodes: [...base.nodes, ...warming],
      detector: { ...base.detector, common_mode_applied: false, false_alarm_model: { ...base.detector.false_alarm_model, calibrated: false } },
    };
    render(<MagnetometerSettings config={CONFIG} />);
    expect(await screen.findByText(/^Predicted: not calibrated with the magnetometers still warming up\./)).toBeInTheDocument();
  });

  it("drops its unapplied settings when the page discards them, and keeps the flyby form", async () => {
    const { rerender } = render(<MagnetometerSettings config={CONFIG} discard={0} />);
    fireEvent.change(await screen.findByRole("slider", { name: "Detection threshold" }), { target: { value: "7" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Altitude (m)" }), { target: { value: "450" } });
    rerender(<MagnetometerSettings config={CONFIG} discard={1} />);
    expect(screen.getByRole("slider", { name: "Detection threshold" })).toHaveValue("5.5");
    expect(screen.queryByText("Unapplied changes")).not.toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Altitude (m)" })).toHaveValue(450);
  });

  it("marks its edits as unapplied until they are applied, and tells the page", async () => {
    const onDirtyChange = vi.fn();
    const onApplied = vi.fn();
    render(<MagnetometerSettings config={CONFIG} onDirtyChange={onDirtyChange} onApplied={onApplied} />);
    expect(screen.queryByText("Unapplied changes")).not.toBeInTheDocument();
    fireEvent.change(await screen.findByRole("slider", { name: "Detection threshold" }), { target: { value: "7" } });
    expect(screen.getByText("Unapplied changes")).toBeInTheDocument();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Apply magnetometer settings" }));
    await screen.findByText(/^Applied/);
    expect(screen.queryByText("Unapplied changes")).not.toBeInTheDocument();
    expect(onApplied).toHaveBeenCalledWith(expect.anything(), false);
  });

  // A section that goes takes its edits with it: the page must stop counting
  // them, whether the server stopped sending the fleet's keys or the page
  // was closed.
  it("tells the page it holds nothing unapplied once it goes", async () => {
    const onDirtyChange = vi.fn();
    const { rerender } = render(<MagnetometerSettings config={CONFIG} onDirtyChange={onDirtyChange} />);
    fireEvent.change(await screen.findByRole("slider", { name: "Detection threshold" }), { target: { value: "7" } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    rerender(<MagnetometerSettings config={{ frac_anomalous: 0.05, _updated_at: 100 }} onDirtyChange={onDirtyChange} />);
    expect(screen.queryByRole("slider", { name: "Detection threshold" })).not.toBeInTheDocument();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });
});
