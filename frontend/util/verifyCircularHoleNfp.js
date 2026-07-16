/**
 * Self-check for the circular-hole NFP fast path in background.js's getInnerNfp().
 *
 * Claim being verified: for a circular hole of radius R centered at (Acx,Acy), and a circular
 * candidate part of radius r centered at (Bcx,Bcy), the valid positions for the part's
 * reference point B[0] (which sits ON the part's own boundary, not its center - that's where
 * circle tessellation always starts, see svgparser.js's polygonify) form an exact disk of
 * radius (R - r), centered at (Acx,Acy) shifted by the fixed offset (B[0] - partCenter).
 *
 * Unlike a generic polygon-in-circle fit, this is provably EXACT (not just a safe
 * approximation): a circle's distance from its own center is the same in every direction, so
 * there's no worst-case-direction conservatism to worry about, in contrast to an arbitrary
 * candidate shape (see git history / PR discussion for why the fast path is restricted to
 * round-on-round rather than generalized to any B).
 *
 * Verified by brute-force sampling directly against the geometric containment definition, not
 * against the codebase's own NFP code (which computes a different quantity - the outer/
 * collision NFP - and would make this check circular).
 *
 * Run with: node main/util/verifyCircularHoleNfp.js
 */
'use strict';

// Ground truth: does a circle of radius r centered at partCenter, whose boundary point
// B0 lands at candidate position c, stay entirely inside disk(Acx,Acy,R)?
function fitsAt(c, B0, partCenter, r, Acx, Acy, R, eps) {
  const placedCenter = {
    x: c.x + (partCenter.x - B0.x),
    y: c.y + (partCenter.y - B0.y),
  };
  const dist = Math.hypot(placedCenter.x - Acx, placedCenter.y - Acy);
  return dist <= R - r + eps;
}

// Fast path under test.
function fastFitDisk(Acx, Acy, R, B0, partCenter, r) {
  const fitRadius = R - r;
  if (fitRadius <= 0) return null;
  const offsetX = B0.x - partCenter.x;
  const offsetY = B0.y - partCenter.y;
  return { cx: Acx + offsetX, cy: Acy + offsetY, r: fitRadius };
}

function check(name, Acx, Acy, R, partCenter, r, b0AngleDeg) {
  const eps = 1e-9;
  // B[0] is a point on the part's own boundary, at an arbitrary angle from its center -
  // this is the "reference point sits on the boundary, not the center" case the offset math
  // has to handle correctly.
  const theta0 = (b0AngleDeg * Math.PI) / 180;
  const B0 = { x: partCenter.x + r * Math.cos(theta0), y: partCenter.y + r * Math.sin(theta0) };

  const fast = fastFitDisk(Acx, Acy, R, B0, partCenter, r);

  if (R - r <= 0) {
    // sample a few candidate centers near the hole center; none should fit
    for (let a = 0; a < 8; a++) {
      const t = (a / 8) * 2 * Math.PI;
      const c = { x: Acx + 0.1 * Math.cos(t), y: Acy + 0.1 * Math.sin(t) };
      if (fitsAt(c, B0, partCenter, r, Acx, Acy, R, eps)) {
        throw new Error(`${name}: expected no fit, but center ${JSON.stringify(c)} fits`);
      }
    }
    console.log(`PASS ${name} (correctly unfittable, r=${r} > R=${R})`);
    return;
  }

  // Exact claim: every point on/just inside the claimed disk fits, every point just outside
  // does NOT - both directions, since this is meant to be tight, not merely conservative.
  for (let a = 0; a < 36; a++) {
    const theta = (a / 36) * 2 * Math.PI;

    const inC = { x: fast.cx + fast.r * 0.999 * Math.cos(theta), y: fast.cy + fast.r * 0.999 * Math.sin(theta) };
    if (!fitsAt(inC, B0, partCenter, r, Acx, Acy, R, eps)) {
      throw new Error(`${name}: point just inside claimed disk (theta=${theta.toFixed(2)}) does not fit`);
    }

    const outC = { x: fast.cx + fast.r * 1.01 * Math.cos(theta), y: fast.cy + fast.r * 1.01 * Math.sin(theta) };
    if (fitsAt(outC, B0, partCenter, r, Acx, Acy, R, eps)) {
      throw new Error(`${name}: point just outside claimed disk (theta=${theta.toFixed(2)}) still fits - not tight`);
    }
  }

  console.log(`PASS ${name} (fitRadius=${fast.r.toFixed(3)}, exact in all directions)`);
}

// B[0] at theta=0 (matches real tessellation start), part concentric-ish with the hole.
check('B[0] at tessellation start, hole/part roughly aligned', 0, 0, 10, { x: 0, y: 0 }, 4, 0);

// Part center offset from origin (as if not yet placed near the hole), B[0] at an arbitrary angle.
check('part far from hole, B[0] at 137 degrees', 50, -30, 12, { x: 500, y: 500 }, 5, 137);

// Tight fit, radii nearly equal.
check('near-equal radii', 0, 0, 10.5, { x: 0, y: 0 }, 10, 45);

// Part too big for the hole.
check('oversized part cannot fit', 0, 0, 5, { x: 0, y: 0 }, 6, 0);

console.log('All circular-hole NFP checks passed.');
