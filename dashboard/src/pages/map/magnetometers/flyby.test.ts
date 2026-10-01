import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PASS, flybyErrorText, parsePass, PASS_FIELDS, passProblem, passText, requestFlyby } from "./flyby";

describe("requestFlyby", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  // A flyby is a command, not a setting: nothing in its reply is a config
  // stamp, even from a server that still sent one.
  it("posts the pass for a magnetometer and returns the request's number, and nothing else", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, flyby: { seq: 7, requested_at: 1_790_726_400 }, updated_at: 1234.5 }) });
    await expect(requestFlyby("mag-synth-002", DEFAULT_PASS)).resolves.toEqual({ seq: 7 });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/sim\/magnetometers\/flyby$/);
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ ...DEFAULT_PASS, node_id: "mag-synth-002" });
  });

  it("leaves the magnetometer to the fleet when none is named", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    await expect(requestFlyby("", DEFAULT_PASS)).resolves.toEqual({ seq: null });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty("node_id");
    await requestFlyby(null, DEFAULT_PASS);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty("node_id");
  });
});

describe("the pass form", () => {
  const field = (key: string) => PASS_FIELDS.find((f) => f.key === key)!;

  it("holds the same bounds as the server's validate_flyby", () => {
    expect(PASS_FIELDS.map(({ key, min, max }) => [key, min, max])).toEqual([
      ["closest_approach_m", 0, 20_000],
      ["altitude_m", 50, 15_000],
      ["speed_mps", 5, 1_000],
      ["lead_s", 10, 600],
    ]);
  });

  it("says what is wrong with a field, in the form's words", () => {
    expect(passProblem(field("lead_s"), "60")).toBeNull();
    expect(passProblem(field("lead_s"), "")).toBe("Enter a number, 10–600");
    expect(passProblem(field("lead_s"), "  ")).toBe("Enter a number, 10–600");
    expect(passProblem(field("lead_s"), "5")).toBe("Must be 10–600");
    // Written as the server writes its bounds, so the two never disagree.
    expect(passProblem(field("closest_approach_m"), "20001")).toBe("Must be 0–20000");
    expect(passProblem(field("speed_mps"), "1001")).toBe("Must be 5–1000");
    expect(passProblem(field("closest_approach_m"), "0")).toBeNull();
  });

  it("reads the pass the form holds", () => {
    expect(parsePass({ closest_approach_m: "800", altitude_m: "300", speed_mps: "120", lead_s: "60" })).toEqual({
      closest_approach_m: 800,
      altitude_m: 300,
      speed_mps: 120,
      lead_s: 60,
    });
    expect(parsePass(passText(DEFAULT_PASS))).toEqual(DEFAULT_PASS);
  });

  it("puts the form's labels in place of the API's key names in a refusal", () => {
    expect(flybyErrorText("lead_s must be 10–600")).toBe("In (s) must be 10–600");
    expect(flybyErrorText("speed_mps must be 5–1000")).toBe("Speed (m/s) must be 5–1000");
    expect(flybyErrorText("node_id must be a magnetometer id (mag-…) or absent for any")).toBe(
      "Magnetometer must be a magnetometer id (mag-…) or absent for any",
    );
    expect(flybyErrorText("Not Found")).toBe("Not Found");
  });
});
