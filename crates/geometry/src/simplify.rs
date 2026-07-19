//! Port of main/util/simplify.js (Vladimir Agafonkin's simplify-js, as
//! modified by Jack Qiao): radial-distance prefilter + Ramer-Douglas-Peucker.

use crate::point::Point;

fn sq_dist(p1: Point, p2: Point) -> f64 {
    let dx = p1.x - p2.x;
    let dy = p1.y - p2.y;
    dx * dx + dy * dy
}

fn sq_seg_dist(p: Point, p1: Point, p2: Point) -> f64 {
    let mut x = p1.x;
    let mut y = p1.y;
    let dx = p2.x - x;
    let dy = p2.y - y;

    if dx != 0.0 || dy != 0.0 {
        let t = ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy);
        if t > 1.0 {
            x = p2.x;
            y = p2.y;
        } else if t > 0.0 {
            x += dx * t;
            y += dy * t;
        }
    }

    let dx = p.x - x;
    let dy = p.y - y;
    dx * dx + dy * dy
}

fn simplify_radial_dist(points: &[Point], sq_tolerance: f64) -> Vec<Point> {
    let mut prev_point = points[0];
    let mut new_points = vec![prev_point];
    let mut point = prev_point;
    // Ports `prevPoint !== point` (JS reference-identity: "is the final
    // input point the exact same object we already pushed as prevPoint").
    // A Rust value comparison can't express "same object" - two distinct
    // points that happen to share identical (x, y) would wrongly compare
    // equal (or, before this fix, wrongly compare *unequal* whenever they
    // differed only in the unrelated `marked` bookkeeping field). Tracking
    // "did the loop just push this exact point" directly sidesteps value
    // equality entirely and matches the original's intent exactly.
    let mut last_was_pushed = true;

    for &p in &points[1..] {
        point = p;
        if point.marked || sq_dist(point, prev_point) > sq_tolerance {
            new_points.push(point);
            prev_point = point;
            last_was_pushed = true;
        } else {
            last_was_pushed = false;
        }
    }

    if !last_was_pushed {
        new_points.push(point);
    }

    new_points
}

fn simplify_dp_step(points: &[Point], first: usize, last: usize, sq_tolerance: f64, simplified: &mut Vec<Point>) {
    let mut max_sq_dist = sq_tolerance;
    let mut index: Option<usize> = None;

    for i in (first + 1)..last {
        let sq_d = sq_seg_dist(points[i], points[first], points[last]);
        if sq_d > max_sq_dist {
            index = Some(i);
            max_sq_dist = sq_d;
        }
    }

    if let Some(index) = index {
        if max_sq_dist > sq_tolerance {
            if index - first > 1 {
                simplify_dp_step(points, first, index, sq_tolerance, simplified);
            }
            simplified.push(points[index]);
            if last - index > 1 {
                simplify_dp_step(points, index, last, sq_tolerance, simplified);
            }
        }
    }
}

fn simplify_douglas_peucker(points: &[Point], sq_tolerance: f64) -> Vec<Point> {
    let last = points.len() - 1;
    let mut simplified = vec![points[0]];
    simplify_dp_step(points, 0, last, sq_tolerance, &mut simplified);
    simplified.push(points[last]);
    simplified
}

/// Port of `simplify(points, tolerance, highestQuality)`. `tolerance`
/// defaults to `1.0` (squared) when not given, matching the JS default.
pub fn simplify(points: &[Point], tolerance: Option<f64>, highest_quality: bool) -> Vec<Point> {
    if points.len() <= 2 {
        return points.to_vec();
    }

    let sq_tolerance = tolerance.map_or(1.0, |t| t * t);

    let radial = if highest_quality {
        points.to_vec()
    } else {
        simplify_radial_dist(points, sq_tolerance)
    };

    simplify_douglas_peucker(&radial, sq_tolerance)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_collinear_points_keeps_corners() {
        let points = [
            Point::new(0.0, 0.0),
            Point::new(1.0, 0.0), // collinear - should be dropped
            Point::new(2.0, 0.0), // collinear - should be dropped
            Point::new(2.0, 2.0), // corner - must be kept
            Point::new(0.0, 2.0),
        ];
        // highest_quality=true skips the radial-distance prefilter, isolating the DP step
        let result = simplify(&points, Some(0.01), true);
        assert!(result.contains(&Point::new(0.0, 0.0)));
        assert!(result.contains(&Point::new(2.0, 2.0)));
        assert!(result.len() < points.len());
    }

    #[test]
    fn passes_through_short_inputs_unchanged() {
        let points = [Point::new(0.0, 0.0), Point::new(1.0, 1.0)];
        assert_eq!(simplify(&points, Some(0.01), false), points.to_vec());
    }

    /// Regression test for a JS-reference-identity-vs-Rust-value-equality
    /// bug: `simplify_radial_dist`'s "was the endpoint already pushed?"
    /// check used to compare `Point` values (including the unrelated
    /// `marked` field), so a genuinely distinct final input point that
    /// happens to share coordinates with the last *accepted* point (a very
    /// real case - closed polygons routinely repeat their first point's
    /// coordinates) was wrongly treated as "already there" and silently
    /// dropped. `highest_quality: false` is required to exercise this - it
    /// skips straight to the radial-distance prefilter this bug lives in.
    #[test]
    fn keeps_the_final_point_even_when_it_coincides_with_the_last_accepted_point() {
        let points = [
            Point::new(0.0, 0.0),   // always kept (first point)
            Point::new(0.1, 0.1),   // within tolerance of (0,0) - filtered out
            Point::new(0.0, 0.0),   // last point - same coordinates as the first, but a distinct input point that must still be kept
        ];
        let result = simplify(&points, Some(1.0), false);
        assert_eq!(result.len(), 2, "must keep both the first and the genuinely-last point, even though they share coordinates: {result:?}");
        assert_eq!(result[0], Point::new(0.0, 0.0));
        assert_eq!(result[1], Point::new(0.0, 0.0));
    }
}
