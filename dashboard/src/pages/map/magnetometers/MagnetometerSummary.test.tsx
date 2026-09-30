import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MagnetometerSummary from "./MagnetometerSummary";
import { network } from "../../../test/magnetometerNetwork";

describe("MagnetometerSummary", () => {
  beforeEach(() => localStorage.clear());

  it("counts the network, scores it against the truth and lists the latest events", () => {
    render(<MagnetometerSummary network={network()} onSelect={() => {}} />);
    expect(screen.getByText("3 placed · 1 detecting")).toBeInTheDocument();
    expect(screen.getByText("3 in 240.0 node-hours")).toBeInTheDocument();
    expect(screen.getByText("0.013 per node-hour, 95 %: 0.003–0.037")).toBeInTheDocument();
    expect(screen.getByText(/UAPs are 1e9 A·m² dipoles\./)).toBeInTheDocument();
    expect(screen.getByText("2 of 2 detected")).toBeInTheDocument();
    expect(screen.getByText("2 true, 3 false")).toBeInTheDocument();
    expect(screen.getByText(/Threshold 5\.5σ, common mode removed/)).toBeInTheDocument();
    expect(screen.getByText(/RM3100 at 200 cycles/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /synth-00\d/ })).toHaveLength(2);
    expect(screen.getByText("812 nT · 450 m – 1.20 km · detecting")).toBeInTheDocument();
    expect(screen.getByText("32 nT · 3.10 km – 4.30 km · false alarm")).toBeInTheDocument();
  });

  it("opens the magnetometer an event came from", () => {
    const onSelect = vi.fn();
    render(<MagnetometerSummary network={network()} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /synth-002/ }));
    expect(onSelect).toHaveBeenCalledWith("mag-synth-002");
  });

  it("says when a storm is running and the common mode is left in", () => {
    const base = network();
    render(
      <MagnetometerSummary
        network={{ ...base, storm: true, settings: { ...base.settings, mag_common_mode: false } }}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(/common mode not removed; a geomagnetic storm is running/)).toBeInTheDocument();
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
