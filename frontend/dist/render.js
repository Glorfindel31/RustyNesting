// Shared pure SVG/geometry helpers for rendering a shape (or a placed part)
// as an SVG polygon tree - used by app.js for both the shapes table's
// thumbnails and the nested result view. Kept as its own module rather than
// inlined in app.js so the rendering math stays independently testable/
// reusable if another view ever needs the same shape rendering.

export function boundsOf(points) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minx = Math.min(...xs);
  const miny = Math.min(...ys);
  return { minx, miny, w: Math.max(...xs) - minx, h: Math.max(...ys) - miny };
}

// DXF/CAD coordinates are y-up; SVG coordinates are y-down. Rendering raw
// points would mirror the layout vertically compared to how it looks in a
// CAD viewer - flip within the sheet's own bounding box instead.
export function toSvgPoints(points, sheetBounds) {
  return points.map((p) => ({ x: p.x - sheetBounds.minx, y: sheetBounds.h - (p.y - sheetBounds.miny) }));
}

export function pointsToPath(points) {
  return points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
}

export function rotatedTranslatedPoints(points, rotationDeg, dx, dy) {
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return points.map((p) => ({ x: p.x * cos - p.y * sin + dx, y: p.x * sin + p.y * cos + dy }));
}

// Real DXF layers are arbitrary user-given names (cut/etch/drill/whatever a
// given job uses), so there's no fixed palette to draw from - hash the name
// to a hue instead. Same layer name always gets the same color, in both the
// shape thumbnails and the nested result, without needing a legend or any
// per-job configuration.
export function colorForLayer(layer) {
  let hash = 0;
  for (let i = 0; i < layer.length; i++) hash = (hash * 31 + layer.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360}, 85%, 65%)`;
}

export const UNPLACED_COLOR = "#ff5a4a"; // matches --error in app.css

// Recursively draws a shape and every nested child (holes, interior
// features on other layers) - a DXF part is a tree, not just its outer
// boundary, and dropping the children was silently discarding layer
// identity the app is supposed to preserve end to end. `transformPoints`
// does whatever coordinate mapping the caller needs (thumbnail-local bounds,
// or rotate+translate+sheet-relative for a placed part) - every node in the
// tree shares the same rigid transform since children are defined relative
// to the same local origin as their parent.
//
// `strokeOverride`, when given, replaces colorForLayer for every node in the
// tree - used to render an unplaced part entirely in the "error" color
// regardless of its real layer, so it reads as "this one's a problem" at a
// glance rather than blending in with normally-colored parts.
export function renderShapeSvg(shape, transformPoints, isRoot = true, strokeOverride = null) {
  const pts = transformPoints(shape.points);
  const stroke = strokeOverride ?? colorForLayer(shape.layer);
  let markup = `<polygon points="${pointsToPath(pts)}" fill="none" stroke="${stroke}" stroke-width="${isRoot ? 1.4 : 1}" vector-effect="non-scaling-stroke" />`;
  for (const child of shape.children ?? []) markup += renderShapeSvg(child, transformPoints, false, strokeOverride);
  return markup;
}
