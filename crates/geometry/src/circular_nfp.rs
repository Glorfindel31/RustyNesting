//! Port of the disk-fit math from main/util/verifyCircularHoleNfp.js and its
//! real production counterpart, background.js's `getInnerNfp` circular-hole
//! fast path (background.js:1886-1894).
//!
//! Claim: for a circular hole of radius `r_hole` centered at `hole_center`,
//! and a circular candidate part of radius `r_part` centered at `part_center`,
//! the valid positions for the part's reference point `b0` (a point on the
//! part's own boundary, not its center - that's where circle tessellation
//! always starts, see svgparser.js's polygonify) form an exact disk of
//! radius `r_hole - r_part`, centered at `hole_center` shifted by the fixed
//! offset `(b0 - part_center)`. This is provably exact (not merely a safe
//! approximation): a circle's distance from its own center is the same in
//! every direction, unlike an arbitrary candidate shape - see git history /
//! PR discussion for why this fast path is restricted to round-on-round.
//!
//! `getInnerNfp` itself (Phase 2 material: DB cache lookups, tessellating
//! this disk into an actual NFP polygon via `tessellateCircle`, and the
//! other two inner-NFP fast paths) is not ported here - only the disk-fit
//! math this file's tests exist to verify.

use crate::point::Point;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Circle {
    pub cx: f64,
    pub cy: f64,
    pub r: f64,
}

/// Port of `fastFitDisk`: the fast path under test. Returns `None` if the
/// part cannot possibly fit (its radius is >= the hole's).
pub fn fast_fit_disk(hole_center: Point, r_hole: f64, b0: Point, part_center: Point, r_part: f64) -> Option<Circle> {
    let fit_radius = r_hole - r_part;
    if fit_radius <= 0.0 {
        return None;
    }
    let offset_x = b0.x - part_center.x;
    let offset_y = b0.y - part_center.y;
    Some(Circle {
        cx: hole_center.x + offset_x,
        cy: hole_center.y + offset_y,
        r: fit_radius,
    })
}

/// Port of `fitsAt`: ground truth via brute-force geometric containment,
/// checked independently of the codebase's own NFP code (which computes a
/// different quantity - the outer/collision NFP - and would make this check
/// circular).
pub fn fits_at(
    candidate: Point,
    b0: Point,
    part_center: Point,
    r_part: f64,
    hole_center: Point,
    r_hole: f64,
    eps: f64,
) -> bool {
    let placed_center = Point::new(
        candidate.x + (part_center.x - b0.x),
        candidate.y + (part_center.y - b0.y),
    );
    let dist = (placed_center.x - hole_center.x).hypot(placed_center.y - hole_center.y);
    dist <= r_hole - r_part + eps
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    /// Port of `check()`: brute-force-verifies `fast_fit_disk` against
    /// `fits_at` in all directions, for both the fits-nowhere case (part too
    /// big) and the exact-boundary case (every point just inside the claimed
    /// disk fits; every point just outside does not).
    fn check(hole_center: Point, r_hole: f64, part_center: Point, r_part: f64, b0_angle_deg: f64) {
        let eps = 1e-9;
        let theta0 = b0_angle_deg * PI / 180.0;
        let b0 = Point::new(
            part_center.x + r_part * theta0.cos(),
            part_center.y + r_part * theta0.sin(),
        );

        let fast = fast_fit_disk(hole_center, r_hole, b0, part_center, r_part);

        if r_hole - r_part <= 0.0 {
            for a in 0..8 {
                let t = (a as f64 / 8.0) * 2.0 * PI;
                let c = Point::new(hole_center.x + 0.1 * t.cos(), hole_center.y + 0.1 * t.sin());
                assert!(
                    !fits_at(c, b0, part_center, r_part, hole_center, r_hole, eps),
                    "expected no fit, but center {c:?} fits"
                );
            }
            return;
        }

        let fast = fast.expect("fitRadius > 0 implies Some");
        for a in 0..36 {
            let theta = (a as f64 / 36.0) * 2.0 * PI;

            let in_c = Point::new(
                fast.cx + fast.r * 0.999 * theta.cos(),
                fast.cy + fast.r * 0.999 * theta.sin(),
            );
            assert!(
                fits_at(in_c, b0, part_center, r_part, hole_center, r_hole, eps),
                "point just inside claimed disk (theta={theta:.2}) does not fit"
            );

            let out_c = Point::new(
                fast.cx + fast.r * 1.01 * theta.cos(),
                fast.cy + fast.r * 1.01 * theta.sin(),
            );
            assert!(
                !fits_at(out_c, b0, part_center, r_part, hole_center, r_hole, eps),
                "point just outside claimed disk (theta={theta:.2}) still fits - not tight"
            );
        }
    }

    #[test]
    fn b0_at_tessellation_start_hole_and_part_roughly_aligned() {
        check(Point::new(0.0, 0.0), 10.0, Point::new(0.0, 0.0), 4.0, 0.0);
    }

    #[test]
    fn part_far_from_hole_b0_at_137_degrees() {
        check(Point::new(50.0, -30.0), 12.0, Point::new(500.0, 500.0), 5.0, 137.0);
    }

    #[test]
    fn near_equal_radii_tight_fit() {
        check(Point::new(0.0, 0.0), 10.5, Point::new(0.0, 0.0), 10.0, 45.0);
    }

    #[test]
    fn oversized_part_cannot_fit() {
        check(Point::new(0.0, 0.0), 5.0, Point::new(0.0, 0.0), 6.0, 0.0);
    }
}
