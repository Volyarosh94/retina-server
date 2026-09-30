import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MagnetometerSettings from "./MagnetometerSettings";
import { network } from "../../../test/magnetometerNetwork";

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

function installFetch({ putStatus = 200 }: { putStatus?: number } = {}) {
  fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
    const u = String(url);
    const method = opts?.method ?? "GET";
    if (u.endsWith("/sim/magnetometers") && method === "GET") {
      return { ok: true, json: async () => network() };
    }
    if (u.endsWith("/simulation/config") && method === "PUT") {
      if (putStatus !== 200) {
        return { ok: false, status: putStatus, statusText: "Bad Request", json: async () => ({ detail: "Magnetometer settings need SYNTHETIC_FLEET_ENABLED" }) };
      }
      return { ok: true, json: async () => ({ ok: true, config: { ...CONFIG, ...JSON.parse(String(opts?.body)), _updated_at: 200 } }) };
    }
    if (u.endsWith("/sim/magnetometers/flyby") && method === "POST") {
      return { ok: true, json: async () => ({ ok: true, flyby: { ...JSON.parse(String(opts?.body)), seq: 3 }, updated_at: 300 }) };
    }
    return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
}

function sent(method: string, path: string) {
  const call = fetchMock.mock.calls.find(([u, o]) => String(u).endsWith(path) && (o?.method ?? "GET") === method);
  return call ? JSON.parse(String(call[1].body)) : undefined;
}

describe("MagnetometerSettings", () => {
  beforeEach(() => installFetch());
  afterEach(() => vi.unstubAllGlobals());

  it("shows nothing, and asks for nothing, where the server runs no fleet", async () => {
    const { container } = render(<MagnetometerSettings config={{ frac_anomalous: 0.05 }} onApplied={() => {}} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the running network and what the threshold predicts beside what is measured", async () => {
    render(<MagnetometerSettings config={CONFIG} onApplied={() => {}} />);
    expect(await screen.findByText(/^Running: 3 magnetometers · 1 detecting · 0\.013 per node-hour/)).toBeInTheDocument();
    expect(
      screen.getByText(/^Predicted: 0\.00028 false alarms per node-hour, about one every 50 days across 3 magnetometers\. Measured: 0\.013/),
    ).toBeInTheDocument();
  });

  it("applies only its own keys and hands the new stamp back, so the page sees no drift", async () => {
    const onApplied = vi.fn();
    render(<MagnetometerSettings config={CONFIG} onApplied={onApplied} />);
    fireEvent.change(await screen.findByRole("slider", { name: "Detection threshold" }), { target: { value: "6.2" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Placement" }), { target: { value: "core" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply magnetometer settings" }));

    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(200));
    const body = sent("PUT", "/simulation/config");
    expect(Object.keys(body).sort()).toEqual(MAG_KEYS);
    expect(body.mag_threshold_sigma).toBe(6.2);
    expect(body.mag_placement).toBe("core");
    expect(screen.getByText(/^Applied — the simulator re-places its magnetometers/)).toBeInTheDocument();
  });

  it("keeps an unapplied edit when the config polls again, and follows the server once applied", async () => {
    const { rerender } = render(<MagnetometerSettings config={CONFIG} onApplied={() => {}} />);
    const slider = await screen.findByRole("slider", { name: "Detection threshold" });
    fireEvent.change(slider, { target: { value: "4.5" } });
    rerender(<MagnetometerSettings config={{ ...CONFIG, _updated_at: 150 }} onApplied={() => {}} />);
    expect(screen.getByRole("slider", { name: "Detection threshold" })).toHaveValue("4.5");

    fireEvent.click(screen.getByRole("button", { name: "Apply magnetometer settings" }));
    await screen.findByText(/^Applied/);
    rerender(<MagnetometerSettings config={{ ...CONFIG, mag_threshold_sigma: 7, _updated_at: 400 }} onApplied={() => {}} />);
    expect(screen.getByRole("slider", { name: "Detection threshold" })).toHaveValue("7");
  });

  it("shows the server's refusal", async () => {
    installFetch({ putStatus: 400 });
    render(<MagnetometerSettings config={CONFIG} onApplied={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Apply magnetometer settings" }));
    expect(await screen.findByText("Error: Magnetometer settings need SYNTHETIC_FLEET_ENABLED")).toBeInTheDocument();
  });

  it("flies a UAP past the magnetometer chosen, with the pass as set", async () => {
    const onApplied = vi.fn();
    render(<MagnetometerSettings config={CONFIG} onApplied={onApplied} />);
    const fly = await screen.findByRole("button", { name: "Fly a UAP past it" });
    await waitFor(() => expect(fly).toBeEnabled());
    fireEvent.change(screen.getByRole("combobox", { name: "Magnetometer" }), { target: { value: "mag-synth-002" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Closest approach (m)" }), { target: { value: "800" } });
    fireEvent.click(fly);

    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(300));
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
    render(<MagnetometerSettings config={CONFIG} onApplied={() => {}} />);
    const fly = await screen.findByRole("button", { name: "Fly a UAP past it" });
    await waitFor(() => expect(fly).toBeEnabled());
    fireEvent.click(fly);
    await screen.findByText(/passes a magnetometer the simulator picks/);
    expect(sent("POST", "/sim/magnetometers/flyby")).not.toHaveProperty("node_id");
  });
});
