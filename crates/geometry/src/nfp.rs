//! Port of the NFP-tracing portions of main/util/geometryutil.js: segment/
//! polygon intersection and distance helpers, the orbiting `noFitPolygon`
//! algorithm, its rectangular fast path, and `polygonHull`. See polygon.rs
//! for the non-NFP helpers this module builds on.

use crate::point::Point;
use crate::polygon::{almost_equal, normalize_vector, on_segment, point_in_polygon, TOL};

fn points_equal_or_almost(a: Point, b: Point) -> bool {
    (a.x == b.x && a.y == b.y) || almost_equal(a.x, b.x, None) && almost_equal(a.y, b.y, None)
}

/// Appends a copy of the first point to close the loop, unless it's already closed.
fn close_loop(points: &[Point]) -> Vec<Point> {
    let mut v = points.to_vec();
    if let (Some(first), Some(last)) = (v.first().copied(), v.last().copied()) {
        if first.x != last.x || first.y != last.y {
            v.push(first);
        }
    }
    v
}

/// Port of `intersect`. Does not close the loop itself - callers that need
/// the wrap-around edge covered must pre-close A and B (see `close_loop`),
/// matching the original's reliance on callers doing this.
pub fn intersect(a: &[Point], a_offset: Point, b: &[Point], b_offset: Point) -> bool {
    let zero = Point::new(0.0, 0.0);

    for i in 0..a.len().saturating_sub(1) {
        for j in 0..b.len().saturating_sub(1) {
            let a1 = Point::new(a[i].x + a_offset.x, a[i].y + a_offset.y);
            let a2 = Point::new(a[i + 1].x + a_offset.x, a[i + 1].y + a_offset.y);
            let b1 = Point::new(b[j].x + b_offset.x, b[j].y + b_offset.y);
            let b2 = Point::new(b[j + 1].x + b_offset.x, b[j + 1].y + b_offset.y);

            let mut prevbindex = if j == 0 { b.len() - 1 } else { j - 1 };
            let mut prevaindex = if i == 0 { a.len() - 1 } else { i - 1 };
            let mut nextbindex = if j + 1 == b.len() - 1 { 0 } else { j + 2 };
            let mut nextaindex = if i + 1 == a.len() - 1 { 0 } else { i + 2 };

            if points_equal_or_almost(b[prevbindex], b[j]) {
                prevbindex = if prevbindex == 0 { b.len() - 1 } else { prevbindex - 1 };
            }
            if points_equal_or_almost(a[prevaindex], a[i]) {
                prevaindex = if prevaindex == 0 { a.len() - 1 } else { prevaindex - 1 };
            }
            if points_equal_or_almost(b[nextbindex], b[j + 1]) {
                nextbindex = if nextbindex == b.len() - 1 { 0 } else { nextbindex + 1 };
            }
            if points_equal_or_almost(a[nextaindex], a[i + 1]) {
                nextaindex = if nextaindex == a.len() - 1 { 0 } else { nextaindex + 1 };
            }

            let a0 = Point::new(a[prevaindex].x + a_offset.x, a[prevaindex].y + a_offset.y);
            let b0 = Point::new(b[prevbindex].x + b_offset.x, b[prevbindex].y + b_offset.y);
            let a3 = Point::new(a[nextaindex].x + a_offset.x, a[nextaindex].y + a_offset.y);
            let b3 = Point::new(b[nextbindex].x + b_offset.x, b[nextbindex].y + b_offset.y);

            if on_segment(a1, a2, b1, None) || points_equal_or_almost(a1, b1) {
                let b0in = point_in_polygon(b0, a, zero, None);
                let b2in = point_in_polygon(b2, a, zero, None);
                if (b0in == Some(true) && b2in == Some(false)) || (b0in == Some(false) && b2in == Some(true)) {
                    return true;
                }
                continue;
            }

            if on_segment(a1, a2, b2, None) || points_equal_or_almost(a2, b2) {
                let b1in = point_in_polygon(b1, a, zero, None);
                let b3in = point_in_polygon(b3, a, zero, None);
                if (b1in == Some(true) && b3in == Some(false)) || (b1in == Some(false) && b3in == Some(true)) {
                    return true;
                }
                continue;
            }

            if on_segment(b1, b2, a1, None) || points_equal_or_almost(a1, b2) {
                let a0in = point_in_polygon(a0, b, zero, None);
                let a2in = point_in_polygon(a2, b, zero, None);
                if (a0in == Some(true) && a2in == Some(false)) || (a0in == Some(false) && a2in == Some(true)) {
                    return true;
                }
                continue;
            }

            if on_segment(b1, b2, a2, None) || points_equal_or_almost(a2, b1) {
                let a1in = point_in_polygon(a1, b, zero, None);
                let a3in = point_in_polygon(a3, b, zero, None);
                if (a1in == Some(true) && a3in == Some(false)) || (a1in == Some(false) && a3in == Some(true)) {
                    return true;
                }
                continue;
            }

            if crate::polygon::line_intersect(b1, b2, a1, a2, false).is_some() {
                return true;
            }
        }
    }

    false
}

/// Port of `pointDistance`.
pub fn point_distance(p: Point, s1: Point, s2: Point, normal: Point, infinite: bool) -> Option<f64> {
    let normal = normalize_vector(normal);
    let dir = Point::new(normal.y, -normal.x);

    let pdot = p.x * dir.x + p.y * dir.y;
    let s1dot = s1.x * dir.x + s1.y * dir.y;
    let s2dot = s2.x * dir.x + s2.y * dir.y;

    let pdotnorm = p.x * normal.x + p.y * normal.y;
    let s1dotnorm = s1.x * normal.x + s1.y * normal.y;
    let s2dotnorm = s2.x * normal.x + s2.y * normal.y;

    if !infinite {
        if ((pdot < s1dot || almost_equal(pdot, s1dot, None)) && (pdot < s2dot || almost_equal(pdot, s2dot, None)))
            || ((pdot > s1dot || almost_equal(pdot, s1dot, None)) && (pdot > s2dot || almost_equal(pdot, s2dot, None)))
        {
            return None;
        }
        if almost_equal(pdot, s1dot, None)
            && almost_equal(pdot, s2dot, None)
            && pdotnorm > s1dotnorm
            && pdotnorm > s2dotnorm
        {
            return Some((pdotnorm - s1dotnorm).min(pdotnorm - s2dotnorm));
        }
        if almost_equal(pdot, s1dot, None)
            && almost_equal(pdot, s2dot, None)
            && pdotnorm < s1dotnorm
            && pdotnorm < s2dotnorm
        {
            return Some(-(s1dotnorm - pdotnorm).min(s2dotnorm - pdotnorm));
        }
    }

    Some(-(pdotnorm - s1dotnorm + (s1dotnorm - s2dotnorm) * (s1dot - pdot) / (s1dot - s2dot)))
}

/// JS coerces `null` to `0` in arithmetic, so `dB*overlap` on a null `dB` is
/// `almostEqual(0,0)` = true; this mirrors that for the `dcheck` callers below.
fn null_coerced_check(d: Option<f64>, overlap: f64) -> bool {
    match d {
        None => true,
        Some(d) => d < 0.0 || almost_equal(d * overlap, 0.0, None),
    }
}

/// Port of `segmentDistance`.
pub fn segment_distance(a: Point, b: Point, e: Point, f: Point, direction: Point) -> Option<f64> {
    let normal = Point::new(direction.y, -direction.x);
    let reverse = Point::new(-direction.x, -direction.y);

    let dot_a = a.x * normal.x + a.y * normal.y;
    let dot_b = b.x * normal.x + b.y * normal.y;
    let dot_e = e.x * normal.x + e.y * normal.y;
    let dot_f = f.x * normal.x + f.y * normal.y;

    let cross_a = a.x * direction.x + a.y * direction.y;
    let cross_b = b.x * direction.x + b.y * direction.y;
    let cross_e = e.x * direction.x + e.y * direction.y;
    let cross_f = f.x * direction.x + f.y * direction.y;

    let ab_min = dot_a.min(dot_b);
    let ab_max = dot_a.max(dot_b);
    let ef_max = dot_e.max(dot_f);
    let ef_min = dot_e.min(dot_f);

    if almost_equal(ab_max, ef_min, Some(TOL)) || almost_equal(ab_min, ef_max, Some(TOL)) {
        return None;
    }
    if ab_max < ef_min || ab_min > ef_max {
        return None;
    }

    let overlap = if (ab_max > ef_max && ab_min < ef_min) || (ef_max > ab_max && ef_min < ab_min) {
        1.0
    } else {
        let min_max = ab_max.min(ef_max);
        let max_min = ab_min.max(ef_min);
        let max_max = ab_max.max(ef_max);
        let min_min = ab_min.min(ef_min);
        (min_max - max_min) / (max_max - min_min)
    };

    let cross_abe = (e.y - a.y) * (b.x - a.x) - (e.x - a.x) * (b.y - a.y);
    let cross_abf = (f.y - a.y) * (b.x - a.x) - (f.x - a.x) * (b.y - a.y);

    if almost_equal(cross_abe, 0.0, None) && almost_equal(cross_abf, 0.0, None) {
        let ab_norm_len = (b.y - a.y).hypot(a.x - b.x);
        let ab_norm = Point::new((b.y - a.y) / ab_norm_len, (a.x - b.x) / ab_norm_len);
        let ef_norm_len = (f.y - e.y).hypot(e.x - f.x);
        let ef_norm = Point::new((f.y - e.y) / ef_norm_len, (e.x - f.x) / ef_norm_len);

        if (ab_norm.y * ef_norm.x - ab_norm.x * ef_norm.y).abs() < TOL
            && ab_norm.y * ef_norm.y + ab_norm.x * ef_norm.x < 0.0
        {
            let normdot = ab_norm.y * direction.y + ab_norm.x * direction.x;
            if almost_equal(normdot, 0.0, Some(TOL)) {
                return None;
            }
            if normdot < 0.0 {
                return Some(0.0);
            }
        }
        return None;
    }

    let mut distances: Vec<f64> = Vec::new();

    if almost_equal(dot_a, dot_e, None) {
        distances.push(cross_a - cross_e);
    } else if almost_equal(dot_a, dot_f, None) {
        distances.push(cross_a - cross_f);
    } else if dot_a > ef_min && dot_a < ef_max {
        let mut d = point_distance(a, e, f, reverse, false);
        if d.is_some_and(|dv| almost_equal(dv, 0.0, None)) {
            let d_b = point_distance(b, e, f, reverse, true);
            if null_coerced_check(d_b, overlap) {
                d = None;
            }
        }
        if let Some(dv) = d {
            distances.push(dv);
        }
    }

    if almost_equal(dot_b, dot_e, None) {
        distances.push(cross_b - cross_e);
    } else if almost_equal(dot_b, dot_f, None) {
        distances.push(cross_b - cross_f);
    } else if dot_b > ef_min && dot_b < ef_max {
        let mut d = point_distance(b, e, f, reverse, false);
        if d.is_some_and(|dv| almost_equal(dv, 0.0, None)) {
            let d_a = point_distance(a, e, f, reverse, true);
            if null_coerced_check(d_a, overlap) {
                d = None;
            }
        }
        if let Some(dv) = d {
            distances.push(dv);
        }
    }

    if dot_e > ab_min && dot_e < ab_max {
        let mut d = point_distance(e, a, b, direction, false);
        if d.is_some_and(|dv| almost_equal(dv, 0.0, None)) {
            let d_f = point_distance(f, a, b, direction, true);
            if null_coerced_check(d_f, overlap) {
                d = None;
            }
        }
        if let Some(dv) = d {
            distances.push(dv);
        }
    }

    if dot_f > ab_min && dot_f < ab_max {
        let mut d = point_distance(f, a, b, direction, false);
        if d.is_some_and(|dv| almost_equal(dv, 0.0, None)) {
            let d_e = point_distance(e, a, b, direction, true);
            if null_coerced_check(d_e, overlap) {
                d = None;
            }
        }
        if let Some(dv) = d {
            distances.push(dv);
        }
    }

    distances.into_iter().reduce(f64::min)
}

/// Port of `polygonSlideDistance`.
pub fn polygon_slide_distance(
    a: &[Point],
    a_offset: Point,
    b: &[Point],
    b_offset: Point,
    direction: Point,
    ignore_negative: bool,
) -> Option<f64> {
    let edge_a = close_loop(a);
    let edge_b = close_loop(b);
    let dir = normalize_vector(direction);

    let mut distance: Option<f64> = None;

    for i in 0..edge_b.len().saturating_sub(1) {
        for j in 0..edge_a.len().saturating_sub(1) {
            let a1 = Point::new(edge_a[j].x + a_offset.x, edge_a[j].y + a_offset.y);
            let a2 = Point::new(edge_a[j + 1].x + a_offset.x, edge_a[j + 1].y + a_offset.y);
            let b1 = Point::new(edge_b[i].x + b_offset.x, edge_b[i].y + b_offset.y);
            let b2 = Point::new(edge_b[i + 1].x + b_offset.x, edge_b[i + 1].y + b_offset.y);

            if (almost_equal(a1.x, a2.x, None) && almost_equal(a1.y, a2.y, None))
                || (almost_equal(b1.x, b2.x, None) && almost_equal(b1.y, b2.y, None))
            {
                continue;
            }

            if let Some(d) = segment_distance(a1, a2, b1, b2, dir) {
                if distance.is_none_or(|dist| d < dist) && (!ignore_negative || d > 0.0 || almost_equal(d, 0.0, None))
                {
                    distance = Some(d);
                }
            }
        }
    }

    distance
}

/// Port of `polygonProjectionDistance`.
pub fn polygon_projection_distance(
    a: &[Point],
    a_offset: Point,
    b: &[Point],
    b_offset: Point,
    direction: Point,
) -> Option<f64> {
    let edge_a = close_loop(a);
    let edge_b = close_loop(b);

    let mut distance: Option<f64> = None;

    for i in 0..edge_b.len() {
        let mut minprojection: Option<f64> = None;
        for j in 0..edge_a.len().saturating_sub(1) {
            let p = Point::new(edge_b[i].x + b_offset.x, edge_b[i].y + b_offset.y);
            let s1 = Point::new(edge_a[j].x + a_offset.x, edge_a[j].y + a_offset.y);
            let s2 = Point::new(edge_a[j + 1].x + a_offset.x, edge_a[j + 1].y + a_offset.y);

            if ((s2.y - s1.y) * direction.x - (s2.x - s1.x) * direction.y).abs() < TOL {
                continue;
            }

            if let Some(d) = point_distance(p, s1, s2, direction, false) {
                if minprojection.is_none_or(|mp| d < mp) {
                    minprojection = Some(d);
                }
            }
        }
        if let Some(mp) = minprojection {
            if distance.is_none_or(|dist| mp > dist) {
                distance = Some(mp);
            }
        }
    }

    distance
}

fn in_nfp(p: Point, nfp: Option<&[Vec<Point>]>) -> bool {
    let Some(nfp) = nfp else { return false };
    for poly in nfp {
        for q in poly {
            if almost_equal(p.x, q.x, None) && almost_equal(p.y, q.y, None) {
                return true;
            }
        }
    }
    false
}

/// Port of `searchStartPoint`. Mutates `a`'s `marked` flags in place (the
/// same persistence-across-calls behavior the JS relies on via shared point
/// object references) to avoid retrying an already-searched start vertex.
pub fn search_start_point(
    a: &mut [Point],
    b: &[Point],
    inside: bool,
    nfp: Option<&[Vec<Point>]>,
) -> Option<Point> {
    let n = a.len();
    if n == 0 {
        return None;
    }
    let a_closed = close_loop(a);
    let b_closed = close_loop(b);
    let zero = Point::new(0.0, 0.0);

    for i in 0..n {
        if a[i].marked {
            continue;
        }
        a[i].marked = true;

        for j in 0..b.len() {
            let mut offset = Point::new(a[i].x - b[j].x, a[i].y - b[j].y);

            let mut binside: Option<bool> = None;
            for k in 0..b.len() {
                let test = Point::new(b[k].x + offset.x, b[k].y + offset.y);
                if let Some(inpoly) = point_in_polygon(test, a, zero, None) {
                    binside = Some(inpoly);
                    break;
                }
            }

            let Some(binside_val) = binside else {
                return None; // A and B are the same
            };

            let start_point = offset;
            if ((binside_val && inside) || (!binside_val && !inside))
                && !intersect(&a_closed, zero, &b_closed, offset)
                && !in_nfp(start_point, nfp)
            {
                return Some(start_point);
            }

            // slide B along the vector from A[i] to A[i+1]
            let next = (i + 1) % n;
            let (vx0, vy0) = (a[next].x - a[i].x, a[next].y - a[i].y);

            let d1 = polygon_projection_distance(a, zero, b, offset, Point::new(vx0, vy0));
            let d2 = polygon_projection_distance(b, offset, a, zero, Point::new(-vx0, -vy0));

            let d = match (d1, d2) {
                (None, None) => None,
                (Some(d1), None) => Some(d1),
                (None, Some(d2)) => Some(d2),
                (Some(d1), Some(d2)) => Some(d1.min(d2)),
            };

            let Some(d) = d else { continue };
            if almost_equal(d, 0.0, None) || d <= 0.0 {
                continue;
            }

            let (mut vx, mut vy) = (vx0, vy0);
            let vd2 = vx * vx + vy * vy;
            if d * d < vd2 && !almost_equal(d * d, vd2, None) {
                let vd = vx.hypot(vy);
                vx *= d / vd;
                vy *= d / vd;
            }

            offset.x += vx;
            offset.y += vy;

            let mut binside2: Option<bool> = None;
            for k in 0..b.len() {
                let test = Point::new(b[k].x + offset.x, b[k].y + offset.y);
                if let Some(inpoly) = point_in_polygon(test, a, zero, None) {
                    binside2 = Some(inpoly);
                    break;
                }
            }
            let binside_val2 = binside2.unwrap_or(binside_val);

            let start_point = offset;
            if ((binside_val2 && inside) || (!binside_val2 && !inside))
                && !intersect(&a_closed, zero, &b_closed, offset)
                && !in_nfp(start_point, nfp)
            {
                return Some(start_point);
            }
        }
    }

    None
}

/// Port of `noFitPolygonRectangle`: the interior-NFP fast path for the
/// special case where A is a rectangle.
pub fn no_fit_polygon_rectangle(a: &[Point], b: &[Point]) -> Option<Vec<Vec<Point>>> {
    let (mut min_ax, mut min_ay, mut max_ax, mut max_ay) = (a[0].x, a[0].y, a[0].x, a[0].y);
    for p in &a[1..] {
        if p.x < min_ax {
            min_ax = p.x;
        }
        if p.y < min_ay {
            min_ay = p.y;
        }
        if p.x > max_ax {
            max_ax = p.x;
        }
        if p.y > max_ay {
            max_ay = p.y;
        }
    }

    let (mut min_bx, mut min_by, mut max_bx, mut max_by) = (b[0].x, b[0].y, b[0].x, b[0].y);
    for p in &b[1..] {
        if p.x < min_bx {
            min_bx = p.x;
        }
        if p.y < min_by {
            min_by = p.y;
        }
        if p.x > max_bx {
            max_bx = p.x;
        }
        if p.y > max_by {
            max_by = p.y;
        }
    }

    if max_bx - min_bx > max_ax - min_ax {
        return None;
    }
    if max_by - min_by > max_ay - min_ay {
        return None;
    }

    Some(vec![vec![
        Point::new(min_ax - min_bx + b[0].x, min_ay - min_by + b[0].y),
        Point::new(max_ax - max_bx + b[0].x, min_ay - min_by + b[0].y),
        Point::new(max_ax - max_bx + b[0].x, max_ay - max_by + b[0].y),
        Point::new(min_ax - min_bx + b[0].x, max_ay - max_by + b[0].y),
    ]])
}

#[derive(Clone, Copy)]
enum VertexRef {
    A(usize),
    B(usize),
}

struct NfpVector {
    x: f64,
    y: f64,
    start: VertexRef,
    end: VertexRef,
}

fn mark_vertex(a: &mut [Point], b: &mut [Point], vref: VertexRef) {
    match vref {
        VertexRef::A(i) => a[i].marked = true,
        VertexRef::B(i) => b[i].marked = true,
    }
}

struct Touch {
    kind: u8,
    a_idx: usize,
    b_idx: usize,
}

/// Port of `noFitPolygon`: orbits B about (static) A to compute the NFP. If
/// `inside` is set, B orbits inside A instead of outside. If `search_edges`
/// is set, all edges of A are explored, producing multiple NFP loops.
/// Returns `None` only for invalid input (fewer than 3 vertices); otherwise
/// always returns a list (possibly empty).
pub fn no_fit_polygon(
    a: &mut [Point],
    b: &mut [Point],
    inside: bool,
    search_edges: bool,
) -> Option<Vec<Vec<Point>>> {
    if a.len() < 3 || b.len() < 3 {
        return None;
    }

    let mut min_a = a[0].y;
    let mut min_a_index = 0;
    let mut max_b = b[0].y;
    let mut max_b_index = 0;

    for i in 1..a.len() {
        a[i].marked = false;
        if a[i].y < min_a {
            min_a = a[i].y;
            min_a_index = i;
        }
    }
    for i in 1..b.len() {
        b[i].marked = false;
        if b[i].y > max_b {
            max_b = b[i].y;
            max_b_index = i;
        }
    }

    let mut startpoint = if !inside {
        Some(Point::new(
            a[min_a_index].x - b[max_b_index].x,
            a[min_a_index].y - b[max_b_index].y,
        ))
    } else {
        search_start_point(a, b, true, None)
    };

    let mut nfp_list: Vec<Vec<Point>> = Vec::new();
    let zero = Point::new(0.0, 0.0);

    while let Some(sp) = startpoint {
        let mut b_offset = sp;

        let mut nfp: Option<Vec<Point>> = Some(vec![Point::new(b[0].x + b_offset.x, b[0].y + b_offset.y)]);

        let mut prevvector: Option<Point> = None;
        let mut referencex = b[0].x + b_offset.x;
        let mut referencey = b[0].y + b_offset.y;
        let startx = referencex;
        let starty = referencey;
        let mut counter = 0usize;
        let limit = 10 * (a.len() + b.len());

        while counter < limit {
            let mut touching: Vec<Touch> = Vec::new();

            for i in 0..a.len() {
                let nexti = if i == a.len() - 1 { 0 } else { i + 1 };
                for j in 0..b.len() {
                    let nextj = if j == b.len() - 1 { 0 } else { j + 1 };
                    let bj = Point::new(b[j].x + b_offset.x, b[j].y + b_offset.y);
                    if almost_equal(a[i].x, bj.x, None) && almost_equal(a[i].y, bj.y, None) {
                        touching.push(Touch { kind: 0, a_idx: i, b_idx: j });
                    } else if on_segment(a[i], a[nexti], bj, None) {
                        touching.push(Touch { kind: 1, a_idx: nexti, b_idx: j });
                    } else {
                        let bnextj = Point::new(b[nextj].x + b_offset.x, b[nextj].y + b_offset.y);
                        if on_segment(bj, bnextj, a[i], None) {
                            touching.push(Touch { kind: 2, a_idx: i, b_idx: nextj });
                        }
                    }
                }
            }

            let mut vectors: Vec<NfpVector> = Vec::new();

            for t in &touching {
                a[t.a_idx].marked = true;

                let prev_a_index = if t.a_idx == 0 { a.len() - 1 } else { t.a_idx - 1 };
                let next_a_index = if t.a_idx + 1 >= a.len() { 0 } else { t.a_idx + 1 };
                let vertex_a = a[t.a_idx];
                let prev_a = a[prev_a_index];
                let next_a = a[next_a_index];

                let prev_b_index = if t.b_idx == 0 { b.len() - 1 } else { t.b_idx - 1 };
                let next_b_index = if t.b_idx + 1 >= b.len() { 0 } else { t.b_idx + 1 };
                let vertex_b = b[t.b_idx];
                let prev_b = b[prev_b_index];

                match t.kind {
                    0 => {
                        vectors.push(NfpVector {
                            x: prev_a.x - vertex_a.x,
                            y: prev_a.y - vertex_a.y,
                            start: VertexRef::A(t.a_idx),
                            end: VertexRef::A(prev_a_index),
                        });
                        vectors.push(NfpVector {
                            x: next_a.x - vertex_a.x,
                            y: next_a.y - vertex_a.y,
                            start: VertexRef::A(t.a_idx),
                            end: VertexRef::A(next_a_index),
                        });
                        vectors.push(NfpVector {
                            x: vertex_b.x - prev_b.x,
                            y: vertex_b.y - prev_b.y,
                            start: VertexRef::B(prev_b_index),
                            end: VertexRef::B(t.b_idx),
                        });
                        let next_b = b[next_b_index];
                        vectors.push(NfpVector {
                            x: vertex_b.x - next_b.x,
                            y: vertex_b.y - next_b.y,
                            start: VertexRef::B(next_b_index),
                            end: VertexRef::B(t.b_idx),
                        });
                    }
                    1 => {
                        vectors.push(NfpVector {
                            x: vertex_a.x - (vertex_b.x + b_offset.x),
                            y: vertex_a.y - (vertex_b.y + b_offset.y),
                            start: VertexRef::A(prev_a_index),
                            end: VertexRef::A(t.a_idx),
                        });
                        vectors.push(NfpVector {
                            x: prev_a.x - (vertex_b.x + b_offset.x),
                            y: prev_a.y - (vertex_b.y + b_offset.y),
                            start: VertexRef::A(t.a_idx),
                            end: VertexRef::A(prev_a_index),
                        });
                    }
                    _ => {
                        vectors.push(NfpVector {
                            x: vertex_a.x - (vertex_b.x + b_offset.x),
                            y: vertex_a.y - (vertex_b.y + b_offset.y),
                            start: VertexRef::B(prev_b_index),
                            end: VertexRef::B(t.b_idx),
                        });
                        vectors.push(NfpVector {
                            x: vertex_a.x - (prev_b.x + b_offset.x),
                            y: vertex_a.y - (prev_b.y + b_offset.y),
                            start: VertexRef::B(t.b_idx),
                            end: VertexRef::B(prev_b_index),
                        });
                    }
                }
            }

            let mut translate_idx: Option<usize> = None;
            let mut maxd = 0.0;

            for (vi, v) in vectors.iter().enumerate() {
                if v.x == 0.0 && v.y == 0.0 {
                    continue;
                }

                if let Some(pv) = prevvector {
                    if v.y * pv.y + v.x * pv.x < 0.0 {
                        let vectorlength = v.x.hypot(v.y);
                        let unitv = Point::new(v.x / vectorlength, v.y / vectorlength);
                        let prevlength = pv.x.hypot(pv.y);
                        let prevunit = Point::new(pv.x / prevlength, pv.y / prevlength);
                        if (unitv.y * prevunit.x - unitv.x * prevunit.y).abs() < 0.0001 {
                            continue;
                        }
                    }
                }

                let direction = Point::new(v.x, v.y);
                let mut d = polygon_slide_distance(a, zero, b, b_offset, direction, true);
                let vecd2 = v.x * v.x + v.y * v.y;

                if d.is_none_or(|dv| dv * dv > vecd2) {
                    d = Some(v.x.hypot(v.y));
                }

                if let Some(dv) = d {
                    if dv > maxd {
                        maxd = dv;
                        translate_idx = Some(vi);
                    }
                }
            }

            let Some(ti) = translate_idx else {
                nfp = None;
                break;
            };
            if almost_equal(maxd, 0.0, None) {
                nfp = None;
                break;
            }

            let (start_ref, end_ref) = (vectors[ti].start, vectors[ti].end);
            mark_vertex(a, b, start_ref);
            mark_vertex(a, b, end_ref);

            let mut translate = Point::new(vectors[ti].x, vectors[ti].y);
            prevvector = Some(translate);

            let vlength2 = translate.x * translate.x + translate.y * translate.y;
            if maxd * maxd < vlength2 && !almost_equal(maxd * maxd, vlength2, None) {
                let scale = (maxd * maxd / vlength2).sqrt();
                translate.x *= scale;
                translate.y *= scale;
            }

            referencex += translate.x;
            referencey += translate.y;

            if almost_equal(referencex, startx, None) && almost_equal(referencey, starty, None) {
                break; // full loop
            }

            let mut looped = false;
            if let Some(nfp_vec) = &nfp {
                if !nfp_vec.is_empty() {
                    for p in &nfp_vec[..nfp_vec.len() - 1] {
                        if almost_equal(referencex, p.x, None) && almost_equal(referencey, p.y, None) {
                            looped = true;
                        }
                    }
                }
            }
            if looped {
                break;
            }

            if let Some(nfp_vec) = &mut nfp {
                nfp_vec.push(Point::new(referencex, referencey));
            }

            b_offset.x += translate.x;
            b_offset.y += translate.y;

            counter += 1;
        }

        if let Some(nfp_vec) = nfp {
            if !nfp_vec.is_empty() {
                nfp_list.push(nfp_vec);
            }
        }

        if !search_edges {
            break;
        }

        startpoint = search_start_point(a, b, inside, Some(&nfp_list));
    }

    Some(nfp_list)
}

/// Port of `polygonHull`: given two polygons that touch at at least one
/// point but do not overlap, returns the outer perimeter of both as a single
/// continuous polygon (used for hole-fitting two already-touching parts).
/// A and B must have the same winding direction.
pub fn polygon_hull(a_in: &[Point], a_offset_in: Point, b_in: &[Point], b_offset_in: Point) -> Option<Vec<Point>> {
    if a_in.len() < 3 || b_in.len() < 3 {
        return None;
    }

    let mut miny = a_in[0].y + a_offset_in.y;
    let mut start_is_b = false;
    let mut start_index = 0usize;

    for i in 0..a_in.len() {
        let y = a_in[i].y + a_offset_in.y;
        if y < miny {
            miny = y;
            start_is_b = false;
            start_index = i;
        }
    }
    for i in 0..b_in.len() {
        let y = b_in[i].y + b_offset_in.y;
        if y < miny {
            miny = y;
            start_is_b = true;
            start_index = i;
        }
    }

    // for simplicity, A is always treated as the starting polygon
    let (a, a_offset, b, b_offset): (Vec<Point>, Point, Vec<Point>, Point) = if start_is_b {
        (b_in.to_vec(), b_offset_in, a_in.to_vec(), a_offset_in)
    } else {
        (a_in.to_vec(), a_offset_in, b_in.to_vec(), b_offset_in)
    };

    let mut c: Vec<Point> = Vec::new();
    let mut intercept1: Option<usize> = None;
    let mut intercept2: Option<usize> = None;

    // scan forward from the starting point
    let mut current = start_index;
    for _ in 0..a.len() + 1 {
        if current == a.len() {
            current = 0;
        }
        let next = if current == a.len() - 1 { 0 } else { current + 1 };
        let mut touching = false;

        for j in 0..b.len() {
            let nextj = if j == b.len() - 1 { 0 } else { j + 1 };
            let ac = Point::new(a[current].x + a_offset.x, a[current].y + a_offset.y);
            let an = Point::new(a[next].x + a_offset.x, a[next].y + a_offset.y);
            let bj = Point::new(b[j].x + b_offset.x, b[j].y + b_offset.y);
            let bn = Point::new(b[nextj].x + b_offset.x, b[nextj].y + b_offset.y);

            if almost_equal(ac.x, bj.x, None) && almost_equal(ac.y, bj.y, None) {
                c.push(ac);
                intercept1 = Some(j);
                touching = true;
                break;
            } else if on_segment(ac, an, bj, None) {
                c.push(ac);
                c.push(bj);
                intercept1 = Some(j);
                touching = true;
                break;
            } else if on_segment(bj, bn, ac, None) {
                c.push(ac);
                c.push(bn);
                intercept1 = Some(nextj);
                touching = true;
                break;
            }
        }

        if touching {
            break;
        }
        c.push(Point::new(a[current].x + a_offset.x, a[current].y + a_offset.y));
        current += 1;
    }

    // scan backward from the starting point
    let mut current_i: i64 = start_index as i64 - 1;
    for _ in 0..a.len() + 1 {
        if current_i < 0 {
            current_i = a.len() as i64 - 1;
        }
        let current = current_i as usize;
        let next = if current == 0 { a.len() - 1 } else { current - 1 };
        let mut touching = false;

        for j in 0..b.len() {
            let nextj = if j == b.len() - 1 { 0 } else { j + 1 };
            let ac = Point::new(a[current].x + a_offset.x, a[current].y + a_offset.y);
            let an = Point::new(a[next].x + a_offset.x, a[next].y + a_offset.y);
            let bj = Point::new(b[j].x + b_offset.x, b[j].y + b_offset.y);
            let bn = Point::new(b[nextj].x + b_offset.x, b[nextj].y + b_offset.y);

            // NB: preserves the original's asymmetry - this y-comparison is
            // missing `+ a_offset.y` on the A side, unlike the forward scan above.
            if almost_equal(ac.x, bj.x, None) && almost_equal(a[current].y, bj.y, None) {
                c.insert(0, ac);
                intercept2 = Some(j);
                touching = true;
                break;
            } else if on_segment(ac, an, bj, None) {
                c.insert(0, bj);
                c.insert(0, ac);
                intercept2 = Some(j);
                touching = true;
                break;
            } else if on_segment(bj, bn, ac, None) {
                c.insert(0, ac);
                intercept2 = Some(j);
                touching = true;
                break;
            }
        }

        if touching {
            break;
        }
        c.insert(0, Point::new(a[current].x + a_offset.x, a[current].y + a_offset.y));
        current_i -= 1;
    }

    let (Some(intercept1), Some(intercept2)) = (intercept1, intercept2) else {
        return None;
    };

    // the relevant points on B now lie between intercept1 and intercept2
    let mut current = intercept1 + 1;
    for _ in 0..b.len() {
        if current == b.len() {
            current = 0;
        }
        c.push(Point::new(b[current].x + b_offset.x, b[current].y + b_offset.y));
        if current == intercept2 {
            break;
        }
        current += 1;
    }

    // dedupe adjacent (wrapping) points
    let mut i = 0;
    while i < c.len() {
        let next = if i == c.len() - 1 { 0 } else { i + 1 };
        if almost_equal(c[i].x, c[next].x, None) && almost_equal(c[i].y, c[next].y, None) {
            c.remove(i);
            // stay at the same index - the removal shifted the next element into position i
        } else {
            i += 1;
        }
    }

    Some(c)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polygon_hull_returns_none_on_degenerate_input() {
        assert!(polygon_hull(
            &[Point::new(0.0, 0.0)],
            Point::new(0.0, 0.0),
            &[Point::new(1.0, 1.0)],
            Point::new(0.0, 0.0)
        )
        .is_none());
    }

    #[test]
    fn polygon_hull_returns_none_for_polygons_that_dont_touch() {
        let a = [Point::new(0.0, 0.0), Point::new(2.0, 0.0), Point::new(1.0, 2.0)];
        let b = [Point::new(10.0, 0.0), Point::new(12.0, 0.0), Point::new(11.0, 2.0)];
        let zero = Point::new(0.0, 0.0);
        assert!(polygon_hull(&a, zero, &b, zero).is_none());
    }

    #[test]
    fn polygon_hull_merges_two_triangles_sharing_a_vertex() {
        let a = [Point::new(0.0, 0.0), Point::new(2.0, 0.0), Point::new(1.0, 2.0)];
        let b = [Point::new(2.0, 0.0), Point::new(4.0, 0.0), Point::new(3.0, 2.0)];
        let zero = Point::new(0.0, 0.0);
        let hull = polygon_hull(&a, zero, &b, zero).expect("hull should exist");

        let bounds = crate::polygon::get_polygon_bounds(&hull).expect("hull has bounds");
        for p in a.iter().chain(b.iter()) {
            assert!(p.x >= bounds.x - 1e-6);
            assert!(p.x <= bounds.x + bounds.width + 1e-6);
        }
    }

    #[test]
    fn no_fit_polygon_rectangle_interior_fit() {
        // A 10x10 square container, B a 4x4 square part
        let a = [
            Point::new(0.0, 0.0),
            Point::new(10.0, 0.0),
            Point::new(10.0, 10.0),
            Point::new(0.0, 10.0),
        ];
        let b = [
            Point::new(0.0, 0.0),
            Point::new(4.0, 0.0),
            Point::new(4.0, 4.0),
            Point::new(0.0, 4.0),
        ];
        let nfp = no_fit_polygon_rectangle(&a, &b).expect("B fits inside A");
        assert_eq!(nfp.len(), 1);
        // the valid placement region for B's reference point is a 6x6 square
        let bounds = crate::polygon::get_polygon_bounds(&nfp[0]).unwrap();
        assert!((bounds.width - 6.0).abs() < 1e-9);
        assert!((bounds.height - 6.0).abs() < 1e-9);
    }

    #[test]
    fn no_fit_polygon_rectangle_returns_none_when_b_too_big() {
        let a = [
            Point::new(0.0, 0.0),
            Point::new(10.0, 0.0),
            Point::new(10.0, 10.0),
            Point::new(0.0, 10.0),
        ];
        let b = [
            Point::new(0.0, 0.0),
            Point::new(20.0, 0.0),
            Point::new(20.0, 20.0),
            Point::new(0.0, 20.0),
        ];
        assert!(no_fit_polygon_rectangle(&a, &b).is_none());
    }

    #[test]
    fn no_fit_polygon_outer_orbit_of_two_squares_is_closed() {
        // Outer NFP of two unit-ish squares: B (2x2) orbiting outside A (4x4)
        // should trace a closed loop back to (approximately) its own start.
        let mut a = vec![
            Point::new(0.0, 0.0),
            Point::new(4.0, 0.0),
            Point::new(4.0, 4.0),
            Point::new(0.0, 4.0),
        ];
        let mut b = vec![
            Point::new(0.0, 0.0),
            Point::new(2.0, 0.0),
            Point::new(2.0, 2.0),
            Point::new(0.0, 2.0),
        ];
        let nfp = no_fit_polygon(&mut a, &mut b, false, false).expect("valid input");
        assert_eq!(nfp.len(), 1);
        assert!(nfp[0].len() >= 4);
    }
}
