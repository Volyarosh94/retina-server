import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MagnetometerSummary from "./MagnetometerSummary";
import { magEvent, network, NOW_MS, withNode } from "../../../test/magnetometerNetwork";
import { DEFAULT_MAP_THEME, PALETTES } from "../mapPalette";

describe("MagnetometerSummary", () => {
  beforeEach(() => localStorage.clear());

  it("counts the network, scores it against the truth and lists the latest events", () => {
    render(<MagnetometerSummary network={network()} onSelect={() => {}} />);
    expect(screen.getByText("3 placed · 1 detecting")).toBeInTheDocument();
    expect(screen.getByText("3 in 240 node-hours searched")).toBeInTheDocument();
    expect(screen.getByText("0.013 per node-hour, 95 %: 0.0026–0.037")).toBeInTheDocument();
    expect(screen.getByText(/UAPs are 1e9 A·m² dipoles\./)).toBeInTheDocument();
    expect(screen.getByText("2 of 2 detected")).toBeInTheDocument();
    expect(screen.getByText("2 true, 3 false")).toBeInTheDocument();
    expect(screen.getByText(/^Threshold 5\.5σ, common mode removed\./)).toBeInTheDocument();
    expect(screen.getByText(/RM3100 at 200 cycles/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /synth-00\d/ })).toHaveLength(2);
    expect(screen.getByText("812 nT · 450 m – 1.20 km · detecting")).toBeInTheDocument();
    expect(screen.getByText("32 nT · 3.10 km – 4.30 km · false alarm")).toBeInTheDocument();
  });

  it("is a region a screen reader can find by its name", () => {
    render(<MagnetometerSummary network={network()} onSelect={() => {}} />);
    expect(screen.getByRole("region", { name: "Magnetometers" })).toHaveClass("mag-summary");
  });

  it("opens the magnetometer an event came from", () => {
    const onSelect = vi.fn();
    render(<MagnetometerSummary network={network()} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /synth-002/ }));
    expect(onSelect).toHaveBeenCalledWith("mag-synth-002");
  });

  /** The network as the server sends it when the noise model does not hold. */
  function uncalibrated(patch: Partial<ReturnType<typeof network>> = {}, detector: Partial<ReturnType<typeof network>["detector"]> = {}) {
    const base = network();
    return {
      ...base,
      ...patch,
      detector: { ...base.detector, ...detector, false_alarm_model: { ...base.detector.false_alarm_model, calibrated: false } },
    };
  }

  const caveat = () => document.querySelector(".mag-summary .mag-caveat");

  // In the warning's ink, which reads where the muted note's does not, and
  // about now: an event opened earlier keeps the confidence it was given.
  it("says when a storm is running and the common mode is left in, and that detections opening now carry no confidence", () => {
    const base = network();
    render(
      <MagnetometerSummary
        network={uncalibrated({ storm: true, settings: { ...base.settings, mag_common_mode: false } }, { common_mode_applied: false })}
        onSelect={() => {}}
      />,
    );
    expect(caveat()).toHaveTextContent(
      /^No confidence for detections opening now: the noise model does not hold with a storm running and the common mode left in\.$/,
    );
    expect(screen.getByText(/^Threshold 5\.5σ\. RM3100/)).toBeInTheDocument();
  });

  // The server takes it out only with six or more magnetometers reporting.
  it("says the common mode is not removed when too few magnetometers report, whatever the setting", () => {
    render(<MagnetometerSummary network={uncalibrated({}, { common_mode_applied: false })} onSelect={() => {}} />);
    expect(caveat()).toHaveTextContent(/the noise model does not hold with fewer than six magnetometers reporting\.$/);
  });

  it("says the common mode waits for the warm-up when enough are placed but few have a static level", () => {
    const base = network();
    const warming = Array.from({ length: 5 }, (_, i) => ({ ...base.nodes[2], node_id: `mag-w${i}`, host_node_id: `w${i}` }));
    render(<MagnetometerSummary network={uncalibrated({ nodes: [...base.nodes, ...warming] }, { common_mode_applied: false })} onSelect={() => {}} />);
    expect(caveat()).toHaveTextContent(/the noise model does not hold with the magnetometers still warming up\.$/);
  });

  // The model behind an event's confidence needs the common mode subtracted,
  // no storm and a reading a second; the card says which does not hold.
  it("says when readings are not a second apart, and that confidences are then not given", () => {
    render(<MagnetometerSummary network={uncalibrated({}, { reading_period_s: 1.6, reading_period_calibrated: false })} onSelect={() => {}} />);
    expect(screen.getByText(/^Threshold 5\.5σ, common mode removed\. RM3100/)).toBeInTheDocument();
    expect(caveat()).toHaveTextContent(/^No confidence for detections opening now: the noise model does not hold with readings 1\.6 s apart, not 1 s\.$/);
    expect(screen.queryByText(/Event confidences are not calibrated/)).not.toBeInTheDocument();
  });

  // The server judges the spacing before rounding it, and with a margin: at
  // 1.0999 s it holds and arrives as 1.1; once out, 1.07 s is not back in.
  it("takes the server's word on the readings' spacing, never the rounded figure's", () => {
    const base = network();
    const { rerender } = render(
      <MagnetometerSummary network={{ ...base, detector: { ...base.detector, reading_period_s: 1.1, reading_period_calibrated: true } }} onSelect={() => {}} />,
    );
    expect(caveat()).toBeNull();
    rerender(<MagnetometerSummary network={uncalibrated({}, { reading_period_s: 1.07, reading_period_calibrated: false })} onSelect={() => {}} />);
    expect(caveat()).toHaveTextContent(/the noise model does not hold with readings 1\.07 s apart, not 1 s\.$/);
  });

  // For whoever is working out why readings are missing; nothing at all while
  // the server has turned nothing away.
  it("says what the server turned away from the fleet, only when it turned something away", () => {
    const base = network();
    const { rerender } = render(<MagnetometerSummary network={base} onSelect={() => {}} />);
    expect(screen.queryByText(/^Since it started, the server has/)).not.toBeInTheDocument();
    expect(document.querySelector(".mag-summary-fleet")).toBeNull();

    rerender(<MagnetometerSummary network={{ ...base, detector: { ...base.detector, pushes_refused: 3, entries_rejected: 0 } }} onSelect={() => {}} />);
    const line = screen.getByText("Since it started, the server has refused 3 pushes from the fleet (their readings are lost).");
    // A fact to look into, in the secondary ink, not a warning.
    expect(line).toHaveClass("mag-summary-fleet");
    expect(line).not.toHaveClass("mag-caveat");
  });

  it("says nothing of calibration while the model holds", () => {
    render(<MagnetometerSummary network={network()} onSelect={() => {}} />);
    expect(screen.queryByText(/noise model/)).not.toBeInTheDocument();
    expect(caveat()).toBeNull();
  });

  // A pass counts once its field rises 20 nT above the lowest since the last;
  // it is found while a detection the truth confirms is open during it. Said
  // in a disclosure, open to the keyboard and a screen reader, not in a
  // title only a pointer's hover shows.
  it("says how a pass is counted and when it counts as found, to everyone", () => {
    render(<MagnetometerSummary network={network()} onSelect={() => {}} />);
    expect(screen.getByText("UAP passes ≥ 20 nT").closest(".mag-summary-row")).not.toHaveAttribute("title");
    const disclosure = screen.getByText("How passes are counted");
    expect(disclosure.tagName).toBe("SUMMARY");
    expect(disclosure.closest("details")).toHaveTextContent(
      "A pass counts once the UAP's field at a magnetometer rises 20 nT above its lowest since that magnetometer's last pass. It is found if a detection the truth confirms is open during it. It stays open until 256 s after its field last peaked: the detector reports a pass up to 4 time scales after its closest approach, and its longest is 64 s.",
    );
  });

  // 256 s is four of the detector's longest time scale, which it says itself.
  it("takes how long a pass stays open from the detector's own time scales", () => {
    const base = network();
    render(<MagnetometerSummary network={{ ...base, detector: { ...base.detector, scales_s: [2, 4, 8, 16, 32] } }} onSelect={() => {}} />);
    expect(screen.getByText("How passes are counted").closest("details")).toHaveTextContent(
      /stays open until 128 s after its field last peaked: the detector reports a pass up to 4 time scales after its closest approach, and its longest is 32 s\.$/,
    );
  });

  it("counts the passes still in progress", () => {
    const base = network();
    render(<MagnetometerSummary network={{ ...base, stats: { ...base.stats, passes: 3, passes_open: 1 } }} onSelect={() => {}} />);
    expect(screen.getByText("2 of 3 detected")).toBeInTheDocument();
    expect(screen.getByText("1 still in progress")).toBeInTheDocument();
  });

  it("does not offer to open a magnetometer the simulator has taken away", () => {
    const onSelect = vi.fn();
    const base = network();
    render(<MagnetometerSummary network={{ ...base, nodes: base.nodes.filter((n) => n.node_id !== "mag-synth-001") }} onSelect={onSelect} />);
    const gone = screen.getByRole("button", { name: /synth-001/ });
    expect(gone).toBeDisabled();
    expect(gone).toHaveTextContent("no longer placed");
    fireEvent.click(gone);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /synth-002/ })).toBeEnabled();
  });

  it("calls a silent magnetometer's open event 'no data', and does not count it as detecting", () => {
    render(<MagnetometerSummary network={withNode(network(), "mag-synth-002", { state: "stale", last_ms: NOW_MS - 30_000 })} onSelect={() => {}} />);
    expect(screen.getByText("812 nT · 450 m – 1.20 km · no data")).toBeInTheDocument();
    expect(screen.queryByText(/detecting/)).not.toBeInTheDocument();
    expect(screen.getByText("3 placed")).toBeInTheDocument();
  });

  // The legend gives amber to an elevated badge and grey to a silent one, so
  // an event's dot says only whether it is a detection: filled while it is
  // live, a ring once it has closed, red for a UAP and neutral for anything else.
  it("marks each event live or past, and a UAP or not, without borrowing the badges' meanings", () => {
    const base = network();
    const uap = magEvent({ event_id: "mag-evt-run-1-00003", node_id: "mag-synth-003", host_node_id: "synth-003", active: false, end_ms: NOW_MS - 60_000 });
    render(<MagnetometerSummary network={{ ...base, events: [...base.events, uap] }} onSelect={() => {}} />);
    const dot = (host: string) => screen.getByRole("button", { name: new RegExp(host) }).querySelector(".mag-dot") as HTMLElement;
    const palette = PALETTES[DEFAULT_MAP_THEME];
    expect(dot("synth-002")).toHaveClass("mag-dot-live");
    expect(dot("synth-002").style.getPropertyValue("--mag-dot")).toBe(palette.ANOMALY);
    expect(dot("synth-003")).toHaveClass("mag-dot-past");
    expect(dot("synth-003").style.getPropertyValue("--mag-dot")).toBe(palette.ANOMALY);
    expect(dot("synth-001")).toHaveClass("mag-dot-past");
    expect(dot("synth-001").style.getPropertyValue("--mag-dot")).toBe(palette.INK_MUTED);
    for (const host of ["synth-001", "synth-002", "synth-003"]) {
      expect([palette.WARN, palette.INK_SUBTLE]).not.toContain(dot(host).style.getPropertyValue("--mag-dot"));
    }
  });

  it("marks the detecting count in the console's ink rather than a map colour", () => {
    render(<MagnetometerSummary network={network()} onSelect={() => {}} />);
    const count = screen.getByText("3 placed · 1 detecting");
    expect(count).toHaveClass("mag-summary-count", "mag-detecting");
    expect(count).not.toHaveAttribute("style");
  });

  it("says it is still measuring before the first node-hour of data", () => {
    const base = network();
    render(
      <MagnetometerSummary
        network={{ ...base, stats: { ...base.stats, false_alarms_per_node_hour: null, false_alarms_per_node_hour_ci95: null } }}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("measuring…")).toBeInTheDocument();
    expect(screen.queryByText(/per node-hour/)).not.toBeInTheDocument();
  });

  it("collapses to its header and remembers it", () => {
    const { unmount } = render(<MagnetometerSummary network={network()} onSelect={() => {}} />);
    const header = screen.getByRole("button", { name: /Magnetometers/ });
    expect(header).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/False alarms/)).not.toBeInTheDocument();
    unmount();

    render(<MagnetometerSummary network={network()} onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /Magnetometers/ })).toHaveAttribute("aria-expanded", "false");
  });
});
