import { memo, useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import { Marker, Polygon, Tooltip } from "react-leaflet";
import { usePalette } from "../useMapTheme";
import { annulus } from "./geometry";
import { badgeSvg, type BadgeInk } from "./badge";
import {
  formatRange,
  formatScore,
  formatSeconds,
  isKnownState,
  isLive,
  isRecent,
  searchedScales,
  stateColourKey,
  stateLabel,
  withAlpha,
} from "./format";
import type { MagNetwork, MagNode, MagState } from "./types";
import "./magnetometers.css";

/**
 * The simulated magnetometers on the /sim map.
 *
 * Each is a small badge beside the radar node it shares a roof with, at the
 * position the server publishes for that node, so the two read as one site.
 * The badge is drawn on the map's quality scale, with a shape for each state
 * as well (badge.ts): a GOOD square when quiet, a WARN diamond when its
 * detection score is within 1.5σ of the threshold, an ANOMALY square that
 * pulses while it is detecting, grey while warming up and hollow grey when it
 * has gone silent. A detection also draws the range band the event's strength
 * implies for the configured dipole moment: the UAP is somewhere in that ring.
 *
 * DivIcons in the marker pane rather than canvas paths: panes.ts explains why
 * a second interactive canvas would swallow the map's clicks. The class is
 * `mag-marker`, never `node-marker`, which the E2E suite counts.
 */
function badgeHtml(ink: BadgeInk, state: MagState, selected: boolean): string {
  const colour = ink[stateColourKey(state)];
  const pulse = `--mag-pulse:${withAlpha(colour, 0.7)};--mag-pulse-end:${withAlpha(colour, 0)};--mag-halo:${withAlpha(colour, 0.45)}`;
  // Markup built as a string: only a state this layer knows goes into it.
  const kind = isKnownState(state) ? state : "unknown";
  return `<div class="mag-badge mag-${kind}${selected ? " mag-selected" : ""}" style="${pulse}">${badgeSvg(state, ink, { selected })}</div>`;
}

const iconCache = new Map<string, L.DivIcon>();

function badgeIcon(ink: BadgeInk, state: MagState, selected: boolean): L.DivIcon {
  const key = `${ink[stateColourKey(state)]}|${ink.INK_MUTED}|${ink.ICON_HALO}|${state}|${selected}`;
  let icon = iconCache.get(key);
  if (!icon) {
    icon = L.divIcon({
      className: "mag-marker",
      html: badgeHtml(ink, state, selected),
      iconSize: [18, 18],
      // Up and to the right of the radar node's own dot at the same point.
      iconAnchor: [-3, 21],
    });
    iconCache.set(key, icon);
  }
  return icon;
}

/** A closed detection's band stays on the map this long, fainter. */
const BAND_LINGER_MS = 60_000;

interface Props {
  network: MagNetwork;
  /** Radar node positions by node ref, so a badge sits exactly on its site. */
  sitePositions: Map<string, [number, number]>;
  selectedId: string | null;
  onSelect: (nodeId: string) => void;
}

function MagnetometerLayer({ network, sitePositions, selectedId, onSelect }: Props) {
  const palette = usePalette();
  const nowMs = network.now_ms;
  const placed = useMemo(
    () =>
      network.nodes.map((node) => {
        const site = sitePositions.get(node.host_node_id);
        return { node, position: site ?? ([node.lat, node.lon] as [number, number]) };
      }),
    [network.nodes, sitePositions],
  );

  return (
    <>
      {placed.map(({ node, position }) => {
        const event = node.event;
        // An event left open on a magnetometer that went silent ended, as far
        // as anyone can tell, at its last reading.
        const silentSince = node.state === "stale" ? node.last_ms : null;
        if (!isRecent(event, nowMs, BAND_LINGER_MS, silentSince) || !event?.range_km) return null;
        const live = isLive(event, node.state);
        const [inner, outer] = event.range_km;
        return (
          <Polygon
            key={`band-${event.event_id}`}
            positions={annulus(position[0], position[1], inner, outer)}
            interactive={false}
            className="mag-range-band"
            pathOptions={{
              color: palette.ANOMALY,
              weight: 1.2,
              dashArray: "4 4",
              fillColor: palette.ANOMALY,
              fillOpacity: live ? 0.16 : 0.07,
              opacity: live ? 0.9 : 0.45,
            }}
          />
        );
      })}
      {placed.map(({ node, position }) => (
        <MagMarker
          key={node.node_id}
          node={node}
          position={position}
          icon={badgeIcon(palette, node.state, node.node_id === selectedId)}
          periodS={network.detector.reading_period_s}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

const MagMarker = memo(function MagMarker({
  node,
  position,
  icon,
  periodS,
  onSelect,
}: {
  node: MagNode;
  position: [number, number];
  icon: L.DivIcon;
  /** The network's spacing of readings, in seconds, which sets the time scales' lengths. */
  periodS: number | null;
  onSelect: (nodeId: string) => void;
}) {
  const marker = useRef<L.Marker>(null);
  const event = node.event;
  const nodeId = node.node_id;
  const scoring = node.state === "quiet" || node.state === "elevated" || node.state === "alarm";
  const search = searchedScales(node.longest_scale_s, periodS);
  // The badge's name carries its state, which its colour and shape show
  // everyone else. Set on the element, which Leaflet keeps (and the keyboard
  // focus on it) through every change of icon. No `title` as well: the
  // tooltip shows on hover and focus, and a title only stacked a second,
  // plainer one on top of it.
  const label = `Magnetometer beside ${node.host_node_id}: ${stateLabel(node.state).toLowerCase()}`;
  useEffect(() => {
    marker.current?.getElement()?.setAttribute("aria-label", label);
  }, [label, icon]);
  const handlers = useMemo(
    () => ({
      click: () => onSelect(nodeId),
      // Leaflet makes the badge a focusable button but answers Enter only by
      // opening a bound popup, and these have none. Space is stopped here as
      // well as handled: on the map at large it pauses the feed. A held key
      // is one press, not a toggle per repeat.
      keydown: (e: L.LeafletKeyboardEvent) => {
        const key = e.originalEvent.key;
        if (key !== "Enter" && key !== " ") return;
        L.DomEvent.stop(e.originalEvent);
        if (!e.originalEvent.repeat) onSelect(nodeId);
      },
    }),
    [nodeId, onSelect],
  );
  return (
    <Marker
      ref={marker}
      position={position}
      icon={icon}
      zIndexOffset={1200}
      bubblingMouseEvents={false}
      eventHandlers={handlers}
      keyboard
    >
      <Tooltip direction="top" offset={[9, -20]} opacity={0.95}>
        <div className="mag-tooltip">
          <strong>Magnetometer</strong> · {node.host_node_id}
          <br />
          {stateLabel(node.state)}
          {scoring ? ` · score ${formatScore(node.score_sigma)}` : ""}
          {/* Quiet, but not yet listening for slow passes: worth knowing before reading it as clear. */}
          {scoring && search && !search.complete && node.longest_scale_s !== null ? (
            <>
              <br />
              searching passes up to {formatSeconds(node.longest_scale_s)}
            </>
          ) : null}
          {isLive(event, node.state) && event ? (
            <>
              <br />
              UAP {Math.round(event.strength_nt)} nT, {formatRange(event.range_km)}
            </>
          ) : null}
        </div>
      </Tooltip>
    </Marker>
  );
});

export default memo(MagnetometerLayer);
