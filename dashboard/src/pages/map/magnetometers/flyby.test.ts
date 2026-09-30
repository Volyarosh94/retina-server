import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PASS, requestFlyby } from "./flyby";

describe("requestFlyby", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("posts the pass for a magnetometer and returns the request's number and stamp", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, flyby: { seq: 7 }, updated_at: 1234.5 }) });
    await expect(requestFlyby("mag-synth-002", DEFAULT_PASS)).resolves.toEqual({ seq: 7, updatedAt: 1234.5 });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/sim\/magnetometers\/flyby$/);
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ ...DEFAULT_PASS, node_id: "mag-synth-002" });
  });

  it("leaves the magnetometer to the fleet when none is named", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    await expect(requestFlyby("", DEFAULT_PASS)).resolves.toEqual({ seq: null, updatedAt: null });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty("node_id");
    await requestFlyby(null, DEFAULT_PASS);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty("node_id");
  });
});
