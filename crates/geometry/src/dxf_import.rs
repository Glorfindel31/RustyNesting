//! DXF entity -> polygon-tree conversion (replaces SVG import per the scope
//! change recorded in docs/PORT_STATUS.md). Does the same shape of work
//! `svgparser.js` did for SVG - closed-profile detection, parent/hole
//! containment nesting, `.isCircle` metadata for the circular-hole NFP fast
//! path (see circular_nfp.rs) - just against DXF entities instead of an SVG
//! DOM, via the `dxf` crate.
//!
//! Currently supported: `LWPOLYLINE` (closed, including bulge/arc segments),
//! `CIRCLE`, and full-sweep `ARC` (treated as a circle, same as SVG's
//! isCircle handling for a `<circle>`-equivalent full arc). Bare `LINE`/
//! partial-`ARC` networks that only form a closed profile once their
//! endpoints are chained together are **not** supported yet - that needs a
//! separate edge-graph-joining algorithm and is tracked as a follow-up in
//! docs/PORT_STATUS.md rather than attempted half-correct here. The older
//! heavyweight `POLYLINE` entity (pre-LWPOLYLINE, vertices as separate linked
//! entities) is also not yet supported.

use dxf::entities::{Entity, EntityType};

use crate::circular_nfp::Circle;
use crate::point::Point;
use crate::polygon::{get_polygon_bounds, point_in_polygon, polygon_area, Bounds};

/// A closed profile extracted from one or more DXF entities, tagged with its
/// source layer and (for holes) nested children. Mirrors the `.children` /
/// `.isCircle` shape `svgparser.js` produced for SVG polygons.
#[derive(Clone, Debug)]
pub struct LayeredPolygon {
    pub points: Vec<Point>,
    pub layer: String,
    pub is_circle: Option<Circle>,
    pub children: Vec<LayeredPolygon>,
}

impl LayeredPolygon {
    fn new(points: Vec<Point>, layer: String, is_circle: Option<Circle>) -> Self {
        LayeredPolygon {
            points,
            layer,
            is_circle,
            children: Vec::new(),
        }
    }
}

/// Minimum angular step per tessellated arc segment, regardless of how loose
/// `curve_tolerance` is - keeps degenerate/huge-tolerance inputs from
/// collapsing an arc to a single chord.
const MIN_ARC_SEGMENTS: u32 = 2;
/// Upper bound on tessellation segments for one arc/circle, so a tiny
/// `curve_tolerance` on a huge-radius circle can't runaway-allocate.
const MAX_ARC_SEGMENTS: u32 = 720;

/// The max angular step (radians) that keeps the chord-to-arc sagitta error
/// within `tolerance` for the given `radius` (basic circular chord-error
/// bound: error ~= r*(1 - cos(dtheta/2))).
fn arc_step_angle(radius: f64, tolerance: f64) -> f64 {
    let r = radius.abs().max(1e-9);
    let ratio = (1.0 - (tolerance / r)).clamp(-1.0, 1.0);
    (2.0 * ratio.acos()).max(0.001)
}

fn segment_count(total_angle: f64, radius: f64, tolerance: f64) -> u32 {
    let step = arc_step_angle(radius, tolerance);
    let n = (total_angle.abs() / step).ceil() as u32;
    n.clamp(MIN_ARC_SEGMENTS, MAX_ARC_SEGMENTS)
}

/// Tessellates a full circle into a closed polygon, starting at angle 0
/// (matching the plan's "circle tessellation always starts on the boundary"
/// invariant that `circular_nfp`'s fast path depends on).
fn tessellate_circle(cx: f64, cy: f64, r: f64, tolerance: f64) -> Vec<Point> {
    let n = segment_count(2.0 * std::f64::consts::PI, r, tolerance);
    (0..n)
        .map(|i| {
            let theta = 2.0 * std::f64::consts::PI * (i as f64) / (n as f64);
            Point::new(cx + r * theta.cos(), cy + r * theta.sin())
        })
        .collect()
}

/// Converts a DXF LWPOLYLINE bulge segment (from `p0` to `p1`) into the
/// intermediate points of its arc, excluding both endpoints (the caller
/// already has them). `bulge` is `tan(included_angle / 4)`; positive = CCW,
/// negative = CW, by DXF convention.
fn tessellate_bulge(p0: Point, p1: Point, bulge: f64, tolerance: f64) -> Vec<Point> {
    if bulge == 0.0 {
        return Vec::new();
    }

    let dx = p1.x - p0.x;
    let dy = p1.y - p0.y;
    let chord = dx.hypot(dy);
    if chord < 1e-12 {
        return Vec::new();
    }

    let theta = 4.0 * bulge.atan(); // signed included angle
    let sagitta = bulge * chord / 2.0; // exact identity: sagitta = tan(theta/4) * chord/2
    let radius = (sagitta * sagitta + (chord / 2.0) * (chord / 2.0)) / (2.0 * sagitta);

    let ux = dx / chord;
    let uy = dy / chord;
    let nx = -uy; // perpendicular, 90 deg CCW from chord direction
    let ny = ux;

    let mx = (p0.x + p1.x) / 2.0;
    let my = (p0.y + p1.y) / 2.0;
    let cx = mx + nx * (sagitta - radius);
    let cy = my + ny * (sagitta - radius);

    let start_angle = (p0.y - cy).atan2(p0.x - cx);
    let n = segment_count(theta, radius, tolerance);

    (1..n)
        .map(|i| {
            let a = start_angle + theta * (i as f64) / (n as f64);
            Point::new(cx + radius.abs() * a.cos(), cy + radius.abs() * a.sin())
        })
        .collect()
}

fn lwpolyline_to_points(poly: &dxf::entities::LwPolyline, tolerance: f64) -> Vec<Point> {
    let verts = &poly.vertices;
    let mut points = Vec::with_capacity(verts.len());
    let n = verts.len();

    for i in 0..n {
        let p0 = Point::new(verts[i].x, verts[i].y);
        points.push(p0);

        // only emit the arc between this vertex and the next if there IS a
        // next vertex to connect to (the last vertex only connects onward
        // when the polyline is closed, wrapping back to vertex 0)
        let has_next = i + 1 < n || poly.is_closed();
        if has_next && verts[i].bulge != 0.0 {
            let next = &verts[if i + 1 < n { i + 1 } else { 0 }];
            let p1 = Point::new(next.x, next.y);
            points.extend(tessellate_bulge(p0, p1, verts[i].bulge, tolerance));
        }
    }

    points
}

/// True if an ARC's angular sweep is a full circle (some DXF exporters
/// represent circles as a 0-360 degree ARC rather than a CIRCLE entity).
fn arc_is_full_circle(arc: &dxf::entities::Arc) -> bool {
    let sweep = (arc.end_angle - arc.start_angle).rem_euclid(360.0);
    sweep < 1e-6 || (360.0 - sweep) < 1e-6
}

/// Converts one DXF entity into a closed profile, if it represents one.
/// Returns `None` for entity types that aren't (yet) supported, or that
/// aren't closed (e.g. an open LWPOLYLINE or a partial ARC) - see the module
/// doc comment for what's deliberately not handled yet.
pub fn entity_to_polygon(entity: &Entity, curve_tolerance: f64) -> Option<LayeredPolygon> {
    let layer = entity.common.layer.clone();

    match &entity.specific {
        EntityType::LwPolyline(poly) if poly.is_closed() => {
            let points = lwpolyline_to_points(poly, curve_tolerance);
            if points.len() < 3 {
                return None;
            }
            Some(LayeredPolygon::new(points, layer, None))
        }
        EntityType::Circle(circle) => {
            let points = tessellate_circle(circle.center.x, circle.center.y, circle.radius, curve_tolerance);
            let meta = Circle {
                cx: circle.center.x,
                cy: circle.center.y,
                r: circle.radius,
            };
            Some(LayeredPolygon::new(points, layer, Some(meta)))
        }
        EntityType::Arc(arc) if arc_is_full_circle(arc) => {
            let points = tessellate_circle(arc.center.x, arc.center.y, arc.radius, curve_tolerance);
            let meta = Circle {
                cx: arc.center.x,
                cy: arc.center.y,
                r: arc.radius,
            };
            Some(LayeredPolygon::new(points, layer, Some(meta)))
        }
        _ => None,
    }
}

/// Converts every closed-profile-capable entity in `entities` into a flat
/// list of `LayeredPolygon`s (no parent/hole nesting yet - see
/// `build_polygon_tree`).
pub fn entities_to_polygons<'a>(
    entities: impl Iterator<Item = &'a Entity>,
    curve_tolerance: f64,
) -> Vec<LayeredPolygon> {
    entities
        .filter_map(|e| entity_to_polygon(e, curve_tolerance))
        .collect()
}

/// True if `candidate`'s first point lies inside `container` (containment
/// test used to build the parent/hole tree - matches the "point-in-polygon"
/// approach `svgparser.js` used for SVG parent/hole detection).
fn contains(container: &[Point], candidate: &[Point]) -> bool {
    let zero = Point::new(0.0, 0.0);
    point_in_polygon(candidate[0], container, zero, None) == Some(true)
}

fn area_of(points: &[Point]) -> f64 {
    polygon_area(points).abs()
}

/// Finds the tightest (smallest-area) node in `nodes` (searched depth-first)
/// that contains `poly`, returning the path of child indices from `nodes`
/// down to it. `nodes` must already be free of any polygon smaller than
/// `poly` (see `build_polygon_tree`'s largest-to-smallest insertion order),
/// so "deepest match" is also "tightest match." Returns indices rather than
/// a reference so the caller can do a single mutable descent afterward -
/// recursing on `&mut` with a "try deeper, else use this node" fallback hits
/// a real borrow-checker limitation (the recursive call's lifetime pins the
/// whole subtree even on the path that doesn't use it).
fn find_container_path(nodes: &[LayeredPolygon], poly: &[Point]) -> Vec<usize> {
    match nodes.iter().position(|n| contains(&n.points, poly)) {
        Some(idx) => {
            let mut path = vec![idx];
            path.extend(find_container_path(&nodes[idx].children, poly));
            path
        }
        None => Vec::new(),
    }
}

fn get_mut_by_path<'a>(nodes: &'a mut [LayeredPolygon], path: &[usize]) -> &'a mut LayeredPolygon {
    let (&first, rest) = path.split_first().expect("path must be non-empty");
    let node = &mut nodes[first];
    if rest.is_empty() {
        node
    } else {
        get_mut_by_path(&mut node.children, rest)
    }
}

/// Builds the parent/hole tree for a flat set of closed profiles via
/// containment (mirrors `svgparser.js`'s parent/hole detection). Polygons
/// are nested arbitrarily deep - a hole containing a smaller "island" shape
/// becomes that island's parent, same as nested SVG paths.
pub fn build_polygon_tree(mut flat: Vec<LayeredPolygon>) -> Vec<LayeredPolygon> {
    // largest-area first, so every already-placed node is a valid (non-too-small) candidate parent
    flat.sort_by(|a, b| area_of(&b.points).partial_cmp(&area_of(&a.points)).unwrap());

    let mut roots: Vec<LayeredPolygon> = Vec::new();
    for poly in flat {
        let path = find_container_path(&roots, &poly.points);
        if path.is_empty() {
            roots.push(poly);
        } else {
            get_mut_by_path(&mut roots, &path).children.push(poly);
        }
    }
    roots
}

/// Port of the plan's "oversized-part bbox check": true if `part`'s bounds
/// don't fit within `sheet_bounds` in either dimension (part can never be
/// placed on this sheet in any rotation-free orientation).
pub fn is_oversized(part: &[Point], sheet_bounds: Bounds) -> bool {
    match get_polygon_bounds(part) {
        Some(b) => b.width > sheet_bounds.width || b.height > sheet_bounds.height,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dxf::entities::{Arc, Circle as DxfCircle, EntityCommon, LwPolyline};
    use dxf::{LwPolylineVertex, Point as DxfPoint};

    fn entity(layer: &str, specific: EntityType) -> Entity {
        Entity {
            common: EntityCommon {
                layer: layer.to_string(),
                ..Default::default()
            },
            specific,
        }
    }

    #[test]
    fn circle_entity_tessellates_and_carries_is_circle_metadata() {
        let e = entity(
            "CUT",
            EntityType::Circle(DxfCircle {
                center: DxfPoint::new(5.0, 5.0, 0.0),
                radius: 3.0,
                ..Default::default()
            }),
        );

        let poly = entity_to_polygon(&e, 0.01).expect("circle should convert");
        assert_eq!(poly.layer, "CUT");
        let circle = poly.is_circle.expect("circle metadata expected");
        assert_eq!(circle, Circle { cx: 5.0, cy: 5.0, r: 3.0 });

        let area = polygon_area(&poly.points).abs();
        let expected = std::f64::consts::PI * 3.0 * 3.0;
        // an inscribed polygon under-approximates a circle's area by construction;
        // a tight curve_tolerance (0.01) should keep that error under 1%
        assert!((area - expected).abs() / expected < 0.01);
    }

    #[test]
    fn full_sweep_arc_is_treated_as_a_circle() {
        let e = entity(
            "0",
            EntityType::Arc(Arc {
                center: DxfPoint::new(0.0, 0.0, 0.0),
                radius: 2.0,
                start_angle: 0.0,
                end_angle: 360.0,
                ..Default::default()
            }),
        );

        let poly = entity_to_polygon(&e, 0.1).expect("full-sweep arc should convert");
        assert!(poly.is_circle.is_some());
    }

    #[test]
    fn partial_arc_is_not_a_closed_profile() {
        let e = entity(
            "0",
            EntityType::Arc(Arc {
                center: DxfPoint::new(0.0, 0.0, 0.0),
                radius: 2.0,
                start_angle: 0.0,
                end_angle: 90.0,
                ..Default::default()
            }),
        );
        assert!(entity_to_polygon(&e, 0.1).is_none());
    }

    #[test]
    fn open_lwpolyline_is_not_a_closed_profile() {
        let mut poly = LwPolyline {
            vertices: vec![
                LwPolylineVertex { x: 0.0, y: 0.0, bulge: 0.0, ..Default::default() },
                LwPolylineVertex { x: 10.0, y: 0.0, bulge: 0.0, ..Default::default() },
            ],
            ..Default::default()
        };
        poly.set_is_closed(false);
        let e = entity("0", EntityType::LwPolyline(poly));
        assert!(entity_to_polygon(&e, 0.1).is_none());
    }

    #[test]
    fn closed_rectangular_lwpolyline_converts_with_no_bulge() {
        let mut poly = LwPolyline {
            vertices: vec![
                LwPolylineVertex { x: 0.0, y: 0.0, bulge: 0.0, ..Default::default() },
                LwPolylineVertex { x: 10.0, y: 0.0, bulge: 0.0, ..Default::default() },
                LwPolylineVertex { x: 10.0, y: 5.0, bulge: 0.0, ..Default::default() },
                LwPolylineVertex { x: 0.0, y: 5.0, bulge: 0.0, ..Default::default() },
            ],
            ..Default::default()
        };
        poly.set_is_closed(true);
        let e = entity("PROFILE", EntityType::LwPolyline(poly));

        let converted = entity_to_polygon(&e, 0.1).expect("closed rectangle should convert");
        assert_eq!(converted.layer, "PROFILE");
        assert_eq!(converted.points.len(), 4);
        assert!((polygon_area(&converted.points).abs() - 50.0).abs() < 1e-9);
    }

    #[test]
    fn bulge_segment_tessellates_a_half_circle_with_correct_area_contribution() {
        // A closed "D" shape: straight line from (-1,0) to (1,0), then a bulge=1
        // (180 degree, i.e. semicircular) arc back from (1,0) to (-1,0) - bulge=1
        // means the included angle is 4*atan(1) = 180 degrees exactly.
        let mut poly = LwPolyline {
            vertices: vec![
                LwPolylineVertex { x: -1.0, y: 0.0, bulge: 0.0, ..Default::default() },
                LwPolylineVertex { x: 1.0, y: 0.0, bulge: 1.0, ..Default::default() },
            ],
            ..Default::default()
        };
        poly.set_is_closed(true);
        let e = entity("0", EntityType::LwPolyline(poly));

        let converted = entity_to_polygon(&e, 0.001).expect("D-shape should convert");
        let area = polygon_area(&converted.points).abs();
        // half-disk of radius 1: area = pi/2
        assert!((area - std::f64::consts::FRAC_PI_2).abs() < 0.01, "area was {area}");
    }

    #[test]
    fn build_polygon_tree_nests_a_hole_and_an_island_inside_it() {
        // Outer 20x20 square, a 10x10 hole square inside it, and a 2x2 island inside the hole.
        let outer = LayeredPolygon::new(
            vec![
                Point::new(0.0, 0.0),
                Point::new(20.0, 0.0),
                Point::new(20.0, 20.0),
                Point::new(0.0, 20.0),
            ],
            "CUT".into(),
            None,
        );
        let hole = LayeredPolygon::new(
            vec![
                Point::new(5.0, 5.0),
                Point::new(15.0, 5.0),
                Point::new(15.0, 15.0),
                Point::new(5.0, 15.0),
            ],
            "DRILL".into(),
            None,
        );
        let island = LayeredPolygon::new(
            vec![
                Point::new(9.0, 9.0),
                Point::new(11.0, 9.0),
                Point::new(11.0, 11.0),
                Point::new(9.0, 11.0),
            ],
            "CUT".into(),
            None,
        );

        let tree = build_polygon_tree(vec![island, outer, hole]);

        assert_eq!(tree.len(), 1, "only the outer square should be a root");
        let root = &tree[0];
        assert_eq!(root.children.len(), 1, "hole should nest directly under the outer square");
        let nested_hole = &root.children[0];
        assert_eq!(nested_hole.layer, "DRILL");
        assert_eq!(nested_hole.children.len(), 1, "island should nest under the hole, not the outer square");
        assert_eq!(nested_hole.children[0].layer, "CUT");
    }

    #[test]
    fn is_oversized_flags_a_part_bigger_than_the_sheet() {
        let part = [
            Point::new(0.0, 0.0),
            Point::new(100.0, 0.0),
            Point::new(100.0, 100.0),
            Point::new(0.0, 100.0),
        ];
        let sheet = Bounds { x: 0.0, y: 0.0, width: 50.0, height: 50.0 };
        assert!(is_oversized(&part, sheet));

        let small_sheet_fitting_part = [
            Point::new(0.0, 0.0),
            Point::new(10.0, 0.0),
            Point::new(10.0, 10.0),
            Point::new(0.0, 10.0),
        ];
        assert!(!is_oversized(&small_sheet_fitting_part, sheet));
    }
}
