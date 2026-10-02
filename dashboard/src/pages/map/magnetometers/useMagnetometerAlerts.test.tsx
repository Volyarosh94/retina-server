import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMagnetometerAlerts } from "./useMagnetometerAlerts";
import { magEvent, network } from "../../../test/magnetometerNetwork";
import type { MagNetwork } from "./types";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("../toast", () => ({ toast }));

describe("useMagnetometerAlerts", () => {
  beforeEach(() => toast.mockReset());

  it("announces a detection that begins while the page is open, once", () => {
    const { rerender } = renderHook(({ n }: { n: MagNetwork | null }) => useMagnetometerAlerts(n), {
      initialProps: { n: null as MagNetwork | null },
    });
    // What is already open when the page loads is not news.
    rerender({ n: network() });
    expect(toast).not.toHaveBeenCalled();

    const fresh = magEvent({ event_id: "mag-synth-003-1", node_id: "mag-synth-003", host_node_id: "synth-003", strength_nt: 95.2, range_km: [1.1, 1.6] });
    const later = network({ events: [fresh, ...network().events] });
    rerender({ n: later });
    expect(toast).toHaveBeenCalledTimes(1);
    // That it started, not what it measured as it opened: a score just over
    // the threshold gives the weakest strength and the widest range the event
    // will have, and the summary and the panel follow it from there.
    expect(toast).toHaveBeenCalledWith("Magnetometer beside synth-003 started detecting.", {
      tone: "warn",
      // As long as the map's squawk alert: long enough to read.
      durationMs: 6000,
    });

    rerender({ n: network({ events: [...later.events] }) });
    expect(toast).toHaveBeenCalledTimes(1);
  });

  // A storm with the common mode left in can set off the whole network in
  // one second: one toast says so, rather than a column of them.
  it("gathers the detections that start together into one toast", () => {
    const { rerender } = renderHook(({ n }: { n: MagNetwork }) => useMagnetometerAlerts(n), {
      initialProps: { n: network({ events: [] }) },
    });
    const hosts = ["synth-001", "synth-002", "synth-003", "synth-004", "synth-005"];
    const burst = hosts.map((host, i) => magEvent({ event_id: `mag-evt-run-1-0001${i}`, node_id: `mag-${host}`, host_node_id: host }));
    rerender({ n: network({ events: burst }) });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith("5 magnetometers started detecting: beside synth-001, synth-002, synth-003 and 2 more.", {
      tone: "warn",
      durationMs: 6000,
    });

    // Three at once are still worth one toast each.
    toast.mockReset();
    const three = ["synth-006", "synth-007", "synth-008"].map((host, i) =>
      magEvent({ event_id: `mag-evt-run-1-0002${i}`, node_id: `mag-${host}`, host_node_id: host }),
    );
    rerender({ n: network({ events: [...three, ...burst] }) });
    expect(toast).toHaveBeenCalledTimes(3);
  });

  // A restarted server starts its events again. Everything in the new run
  // began while the page watched, so none of it has been announced.
  it("announces the detections that follow a server restart", () => {
    const { rerender } = renderHook(({ n }: { n: MagNetwork }) => useMagnetometerAlerts(n), {
      initialProps: { n: network() },
    });
    rerender({ n: network({ run_id: "run-2", events: [] }) });
    const reused = (id: string, host: string) =>
      magEvent({ event_id: id, node_id: `mag-${host}`, host_node_id: host, range_km: [1.1, 1.6], strength_nt: 95.2 });
    // An older server numbered events afresh with every run, so an id can repeat.
    rerender({ n: network({ run_id: "run-2", events: [reused(network().events[1].event_id, "synth-001")] }) });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenLastCalledWith("Magnetometer beside synth-001 started detecting.", expect.anything());
    rerender({ n: network({ run_id: "run-2", events: [reused("mag-evt-run-2-00002", "synth-003"), reused(network().events[1].event_id, "synth-001")] }) });
    expect(toast).toHaveBeenCalledTimes(2);
  });

  it("announces what is open in a new run's first answer, if that is the first it hears of the run", () => {
    const { rerender } = renderHook(({ n }: { n: MagNetwork }) => useMagnetometerAlerts(n), {
      initialProps: { n: network() },
    });
    rerender({ n: network({ run_id: "run-2" }) });
    // The detection open in the fixture began after the restart.
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("does not announce what opened while the layer was off", () => {
    const { rerender } = renderHook(({ n }: { n: MagNetwork | null }) => useMagnetometerAlerts(n), {
      initialProps: { n: network({ events: [] }) as MagNetwork | null },
    });
    rerender({ n: null });
    rerender({ n: network() });
    expect(toast).not.toHaveBeenCalled();
  });

  it("does not announce an event that closed before it was seen", () => {
    const { rerender } = renderHook(({ n }: { n: MagNetwork }) => useMagnetometerAlerts(n), {
      initialProps: { n: network({ events: [] }) },
    });
    rerender({ n: network({ events: [magEvent({ event_id: "closed", active: false, end_ms: 1 })] }) });
    expect(toast).not.toHaveBeenCalled();
  });
});
