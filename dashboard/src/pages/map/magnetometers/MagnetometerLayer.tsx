import { memo, useMemo } from "react";
import L from "leaflet";
import { Marker, Polygon, Tooltip } from "react-leaflet";
import { usePalette } from "../useMapTheme";
import { annulus } from "./geometry";
import { formatRange, formatScore, isRecent, STATE_LABEL, stateColourKey, withAlpha } from "./format";
import type { MagNetwork, MagNode } from "./types";
import "./magnetometers.css";

/**
 * The simulated magnetometers on the /sim map.
 *
 * Each is a small badge beside the radar node it shares a roof with, at the
 * position the server publishes for that node, so the two read as one site.
 * The badge takes the map's own semantic colours: the node colour when quiet,
 * WARN when its detection score is within 1.5σ of the threshold, ANOMALY while
 * it is detecting, grey while warming up or silent. A detection also draws the
 * range band the event's strength implies for the configured dipole moment:
 * the UAP is somewhere in that ring.
 *
 * DivIcons in the marker pane rather than canvas paths: panes.ts explains why
 * a second interactive canvas would swallow the map's clicks. The class is
 * `mag-marker`, never `node-marker`, which the E2E suite counts.
 */
function badgeHtml(colour: string, halo: string, state: string, selected: boolean): string {
  const ring = selected ? `<circle cx="9" cy="9" r="8.2" fill="none" stroke="${colour}" stroke-width="1.6"/>` : "";
  const pulse = `--mag-pulse:${withAlpha(colour, 0.7)};--mag-pulse-end:${withAlpha(colour, 0)};--mag-halo:${withAlpha(colour, 0.45)}`;
  return `<div class="mag-badge mag-${state}${selected ? " mag-selected" : ""}" style="${pulse}">
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    ${ring}
    <rect x="3" y="3" width="12" height="12" rx="3" fill="${colour}" fill-opacity="0.92" stroke="${halo}" stroke-width="1.2"/>
    <path d="M6.2 5.8 v4.1 a2.8 2.8 0 0 0 5.6 0 v-4.1" fill="none" stroke="${halo}" stroke-width="1.5" stroke-linecap="round"/>
  </svg>
</div>`;
}

const iconCache = new Map<string, L.DivIcon>();

function badgeIcon(colour: string, halo: string, state: string, selected: boolean): L.DivIcon {
  const key = `${colour}|${halo}|${state}|${selected}`;
  let icon = iconCache.get(key);
  if (!icon) {
    icon = L.divIcon({
      className: "mag-marker",
      html: badgeHtml(colour, halo, state, selected),
      iconSize: [18, 18],
      // Up and to the right of the radar node's own dot at the same point.
      iconAnchor: [-3, 21],
    });
    iconCache.set(key, icon);
  }
  return icon;
}

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
        if (!isRecent(event, nowMs) || !event?.range_km) return null;
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
              fillOpacity: event.active ? 0.16 : 0.07,
              opacity: event.active ? 0.9 : 0.45,
            }}
          />
        );
      })}
      {placed.map(({ node, position }) => (
        <MagMarker
          key={node.node_id}
          node={node}
          position={position}
          colour={palette[stateColourKey(node.state)]}
          halo={palette.ICON_HALO}
          selected={node.node_id === selectedId}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

const MagMarker = memo(function MagMarker({
  node,
  position,
  colour,
  halo,
  selected,
  onSelect,
}: {
  node: MagNode;
  position: [number, number];
  colour: string;
  halo: string;
  selected: boolean;
  onSelect: (nodeId: string) => void;
}) {
  const event = node.event;
  return (
    <Marker
      position={position}
      icon={badgeIcon(colour, halo, node.state, selected)}
      zIndexOffset={1200}
      bubblingMouseEvents={false}
      eventHandlers={{ click: () => onSelect(node.node_id) }}
      keyboard
      title={`Magnetometer beside ${node.host_node_id}`}
    >
      <Tooltip direction="top" offset={[9, -20]} opacity={0.95}>
        <div className="mag-tooltip">
          <strong>Magnetometer</strong> · {node.host_node_id}
          <br />
          {STATE_LABEL[node.state]}
          {node.state !== "warming_up" && node.state !== "stale" ? ` · score ${formatScore(node.score_sigma)}` : ""}
          {event?.active ? (
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
