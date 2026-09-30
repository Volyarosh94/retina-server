import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asNetwork, useMagnetometerDetail, useMagnetometers } from "./useMagnetometers";
import { network } from "../../../test/magnetometerNetwork";

describe("asNetwork", () => {
  it("takes a response with the shape the layer draws", () => {
    const body = network();
    expect(asNetwork(body)).toBe(body);
  });

  it("refuses anything else, so a missing route or a proxy's page leaves the map alone", () => {
    expect(asNetwork(null)).toBeNull();
    expect(asNetwork("<html>502 Bad Gateway</html>")).toBeNull();
    expect(asNetwork({})).toBeNull();
    expect(asNetwork({ nodes: [], events: [] })).toBeNull();
    expect(asNetwork({ ...network(), nodes: "none" })).toBeNull();
  });
});

describe("polling", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for nothing while the layer is off", async () => {
    const { result } = renderHook(() => useMagnetometers(false));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it("returns the network while the layer is on", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => network() });
    const { result } = renderHook(() => useMagnetometers(true));
    await waitFor(() => expect(result.current?.nodes).toHaveLength(3));
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/sim\/magnetometers$/);
  });

  it("returns null for a response of the wrong shape", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ detail: "Not Found" }) });
    const { result } = renderHook(() => useMagnetometers(true));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBeNull();
  });

  it("asks for one magnetometer's last ten minutes by its encoded id", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ node_id: "mag-a/b" }) });
    const { result } = renderHook(() => useMagnetometerDetail("mag-a/b"));
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/sim\/magnetometers\/mag-a%2Fb\?window=600$/);
  });

  it("asks for no detail with no magnetometer selected", async () => {
    const { result } = renderHook(() => useMagnetometerDetail(null));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });
});
