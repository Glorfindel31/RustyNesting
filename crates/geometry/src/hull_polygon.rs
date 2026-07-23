//! Port of main/util/HullPolygon.ts's `hull()` (Andrew's monotone chain
//! convex hull algorithm, based on d3-polygon). Only `hull()` is ported -
//! the original also has `area`, `centroid`, `contains`, `length` methods,
//! but grepping the whole Electron repo shows zero call sites for any of
//! them; only `.hull()` is ever called (from `deepnest.js`'s
//! `getHull`/`simplifyPolygon` and `background.js`).

use crate::point::Point;

fn cross(a: Point, b: Point, c: Point) -> f64 {
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

/// Assumes `points` is already sorted lexicographically by (x, y). Returns
/// indices into `points`, in left-to-right order, forming the upper hull.
fn compute_upper_hull_indexes(points: &[Point]) -> Vec<usize> {
    let n = points.len();
    let mut indexes: Vec<usize> = vec![0, 1];
    let mut size = 2usize;

    for i in 2..n {
        while size > 1 && cross(points[indexes[size - 2]], points[indexes[size - 1]], points[i]) <= 0.0 {
            size -= 1;
        }
        if size == indexes.len() {
            indexes.push(i);
        } else {
            indexes[size] = i;
        }
        size += 1;
    }

    indexes.truncate(size);
    indexes
}

/// Port of `HullPolygon.hull`: the convex hull of `points`, in
/// counterclockwise order. `None` if fewer than 3 points are given.
pub fn hull(points: &[Point]) -> Option<Vec<Point>> {
    let n = points.len();
    if n < 3 {
        return None;
    }

    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| points[a].x.total_cmp(&points[b].x).then(points[a].y.total_cmp(&points[b].y)));

    let sorted_points: Vec<Point> = order.iter().map(|&i| points[i]).collect();
    let flipped_points: Vec<Point> = sorted_points.iter().map(|p| Point::new(p.x, -p.y)).collect();

    let upper_indexes = compute_upper_hull_indexes(&sorted_points);
    let lower_indexes = compute_upper_hull_indexes(&flipped_points);

    // compute_upper_hull_indexes always returns >= 2 indices: `size` starts
    // at 2 and its inner while loop stops at `size > 1`, so every iteration
    // of the outer `for i in 2..n` loop leaves it >= 2 after the trailing
    // `size += 1` - and `hull`'s own `n < 3` guard above guarantees at least
    // one such iteration runs. Never panics.
    let skip_left = lower_indexes[0] == upper_indexes[0];
    let skip_right = *lower_indexes.last().unwrap() == *upper_indexes.last().unwrap();

    let mut result = Vec::new();
    for &i in upper_indexes.iter().rev() {
        result.push(points[order[i]]);
    }
    let lower_start = if skip_left { 1 } else { 0 };
    let lower_end = lower_indexes.len() - usize::from(skip_right);
    for &i in &lower_indexes[lower_start..lower_end] {
        result.push(points[order[i]]);
    }

    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_none_for_fewer_than_three_points() {
        assert!(hull(&[Point::new(0.0, 0.0), Point::new(1.0, 1.0)]).is_none());
    }

    #[test]
    fn hull_of_a_square_with_an_interior_point_excludes_the_interior_point() {
        let points = [
            Point::new(0.0, 0.0),
            Point::new(10.0, 0.0),
            Point::new(10.0, 10.0),
            Point::new(0.0, 10.0),
            Point::new(5.0, 5.0), // interior, must be excluded
        ];
        let h = hull(&points).expect("hull should exist");
        assert_eq!(h.len(), 4);
        assert!(!h.contains(&Point::new(5.0, 5.0)));
        for corner in &points[0..4] {
            assert!(h.contains(corner));
        }
    }

    #[test]
    fn hull_of_a_triangle_is_the_triangle_itself() {
        let points = [Point::new(0.0, 0.0), Point::new(4.0, 0.0), Point::new(2.0, 3.0)];
        let h = hull(&points).expect("hull should exist");
        assert_eq!(h.len(), 3);
    }
}
