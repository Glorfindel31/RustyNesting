//! Tauri command layer - the "redesign, not port" point in the UI layer
//! (`docs/PORT_STATUS.md`'s Phase 6 table). The original dispatches one
//! `background-start` IPC message per GA individual to a pool of separate
//! worker `BrowserWindow` processes, collecting `background-response`
//! messages back asynchronously; this collapses to a single synchronous
//! command per nest run, since `nesting::dispatch` already parallelizes a
//! generation in-process via rayon - there's no separate worker process to
//! message.
//!
//! **First slice, not the full surface**: this wires `import_dxf` and
//! `run_nest` - reading a DXF file and running a bounded number of GA
//! generations - end to end against the real engine (Phases 1-5). It does
//! **not** wire the legacy `frontend/deepnest.js`/`index.html`'s
//! `require("electron").ipcRenderer` construction, which expects the
//! original's exact `background-*` channel shapes; that's a separate,
//! larger "adapt the existing Ractive UI to the new command surface" pass.
//! Progress events, `widenRotationsIfStalled`/`refineStalledBest`
//! (needs a run loop that persists across multiple `run_nest`-shaped calls,
//! which this single-shot command isn't), and DXF export are also not here
//! yet - see `docs/PORT_STATUS.md`'s Phase 6/7 tables.
//!
//! Every command is a thin wrapper around a plain function (`import_dxf`/
//! `run_nest` below) that takes no Tauri types and returns a plain
//! `Result` - testable directly, without spinning up a Tauri runtime.

use std::collections::HashMap;

use dxf::Drawing;
use geometry::clearance::{prepare_part, prepare_sheet};
use geometry::dxf_export::{PlacedShape, SheetLayout};
use geometry::dxf_import::LayeredPolygon;
use nesting::dispatch;
use nesting::ga::{is_better_nest, GeneticAlgorithm};
use nesting::placement::PlaceResult;
use tauri::Emitter;

use crate::dto::{expand_parts, ExportDxfRequest, NestProgressDto, NestSnapshotDto, PlacedPartDto, PolygonDto, RunNestRequest, RunNestResponse, SheetPlacementDto};

/// Reads a DXF file from disk and returns its closed profiles as a
/// parent/hole tree (`geometry::dxf_import::build_polygon_tree`) - the
/// frontend is expected to turn these into `PartDto`s (assigning quantities)
/// for a later `run_nest` call, or into sheets directly.
pub fn import_dxf(path: &str, curve_tolerance: f64) -> Result<Vec<PolygonDto>, String> {
    let drawing = Drawing::load_file(path).map_err(|e| format!("couldn't parse {path} as DXF: {e}"))?;

    let flat = geometry::dxf_import::entities_to_polygons(drawing.entities(), curve_tolerance);
    let tree = geometry::dxf_import::build_polygon_tree(flat);

    Ok(tree.iter().map(PolygonDto::from).collect())
}

/// Writes the given nest result back out to a DXF file at `path` - new
/// scope, not a port (the original app never wrote DXF locally at all, see
/// `docs/PORT_STATUS.md`'s Phase 7 table). Takes exactly what the frontend
/// already has after a `run_nest_command` call (`request.sheets`/`parts`
/// for the *true*, unpadded geometry - export never uses the internally
/// padded shapes `run_nest` builds - plus `response.placements` from that
/// same call) rather than re-deriving anything server-side.
pub fn export_dxf(path: &str, request: ExportDxfRequest) -> Result<(), String> {
    if request.sheet_spacing < 0.0 {
        return Err("sheet spacing must be >= 0".into());
    }

    let true_sheets: Vec<LayeredPolygon> = request.sheets.into_iter().map(Into::into).collect();
    let (_, parts_by_id) = expand_parts(request.parts);

    let layouts: Vec<SheetLayout> = request
        .placements
        .into_iter()
        .map(|sp| {
            let sheet = true_sheets.get(sp.sheet_index).cloned().ok_or_else(|| format!("placement references sheet_index {} out of range", sp.sheet_index))?;
            let parts = sp
                .parts
                .into_iter()
                .map(|p| {
                    let shape = parts_by_id.get(&p.id).cloned().ok_or_else(|| format!("placement references unknown part id {}", p.id))?;
                    Ok(PlacedShape { shape, x: p.x, y: p.y, rotation: p.rotation })
                })
                .collect::<Result<Vec<_>, String>>()?;
            Ok(SheetLayout { sheet, parts })
        })
        .collect::<Result<Vec<_>, String>>()?;

    let drawing = geometry::dxf_export::export_dxf(&layouts, request.sheet_spacing, request.include_sheet_outline);
    drawing.save_file(path).map_err(|e| format!("couldn't write {path}: {e}"))
}

/// Runs `request.config.generations` GA generations against
/// `request.sheets`/`request.parts` and returns the best result found
/// (`nesting::ga::is_better_nest`, not raw fitness - see its doc comment for
/// why those can rank differently). Every part-shape/quantity pair is
/// expanded into individually-id'd physical copies first
/// (`dto::expand_parts`), same as the original's `launchWorkers` building
/// its GA seed population.
// Only the tests below call this directly (the real `run_nest_command`
// uses `run_nest_with_progress` to get per-generation events) - gated to
// test builds instead of carrying an unused production entry point.
#[cfg(test)]
pub fn run_nest(request: RunNestRequest) -> Result<RunNestResponse, String> {
    run_nest_with_progress(request, |_, _, _| {})
}

/// Same as `run_nest`, but calls `on_progress(generation, total_generations,
/// best_so_far)` after every completed generation - the hook the
/// `run_nest_command` Tauri wrapper uses to `emit` a live "nest-progress"
/// event per generation, so the UI can show what's happening instead of
/// blocking silently until the whole run finishes. Plain `run_nest` (used by
/// every test below and any caller that doesn't care) is just this with a
/// no-op hook.
///
/// Inlines the generation loop `nesting::dispatch::run` would otherwise do,
/// rather than adding a callback parameter to that function - `dispatch`'s
/// own doc comment already calls progress plumbing out as "left to whatever
/// wraps this loop", so this is that wrapper, not a fork of engine logic.
pub fn run_nest_with_progress(request: RunNestRequest, mut on_progress: impl FnMut(usize, usize, &PlaceResult) + Send) -> Result<RunNestResponse, String> {
    if request.sheets.is_empty() {
        return Err("at least one sheet is required".into());
    }
    if request.parts.is_empty() {
        return Err("at least one part is required".into());
    }
    // Both feed straight into GeneticAlgorithm::new(), which panics rather
    // than erroring on either: rotations=0 makes random_angles's
    // rng.gen_range(0..0) panic (empty range), and population_size 0 or 1
    // leaves the population at size 1 (GeneticAlgorithm::new() always seeds
    // one individual before checking population_size), which panics on the
    // first generation() call when it tries to pick a second, distinct
    // parent. Catch both here, at the actual trust boundary, instead of
    // three call frames deep in the engine.
    if request.config.rotations == 0 {
        return Err("rotations must be at least 1".into());
    }
    if request.config.population_size < 2 {
        return Err("population_size must be at least 2".into());
    }
    if request.config.margin < 0.0 {
        return Err("margin must be >= 0".into());
    }
    if request.config.spacing < 0.0 {
        return Err("spacing must be >= 0".into());
    }
    let margin = request.config.margin;
    let spacing = request.config.spacing;
    let max_threads = request.config.max_threads;

    // Padding is applied here, internally, purely to shape the placement
    // decisions the engine makes - see geometry::clearance's module doc for
    // the full derivation. The response only ever reports (id, x, y,
    // rotation), computed against this padded geometry but geometrically
    // valid for the caller's original (true, unpadded) shapes too, since
    // padding doesn't recenter a polygon - nothing padded is ever returned.
    let true_sheets: Vec<LayeredPolygon> = request.sheets.into_iter().map(Into::into).collect();
    let sheets: Vec<LayeredPolygon> = true_sheets
        .iter()
        .map(|sheet| {
            let points = prepare_sheet(&sheet.points, margin, spacing).ok_or("margin/spacing leaves a sheet with no usable area")?;
            Ok(LayeredPolygon { points, layer: sheet.layer.clone(), is_circle: sheet.is_circle, children: sheet.children.clone() })
        })
        .collect::<Result<_, &str>>()?;

    let (adam, true_parts_by_id) = expand_parts(request.parts);
    if adam.is_empty() {
        return Err("every part had quantity 0".into());
    }
    let parts_by_id: HashMap<usize, LayeredPolygon> = true_parts_by_id
        .iter()
        .map(|(&id, part)| {
            let points = prepare_part(&part.points, spacing).ok_or("spacing leaves a part with no usable outline")?;
            Ok((id, LayeredPolygon { points, layer: part.layer.clone(), is_circle: part.is_circle, children: part.children.clone() }))
        })
        .collect::<Result<_, &str>>()?;

    let placement_config = request.config.placement_config();
    let ga_config = request.config.ga_config();
    let mut ga = GeneticAlgorithm::new(adam, ga_config, Vec::new());

    let generations = request.config.generations;
    let mut run_generations = move || {
        let mut best: Option<PlaceResult> = None;
        // Every time `best` actually improves, keep a copy - not just the
        // final one - so the frontend can show "the other nests it tried"
        // (`RunNestResponse::history`), not only the winner. Bounded by how
        // often a genuinely better individual turns up, which in practice
        // is far less than once per generation once the GA converges - not
        // one full snapshot per generation regardless of `generations`.
        let mut history: Vec<(usize, PlaceResult)> = Vec::new();
        for generation in 1..=generations {
            let results = dispatch::run_generation(&mut ga, &sheets, &parts_by_id, &placement_config);
            for result in results {
                if best.as_ref().is_none_or(|b| is_better_nest(&result, b)) {
                    best = Some(result.clone());
                    history.push((generation, result));
                }
            }
            if let Some(so_far) = &best {
                on_progress(generation, generations, so_far);
            }
        }
        best.map(|b| (b, history))
    };

    // 0 (the default) means "no cap" - just use rayon's own global pool, no
    // need to spin up a second one. A cap builds a fresh scoped pool for
    // this call only, since rayon's global pool can only be configured once
    // per process (a second `build_global()` call would panic) and
    // different calls may want different caps.
    let outcome = if max_threads > 0 {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(max_threads)
            .build()
            .map_err(|e| format!("couldn't build a {max_threads}-thread pool: {e}"))?;
        pool.install(run_generations)
    } else {
        run_generations()
    };
    let (best, history) = outcome.ok_or_else(|| "ran zero generations".to_string())?;

    fn to_placements_dto(placements: Vec<nesting::placement::SheetPlacement>) -> Vec<SheetPlacementDto> {
        placements
            .into_iter()
            .map(|sp| SheetPlacementDto {
                sheet_index: sp.sheet_index,
                parts: sp.parts.into_iter().map(|p| PlacedPartDto { id: p.id, x: p.placement.x, y: p.placement.y, rotation: p.rotation }).collect(),
            })
            .collect()
    }

    Ok(RunNestResponse {
        history: history
            .into_iter()
            .map(|(generation, r)| NestSnapshotDto {
                generation,
                placements: to_placements_dto(r.placements),
                fitness: r.fitness,
                utilisation: r.utilisation,
                unplaced_count: r.unplaced_count,
                unplaced_ids: r.unplaced_ids,
            })
            .collect(),
        placements: to_placements_dto(best.placements),
        fitness: best.fitness,
        utilisation: best.utilisation,
        unplaced_count: best.unplaced_count,
        unplaced_ids: best.unplaced_ids,
    })
}

// rename_all = "snake_case": Tauri's default JS<->Rust argument binding
// camelCases top-level command parameter names (so `curve_tolerance` here
// would otherwise have to be called as `curveTolerance` from JS), but
// nested struct fields (RunNestRequest and everything under it) are plain
// serde with no rename_all, i.e. snake_case. Opting into snake_case for the
// command args too keeps one casing convention across the whole wire
// format instead of two, which is one fewer thing to get subtly wrong when
// hand-writing the JS call site.
// Both commands below are `async fn` and hand the actual work to
// `spawn_blocking` rather than running it inline. A plain (non-async)
// `#[tauri::command]` executes on whatever thread Tauri's IPC dispatch
// happens on - on desktop that's the same thread pumping the window's
// event loop, so a long-running synchronous command (a big DXF parse, or
// a nest run with enough generations/parts to take seconds) freezes the
// entire window - no repaint, no input, nothing - until it returns. Moving
// the work to a background thread via `spawn_blocking` and `.await`-ing it
// here keeps the event loop free the whole time.
#[tauri::command(rename_all = "snake_case")]
pub async fn import_dxf_command(path: String, curve_tolerance: f64) -> Result<Vec<PolygonDto>, String> {
    tauri::async_runtime::spawn_blocking(move || import_dxf(&path, curve_tolerance))
        .await
        .map_err(|e| format!("import task panicked: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn export_dxf_command(path: String, request: ExportDxfRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || export_dxf(&path, request))
        .await
        .map_err(|e| format!("export task panicked: {e}"))?
}

// `app: tauri::AppHandle` is one of Tauri's special injected command
// parameters - it's resolved from the running app, not sent by the JS
// caller, so `invoke("run_nest_command", { request })` on the frontend is
// unaffected by adding it here.
#[tauri::command(rename_all = "snake_case")]
pub async fn run_nest_command(app: tauri::AppHandle, request: RunNestRequest) -> Result<RunNestResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_nest_with_progress(request, |generation, generations, best_so_far| {
            // A dropped/closing window makes `emit` return an error; there's
            // no meaningful recovery from inside a progress callback, so
            // ignore it rather than aborting an otherwise-successful nest
            // run over a lost UI update.
            let _ = app.emit(
                "nest-progress",
                NestProgressDto {
                    generation,
                    generations,
                    best_fitness: best_so_far.fitness,
                    sheets_used: best_so_far.placements.len(),
                    unplaced_count: best_so_far.unplaced_count,
                    utilisation: best_so_far.utilisation,
                },
            );
        })
    })
    .await
    .map_err(|e| format!("nest task panicked: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::{NestConfigDto, PartDto, PlacementTypeDto, PointDto};

    fn square_dto(size: f64) -> PolygonDto {
        PolygonDto {
            points: vec![
                PointDto { x: 0.0, y: 0.0 },
                PointDto { x: size, y: 0.0 },
                PointDto { x: size, y: size },
                PointDto { x: 0.0, y: size },
            ],
            layer: "0".into(),
            is_circle: None,
            children: Vec::new(),
        }
    }

    fn config(generations: usize) -> NestConfigDto {
        NestConfigDto {
            placement_type: PlacementTypeDto::Gravity,
            rotations: 1,
            population_size: 6,
            mutation_rate: 15.0,
            dominant_part_area_threshold: nesting::placement::DEFAULT_DOMINANT_PART_AREA_THRESHOLD,
            curve_tolerance: 0.3,
            generations,
            margin: 0.0,
            spacing: 0.0,
            max_threads: 0,
        }
    }

    #[test]
    fn run_nest_places_a_simple_part_end_to_end() {
        let request = RunNestRequest {
            sheets: vec![square_dto(100.0)],
            parts: vec![PartDto { polygon: square_dto(10.0), quantity: 3 }],
            config: config(2),
        };

        let response = run_nest(request).expect("should nest successfully");

        assert_eq!(response.unplaced_count, 0);
        assert_eq!(response.placements.len(), 1);
        assert_eq!(response.placements[0].parts.len(), 3);
        assert!(response.utilisation > 0.0);
    }

    #[test]
    fn run_nest_history_ends_with_the_same_result_as_the_top_level_fields() {
        let request = RunNestRequest {
            sheets: vec![square_dto(100.0)],
            parts: vec![PartDto { polygon: square_dto(10.0), quantity: 3 }],
            config: config(5),
        };

        let response = run_nest(request).expect("should nest successfully");

        assert!(!response.history.is_empty(), "at least the first placed individual should count as an improvement");
        let last = response.history.last().unwrap();
        assert_eq!(last.fitness, response.fitness, "history's last entry should be the same result reported at the top level");
        assert_eq!(last.unplaced_count, response.unplaced_count);
        assert_eq!(last.placements.len(), response.placements.len());
        // generations should be non-decreasing across history (each entry
        // found no earlier than the one before it)
        for pair in response.history.windows(2) {
            assert!(pair[0].generation <= pair[1].generation);
        }
    }

    #[test]
    fn run_nest_fits_a_full_sheet_size_part_with_zero_margin_regardless_of_spacing() {
        // The exact scenario margin/spacing was built for: a part exactly
        // the sheet's size must be placeable with zero waste as long as
        // margin is 0, no matter what spacing is set to (spacing is a
        // part-to-part concern, unrelated to a single part's fit against
        // the sheet edge).
        let mut cfg = config(1);
        cfg.margin = 0.0;
        cfg.spacing = 6.5;
        let request = RunNestRequest { sheets: vec![square_dto(100.0)], parts: vec![PartDto { polygon: square_dto(100.0), quantity: 1 }], config: cfg };

        let response = run_nest(request).expect("full-sheet-size part should nest with zero margin");

        assert_eq!(response.unplaced_count, 0);
        assert_eq!(response.placements[0].parts.len(), 1);
    }

    #[test]
    fn run_nest_rejects_a_part_that_only_fits_without_margin() {
        // Same part/sheet as above, but with a real margin this time - the
        // same part must now correctly fail to place, proving margin is
        // actually enforced and not silently ignored.
        let mut cfg = config(1);
        cfg.margin = 5.0;
        cfg.spacing = 0.0;
        let request = RunNestRequest { sheets: vec![square_dto(100.0)], parts: vec![PartDto { polygon: square_dto(100.0), quantity: 1 }], config: cfg };

        let response = run_nest(request).expect("run_nest itself should still succeed, just leave the part unplaced");

        assert_eq!(response.unplaced_count, 1);
        assert!(response.placements.is_empty());
        assert_eq!(response.unplaced_ids, vec![0], "the single part (id 0, expand_parts's first id) should be reported unplaced by id, not just by count");
    }

    #[test]
    fn run_nest_respects_a_max_threads_cap() {
        let mut cfg = config(2);
        cfg.max_threads = 1;
        let request = RunNestRequest {
            sheets: vec![square_dto(100.0)],
            parts: vec![PartDto { polygon: square_dto(10.0), quantity: 3 }],
            config: cfg,
        };

        let response = run_nest(request).expect("a max_threads cap should still nest successfully, just on fewer threads");

        assert_eq!(response.unplaced_count, 0);
    }

    #[test]
    fn run_nest_rejects_a_zero_thread_count_gracefully() {
        // max_threads: 0 means "no cap" (the default), not "a pool of zero
        // threads" - make sure that sentinel doesn't accidentally reach
        // ThreadPoolBuilder::num_threads(0), which would build a pool that
        // can never run anything.
        let mut cfg = config(1);
        cfg.max_threads = 0;
        let request = RunNestRequest { sheets: vec![square_dto(100.0)], parts: vec![PartDto { polygon: square_dto(10.0), quantity: 1 }], config: cfg };
        let response = run_nest(request).expect("max_threads: 0 must mean uncapped, not a zero-thread pool");
        assert_eq!(response.unplaced_count, 0);
    }

    #[test]
    fn run_nest_enforces_spacing_between_two_placed_parts() {
        // Two parts that would just barely both fit side by side with zero
        // gap must NOT both place once spacing requires more room than the
        // sheet has for both.
        let mut cfg = config(1);
        cfg.margin = 0.0;
        cfg.spacing = 50.0; // larger than the sheet has slack for two 40-wide parts
        let request = RunNestRequest {
            sheets: vec![square_dto(100.0)],
            parts: vec![PartDto { polygon: square_dto(40.0), quantity: 2 }],
            config: cfg,
        };

        let response = run_nest(request).expect("should still run, just not fit both");

        assert_eq!(response.unplaced_count, 1, "spacing=50 between two 40-wide parts on a 100-wide sheet must leave one unplaced");
    }

    #[test]
    fn run_nest_rejects_negative_margin_or_spacing() {
        for (margin, spacing) in [(-1.0, 0.0), (0.0, -1.0)] {
            let mut cfg = config(1);
            cfg.margin = margin;
            cfg.spacing = spacing;
            let request =
                RunNestRequest { sheets: vec![square_dto(100.0)], parts: vec![PartDto { polygon: square_dto(10.0), quantity: 1 }], config: cfg };
            assert!(run_nest(request).is_err(), "margin={margin} spacing={spacing} should be rejected");
        }
    }

    #[test]
    fn run_nest_rejects_empty_sheets() {
        let request = RunNestRequest { sheets: Vec::new(), parts: vec![PartDto { polygon: square_dto(10.0), quantity: 1 }], config: config(1) };
        assert!(run_nest(request).is_err());
    }

    #[test]
    fn run_nest_rejects_empty_parts() {
        let request = RunNestRequest { sheets: vec![square_dto(100.0)], parts: Vec::new(), config: config(1) };
        assert!(run_nest(request).is_err());
    }

    #[test]
    fn run_nest_excludes_zero_quantity_parts() {
        // A part explicitly given quantity 0 contributes zero copies -
        // matches the original's plain `for (j=0; j<quantity; j++)` loop
        // for parts (no fallback-to-1; that convention only exists for
        // *sheet* quantity, a different code path with different
        // semantics). If every part is quantity 0, nothing to nest at all.
        let request =
            RunNestRequest { sheets: vec![square_dto(100.0)], parts: vec![PartDto { polygon: square_dto(10.0), quantity: 0 }], config: config(1) };
        assert!(run_nest(request).is_err());
    }

    #[test]
    fn run_nest_nests_only_the_non_zero_quantity_parts_in_a_mix() {
        let request = RunNestRequest {
            sheets: vec![square_dto(100.0)],
            parts: vec![
                PartDto { polygon: square_dto(10.0), quantity: 2 },
                PartDto { polygon: square_dto(20.0), quantity: 0 },
            ],
            config: config(2),
        };

        let response = run_nest(request).expect("should nest the non-zero-quantity part");

        assert_eq!(response.unplaced_count, 0);
        assert_eq!(response.placements[0].parts.len(), 2, "only the 2 copies of the quantity=2 part should be nested");
    }

    #[test]
    fn run_nest_rejects_zero_rotations() {
        let mut cfg = config(1);
        cfg.rotations = 0;
        let request = RunNestRequest { sheets: vec![square_dto(100.0)], parts: vec![PartDto { polygon: square_dto(10.0), quantity: 1 }], config: cfg };
        assert!(run_nest(request).is_err());
    }

    #[test]
    fn run_nest_rejects_population_size_under_two() {
        for bad_size in [0, 1] {
            let mut cfg = config(1);
            cfg.population_size = bad_size;
            let request =
                RunNestRequest { sheets: vec![square_dto(100.0)], parts: vec![PartDto { polygon: square_dto(10.0), quantity: 1 }], config: cfg };
            assert!(run_nest(request).is_err(), "population_size {bad_size} should be rejected");
        }
    }

    #[test]
    fn run_nest_with_progress_calls_the_hook_once_per_generation() {
        let request = RunNestRequest {
            sheets: vec![square_dto(100.0)],
            parts: vec![PartDto { polygon: square_dto(10.0), quantity: 3 }],
            config: config(4),
        };

        let mut seen_generations = Vec::new();
        let response = run_nest_with_progress(request, |generation, generations, best_so_far| {
            assert_eq!(generations, 4);
            assert!(best_so_far.fitness.is_finite());
            seen_generations.push(generation);
        })
        .expect("should nest successfully");

        assert_eq!(seen_generations, vec![1, 2, 3, 4]);
        assert_eq!(response.unplaced_count, 0);
    }

    #[test]
    fn export_dxf_round_trips_a_real_nest_result() {
        let sheets = vec![square_dto(100.0)];
        let parts = vec![PartDto { polygon: square_dto(10.0), quantity: 3 }];
        let request = RunNestRequest { sheets: sheets.clone(), parts: parts.clone(), config: config(2) };
        let response = run_nest(request).expect("should nest successfully");

        let out_path = std::env::temp_dir().join("rustynesting_export_dxf_test.dxf");
        let export_request = ExportDxfRequest {
            sheets,
            parts,
            placements: response.placements,
            sheet_spacing: 20.0,
            include_sheet_outline: true,
        };
        export_dxf(out_path.to_str().unwrap(), export_request).expect("export should succeed");

        let drawing = Drawing::load_file(&out_path).expect("exported file should be a readable DXF");
        let polyline_count = drawing.entities().filter(|e| matches!(e.specific, dxf::entities::EntityType::LwPolyline(_))).count();
        // 1 sheet outline + 3 placed parts
        assert_eq!(polyline_count, 4);

        let _ = std::fs::remove_file(&out_path);
    }

    #[test]
    fn export_dxf_omits_the_sheet_outline_when_not_requested() {
        let sheets = vec![square_dto(100.0)];
        let parts = vec![PartDto { polygon: square_dto(10.0), quantity: 2 }];
        let request = RunNestRequest { sheets: sheets.clone(), parts: parts.clone(), config: config(2) };
        let response = run_nest(request).expect("should nest successfully");

        let out_path = std::env::temp_dir().join("rustynesting_export_dxf_no_outline_test.dxf");
        let export_request =
            ExportDxfRequest { sheets, parts, placements: response.placements, sheet_spacing: 10.0, include_sheet_outline: false };
        export_dxf(out_path.to_str().unwrap(), export_request).expect("export should succeed");

        let drawing = Drawing::load_file(&out_path).expect("exported file should be a readable DXF");
        let polyline_count = drawing.entities().filter(|e| matches!(e.specific, dxf::entities::EntityType::LwPolyline(_))).count();
        assert_eq!(polyline_count, 2, "only the 2 placed parts, no sheet outline");

        let _ = std::fs::remove_file(&out_path);
    }

    #[test]
    fn export_dxf_rejects_negative_sheet_spacing() {
        let sheets = vec![square_dto(100.0)];
        let parts = vec![PartDto { polygon: square_dto(10.0), quantity: 1 }];
        let request = RunNestRequest { sheets: sheets.clone(), parts: parts.clone(), config: config(1) };
        let response = run_nest(request).expect("should nest successfully");

        let export_request =
            ExportDxfRequest { sheets, parts, placements: response.placements, sheet_spacing: -5.0, include_sheet_outline: false };
        assert!(export_dxf("unused.dxf", export_request).is_err());
    }

    #[test]
    fn import_dxf_reads_the_real_flat_fixture() {
        // reuses the same fixture geometry.rs's own dxf_fixtures.rs tests
        // validate against
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/FLAT.dxf");
        let polygons = import_dxf(path, 0.3).expect("fixture should parse");
        assert!(!polygons.is_empty());
    }

    #[test]
    fn import_dxf_reports_a_missing_file_as_an_error_not_a_panic() {
        assert!(import_dxf("does-not-exist.dxf", 0.3).is_err());
    }
}
