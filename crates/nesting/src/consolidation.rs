//! Port of `main/background.js`'s `refineConsolidation` + `recomputeTotals`:
//! a post-processing pass that relocates already-placed parts between
//! already-open sheets. `place_parts` opens sheets once and never revisits
//! them, which is a classic cause of excess sheet usage in single-pass
//! bin-packing - this fixes that up afterward, on an already-computed
//! result, budget-capped (iterations/target-sheets-tried/wall-clock
//! deadline) so it stays cheap enough to run after every improved result
//! instead of only once at the very end.
//!
//! **Sheet/part identity, simpler than the original by construction**: the
//! original threads `sheetsById`/`partsById` (`Map<id, polygon>`) through
//! because its `allplacements` entries only carry string ids, not direct
//! references. `nesting::placement::SheetPlacement::sheet_index` is already
//! a stable index into the original `sheets` slice (place_parts never
//! reorders or removes from that slice, only from the separate
//! `allplacements`-equivalent it builds) - so sheets need no separate
//! id-map, just plain slice indexing. Parts still need `parts_by_id`
//! (`nesting::dispatch` already uses the same shape), since a part's `id`
//! genuinely is its only identity once it's been placed.
//!
//! **Not ported**: `mergedLength` accumulation in `recompute_totals` - see
//! `nesting::placement`'s module doc for why `config.mergeLines`'s
//! edge-merge bonus isn't tracked anywhere in this port yet.

use std::collections::HashMap;
use std::time::Instant;

use geometry::dxf_import::{polygon_material_area, LayeredPolygon};
use geometry::inner_nfp::inner_nfp;
use geometry::polygon::polygon_area;

use crate::placement::{try_place_part_on_sheet, PlacedPart, PlacementConfig, SheetPlacement};

const MAX_TARGET_SHEETS_TRIED: usize = 15;

fn area_of_sheet(sheet_index: usize, sheets: &[LayeredPolygon]) -> f64 {
    polygon_area(&sheets[sheet_index].points).abs()
}

fn placed_area_of(entry: &SheetPlacement, parts_by_id: &HashMap<usize, LayeredPolygon>) -> f64 {
    entry.parts.iter().filter_map(|p| parts_by_id.get(&p.id)).map(|part| polygon_area(&part.points).abs()).sum()
}

pub struct RefineResult {
    pub allplacements: Vec<SheetPlacement>,
    pub changed: bool,
    pub hit_cap: bool,
}

/// Port of `refineConsolidation`. `deadline` replaces the original's
/// `deadlineMs` (a `Date.now()`-comparable timestamp) with an `Instant` -
/// same wall-clock budget, just Rust's monotonic-clock idiom for it.
pub fn refine_consolidation(
    mut allplacements: Vec<SheetPlacement>,
    parts_by_id: &HashMap<usize, LayeredPolygon>,
    sheets: &[LayeredPolygon],
    config: &PlacementConfig,
    deadline: Instant,
) -> RefineResult {
    let mut changed = false;
    let mut hit_cap = false;
    let max_iterations = allplacements.len().min(20);
    let mut iterations = 0;
    let mut again = true;

    while again && iterations < max_iterations {
        if Instant::now() >= deadline {
            hit_cap = true;
            break;
        }
        again = false;
        iterations += 1;

        // Sparsest sheet first - a more robust proxy for "worth draining"
        // than chronological open order: place_parts's dominant-part-area
        // shortcut can close an EARLY sheet ~90% "done" off a single part,
        // while a LATER sheet ends up sparser after several small parts.
        let mut ranked: Vec<(usize, f64)> = allplacements
            .iter()
            .map(|e| (e.sheet_index, placed_area_of(e, parts_by_id) / area_of_sheet(e.sheet_index, sheets).max(1e-9)))
            .collect();
        ranked.sort_by(|a, b| a.1.total_cmp(&b.1));

        'sources: for &(source_sheet_index, _) in &ranked {
            let Some(source_pos) = allplacements.iter().position(|e| e.sheet_index == source_sheet_index) else {
                continue;
            };

            // Smallest part on this sheet first. A failed relocation is the
            // expensive case (burns through all MAX_TARGET_SHEETS_TRIED
            // tries, each a real NFP/Clipper call) while a success exits
            // early - and big parts are the ones least likely to fit into
            // another sheet's leftover scraps of space. Trying biggest-first
            // spends the shared per-sheet time/iteration budget on the
            // attempts most likely to fail, starving the small parts that
            // actually fit the leftover gaps out of a turn before the
            // deadline hits.
            let mut candidate_parts: Vec<PlacedPart> = allplacements[source_pos].parts.clone();
            candidate_parts.sort_by(|a, b| {
                let area_a = parts_by_id.get(&a.id).map_or(0.0, |p| polygon_area(&p.points).abs());
                let area_b = parts_by_id.get(&b.id).map_or(0.0, |p| polygon_area(&p.points).abs());
                area_a.total_cmp(&area_b)
            });

            let mut moved_any = false;

            for candidate in &candidate_parts {
                if Instant::now() >= deadline {
                    hit_cap = true;
                    break;
                }

                let Some(part_geom) = parts_by_id.get(&candidate.id) else {
                    continue;
                };
                let part_area = polygon_area(&part_geom.points).abs();
                let mut tried_this_part = 0usize;

                for target_pos in 0..allplacements.len() {
                    if Instant::now() >= deadline {
                        hit_cap = true;
                        break;
                    }
                    if allplacements[target_pos].sheet_index == source_sheet_index {
                        continue;
                    }

                    // Cheap pre-filter before any real NFP/Clipper work -
                    // skip a sheet whose remaining estimated area can't
                    // possibly fit this part. Doesn't count against the
                    // tried-budget below (only sheets that pass this and get
                    // a real attempt do).
                    let target_sheet_index = allplacements[target_pos].sheet_index;
                    let target_sheet_area = area_of_sheet(target_sheet_index, sheets);
                    if target_sheet_area - placed_area_of(&allplacements[target_pos], parts_by_id) < part_area {
                        continue;
                    }

                    // Cap how many candidate sheets get a REAL attempt,
                    // regardless of total sheet count - a job with ~100
                    // sheets could otherwise burn through 100 full NFP
                    // computations for a single part before the deadline
                    // check above ever gets a chance to fire again, since it
                    // only runs between candidate parts/target sheets here,
                    // not more granularly.
                    if tried_this_part >= MAX_TARGET_SHEETS_TRIED {
                        break;
                    }
                    tried_this_part += 1;

                    let target_sheet = &sheets[target_sheet_index];
                    let target_geoms: Option<Vec<LayeredPolygon>> =
                        allplacements[target_pos].parts.iter().map(|p| parts_by_id.get(&p.id).cloned()).collect();
                    let Some(target_geoms) = target_geoms else {
                        continue;
                    };
                    let target_placements: Vec<_> = allplacements[target_pos].parts.iter().map(|p| p.placement).collect();

                    let Some(sheet_nfp) = inner_nfp(target_sheet, part_geom, config.curve_tolerance) else {
                        continue;
                    };
                    if sheet_nfp.is_empty() {
                        continue;
                    }

                    let Some(result) = try_place_part_on_sheet(part_geom, &sheet_nfp, target_sheet, &target_geoms, &target_placements, config)
                    else {
                        continue;
                    };

                    if let Some(idx) = allplacements[source_pos].parts.iter().position(|p| p.id == candidate.id) {
                        allplacements[source_pos].parts.remove(idx);
                    }
                    allplacements[target_pos].parts.push(PlacedPart {
                        id: candidate.id,
                        placement: result.position,
                        rotation: candidate.rotation,
                    });
                    changed = true;
                    moved_any = true;
                    break;
                }

                if hit_cap {
                    break;
                }
            }

            if allplacements[source_pos].parts.is_empty() {
                allplacements.remove(source_pos);
            }

            if moved_any || hit_cap {
                // This sheet's (and its targets') contents changed - fill
                // ratios are stale, restart with a fresh ranking pass
                // instead of continuing down the old one.
                again = !hit_cap;
                break 'sources;
            }
            // Otherwise this sheet had nothing relocatable - try the
            // next-sparsest one in this same pass rather than giving up on
            // the whole refinement.
        }
    }

    RefineResult { allplacements, changed, hit_cap }
}

pub struct Totals {
    pub total_placed_area: f64,
    pub total_usable_sheet_area: f64,
    pub utilisation: f64,
}

/// Port of `recomputeTotals`: recomputes the summary fields `place_parts`
/// itself returns, from a possibly-refined `allplacements`. `unplaced_count`
/// is deliberately not touched here (refinement only ever relocates
/// already-successfully-placed parts between already-open sheets, it never
/// un-places anything, so the original value still holds).
pub fn recompute_totals(allplacements: &[SheetPlacement], parts_by_id: &HashMap<usize, LayeredPolygon>, sheets: &[LayeredPolygon]) -> Totals {
    let mut total_usable_sheet_area = 0.0;
    let mut total_placed_area = 0.0;

    for entry in allplacements {
        total_usable_sheet_area += polygon_material_area(&sheets[entry.sheet_index]);
        for p in &entry.parts {
            if let Some(part) = parts_by_id.get(&p.id) {
                total_placed_area += polygon_material_area(part);
            }
        }
    }

    let utilisation = if total_usable_sheet_area > 0.0 { (total_placed_area / total_usable_sheet_area) * 100.0 } else { 0.0 };
    Totals { total_placed_area, total_usable_sheet_area, utilisation }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::placement::{place_parts, NestPart, Placement, PlacementType, DEFAULT_DOMINANT_PART_AREA_THRESHOLD};
    use geometry::point::Point;

    fn square(size: f64) -> LayeredPolygon {
        LayeredPolygon {
            points: vec![Point::new(0.0, 0.0), Point::new(size, 0.0), Point::new(size, size), Point::new(0.0, size)],
            layer: "0".into(),
            is_circle: None,
            children: Vec::new(),
        }
    }

    fn config() -> PlacementConfig {
        PlacementConfig {
            placement_type: PlacementType::Gravity,
            rotations: 1,
            dominant_part_area_threshold: DEFAULT_DOMINANT_PART_AREA_THRESHOLD,
            curve_tolerance: 0.3,
        }
    }

    fn far_future() -> Instant {
        Instant::now() + std::time::Duration::from_secs(60)
    }

    #[test]
    fn drains_a_sparse_sheet_into_another_when_relocation_fits() {
        // Two 1000x1000 sheets. Sheet 0 gets one 950x950 part - big enough
        // (90.25% of the sheet) to trigger the dominant-part-area close, so
        // place_parts's own pass never even attempts the second part on
        // sheet 0, even though its 50-unit-wide leftover margin has real
        // room (with slack) for a 20x20 part. Sheet 1 gets that 20x20 part
        // instead. After refinement it should relocate onto sheet 0's
        // margin, draining sheet 1 to empty and letting it be removed.
        let sheets = vec![square(1000.0), square(1000.0)];
        let parts = vec![
            NestPart { id: 0, polygon: square(950.0), rotation: 0.0 },
            NestPart { id: 1, polygon: square(20.0), rotation: 0.0 },
        ];
        let result = place_parts(&sheets, parts, &config());
        assert_eq!(result.placements.len(), 2, "sanity: parts start on separate sheets");

        let parts_by_id: HashMap<usize, LayeredPolygon> = HashMap::from([(0, square(950.0)), (1, square(20.0))]);

        let refined = refine_consolidation(result.placements, &parts_by_id, &sheets, &config(), far_future());

        assert!(refined.changed);
        assert_eq!(refined.allplacements.len(), 1, "sheet 1 should have drained and been removed");
        assert_eq!(refined.allplacements[0].parts.len(), 2);
    }

    #[test]
    fn does_nothing_when_no_relocation_is_possible() {
        // Two sheets, each already holding a part that fills essentially
        // the whole sheet - nothing can move anywhere.
        let sheets = vec![square(50.0), square(50.0)];
        let parts = vec![
            NestPart { id: 0, polygon: square(48.0), rotation: 0.0 },
            NestPart { id: 1, polygon: square(48.0), rotation: 0.0 },
        ];
        let result = place_parts(&sheets, parts, &config());
        assert_eq!(result.placements.len(), 2, "sanity: 48+48 > 50, both parts can't share one sheet");
        let parts_by_id: HashMap<usize, LayeredPolygon> = HashMap::from([(0, square(48.0)), (1, square(48.0))]);

        let refined = refine_consolidation(result.placements, &parts_by_id, &sheets, &config(), far_future());

        assert!(!refined.changed);
        assert_eq!(refined.allplacements.len(), 2);
    }

    #[test]
    fn respects_an_already_passed_deadline() {
        let sheets = vec![square(100.0), square(100.0)];
        let parts = vec![
            NestPart { id: 0, polygon: square(90.0), rotation: 0.0 },
            NestPart { id: 1, polygon: square(10.0), rotation: 0.0 },
        ];
        let result = place_parts(&sheets, parts, &config());
        let parts_by_id: HashMap<usize, LayeredPolygon> = HashMap::from([(0, square(90.0)), (1, square(10.0))]);

        let already_past = Instant::now() - std::time::Duration::from_secs(1);
        let refined = refine_consolidation(result.placements, &parts_by_id, &sheets, &config(), already_past);

        assert!(refined.hit_cap);
        assert!(!refined.changed);
    }

    #[test]
    fn recompute_totals_matches_a_hand_built_layout() {
        let sheets = vec![square(100.0)];
        let parts_by_id: HashMap<usize, LayeredPolygon> = HashMap::from([(0, square(10.0)), (1, square(20.0))]);
        let allplacements = vec![SheetPlacement {
            sheet_index: 0,
            parts: vec![
                PlacedPart { id: 0, placement: Placement { x: 0.0, y: 0.0 }, rotation: 0.0 },
                PlacedPart { id: 1, placement: Placement { x: 10.0, y: 0.0 }, rotation: 0.0 },
            ],
        }];

        let totals = recompute_totals(&allplacements, &parts_by_id, &sheets);

        assert!((totals.total_usable_sheet_area - 10000.0).abs() < 1e-6);
        assert!((totals.total_placed_area - (100.0 + 400.0)).abs() < 1e-6);
        assert!((totals.utilisation - 5.0).abs() < 1e-6);
    }
}
