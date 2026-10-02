/**
 * Circles on the map for the magnetometer layer: the range band of a
 * detection is an annulus, drawn as a polygon with a hole.
 */

const EARTH_RADIUS_KM = 6371.0;

/** The point `distanceKm` from (lat, lon) on `bearingDeg`, on a sphere. */
export function destination(lat: number, lon: number, bearingDeg: number, distanceKm: number): [number, number] {
  const d = distanceKm / EARTH_RADIUS_KM;
  const b = (bearingDeg * Math.PI) / 180;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lon * Math.PI) / 180;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(b));
  const λ2 = λ1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2));
  return [(φ2 * 180) / Math.PI, (((λ2 * 180) / Math.PI + 540) % 360) - 180];
}

export function ring(lat: number, lon: number, radiusKm: number, steps = 72): [number, number][] {
  const points: [number, number][] = [];
  for (let i = 0; i < steps; i++) points.push(destination(lat, lon, (360 * i) / steps, radiusKm));
  return points;
}

/** Outer ring and (reversed) inner ring: Leaflet fills between them. */
export function annulus(lat: number, lon: number, innerKm: number, outerKm: number): [number, number][][] {
  return [ring(lat, lon, outerKm), ring(lat, lon, innerKm).reverse()];
}
