/**
 * Real Facilio floorplan markers are positioned in actual lng/lat, georeferenced to the raster
 * floorplan image via a 4-corner quad (`indoorfloorplan.geometry`) — normally set by a human
 * dragging the image onto a real map in the Facilio editor. This app has no such calibration
 * step and doesn't track a site's real-world address, so on upload it invents a small, SYNTHETIC
 * quad (anchored at an arbitrary placeholder point, sized to a plausible single-floor footprint,
 * matching the image's aspect ratio) — self-consistent for converting this app's 0-1 unit
 * fractions to/from lng/lat, but not tied to any real geographic location.
 */
export interface GeoQuad {
  /** [lng, lat] corners in image order: top-left, top-right, bottom-right, bottom-left. */
  tl: [number, number];
  tr: [number, number];
  br: [number, number];
  bl: [number, number];
}

const SYNTHETIC_ANCHOR: [number, number] = [-122.4194, 37.7749];
const METERS_PER_DEG_LAT = 111320;
/** Plausible single-floor footprint — keeps the synthetic quad a sane real-world size. */
const TARGET_SPAN_METERS = 60;

export function computeSyntheticGeometry(width: number, height: number): GeoQuad {
  const longerSidePx = Math.max(width, height) || 1;
  const metersPerPixel = TARGET_SPAN_METERS / longerSidePx;
  const [anchorLng, anchorLat] = SYNTHETIC_ANCHOR;
  const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos((anchorLat * Math.PI) / 180);
  const lngSpan = (width * metersPerPixel) / metersPerDegLng;
  const latSpan = (height * metersPerPixel) / METERS_PER_DEG_LAT;
  return {
    tl: [anchorLng, anchorLat],
    tr: [anchorLng + lngSpan, anchorLat],
    br: [anchorLng + lngSpan, anchorLat - latSpan],
    bl: [anchorLng, anchorLat - latSpan],
  };
}

/** Fraction (0-1 of image width/height) -> [lng, lat], via bilinear interpolation across the quad. */
export function quadToLngLat(quad: GeoQuad, xFrac: number, yFrac: number): [number, number] {
  const top: [number, number] = [quad.tl[0] + (quad.tr[0] - quad.tl[0]) * xFrac, quad.tl[1] + (quad.tr[1] - quad.tl[1]) * xFrac];
  const bottom: [number, number] = [quad.bl[0] + (quad.br[0] - quad.bl[0]) * xFrac, quad.bl[1] + (quad.br[1] - quad.bl[1]) * xFrac];
  return [top[0] + (bottom[0] - top[0]) * yFrac, top[1] + (bottom[1] - top[1]) * yFrac];
}

export function quadToGeometryString(quad: GeoQuad): string {
  return JSON.stringify({ type: 'Polygon', coordinates: [[quad.tl, quad.tr, quad.br, quad.bl, quad.tl]] });
}

/** Inverse of `quadToGeometryString` — reads the corners back off a stored `indoorfloorplan.geometry` string. */
export function geometryStringToQuad(geometry: string | null | undefined): GeoQuad | null {
  if (!geometry) return null;
  try {
    const parsed = JSON.parse(geometry);
    const ring = parsed?.coordinates?.[0];
    if (!Array.isArray(ring) || ring.length < 4) return null;
    return { tl: ring[0], tr: ring[1], br: ring[2], bl: ring[3] };
  } catch {
    return null;
  }
}

/** Reads an image data URL's actual pixel dimensions — used to size the synthetic geometry to the real upload's aspect ratio. */
export function measureImageDataUrl(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('Could not measure image dimensions'));
    img.src = dataUrl;
  });
}
