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
    expect(toast).toHaveBeenCalledWith("Magnetometer beside synth-003: 95 nT, UAP 1.10 km – 1.60 km away", { tone: "warn" });

    rerender({ n: network({ events: [...later.events] }) });
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("does not announce an event that closed before it was seen", () => {
    const { rerender } = renderHook(({ n }: { n: MagNetwork }) => useMagnetometerAlerts(n), {
      initialProps: { n: network({ events: [] }) },
    });
    rerender({ n: network({ events: [magEvent({ event_id: "closed", active: false, end_ms: 1 })] }) });
    expect(toast).not.toHaveBeenCalled();
  });
});
