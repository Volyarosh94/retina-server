import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import PhysicsSettings from "./PhysicsSettings";
import { network } from "../../test/magnetometerNetwork";

// Config payload shaped like a fresh backend: the fraction keys are always
// present, but min_aircraft/max_aircraft/max_range_km/n_nodes/dual_fraction
// are only-if-set (core/state.py:545) and absent until an operator PUTs one.
const BARE_CONFIG = {
  frac_anomalous: 0.05,
  frac_drone: 0.1,
  frac_dark: 0.15,
  ground_truth_counts: { total: 0, anomalous: 0, drone: 0, aircraft: 0 },
};

// The Doppler guide links to the map route, so the page needs a router.
function renderSettings() {
  return render(<MemoryRouter><PhysicsSettings /></MemoryRouter>);
}

function installFetchMock(configRef?: { current: Record<string, unknown> }) {
  const fetchMock = vi.fn((url: string, opts?: RequestInit) => {
    const u = String(url);
    if (u.includes("/simulation/config")) {
      if (opts?.method === "PUT") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ok: true, config: configRef?.current ?? BARE_CONFIG }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => configRef?.current ?? BARE_CONFIG,
      } as Response);
    }
    if (u.includes("/simulation/ground-truth")) {
      return Promise.resolve({ ok: true, json: async () => ({ aircraft: [] }) } as Response);
    }
    if (u.includes("/test/solver-stats")) {
      return Promise.resolve({ ok: false, json: async () => ({}) } as Response);
    }
    if (u.includes("/radar/nodes")) {
      return Promise.resolve({ ok: true, json: async () => ({ nodes: {} }) } as Response);
    }
    return Promise.resolve({ ok: false, json: async () => ({}) } as Response);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// Every range input on the page, in DOM order:
// [0] anomalous, [1] drone, [2] dark, [3] total objects target, then scene.
function ranges() {
  return Array.from(
    document.querySelectorAll('input[type="range"]'),
  ) as HTMLInputElement[];
}

describe("PhysicsSettings", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("falls back to numeric draft defaults when the config payload omits min/max_aircraft and max_range_km (no NaN)", async () => {
    installFetchMock();
    renderSettings();

    // "Total objects target" sublabel is built from draft.min_aircraft /
    // draft.max_aircraft — must render the fallback 20-40, never NaN-NaN.
    await waitFor(() => {
      expect(screen.getByText(/spawns 20–40/)).toBeInTheDocument();
    });

    // sceneDraft.max_range_km falls back to 0, which renders as "auto"
    // (per-node generated ranges), not "0 km" and not "NaN km".
    await waitFor(() => {
      expect(screen.getByText("auto")).toBeInTheDocument();
    });

    expect(document.body.textContent).not.toMatch(/NaN/);
  });

  it("sends max_range_km in the Fleet Scene apply payload, not the main Apply payload", async () => {
    const fetchMock = installFetchMock();
    renderSettings();

    await waitFor(() => {
      expect(screen.getByText(/spawns 20–40/)).toBeInTheDocument();
    });

    // Main Apply — must NOT carry max_range_km, and min/max_aircraft must
    // be numeric on the wire (the draft default guarantees this even
    // before the operator touches a slider).
    fireEvent.click(screen.getByRole("button", { name: /Apply to Simulator/i }));

    await waitFor(() => {
      const mainApplyCall = fetchMock.mock.calls.find(
        ([, opts]: any) =>
          opts?.method === "PUT" && !("max_range_km" in JSON.parse(opts.body)) &&
          "frac_anomalous" in JSON.parse(opts.body),
      );
      expect(mainApplyCall).toBeTruthy();
      const body = JSON.parse((mainApplyCall as any)[1].body);
      expect(body).not.toHaveProperty("max_range_km");
      expect(typeof body.min_aircraft).toBe("number");
      expect(typeof body.max_aircraft).toBe("number");
      expect(Number.isNaN(body.min_aircraft)).toBe(false);
      expect(Number.isNaN(body.max_aircraft)).toBe(false);
    });

    // Fleet Scene apply — arm, then confirm — MUST carry max_range_km.
    const sceneBtn = screen.getByRole("button", { name: /Apply Scene Change/i });
    fireEvent.click(sceneBtn); // arms
    const confirmBtn = await screen.findByRole("button", { name: /Confirm restart/i });
    fireEvent.click(confirmBtn); // confirms — PUTs

    await waitFor(() => {
      const sceneApplyCall = fetchMock.mock.calls.find(
        ([, opts]: any) =>
          opts?.method === "PUT" && "n_nodes" in JSON.parse(opts.body),
      );
      expect(sceneApplyCall).toBeTruthy();
      const body = JSON.parse((sceneApplyCall as any)[1].body);
      expect(body).toHaveProperty("max_range_km");
      expect(typeof body.max_range_km).toBe("number");
    });
  });

  // ── Live ADS-B knobs ──────────────────────────────────────────────────
  // Real aircraft pulled from adsb.retina.fm into the simulated world; the
  // dark share of THOSE is its own slider, outside the synthetic mix.

  it("falls back to the live-feed defaults when the payload omits them, and sends both on Apply", async () => {
    const fetchMock = installFetchMock();
    renderSettings();
    await waitFor(() => {
      expect(screen.getByText(/spawns 20–40/)).toBeInTheDocument();
    });

    const liveSlider = screen.getByLabelText("Dark share of live aircraft") as HTMLInputElement;
    expect(liveSlider.value).toBe("15");
    expect(liveSlider.disabled).toBe(false);
    const toggle = screen.getByRole("checkbox") as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    fireEvent.change(liveSlider, { target: { value: "60" } });
    expect(liveSlider.value).toBe("60");

    fireEvent.click(screen.getByRole("button", { name: /Apply to Simulator/i }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([, opts]: any) => opts?.method === "PUT" && "frac_live_dark" in JSON.parse(opts.body),
      );
      expect(call).toBeTruthy();
      const body = JSON.parse((call as any)[1].body);
      expect(body.frac_live_dark).toBe(0.6);
      expect(body.live_adsb_enabled).toBe(true);
      // Still the synthetic knobs alongside — one PUT, never a scene restart.
      expect(body).toHaveProperty("frac_dark");
      expect(body).not.toHaveProperty("n_nodes");
    });
  });

  it("disables the live dark-share slider when the feed is switched off, and sends the flag", async () => {
    const fetchMock = installFetchMock({
      current: { ...BARE_CONFIG, frac_live_dark: 0.3, live_adsb_enabled: true },
    });
    renderSettings();
    await waitFor(() => {
      expect(screen.getByText(/spawns 20–40/)).toBeInTheDocument();
    });
    const liveSlider = screen.getByLabelText("Dark share of live aircraft") as HTMLInputElement;
    expect(liveSlider.value).toBe("30");

    fireEvent.click(screen.getByRole("checkbox"));
    expect(liveSlider.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Apply to Simulator/i }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([, opts]: any) => opts?.method === "PUT" && "live_adsb_enabled" in JSON.parse(opts.body),
      );
      expect(call).toBeTruthy();
      expect(JSON.parse((call as any)[1].body).live_adsb_enabled).toBe(false);
    });
  });

  // ── Drift detection ───────────────────────────────────────────────────
  // A backend restart drops simulation_config back to boot state and
  // re-stamps _updated_at at import. The drafts used to seed once and never
  // re-sync, so the sliders kept showing an applied scene while the
  // simulator had already been pushed back to defaults.

  const APPLIED = {
    frac_anomalous: 0.0,
    frac_drone: 0.30,
    frac_dark: 0.15,
    min_aircraft: 64,
    max_aircraft: 80,
    _updated_at: 2000,
    ground_truth_counts: { total: 0, anomalous: 0, drone: 0, aircraft: 0 },
  };

  // What a restarted backend serves: boot defaults, stamped at import — an
  // earlier wall-clock than the operator's PUT, so the stamp moves backwards.
  const AFTER_RESTART = {
    frac_anomalous: 0.0,
    frac_drone: 0.0,
    frac_dark: 0.15,
    _updated_at: 1000,
    ground_truth_counts: { total: 0, anomalous: 0, drone: 0, aircraft: 0 },
  };

  async function pollOnce() {
    // The config poll is on a 10 s interval; advance past one tick and let
    // the fetch promises settle inside act.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
  }

  it("re-syncs the sliders when the backend reverts and there are no unsaved edits", async () => {
    const configRef = { current: APPLIED as Record<string, unknown> };
    installFetchMock(configRef);
    vi.useFakeTimers();
    renderSettings();

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(ranges()[1].value).toBe("30");   // drone, as applied
    expect(ranges()[3].value).toBe("80");   // total objects target

    configRef.current = AFTER_RESTART;
    await pollOnce();

    // Sliders now show what the simulator is actually running, not the
    // stale applied values.
    expect(ranges()[1].value).toBe("0");
    expect(ranges()[3].value).toBe("40");   // key absent → documented fallback
    expect(document.body.textContent).toMatch(/reverted to boot state/);
    expect(document.body.textContent).toMatch(/actually running/);

    vi.useRealTimers();
  });

  it("keeps unapplied edits when the backend reverts, and warns instead", async () => {
    const configRef = { current: APPLIED as Record<string, unknown> };
    installFetchMock(configRef);
    vi.useFakeTimers();
    renderSettings();

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.change(ranges()[1], { target: { value: "25" } });
    expect(ranges()[1].value).toBe("25");

    configRef.current = AFTER_RESTART;
    await pollOnce();

    // The operator's in-progress edit is theirs — never overwritten.
    expect(ranges()[1].value).toBe("25");
    expect(document.body.textContent).toMatch(/no longer sit on top of what/);
    expect(screen.getByRole("button", { name: /Reload from simulator/i })).toBeInTheDocument();

    vi.useRealTimers();
  });

  it("does not flag drift for the page's own apply", async () => {
    const configRef = { current: APPLIED as Record<string, unknown> };
    installFetchMock(configRef);
    vi.useFakeTimers();
    renderSettings();

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.change(ranges()[1], { target: { value: "25" } });

    // The PUT echoes the new config back with a fresh stamp; the poll that
    // follows must read that as our own write, not somebody else's.
    configRef.current = { ...APPLIED, frac_drone: 0.25, _updated_at: 3000 };
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Apply to Simulator/i }));
      await vi.advanceTimersByTimeAsync(0);
    });
    await pollOnce();

    expect(document.body.textContent).not.toMatch(/changed outside this page/);

    vi.useRealTimers();
  });

  // ── Magnetometers ────────────────────────────────────────────────────
  // A section of its own, present only where the server returns the mag_*
  // keys (a synthetic fleet), with its own Apply. Its unapplied edits count in
  // the page's drift check, and its Apply is settled as the page's own is.

  const MAG = {
    mag_enabled: true,
    mag_n_nodes: 8,
    mag_placement: "spread",
    mag_cycle_count: 200,
    mag_storm: false,
    mag_threshold_sigma: 5.5,
    mag_common_mode: true,
  };

  const threshold = () => screen.getByRole("slider", { name: "Detection threshold" }) as HTMLInputElement;
  const banner = () => document.querySelector(".ps-drift")?.textContent ?? "";

  /**
   * The config route as the server runs it: a request is answered from the
   * config as it stands when the request arrives, and a reply can be held
   * back and released later, so a test can reorder them.
   */
  function installServer(initial: Record<string, unknown>, { holdGets = false, holdPuts = false } = {}) {
    const server = { config: { ...initial }, stamp: 5000 };
    const held: { kind: "GET" | "PUT"; send: () => void }[] = [];
    const answer = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
    const fetchMock = vi.fn((url: string, opts?: RequestInit) => {
      const u = String(url);
      if (u.includes("/simulation/config")) {
        const put = opts?.method === "PUT";
        if (put) server.config = { ...server.config, ...JSON.parse(String(opts?.body)), _updated_at: ++server.stamp };
        const body = put ? { ok: true, config: { ...server.config } } : { ...server.config };
        if (!(put ? holdPuts : holdGets)) return Promise.resolve(answer(body));
        return new Promise<Response>((resolve) => held.push({ kind: put ? "PUT" : "GET", send: () => resolve(answer(body)) }));
      }
      if (/\/sim\/magnetometers$/.test(u)) return Promise.resolve(answer(network()));
      if (u.includes("/sim/magnetometers/flyby")) {
        // A flyby is a command: the config carries it, its stamp does not move.
        server.config = { ...server.config, mag_flyby: { seq: 1 } };
        // What a server from before that sent: the stamp, beside the flyby.
        return Promise.resolve(answer({ ok: true, flyby: { seq: 1 }, updated_at: 9999 }));
      }
      if (u.includes("/simulation/ground-truth")) return Promise.resolve(answer({ aircraft: [] }));
      if (u.includes("/radar/nodes")) return Promise.resolve(answer({ nodes: {} }));
      return Promise.resolve({ ok: false, status: 404, statusText: "Not Found", json: async () => ({}) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    return {
      server,
      fetchMock,
      /** Sends the held replies of a kind, oldest first, and lets them settle. */
      release: async (kind: "GET" | "PUT") => {
        await act(async () => {
          for (const h of held.filter((x) => x.kind === kind)) {
            held.splice(held.indexOf(h), 1);
            h.send();
          }
          await vi.advanceTimersByTimeAsync(0);
        });
      },
    };
  }

  async function mount() {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    renderSettings();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  }

  async function click(name: string | RegExp) {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name }));
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows no magnetometer section where the server returns no magnetometer settings", async () => {
    installFetchMock();
    renderSettings();
    await waitFor(() => {
      expect(screen.getByText(/spawns 20–40/)).toBeInTheDocument();
    });
    expect(screen.queryByText("Magnetometers")).not.toBeInTheDocument();
  });

  it("does not flag drift for the magnetometer section's own apply, and keeps its keys off the page's", async () => {
    const { fetchMock } = installServer({ ...APPLIED, ...MAG });
    await mount();
    expect(screen.getByText("Magnetometers")).toBeInTheDocument();

    fireEvent.change(threshold(), { target: { value: "6.5" } });
    await click("Apply magnetometer settings");
    await pollOnce();
    expect(banner()).toBe("");

    await click(/Apply to Simulator/i);
    await pollOnce();
    expect(banner()).toBe("");
    const puts = fetchMock.mock.calls
      .filter(([, opts]) => opts?.method === "PUT")
      .map(([, opts]) => JSON.parse(String(opts?.body)) as Record<string, unknown>);
    expect(puts.find((body) => "mag_threshold_sigma" in body)).toEqual({ ...MAG, mag_threshold_sigma: 6.5 });
    expect(Object.keys(puts.find((body) => "frac_anomalous" in body) ?? {}).filter((k) => k.startsWith("mag_"))).toEqual([]);
  });

  it("counts the magnetometer section's unapplied edits as the page's when the backend reverts, and Reload discards them", async () => {
    const { server } = installServer({ ...APPLIED, ...MAG, mag_threshold_sigma: 6.5 });
    await mount();
    expect(threshold().value).toBe("6.5");
    fireEvent.change(threshold(), { target: { value: "7" } });
    expect(screen.getByText("Unapplied changes")).toBeInTheDocument();

    // A restart: boot state, stamped earlier, with the default threshold.
    server.config = { ...AFTER_RESTART, ...MAG };
    await pollOnce();

    // The section's edit is the operator's as much as the page's would be.
    expect(threshold().value).toBe("7");
    expect(banner()).toMatch(/no longer sit on top of what/);
    expect(banner()).not.toMatch(/actually running/);

    await click(/Reload from simulator/i);
    expect(threshold().value).toBe("5.5");
    expect(screen.queryByText("Unapplied changes")).not.toBeInTheDocument();
    expect(banner()).toBe("");
  });

  // With nothing unapplied anywhere the page re-syncs, and the section with it.
  it("takes what the simulator runs into the section too when nothing is unapplied", async () => {
    const { server } = installServer({ ...APPLIED, ...MAG });
    await mount();
    server.config = { ...AFTER_RESTART, ...MAG, mag_threshold_sigma: 4.5 };
    await pollOnce();
    expect(banner()).toMatch(/actually running/);
    expect(ranges()[1].value).toBe("0");
    expect(threshold().value).toBe("4.5");
    expect(screen.queryByText("Unapplied changes")).not.toBeInTheDocument();
  });

  // The warning tells the operator to apply or reload. The section's edits
  // alone held the page's sliders back; applying them takes the warning away
  // and leaves the sliders on what the simulator runs.
  it("clears the drift warning once the magnetometer section's edits are applied, and re-syncs the page", async () => {
    const { server } = installServer({ ...APPLIED, ...MAG, mag_threshold_sigma: 6.5 });
    await mount();

    fireEvent.change(threshold(), { target: { value: "7" } });
    server.config = { ...AFTER_RESTART, ...MAG };
    await pollOnce();
    expect(banner()).toMatch(/no longer sit on top of what/);
    // Nothing re-syncs while anything on the page is unapplied.
    expect(ranges()[1].value).toBe("30");
    expect(threshold().value).toBe("7");

    await click("Apply magnetometer settings");
    expect(banner()).toBe("");
    expect(ranges()[1].value).toBe("0"); // what the simulator runs
    expect(server.config.mag_threshold_sigma).toBe(7);
    await pollOnce();
    expect(banner()).toBe("");
    expect(threshold().value).toBe("7");
  });

  it("keeps the flyby form as it was when Reload discards the section's settings edits", async () => {
    const { server } = installServer({ ...APPLIED, ...MAG, mag_threshold_sigma: 6.5 });
    await mount();

    fireEvent.change(screen.getByRole("spinbutton", { name: "Closest approach (m)" }), { target: { value: "900" } });
    fireEvent.change(threshold(), { target: { value: "7" } });
    server.config = { ...AFTER_RESTART, ...MAG };
    await pollOnce();
    await click(/Reload from simulator/i);
    expect(threshold().value).toBe("5.5");
    expect(screen.getByRole("spinbutton", { name: "Closest approach (m)" })).toHaveValue(900);
  });

  // A poll read before the section's write can answer after it, carrying the
  // stamp from before: the section's Apply fetches the config again, which
  // drops that answer, as the page's own Apply does.
  it.each([
    ["with nothing else unapplied", false],
    ["with the page's sliders holding an edit", true],
  ])("drops a poll from before the section's write that answers after it, %s", async (_, pageEdit) => {
    const { server, release } = installServer({ ...APPLIED, ...MAG }, { holdGets: true });
    await mount();
    await release("GET");
    if (pageEdit) fireEvent.change(ranges()[1], { target: { value: "25" } });
    fireEvent.change(threshold(), { target: { value: "7" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); }); // the poll reads stamp 2000, held
    await click("Apply magnetometer settings"); // the write lands (5001) and answers at once
    await release("GET"); // the old poll's answer, then the fetch after the Apply
    expect(banner()).toBe("");
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    await release("GET");
    expect(banner()).toBe("");
    expect(threshold().value).toBe("7");
    expect(ranges()[1].value).toBe(pageEdit ? "25" : "30");
    expect(server.config._updated_at).toBe(5001);
  });

  // The section's Apply clears the warning as the page's own does; the fetch
  // after it still finds the change that landed after the write.
  it("still sees an outside change that lands while the section's write is on its way", async () => {
    const { server, release } = installServer({ ...APPLIED, ...MAG }, { holdPuts: true });
    await mount();
    fireEvent.change(threshold(), { target: { value: "7" } });
    await click("Apply magnetometer settings");
    // Somebody else writes after the section's write landed, before its reply.
    server.config = { ...server.config, frac_dark: 0.4, _updated_at: 9000 };
    await pollOnce();
    await release("PUT");
    expect(banner()).toMatch(/changed outside this page/);
    expect(ranges()[2].value).toBe("40");
    expect(threshold().value).toBe("7");
  });

  // The edit made while the Apply was out never went with it: it stays,
  // unapplied, and the drift check still counts it.
  it("keeps an edit made to the magnetometer section while its Apply is on its way", async () => {
    const { server, release } = installServer({ ...APPLIED, ...MAG }, { holdPuts: true });
    await mount();
    fireEvent.change(threshold(), { target: { value: "7" } });
    await click("Apply magnetometer settings");
    fireEvent.change(threshold(), { target: { value: "8" } });
    await release("PUT");
    await pollOnce();
    expect(threshold().value).toBe("8");
    expect(screen.getByText("Unapplied changes")).toBeInTheDocument();
    expect(server.config.mag_threshold_sigma).toBe(7);
    expect(banner()).toBe("");

    server.config = { ...AFTER_RESTART, ...MAG };
    await pollOnce();
    expect(threshold().value).toBe("8");
    expect(banner()).toMatch(/no longer sit on top of what/);
  });

  // A server without the fleet answers without the mag_* keys (a restart
  // that keeps the snapshot keeps the stamp): the section goes, and its
  // unapplied edits with it.
  it("drops the magnetometer section's edits from the drift check when the section goes", async () => {
    const { server } = installServer({ ...APPLIED, ...MAG });
    await mount();
    fireEvent.change(threshold(), { target: { value: "7" } });
    const withoutFleet: Record<string, unknown> = { ...server.config };
    for (const key of Object.keys(MAG)) delete withoutFleet[key];
    server.config = withoutFleet;
    await pollOnce();
    expect(screen.queryByRole("slider", { name: "Detection threshold" })).not.toBeInTheDocument();
    expect(banner()).toBe("");

    // A change now finds nothing unapplied: the page takes what runs.
    server.config = { ...AFTER_RESTART, ...MAG, _updated_at: 1500 };
    await pollOnce();
    expect(banner()).toMatch(/actually running/);
    expect(threshold().value).toBe("5.5");
  });

  // A flyby is a command, not a setting: the server leaves the stamp alone,
  // and the page takes no stamp from its reply either.
  it("takes no flyby for a change to the config", async () => {
    installServer({ ...APPLIED, ...MAG });
    await mount();
    await click("Fly a UAP past it");
    expect(screen.getByText(/^UAP flyby #1 on its way/)).toBeInTheDocument();
    await pollOnce();
    await pollOnce();
    expect(banner()).toBe("");
  });

  // ── Polling ───────────────────────────────────────────────────────────

  it("polls each endpoint on its own period, and stops when the page closes", async () => {
    const fetchMock = installFetchMock();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    const { unmount } = renderSettings();
    const calls = (path: string) =>
      fetchMock.mock.calls.filter(([url, opts]) => String(url).includes(path) && !opts?.method).length;
    const counts = () => ({
      config: calls("/simulation/config"),
      groundTruth: calls("/simulation/ground-truth"),
      solverStats: calls("/test/solver-stats"),
      nodes: calls("/radar/nodes"),
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(counts()).toEqual({ config: 1, groundTruth: 1, solverStats: 1, nodes: 1 });

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(counts()).toEqual({ config: 2, groundTruth: 6, solverStats: 3, nodes: 2 });

    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(counts()).toEqual({ config: 2, groundTruth: 6, solverStats: 3, nodes: 2 });

    vi.useRealTimers();
  });
});
