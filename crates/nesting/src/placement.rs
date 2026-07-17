//! Port of `background.js`'s single-threaded greedy per-sheet placement
//! loop: `placeParts` + `tryPlacePartOnSheet` + the three placement-type
//! scorers. Phase 3's first end-to-end milestone - no GA, no threads (see
//! `RUST-REWRITE-PLAN.md` and `docs/PORT_STATUS.md`'s Phase 3 table).
//!
//! Simplification vs. the original, not a functional change: the JS side
//! converts every polygon to Clipper's own integer coordinate space by hand
//! (`toClipperCoordinates`/`ScaleUpPath`/`toNestCoordinates`) because the old
//! flat `ClipperLib` API needed manually-oriented, pre-scaled paths. Our
//! `geometry::clipper` wrapper (`crates/geometry/src/clipper.rs`) already
//! does that scaling internally per call (`DeepnestScale`, x10^7) and its
//! boolean ops are true set operations that don't require caller-managed
//! winding for correctness (confirmed by `inner_nfp.rs`'s general fallback,
//! which already composes multiple same-side loops this same way) - so this
//! port works directly in plain `Point` coordinates throughout, with no
//! `nfpToClipperCoordinates`/`toNestCoordinates`-equivalent step needed.
//!
//! Deliberately **not** ported here: `config.mergeLines`'s edge-merge fitness
//! bonus (`mergedLength` in the original). It's an optional scoring nicety,
//! not required for the core placement loop or this milestone's
//! one-rectangle-on-one-sheet correctness goal; the `.exact` per-point
//! marking it depends on isn't tracked on `geometry::Point` yet either. Add
//! both together if/when the edge-merge bonus is needed.

use std::collections::HashSet;

use clipper2::FillRule;
use geometry::clipper::{difference_polygons, intersection_polygons, union_polygons};
use geometry::dxf_import::{polygon_material_area, rotate_layered_polygon, shift_layered_polygon, LayeredPolygon};
use geometry::hull_polygon::hull;
use geometry::inner_nfp::inner_nfp;
use geometry::obstacle_nfp::obstacle_nfp;
use geometry::point::Point;
use geometry::polygon::{almost_equal, get_polygon_bounds, polygon_area};

/// `background.js`'s `DEFAULT_DOMINANT_PART_AREA_THRESHOLD`.
pub const DEFAULT_DOMINANT_PART_AREA_THRESHOLD: f64 = 0.9;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlacementType {
    Gravity,
    Box,
    ConvexHull,
}

#[derive(Clone, Debug)]
pub struct PlacementConfig {
    pub placement_type: PlacementType,
    /// Number of rotation angles tried per part before giving up on a sheet
    /// (equal steps of `360/rotations` degrees). See `docs/PORT_STATUS.md`'s
    /// rotation-angle-grid quirk - kept as plain user-facing config here too.
    pub rotations: u32,
    pub dominant_part_area_threshold: f64,
    pub curve_tolerance: f64,
}

/// A part queued for nesting. `polygon`/`rotation` are replaced (not
/// mutated in place) each time a rotation retry fails, mirroring
/// `background.js`'s `parts[i] = r` - the part's current-best-tried rotation
/// carries over between sheets.
#[derive(Clone, Debug)]
pub struct NestPart {
    pub id: usize,
    pub polygon: LayeredPolygon,
    pub rotation: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Placement {
    pub x: f64,
    pub y: f64,
}

/// One part's final resting place on a sheet. `id` is purely the caller's
/// own identity for the part (see `NestPart::id`) - nothing in this module
/// uses it as an internal key, since ids aren't guaranteed unique (quantity
/// > 1 of the same part shares an id, same as the JS original never assumed
/// otherwise either).
#[derive(Clone, Copy, Debug)]
pub struct PlacedPart {
    pub id: usize,
    pub placement: Placement,
    pub rotation: f64,
}

#[derive(Clone, Debug)]
pub struct SheetPlacement {
    pub sheet_index: usize,
    pub parts: Vec<PlacedPart>,
}

#[derive(Clone, Debug)]
pub struct PlaceResult {
    pub placements: Vec<SheetPlacement>,
    pub fitness: f64,
    pub area: f64,
    pub total_area: f64,
    pub utilisation: f64,
    pub unplaced_count: usize,
}

fn shift_points(points: &[Point], dx: f64, dy: f64) -> Vec<Point> {
    points.iter().map(|p| Point::new(p.x + dx, p.y + dy)).collect()
}

fn get_hull_or_fallback(points: &[Point]) -> Vec<Point> {
    hull(points).unwrap_or_else(|| points.to_vec())
}

/// Port of `hasMaterialOverlap`: true if `a` and `b` share any non-zero-area
/// material, after subtracting both polygons' own holes from the overlap.
fn has_material_overlap(a: &LayeredPolygon, b: &LayeredPolygon) -> bool {
    let intersection = match intersection_polygons(std::slice::from_ref(&a.points), std::slice::from_ref(&b.points), FillRule::NonZero) {
        Ok(r) if !r.is_empty() => r,
        _ => return false,
    };

    let mut holes: Vec<Vec<Point>> = a.children.iter().map(|c| c.points.clone()).collect();
    holes.extend(b.children.iter().map(|c| c.points.clone()));

    let intersection = if holes.is_empty() {
        intersection
    } else {
        match difference_polygons(&intersection, &holes, FillRule::NonZero) {
            Ok(r) => r,
            Err(_) => return true,
        }
    };

    intersection.iter().any(|p| polygon_area(p).abs() > 0.0)
}

/// Port of `hasMaterialOutsideSheet`: true if any of `part` falls outside
/// `sheet`'s outer boundary, or overlaps one of the sheet's own holes.
fn has_material_outside_sheet(part: &LayeredPolygon, sheet: &LayeredPolygon) -> bool {
    let outside = match difference_polygons(std::slice::from_ref(&part.points), std::slice::from_ref(&sheet.points), FillRule::NonZero) {
        Ok(r) => r,
        Err(_) => return true,
    };
    if outside.iter().any(|p| polygon_area(p).abs() > 0.0) {
        return true;
    }

    sheet.children.iter().any(|hole| has_material_overlap(part, hole))
}

/// A candidate placement's fitness, shaped by which placement type produced
/// it - the enum (rather than a bare `area: f64, width: Option<f64>` pair)
/// makes "gravity/box candidates always carry a width, convex-hull
/// candidates never do" a compile-time fact instead of a runtime convention
/// `find_best_candidate` would otherwise have to trust its caller to uphold.
enum CandidateScore {
    Gravity { area: f64, width: f64 },
    Box { area: f64, width: f64 },
    ConvexHull { area: f64 },
}

impl CandidateScore {
    fn area(&self) -> f64 {
        match *self {
            CandidateScore::Gravity { area, .. } | CandidateScore::Box { area, .. } | CandidateScore::ConvexHull { area } => area,
        }
    }

    fn width(&self) -> Option<f64> {
        match self {
            CandidateScore::Gravity { width, .. } | CandidateScore::Box { width, .. } => Some(*width),
            CandidateScore::ConvexHull { .. } => None,
        }
    }
}

struct Candidate {
    shiftvector: Placement,
    score: CandidateScore,
}

/// Port of `findBestCandidate`: replays the bar-climbing comparison the
/// scoring loop used, skipping already-`excluded` candidates. Must stay a
/// byte-for-byte match of the original comparison (including the
/// placement-type-independent x tiebreak) for deferred-validation retries to
/// reproduce what an interleaved validate-as-you-go loop would have picked.
fn find_best_candidate(candidates: &[Candidate], excluded: &HashSet<usize>) -> Option<usize> {
    let mut minarea: Option<f64> = None;
    let mut minwidth: Option<f64> = None;
    let mut minx: Option<f64> = None;
    let mut best: Option<usize> = None;

    for (idx, cand) in candidates.iter().enumerate() {
        if excluded.contains(&idx) {
            continue;
        }
        let area = cand.score.area();
        let x = cand.shiftvector.x;

        let take = minarea.is_none()
            || match &cand.score {
                CandidateScore::Gravity { width, .. } => {
                    *width < minwidth.unwrap() || (almost_equal(*width, minwidth.unwrap(), None) && area < minarea.unwrap())
                }
                CandidateScore::Box { .. } | CandidateScore::ConvexHull { .. } => area < minarea.unwrap(),
            }
            || (almost_equal(minarea.unwrap(), area, None) && x < minx.unwrap());

        if take {
            minarea = Some(area);
            minwidth = cand.score.width();
            minx = Some(x);
            best = Some(idx);
        }
    }

    best
}

fn flush_pending_clips(final_nfp: &mut Vec<Vec<Point>>, pending_clips: &mut Vec<Vec<Point>>) -> bool {
    if pending_clips.is_empty() {
        return true;
    }
    match difference_polygons(final_nfp, pending_clips, FillRule::NonZero) {
        Ok(result) => {
            *final_nfp = result;
            pending_clips.clear();
            true
        }
        Err(_) => false,
    }
}

pub struct PlaceOnSheetResult {
    pub position: Placement,
    pub minarea: f64,
    pub minwidth: Option<f64>,
}

/// Port of `tryPlacePartOnSheet`. `place_parts` never calls this for a
/// sheet's first part (that stays the inline top-left-corner fast path,
/// same as the original) but `placed`/`placements` being empty is otherwise
/// handled correctly here - `nesting::consolidation`'s cross-sheet relocation
/// needs that, since a relocation target isn't guaranteed to already have a
/// part on it.
pub fn try_place_part_on_sheet(
    part: &LayeredPolygon,
    sheet_nfp: &[Vec<Point>],
    sheet: &LayeredPolygon,
    placed: &[LayeredPolygon],
    placements: &[Placement],
    config: &PlacementConfig,
) -> Option<PlaceOnSheetResult> {
    let mut final_nfp: Vec<Vec<Point>> = sheet_nfp.to_vec();

    // Obstacles with no holes just subtract from final_nfp - since set
    // difference commutes, consecutive holeless obstacles are batched into
    // one clipper call. Obstacles WITH holes still run one at a time
    // (difference, then union the hole-restore regions back in) so a later
    // obstacle can still cut into an earlier one's restored hole.
    let mut pending_clips: Vec<Vec<Point>> = Vec::new();
    let mut error = false;

    for (obstacle, placement) in placed.iter().zip(placements.iter()) {
        let Some(nfp) = obstacle_nfp(obstacle, part, config.curve_tolerance) else {
            error = true;
            break;
        };
        let outer = shift_points(&nfp.outer, placement.x, placement.y);

        if nfp.children.is_empty() {
            pending_clips.push(outer);
            continue;
        }

        let children: Vec<Vec<Point>> = nfp.children.iter().map(|c| shift_points(c, placement.x, placement.y)).collect();

        if !flush_pending_clips(&mut final_nfp, &mut pending_clips) {
            error = true;
            break;
        }

        let after_diff = match difference_polygons(&final_nfp, std::slice::from_ref(&outer), FillRule::NonZero) {
            Ok(r) => r,
            Err(_) => {
                error = true;
                break;
            }
        };

        final_nfp = match union_polygons(&after_diff, &children, FillRule::NonZero) {
            Ok(r) => r,
            Err(_) => {
                error = true;
                break;
            }
        };
    }

    if !error {
        error = !flush_pending_clips(&mut final_nfp, &mut pending_clips);
    }

    if error || final_nfp.is_empty() {
        return None;
    }

    // choose the placement that results in the smallest bounding box/hull etc.
    let mut all_points: Vec<Point> = Vec::new();
    for (p, placement) in placed.iter().zip(placements.iter()) {
        for pt in &p.points {
            all_points.push(Point::new(pt.x + placement.x, pt.y + placement.y));
        }
    }

    let all_bounds = get_polygon_bounds(&all_points);
    let part_bounds = get_polygon_bounds(&part.points);
    let placed_hull = if config.placement_type == PlacementType::ConvexHull && !all_points.is_empty() {
        Some(get_hull_or_fallback(&all_points))
    } else {
        None
    };

    let mut candidates: Vec<Candidate> = Vec::new();
    for region in &final_nfp {
        for pt in region {
            let shiftvector = Placement {
                x: pt.x - part.points[0].x,
                y: pt.y - part.points[0].y,
            };

            let score = match config.placement_type {
                PlacementType::Gravity | PlacementType::Box => {
                    let part_bounds = part_bounds.expect("part always has points");
                    let candidate_part_corners = [
                        Point::new(part_bounds.x + shiftvector.x, part_bounds.y + shiftvector.y),
                        Point::new(part_bounds.x + part_bounds.width + shiftvector.x, part_bounds.y + shiftvector.y),
                        Point::new(
                            part_bounds.x + part_bounds.width + shiftvector.x,
                            part_bounds.y + part_bounds.height + shiftvector.y,
                        ),
                        Point::new(part_bounds.x + shiftvector.x, part_bounds.y + part_bounds.height + shiftvector.y),
                    ];
                    // `all_bounds` is `None` when nothing is placed yet (e.g.
                    // refineConsolidation relocating a part onto a sheet that
                    // - unlike place_parts's own first-part fast path, which
                    // never calls this function - could in principle be
                    // empty): there's no existing footprint to union with,
                    // so the candidate's own bounds are the whole answer.
                    // The original doesn't guard this at all (`allbounds.x`
                    // on a `null` `getPolygonBounds([])` would throw) - it
                    // just happens to never hit this path in practice, since
                    // every real caller keeps a target's placed list
                    // non-empty. Handling it here instead of relying on that
                    // same fragile guarantee is a deliberate improvement.
                    let rect_bounds = match all_bounds {
                        Some(all_bounds) => {
                            let rect_corners = [
                                Point::new(all_bounds.x, all_bounds.y),
                                Point::new(all_bounds.x + all_bounds.width, all_bounds.y),
                                Point::new(all_bounds.x + all_bounds.width, all_bounds.y + all_bounds.height),
                                Point::new(all_bounds.x, all_bounds.y + all_bounds.height),
                                candidate_part_corners[0],
                                candidate_part_corners[1],
                                candidate_part_corners[2],
                                candidate_part_corners[3],
                            ];
                            get_polygon_bounds(&rect_corners).expect("rect_corners always has exactly 8 points")
                        }
                        None => get_polygon_bounds(&candidate_part_corners).expect("candidate_part_corners always has exactly 4 points"),
                    };
                    if config.placement_type == PlacementType::Gravity {
                        CandidateScore::Gravity {
                            area: rect_bounds.width * 5.0 + rect_bounds.height,
                            width: rect_bounds.width,
                        }
                    } else {
                        CandidateScore::Box {
                            area: rect_bounds.width * rect_bounds.height,
                            width: rect_bounds.width,
                        }
                    }
                }
                PlacementType::ConvexHull => {
                    let part_points: Vec<Point> = part.points.iter().map(|p| Point::new(p.x + shiftvector.x, p.y + shiftvector.y)).collect();
                    let combined_hull = match &placed_hull {
                        Some(h) => {
                            let mut merged = h.clone();
                            merged.extend(part_points);
                            get_hull_or_fallback(&merged)
                        }
                        None => get_hull_or_fallback(&part_points),
                    };
                    CandidateScore::ConvexHull { area: polygon_area(&combined_hull).abs() }
                }
            };

            candidates.push(Candidate { shiftvector, score });
        }
    }

    // Overlap check deferred until after the full scan finds the true
    // best-by-heuristic, instead of re-validating every transient champion -
    // retries against the next-best on a rare validation failure (NFP-derived
    // candidates can still overlap once checked against actual part geometry,
    // due to floating-point/Clipper-scaling artifacts near boundaries).
    let mut excluded: HashSet<usize> = HashSet::new();
    loop {
        let champion_idx = find_best_candidate(&candidates, &excluded)?;
        let champion = &candidates[champion_idx];
        let shiftvector = champion.shiftvector;
        let test_shifted = shift_layered_polygon(part, shiftvector.x, shiftvector.y);

        let mut is_overlapping = has_material_outside_sheet(&test_shifted, sheet);
        if !is_overlapping {
            for (p, placement) in placed.iter().zip(placements.iter()) {
                let placed_shifted = shift_layered_polygon(p, placement.x, placement.y);
                if has_material_overlap(&test_shifted, &placed_shifted) {
                    is_overlapping = true;
                    break;
                }
            }
        }

        if !is_overlapping {
            return Some(PlaceOnSheetResult {
                position: shiftvector,
                minarea: champion.score.area(),
                minwidth: champion.score.width(),
            });
        }

        excluded.insert(champion_idx);
    }
}

/// Port of `placeParts`: opens sheets once and never revisits them (a part
/// that doesn't fit the current sheet is deferred to a new one). Single
/// individual, no GA, no threads - Phase 3's first end-to-end milestone.
pub fn place_parts(sheets: &[LayeredPolygon], parts: Vec<NestPart>, config: &PlacementConfig) -> PlaceResult {
    let mut parts: Vec<NestPart> = parts
        .into_iter()
        .map(|p| NestPart {
            id: p.id,
            polygon: rotate_layered_polygon(&p.polygon, p.rotation),
            rotation: p.rotation,
        })
        .collect();

    let mut total_sheet_area = 0.0;
    let mut total_usable_sheet_area = 0.0;
    let mut total_placed_area = 0.0;
    let mut fitness = 0.0;
    let mut all_placements: Vec<SheetPlacement> = Vec::new();

    let mut sheet_idx = 0usize;
    while !parts.is_empty() {
        if sheet_idx >= sheets.len() {
            break;
        }
        let sheet = &sheets[sheet_idx];
        let sheet_area = polygon_area(&sheet.points).abs();
        total_sheet_area += sheet_area;
        total_usable_sheet_area += polygon_material_area(sheet);
        fitness += sheet_area;

        let mut placed: Vec<LayeredPolygon> = Vec::new();
        let mut placements: Vec<Placement> = Vec::new();
        // Which slots of `parts` (indices, stable across this sheet's scan
        // since nothing removes elements mid-scan) got placed this pass -
        // NOT which ids: unlike the original's `parts.indexOf(placed[i])` +
        // `splice` (removal by object identity), keying removal off `.id`
        // would delete every part sharing an id with whatever got placed,
        // silently dropping untried duplicate-id siblings (quantity > 1 of
        // the same part is normal usage; nothing requires ids to be unique).
        let mut placed_indices: Vec<usize> = Vec::new();
        let mut placed_parts_out: Vec<PlacedPart> = Vec::new();
        let mut minwidth: Option<f64> = None;
        let mut minarea: Option<f64> = None;

        let mut i = 0;
        while i < parts.len() {
            // Inner NFP, trying all configured rotations until the part fits
            // the sheet at all (only needed for the first-fit test - once
            // placed, subsequent obstacle math uses whatever rotation won).
            let mut sheet_nfp: Option<Vec<Vec<Point>>> = None;
            let step = 360.0 / config.rotations.max(1) as f64;
            for _ in 0..config.rotations.max(1) {
                sheet_nfp = inner_nfp(sheet, &parts[i].polygon, config.curve_tolerance);
                if sheet_nfp.as_ref().is_some_and(|n| !n.is_empty()) {
                    break;
                }
                let new_rotation = {
                    let r = parts[i].rotation + step;
                    if r >= 360.0 {
                        r % 360.0
                    } else {
                        r
                    }
                };
                let new_polygon = rotate_layered_polygon(&parts[i].polygon, step);
                parts[i] = NestPart {
                    id: parts[i].id,
                    polygon: new_polygon,
                    rotation: new_rotation,
                };
            }

            let sheet_nfp = match sheet_nfp {
                Some(n) if !n.is_empty() => n,
                _ => {
                    i += 1;
                    continue;
                }
            };

            // Borrowed, not cloned, until a placement is actually confirmed -
            // most evaluated parts on a busy sheet fail to place (no room,
            // overlap, wrong rotation), so cloning up front paid for a full
            // polygon copy (points + recursive hole children) on the common
            // reject path for nothing.
            let part = &parts[i].polygon;

            if placed.is_empty() {
                // first placement on this sheet: top-left corner
                let mut position: Option<Placement> = None;
                for region in &sheet_nfp {
                    for pt in region {
                        let candidate = Placement {
                            x: pt.x - part.points[0].x,
                            y: pt.y - part.points[0].y,
                        };
                        let shifted = shift_layered_polygon(part, candidate.x, candidate.y);
                        if has_material_outside_sheet(&shifted, sheet) {
                            continue;
                        }
                        let better = match position {
                            None => true,
                            Some(p) => candidate.x < p.x || (almost_equal(candidate.x, p.x, None) && candidate.y < p.y),
                        };
                        if better {
                            position = Some(candidate);
                        }
                    }
                }

                let Some(position) = position else {
                    i += 1;
                    continue;
                };

                placements.push(position);
                placed_indices.push(i);
                placed_parts_out.push(PlacedPart { id: parts[i].id, placement: position, rotation: parts[i].rotation });
                let part_area = polygon_area(&part.points).abs();
                placed.push(parts[i].polygon.clone());

                // This part alone already claims most of the sheet - close it now.
                if part_area >= config.dominant_part_area_threshold * sheet_area {
                    break;
                }
                i += 1;
                continue;
            }

            if let Some(result) = try_place_part_on_sheet(part, &sheet_nfp, sheet, &placed, &placements, config) {
                placements.push(result.position);
                placed_indices.push(i);
                placed_parts_out.push(PlacedPart { id: parts[i].id, placement: result.position, rotation: parts[i].rotation });
                placed.push(parts[i].polygon.clone());
                minarea = Some(result.minarea);
                minwidth = result.minwidth;
            }

            i += 1;
        }

        // Explicit decision (Phase 3 - see docs/PORT_STATUS.md's "NaN-fitness
        // gap" gotcha): minarea/minwidth are only ever set by the >=2nd-part
        // scoring branch above. The original's `(minwidth||0)/sheetarea +
        // (minarea||0)` leaned on JS's undefined-is-falsy coercion to avoid
        // NaN poisoning the running fitness total; `Option<f64>::unwrap_or`
        // makes the same zero-contribution choice explicit instead of
        // implicit for a sheet where 0-1 parts got placed.
        fitness += (minwidth.unwrap_or(0.0) / sheet_area) + minarea.unwrap_or(0.0);

        for p in &placed {
            total_placed_area += polygon_material_area(p);
        }

        // Remove exactly the placed slots, by position - see the
        // `placed_indices` doc comment above for why this can't be `.id`-keyed.
        let placed_index_set: HashSet<usize> = placed_indices.iter().copied().collect();
        let mut kept: Vec<NestPart> = Vec::with_capacity(parts.len().saturating_sub(placed_index_set.len()));
        for (idx, part) in parts.into_iter().enumerate() {
            if !placed_index_set.contains(&idx) {
                kept.push(part);
            }
        }
        parts = kept;

        if placements.is_empty() {
            // Nothing fit on a freshly opened, empty sheet - something is
            // wrong (part(s) genuinely too big); stop rather than looping
            // forever opening empty sheets.
            break;
        }

        all_placements.push(SheetPlacement { sheet_index: sheet_idx, parts: placed_parts_out });

        sheet_idx += 1;
    }

    // Parts that never fit any sheet get a massive area-scaled fitness
    // penalty so the GA (once wired up, Phase 4) strongly prefers solutions
    // where everything is placed, even at the cost of opening more sheets.
    // Guarded against total_sheet_area == 0.0 (place_parts called with no
    // sheets at all) - without it this silently produces `fitness ==
    // Infinity` instead of a large-but-defined value.
    for p in &parts {
        let area_ratio = if total_sheet_area > 0.0 {
            (polygon_area(&p.polygon.points).abs() * 100.0) / total_sheet_area
        } else {
            1.0
        };
        fitness += 100_000_000.0 * area_ratio;
    }

    let utilisation = if total_usable_sheet_area > 0.0 {
        (total_placed_area / total_usable_sheet_area) * 100.0
    } else {
        0.0
    };

    PlaceResult {
        placements: all_placements,
        fitness,
        area: total_placed_area,
        total_area: total_usable_sheet_area,
        utilisation,
        unplaced_count: parts.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(x: f64, y: f64, size: f64) -> LayeredPolygon {
        LayeredPolygon {
            points: vec![
                Point::new(x, y),
                Point::new(x + size, y),
                Point::new(x + size, y + size),
                Point::new(x, y + size),
            ],
            layer: "0".into(),
            is_circle: None,
            children: Vec::new(),
        }
    }

    fn square_with_hole(x: f64, y: f64, size: f64, hole_x: f64, hole_y: f64, hole_size: f64) -> LayeredPolygon {
        let mut poly = square(x, y, size);
        poly.children.push(square(hole_x, hole_y, hole_size));
        poly
    }

    fn config(placement_type: PlacementType) -> PlacementConfig {
        PlacementConfig {
            placement_type,
            rotations: 1,
            dominant_part_area_threshold: DEFAULT_DOMINANT_PART_AREA_THRESHOLD,
            curve_tolerance: 0.3,
        }
    }

    fn separated(x0: f64, y0: f64, s0: f64, x1: f64, y1: f64, s1: f64) -> bool {
        x0 + s0 <= x1 + 1e-6 || x1 + s1 <= x0 + 1e-6 || y0 + s0 <= y1 + 1e-6 || y1 + s1 <= y0 + 1e-6
    }

    /// The milestone: one rectangle placed on one sheet, single individual,
    /// no GA, no threads - the earliest point the full placement stack
    /// (inner NFP -> top-left-corner fast path -> fitness) is provably
    /// correct end-to-end.
    #[test]
    fn one_rectangle_placed_on_one_sheet() {
        let sheet = square(0.0, 0.0, 100.0);
        let part = square(0.0, 0.0, 10.0);
        let parts = vec![NestPart { id: 0, polygon: part, rotation: 0.0 }];

        let result = place_parts(&[sheet], parts, &config(PlacementType::Gravity));

        assert_eq!(result.unplaced_count, 0);
        assert_eq!(result.placements.len(), 1);
        assert_eq!(result.placements[0].parts.len(), 1);
        let placed = result.placements[0].parts[0];
        assert_eq!(placed.id, 0);
        assert_eq!(placed.rotation, 0.0);
        // top-left-corner fast path: the part's own (0,0) corner should land
        // at the sheet's (0,0) corner, the tightest valid position.
        assert!((placed.placement.x - 0.0).abs() < 1e-6, "x was {}", placed.placement.x);
        assert!((placed.placement.y - 0.0).abs() < 1e-6, "y was {}", placed.placement.y);
        assert!((result.area - 100.0).abs() < 1e-6, "area was {}", result.area);
        assert!(result.fitness.is_finite());
    }

    #[test]
    fn two_rectangles_placed_side_by_side_without_overlap() {
        let sheet = square(0.0, 0.0, 100.0);
        let parts = vec![
            NestPart { id: 0, polygon: square(0.0, 0.0, 30.0), rotation: 0.0 },
            NestPart { id: 1, polygon: square(0.0, 0.0, 20.0), rotation: 0.0 },
        ];

        let result = place_parts(&[sheet], parts, &config(PlacementType::Gravity));

        assert_eq!(result.unplaced_count, 0);
        assert_eq!(result.placements.len(), 1);
        assert_eq!(result.placements[0].parts.len(), 2);
        assert!((result.area - (900.0 + 400.0)).abs() < 1e-6, "area was {}", result.area);

        // the two placed 30x30 / 20x20 squares must not overlap
        let placed: Vec<(f64, f64, f64)> = result.placements[0]
            .parts
            .iter()
            .map(|p| {
                let size = if p.id == 0 { 30.0 } else { 20.0 };
                (p.placement.x, p.placement.y, size)
            })
            .collect();
        let (x0, y0, s0) = placed[0];
        let (x1, y1, s1) = placed[1];
        assert!(separated(x0, y0, s0, x1, y1, s1), "parts overlap: ({x0},{y0},{s0}) vs ({x1},{y1},{s1})");
    }

    #[test]
    fn oversized_part_is_left_unplaced_with_a_fitness_penalty() {
        let sheet = square(0.0, 0.0, 10.0);
        let parts = vec![NestPart { id: 0, polygon: square(0.0, 0.0, 20.0), rotation: 0.0 }];

        let result = place_parts(&[sheet], parts, &config(PlacementType::Gravity));

        assert_eq!(result.unplaced_count, 1);
        assert!(result.placements.is_empty());
        // unplaced-part penalty dominates fitness (100,000,000 scale factor)
        assert!(result.fitness > 1_000_000.0, "fitness was {}", result.fitness);
    }

    #[test]
    fn dominant_part_closes_the_sheet_immediately() {
        // A part covering >=90% of the sheet area should close the sheet
        // right after being placed, leaving the second part for a new sheet.
        let sheet = square(0.0, 0.0, 100.0);
        let parts = vec![
            NestPart { id: 0, polygon: square(0.0, 0.0, 95.0), rotation: 0.0 },
            NestPart { id: 1, polygon: square(0.0, 0.0, 5.0), rotation: 0.0 },
        ];

        let result = place_parts(&[sheet.clone(), sheet], parts, &config(PlacementType::Gravity));

        assert_eq!(result.unplaced_count, 0);
        assert_eq!(result.placements.len(), 2);
        assert_eq!(result.placements[0].parts.len(), 1);
        assert_eq!(result.placements[0].parts[0].id, 0);
        assert_eq!(result.placements[1].parts[0].id, 1);
    }

    #[test]
    fn box_and_convexhull_placement_types_also_place_without_overlap() {
        for placement_type in [PlacementType::Box, PlacementType::ConvexHull] {
            let sheet = square(0.0, 0.0, 100.0);
            let parts = vec![
                NestPart { id: 0, polygon: square(0.0, 0.0, 30.0), rotation: 0.0 },
                NestPart { id: 1, polygon: square(0.0, 0.0, 20.0), rotation: 0.0 },
            ];

            let result = place_parts(&[sheet], parts, &config(placement_type));
            assert_eq!(result.unplaced_count, 0, "placement_type {:?}", placement_type);
            assert_eq!(result.placements[0].parts.len(), 2, "placement_type {:?}", placement_type);
        }
    }

    /// Regression test: `try_place_part_on_sheet` must not panic when
    /// `placed`/`placements` are empty, under every placement type - a
    /// scenario `place_parts` itself never produces (the first part on a
    /// sheet always takes the inline top-left-corner path instead) but that
    /// `nesting::consolidation`'s cross-sheet relocation can (a relocation
    /// target isn't guaranteed to already have a part on it).
    #[test]
    fn try_place_part_on_sheet_handles_an_empty_target_sheet() {
        let sheet = square(0.0, 0.0, 100.0);
        let part = square(0.0, 0.0, 10.0);
        let sheet_nfp = inner_nfp(&sheet, &part, 0.3).expect("part fits the empty sheet");

        for placement_type in [PlacementType::Gravity, PlacementType::Box, PlacementType::ConvexHull] {
            let result = try_place_part_on_sheet(&part, &sheet_nfp, &sheet, &[], &[], &config(placement_type));
            assert!(result.is_some(), "placement_type {:?}", placement_type);
        }
    }

    /// Regression test for the id-based-removal bug (reviewer.md finding):
    /// two parts sharing an id, where the first one dominant-closes the
    /// sheet before the second is even attempted. The second must be
    /// deferred to the next sheet, not silently dropped.
    #[test]
    fn duplicate_id_parts_are_not_dropped_when_one_dominant_closes_a_sheet() {
        let sheet = square(0.0, 0.0, 30.0);
        let parts = vec![
            NestPart { id: 0, polygon: square(0.0, 0.0, 30.0), rotation: 0.0 },
            NestPart { id: 0, polygon: square(0.0, 0.0, 30.0), rotation: 0.0 },
        ];

        let result = place_parts(&[sheet.clone(), sheet], parts, &config(PlacementType::Gravity));

        assert_eq!(result.unplaced_count, 0);
        assert_eq!(result.placements.len(), 2, "expected one part per sheet, got {:?}", result.placements);
        assert_eq!(result.placements[0].parts.len(), 1);
        assert_eq!(result.placements[1].parts.len(), 1);
    }

    /// Regression test for the "holed-obstacle path is untested" gap
    /// (reviewer.md finding): a part with a hole, a second part nested
    /// inside that hole, and a third part that must not be allowed to
    /// overlap the second - proving the restored-hole region is correctly
    /// narrowed by a later obstacle, not just correctly computed in isolation.
    #[test]
    fn a_part_placed_inside_another_parts_hole_blocks_a_later_part_from_overlapping_it() {
        // A: 30x30 square with a 10x10 hole in the middle (10,10)-(20,20).
        let a = square_with_hole(0.0, 0.0, 30.0, 10.0, 10.0, 10.0);
        // B and C: both 4x4, small enough to nest inside A's hole - only one can fit.
        let parts = vec![
            NestPart { id: 0, polygon: a, rotation: 0.0 },
            NestPart { id: 1, polygon: square(0.0, 0.0, 4.0), rotation: 0.0 },
            NestPart { id: 2, polygon: square(0.0, 0.0, 4.0), rotation: 0.0 },
        ];

        let result = place_parts(&[square(0.0, 0.0, 100.0)], parts, &config(PlacementType::Gravity));

        assert_eq!(result.unplaced_count, 0, "all 3 parts should fit on one 100x100 sheet: {:?}", result.placements);
        assert_eq!(result.placements.len(), 1);
        let placed = &result.placements[0].parts;
        assert_eq!(placed.len(), 3);

        let sizes = [30.0, 4.0, 4.0];
        for i in 0..placed.len() {
            for j in (i + 1)..placed.len() {
                let (pi, pj) = (placed[i], placed[j]);
                // A's own hole doesn't count as "material" for this simple
                // bbox-overlap check, so only compare the two 4x4 parts
                // against each other directly - A vs. either is fine even if
                // their bboxes touch, since the hole is inside A's bbox.
                if pi.id == 0 || pj.id == 0 {
                    continue;
                }
                assert!(
                    separated(pi.placement.x, pi.placement.y, sizes[pi.id], pj.placement.x, pj.placement.y, sizes[pj.id]),
                    "parts {} and {} overlap: {:?} vs {:?}",
                    pi.id,
                    pj.id,
                    pi.placement,
                    pj.placement
                );
            }
        }
    }
}
