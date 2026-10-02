import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asDetail, asNetwork, useMagnetometerDetail, useMagnetometers } from "./useMagnetometers";
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

/** The least of a detail answer the panel can chart. */
function detailBody(nodeId: string) {
  return { node_id: nodeId, series: { t: [], x: [], y: [], z: [], residual: [], score: [], bx: [], by: [], bz: [], b: [] }, events: [] };
}

describe("asDetail", () => {
  it("takes an answer with a series to chart", () => {
    const body = detailBody("mag-a");
    expect(asDetail(body)).toBe(body);
  });

  // A dashboard newer than its server, during a deploy: everything but the
  // measured field is still charted.
  it("takes an older server's answer without the measured field", () => {
    const series: Record<string, unknown> = { ...detailBody("mag-a").series };
    for (const key of ["bx", "by", "bz", "b"]) delete series[key];
    expect(asDetail({ node_id: "mag-a", series, events: [] })?.series.t).toEqual([]);
    expect(asDetail({ node_id: "mag-a", series })?.events).toEqual([]);
  });

  it("refuses an answer it could not chart", () => {
    expect(asDetail(null)).toBeNull();
    expect(asDetail({ node_id: "mag-a" })).toBeNull();
    expect(asDetail({ node_id: "mag-a", series: { t: [] } })).toBeNull();
    expect(asDetail({ series: detailBody("mag-a").series })).toBeNull();
    expect(asDetail("<html>502 Bad Gateway</html>")).toBeNull();
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

  /** Lets the hook's requests, if any, settle inside act. */
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

  it("asks for nothing while the layer is off", async () => {
    const { result } = renderHook(() => useMagnetometers(false));
    await settle();
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
    await settle();
    expect(result.current).toBeNull();
  });

  it("asks for one magnetometer's last ten minutes by its encoded id", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => detailBody("mag-a/b") });
    const { result } = renderHook(() => useMagnetometerDetail("mag-a/b"));
    await waitFor(() => expect(result.current.detail).not.toBeNull());
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/sim\/magnetometers\/mag-a%2Fb\?window=600$/);
  });

  it("asks for no detail with no magnetometer selected", async () => {
    const { result } = renderHook(() => useMagnetometerDetail(null));
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toEqual({ detail: null, failed: false });
  });

  // usePolling keeps the last answer across a change of key, and for good if
  // the new key's request fails.
  it("never hands one magnetometer's detail out as another's", async () => {
    let failB = false;
    let releaseB: (() => void) | null = null;
    fetchMock.mockImplementation((url: string) => {
      const id = decodeURIComponent(String(url).split("/").pop()!.split("?")[0]);
      if (id === "mag-b" && failB) return Promise.resolve({ ok: false, status: 500, statusText: "Server Error", json: async () => ({}) });
      if (id === "mag-b") return new Promise((resolve) => { releaseB = () => resolve({ ok: true, json: async () => detailBody("mag-b") }); });
      return Promise.resolve({ ok: true, json: async () => detailBody(id) });
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, rerender } = renderHook(({ id }: { id: string }) => useMagnetometerDetail(id), { initialProps: { id: "mag-a" } });
    await waitFor(() => expect(result.current.detail?.node_id).toBe("mag-a"));

    // While B's answer is on its way, there is none, rather than A's.
    rerender({ id: "mag-b" });
    expect(result.current).toEqual({ detail: null, failed: false });
    await act(async () => releaseB?.());
    await waitFor(() => expect(result.current.detail?.node_id).toBe("mag-b"));

    // And when B's request fails, there is still none, and the panel can say so.
    failB = true;
    rerender({ id: "mag-a" });
    await waitFor(() => expect(result.current.detail?.node_id).toBe("mag-a"));
    rerender({ id: "mag-b" });
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.detail).toBeNull();
    quiet.mockRestore();
  });
});
