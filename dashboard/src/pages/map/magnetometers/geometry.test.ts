import { describe, expect, it } from "vitest";
import { annulus, destination, ring } from "./geometry";

const KM_PER_DEGREE = 111.19492664455873; // 2π · 6371 km / 360

/** Great-circle distance, the independent check on destination(). */
function haversineKm([lat1, lon1]: [number, number], [lat2, lon2]: [number, number]): number {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

describe("destination", () => {
  it("goes nowhere for no distance", () => {
    const [lat, lon] = destination(34.85, -82.39, 123, 0);
    expect(lat).toBeCloseTo(34.85, 12);
    expect(lon).toBeCloseTo(-82.39, 12);
  });

  it("moves a degree of latitude north and a degree of longitude east on the equator", () => {
    const north = destination(0, 0, 0, KM_PER_DEGREE);
    expect(north[0]).toBeCloseTo(1, 9);
    expect(north[1]).toBeCloseTo(0, 9);
    const east = destination(0, 0, 90, KM_PER_DEGREE);
    expect(east[0]).toBeCloseTo(0, 9);
    expect(east[1]).toBeCloseTo(1, 9);
  });

  it("wraps across the antimeridian", () => {
    const [, lon] = destination(0, 179.9, 90, KM_PER_DEGREE);
    expect(lon).toBeCloseTo(-179.1, 9);
  });
});

describe("ring and annulus", () => {
  it("puts every point of a ring at its radius", () => {
    const centre: [number, number] = [34.85, -82.39];
    const points = ring(centre[0], centre[1], 1.2, 36);
    expect(points).toHaveLength(36);
    for (const p of points) expect(haversineKm(centre, p)).toBeCloseTo(1.2, 9);
  });

  it("winds the hole the other way, so Leaflet fills only between the rings", () => {
    const [outer, inner] = annulus(34.85, -82.39, 0.5, 2);
    expect(outer).toEqual(ring(34.85, -82.39, 2));
    expect(inner).toEqual(ring(34.85, -82.39, 0.5).reverse());
  });
});
