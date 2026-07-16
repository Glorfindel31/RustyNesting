//! Port of `main/deepnest.js`'s `simplifyPolygon` method — the "custom
//! RDP-simplify post-process" the plan calls out (offset-shell re-merge,
//! exterior-point reversal, axis straightening, `.exact` marking). This is
//! **not** the same thing as `simplify.rs` (that's `main/util/simplify.js`'s
//! Douglas-Peucker point-reduction algorithm, one step this pipeline calls);
//! this is the larger orchestration around it: clean -> DP-simplify -> clean
//! -> offset -> exact-point marking -> offset-shell reversal -> axis
//! straightening -> offset-shell re-merge -> re-clean -> re-mark exact.
//!
//! Two deliberate, disclosed divergences from a bit-for-bit port (both
//! reviewed against the original and judged not load-bearing):
//! - The "adjacent index" check for `.exact` marking relies on
//!   `find()` returning `null` on no match; JS then does arithmetic like
//!   `index1 + 1 == index2` where a `null` operand silently coerces to `0`.
//!   This port treats "not found" as never-adjacent instead of replicating
//!   that coercion, since it would only diverge on a vertex that's
//!   completely unmatched (an edge/error condition outside the algorithm's
//!   normal operation, not a case the plan's "preserve quirks" intent
//!   was protecting).
//! - The axis-straightening inner loop recomputes `sqds` from the *offset*
//!   segment's own endpoints (not the candidate `simple` segment's, despite
//!   the name) and re-checks it against `fixedTolerance` - identical to a
//!   check the outer loop already passed moments earlier on the same
//!   values, so it can never actually skip anything. Omitted as dead code.

use clipper2::FillRule;

use crate::clipper::{clean_polygon, offset as clipper_offset, union_polygons};
use crate::hull_polygon;
use crate::point::Point;
use crate::polygon::{almost_equal, point_in_polygon, polygon_area, within_distance};
use crate::simplify::simplify as dp_simplify;

pub struct SimplifyConfig {
    pub curve_tolerance: f64,
    /// Matches `config.simplify` - when set, skip the whole pipeline below
    /// and just return the convex hull.
    pub use_convex_hull: bool,
}

/// Strict "is this point inside the polygon" check matching the DeepNest
/// class's own `pointInPolygon` (deliberately excludes on-boundary points,
/// same intent as the original's "deliberately coarse" integer-scaled
/// Clipper check, just achieved via our exact `Option<bool>::None` case
/// instead of coordinate-scale coarsening).
fn point_strictly_inside(point: Point, polygon: &[Point]) -> bool {
    point_in_polygon(point, polygon, Point::new(0.0, 0.0), None) == Some(true)
}

/// Port of the local `find()` helper: nearest-match index of `v` within
/// `p`, if any point in `p` lies within `tolerance` of `v`.
fn find(v: Point, p: &[Point], tolerance: f64) -> Option<usize> {
    p.iter().position(|q| within_distance(v, *q, tolerance))
}

/// Port of the "mark any points that are exact" loop: flags (by index into
/// `haystack`) which of its segments correspond to an edge of `original`
/// (in either winding direction), within a tight tolerance.
fn mark_exact(haystack: &[Point], original: &[Point], tolerance: f64) -> Vec<bool> {
    let n = haystack.len();
    let mut exact = vec![false; n];
    for i in 0..n {
        let seg0 = haystack[i];
        let seg1 = haystack[(i + 1) % n];
        let Some(index1) = find(seg0, original, tolerance) else { continue };
        let Some(index2) = find(seg1, original, tolerance) else { continue };
        let m = original.len();
        let adjacent = index1 + 1 == index2
            || index2 + 1 == index1
            || (index1 == 0 && index2 == m - 1)
            || (index2 == 0 && index1 == m - 1);
        if adjacent {
            exact[i] = true;
            exact[(i + 1) % n] = true;
        }
    }
    exact
}

/// Port of the local `getTarget()` helper: nearest point in `simple` to `o`
/// within `tol`, preferring points flagged exact (via `simple_exact`) when
/// any are in range.
fn get_target(o: Point, simple: &[Point], simple_exact: &[bool], tol: f64) -> Point {
    let mut in_range: Vec<(usize, f64)> = simple
        .iter()
        .enumerate()
        .map(|(j, s)| (j, (o.x - s.x).powi(2) + (o.y - s.y).powi(2)))
        .filter(|&(_, d2)| d2 < tol * tol)
        .collect();

    if !in_range.is_empty() {
        let exact_only: Vec<(usize, f64)> = in_range.iter().copied().filter(|&(j, _)| simple_exact[j]).collect();
        if !exact_only.is_empty() {
            in_range = exact_only;
        }
        in_range.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
        simple[in_range[0].0]
    } else {
        simple
            .iter()
            .min_by(|a, b| {
                let da = (o.x - a.x).powi(2) + (o.y - a.y).powi(2);
                let db = (o.x - b.x).powi(2) + (o.y - b.y).powi(2);
                da.partial_cmp(&db).unwrap()
            })
            .copied()
            .expect("simple must be non-empty")
    }
}

/// Port of the local `exterior()` helper: true if any vertex of `complex`
/// falls (depending on `inside`) outside/inside `candidate` in a way that
/// would make `candidate` an invalid replacement offset.
fn is_exterior(candidate: &[Point], complex: &[Point], inside: bool, tolerance: f64) -> bool {
    for &v in complex {
        let contained = point_strictly_inside(v, candidate);
        let matched = find(v, candidate, tolerance).is_some();
        if !inside && !contained && !matched {
            return true;
        }
        if inside && contained && !matched {
            return true;
        }
    }
    false
}

/// Port of `simplifyPolygon`. Returns the simplified/offset polygon; `inside`
/// selects whether the offset direction is inward (for interior/hole
/// profiles) or outward. Holes collected along the way (positive-area
/// offset loops) are only meaningful when `!inside`, matching the original's
/// `if (!inside && holes.length > 0) offset.children = holes`.
pub fn simplify_polygon(polygon: &[Point], inside: bool, config: &SimplifyConfig) -> (Vec<Point>, Vec<Vec<Point>>) {
    let tolerance = 4.0 * config.curve_tolerance;
    let fixed_tolerance = {
        let t = 40.0 * config.curve_tolerance;
        t * t
    };
    let tiny_tolerance = config.curve_tolerance / 1000.0;

    if config.use_convex_hull {
        let h = hull_polygon::hull(polygon);
        return (h.unwrap_or_else(|| polygon.to_vec()), Vec::new());
    }

    let Some(cleaned) = clean_polygon(polygon, config.curve_tolerance) else {
        return (polygon.to_vec(), Vec::new());
    };
    if cleaned.len() <= 1 {
        return (polygon.to_vec(), Vec::new());
    }
    let polygon = cleaned; // rebind: everything below treats this as "the original"

    // polygon -> polyline (close the loop), marking endpoints of long segments
    // so the DP step preserves them regardless of point-distance accuracy
    let mut copy: Vec<Point> = polygon.clone();
    copy.push(polygon[0]);
    for i in 0..copy.len() - 1 {
        let (p1, p2) = (copy[i], copy[i + 1]);
        let sqd = (p2.x - p1.x).powi(2) + (p2.y - p1.y).powi(2);
        if sqd > fixed_tolerance {
            copy[i].marked = true;
            copy[i + 1].marked = true;
        }
    }

    let mut simple = dp_simplify(&copy, Some(tolerance), true);
    simple.pop(); // back to a closed polygon (drop the duplicated closing point)

    let simple = match clean_polygon(&simple, config.curve_tolerance) {
        Some(s) if s.len() > 1 => s,
        _ => polygon.clone(),
    };

    let offset_delta = if inside { -tolerance } else { tolerance };
    let offsets = clipper_offset(&simple, offset_delta);

    let mut chosen_offset: Option<Vec<Point>> = None;
    let mut chosen_area = 0.0;
    let mut holes: Vec<Vec<Point>> = Vec::new();
    for candidate in &offsets {
        let area = polygon_area(candidate);
        if chosen_offset.is_none() || area < chosen_area {
            chosen_area = area;
            chosen_offset = Some(candidate.clone());
        }
        if area > 0.0 {
            holes.push(candidate.clone());
        }
    }
    let Some(mut offset) = chosen_offset else {
        return (polygon.clone(), Vec::new());
    };

    let simple_exact = mark_exact(&simple, &polygon, tiny_tolerance);

    // intermediate offset "shells" between `simple` and the final offset,
    // used as fallback snap targets during the reversal step below
    let numshells = 4;
    let mut shells: Vec<Option<Vec<Point>>> = vec![None; numshells];
    for (j, shell_slot) in shells.iter_mut().enumerate().take(numshells).skip(1) {
        let delta = j as f64 * (tolerance / numshells as f64);
        let delta = if inside { -delta } else { delta };
        let shell = clipper_offset(&simple, delta);
        *shell_slot = shell.into_iter().next();
    }

    // selective reversal of the offset: snap each offset point back toward
    // `simple` (or a fallback shell) wherever doing so doesn't introduce an
    // exterior violation against the original polygon
    for i in 0..offset.len() {
        let o = offset[i];
        let target = get_target(o, &simple, &simple_exact, 2.0 * tolerance);

        let mut test = offset.clone();
        test[i] = target;
        if !is_exterior(&test, &polygon, inside, tiny_tolerance) {
            offset[i] = target;
            continue;
        }

        for (j, shell_slot) in shells.iter().enumerate().take(numshells).skip(1) {
            let Some(shell) = shell_slot else { continue };
            let delta = j as f64 * (tolerance / numshells as f64);
            let target = get_target(o, shell, &vec![false; shell.len()], 2.0 * delta);
            let mut test = offset.clone();
            test[i] = target;
            if !is_exterior(&test, &polygon, inside, tiny_tolerance) {
                offset[i] = target;
                break;
            }
        }
    }

    // straighten long lines: snap near-axis-aligned offset edges onto a
    // similarly-aligned `simple` edge they're already close to, removing
    // the tiny-angle imprecision offsetting introduces (a rounded rectangle
    // would still have issues here, since its long sides don't line up)
    let n = offset.len();
    for i in 0..n {
        let (mut p1, mut p2) = (offset[i], offset[(i + 1) % n]);
        let sqd = (p2.x - p1.x).powi(2) + (p2.y - p1.y).powi(2);
        if sqd < fixed_tolerance {
            continue;
        }

        let m = simple.len();
        for j in 0..m {
            let (s1, s2) = (simple[j], simple[(j + 1) % m]);
            if (almost_equal(s1.x, s2.x, None) || almost_equal(s1.y, s2.y, None))
                && within_distance(p1, s1, 2.0 * tolerance)
                && within_distance(p2, s2, 2.0 * tolerance)
                && (!within_distance(p1, s1, tiny_tolerance) || !within_distance(p2, s2, tiny_tolerance))
            {
                p1 = s1;
                p2 = s2;
                offset[i] = p1;
                offset[(i + 1) % n] = p2;
            }
        }
    }

    // offset-shell re-merge: straightening above can leave `offset`
    // self-intersecting or slightly detached from `polygon` - union them
    // back together and keep the largest (most-negative-signed-area, i.e.
    // outer solid) resulting loop as the new offset
    if let Ok(combined) = union_polygons(&[offset.clone(), polygon.clone()], &[], FillRule::NonZero) {
        let mut best: Option<(Vec<Point>, f64)> = None;
        for loop_ in combined {
            let area = polygon_area(&loop_);
            if best.as_ref().is_none_or(|(_, best_area)| area < *best_area) {
                best = Some((loop_, area));
            }
        }
        if let Some((best_loop, _)) = best {
            offset = best_loop;
        }
    }

    if let Some(cleaned) = clean_polygon(&offset, config.curve_tolerance) {
        if cleaned.len() > 1 {
            offset = cleaned;
        }
    }

    // exact-marking is only used internally by get_target()/is_exterior()
    // above; the original re-marks `.exact` on the final offset here too,
    // but nothing downstream in this function reads it afterward, so
    // there's nothing left to do with it on this port's side.

    let holes = if inside { Vec::new() } else { holes };
    (offset, holes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(x: f64, y: f64, size: f64) -> Vec<Point> {
        vec![
            Point::new(x, y),
            Point::new(x + size, y),
            Point::new(x + size, y + size),
            Point::new(x, y + size),
        ]
    }

    #[test]
    fn convex_hull_fast_path_returns_the_hull_when_config_simplify_is_set() {
        let mut pts = square(0.0, 0.0, 10.0);
        pts.push(Point::new(5.0, 5.0)); // interior point, must be excluded from the hull
        let config = SimplifyConfig { curve_tolerance: 0.1, use_convex_hull: true };
        let (result, holes) = simplify_polygon(&pts, false, &config);
        assert_eq!(result.len(), 4);
        assert!(holes.is_empty());
    }

    #[test]
    fn simplifies_a_clean_square_back_to_roughly_the_same_square() {
        let sq = square(0.0, 0.0, 100.0);
        let config = SimplifyConfig { curve_tolerance: 0.1, use_convex_hull: false };
        let (result, _holes) = simplify_polygon(&sq, false, &config);
        assert!(result.len() >= 3);
        let area = polygon_area(&result).abs();
        // a clean square run through clean->offset->reversal->re-merge should stay
        // very close to its original 10000 area (the whole point of the reversal
        // step is snapping back close to the original, not drifting away from it)
        assert!((area - 10000.0).abs() < 50.0, "area was {area}");
    }
}
