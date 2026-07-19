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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use dxf::Drawing;
use geometry::clearance::{prepare_part, prepare_sheet};
use geometry::dxf_export::{PlacedShape, SheetLayout};
use geometry::dxf_import::LayeredPolygon;
use nesting::cache::NfpCache;
use nesting::consolidation::{recompute_totals, refine_consolidation};
use nesting::dispatch;
use nesting::ga::{is_better_nest, GeneticAlgorithm};
use nesting::placement::PlaceResult;
use tauri::{Emitter, Manager};

use crate::dto::{
    expand_parts, BestResultDto, ExportDxfRequest, NestConfigDto, NestProgressDto, NestSnapshotDto, NestTickDto, PlacedPartDto, PolygonDto,
    RunNestRequest, RunNestResponse, SheetPlacementDto,
};

/// Shared per-process nest-run state, managed Tauri state
/// (`app.manage(NestCancelFlag::default())` in `main.rs`). Both fields are
/// `Arc`s so `run_nest_command` can clone them into the `spawn_blocking`
/// closure that actually runs the GA loop, while `cancel_nest_command` sets
/// `cancel` through the same `State` handle from a separate, concurrent IPC
/// call.
///
/// `running` makes "only one nest at a time" a backend-enforced guarantee
/// instead of trusting the frontend to keep the RUN button disabled: without
/// it, two overlapping `run_nest_command` calls would share one `cancel`
/// flag with no way to tell them apart, and the second call's start-of-run
/// reset could silently swallow a stop meant for the first.
#[derive(Default)]
pub struct NestCancelFlag {
    cancel: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
}

/// Requests that the in-flight `run_nest_command` call (if any) stop after
/// its current generation instead of running all `config.generations` -
/// there's no "which run" to target since only one can ever be in flight at
/// a time (`run_nest_command` rejects a second call outright, see
/// `NestCancelFlag::running`). A cancel with nothing running is a harmless
/// no-op.
#[tauri::command(rename_all = "snake_case")]
pub fn cancel_nest_command(state: tauri::State<NestCancelFlag>) {
    state.cancel.store(true, Ordering::Relaxed);
}

/// Appends one line to a log file that survives across app restarts
/// (`<app_log_dir>/rustynesting.log`) - the frontend's own console panel
/// (`app.js`'s `logLine`) calls this for every line it prints, so import/run/
/// export/error/cancel history from a previous session is still readable
/// afterwards, not just while the window is open. Delegates the actual
/// write to `nesting::benchmark_log::append_benchmark_line` rather than
/// hand-rolling another `OpenOptions`/`writeln!` pair - that helper already
/// rotates the file to `.old` past 5MB, which a hand-rolled version here
/// would otherwise have to duplicate (or, as a first pass of this command
/// did, simply lack, leaving the log to grow unbounded).
///
/// `async` + `spawn_blocking`, like `import_dxf_command`/`export_dxf_command`
/// below, rather than a plain synchronous command - matches this file's own
/// established rule (see the comment above those two) that a blocking
/// command runs on whatever thread services IPC dispatch, which a synchronous
/// file write would otherwise tie up too, however briefly.
#[tauri::command(rename_all = "snake_case")]
pub async fn append_log_command(app: tauri::AppHandle, line: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        nesting::benchmark_log::append_benchmark_line(&dir.join("rustynesting.log"), &line);
        Ok(())
    })
    .await
    .map_err(|e| format!("log write task panicked: {e}"))?
}

fn config_file_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

/// Persists the last-used nest config (`<app_config_dir>/config.json`) so a
/// new session can start from wherever the last one left off, instead of
/// always resetting to the hardcoded defaults in `index.html` - `app.js`
/// calls this right before every `run_nest_command`. `async` +
/// `spawn_blocking` for the same reason as `append_log_command` above.
#[tauri::command(rename_all = "snake_case")]
pub async fn save_config_command(app: tauri::AppHandle, config: NestConfigDto) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = config_file_path(&app)?;
        let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
        std::fs::write(path, json).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("config save task panicked: {e}"))?
}

/// Loads whatever `save_config_command` last wrote, if anything -
/// `Ok(None)` (not an error) the first time the app ever runs, before any
/// config has been saved. `async` + `spawn_blocking` for the same reason as
/// `append_log_command` above.
#[tauri::command(rename_all = "snake_case")]
pub async fn load_config_command(app: tauri::AppHandle) -> Result<Option<NestConfigDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = config_file_path(&app)?;
        if !path.exists() {
            return Ok(None);
        }
        let json = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        serde_json::from_str(&json).map(Some).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("config load task panicked: {e}"))?
}

fn best_result_file_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("best_result.json"))
}

/// Matches `nesting::ga::is_better_nest`'s ordering exactly (fewer unplaced
/// first, then fewer sheets, then higher utilisation) - kept as its own tiny
/// copy here rather than reusing that function directly, since this compares
/// primitives extracted from a `BestResultDto`/`RunNestResponse` pair, not
/// two `nesting::placement::PlaceResult`s.
fn is_better_result(a_unplaced: usize, a_sheets: usize, a_util: f64, b_unplaced: usize, b_sheets: usize, b_util: f64) -> bool {
    if a_unplaced != b_unplaced {
        return a_unplaced < b_unplaced;
    }
    if a_sheets != b_sheets {
        return a_sheets < b_sheets;
    }
    a_util > b_util
}

/// Loads the best nest result saved across every run this app has ever
/// completed (see `run_nest_command`'s own doc comment for when this gets
/// updated) - `app.js` calls this once on startup to offer "recover last
/// session's best, or start fresh". `Ok(None)` (not an error) if nothing's
/// been saved yet.
#[tauri::command(rename_all = "snake_case")]
pub async fn load_best_result_command(app: tauri::AppHandle) -> Result<Option<BestResultDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = best_result_file_path(&app)?;
        if !path.exists() {
            return Ok(None);
        }
        let json = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        serde_json::from_str(&json).map(Some).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("best-result load task panicked: {e}"))?
}

/// Erases the saved best-result file - "start fresh" on the recover-prompt
/// `load_best_result_command` triggers. A no-op (not an error) if nothing
/// was ever saved.
#[tauri::command(rename_all = "snake_case")]
pub async fn clear_best_result_command(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = best_result_file_path(&app)?;
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| format!("best-result clear task panicked: {e}"))?
}

/// Reads a DXF file from disk and returns its closed profiles as a
/// parent/hole tree (`geometry::dxf_import::build_polygon_tree`) - the
/// frontend is expected to turn these into `PartDto`s (assigning quantities)
/// for a later `run_nest` call, or into sheets directly.
///
/// `TEXT`/`MTEXT` entities (part labels, engraved numbers, etc.) have no
/// closed boundary of their own, so they don't become tree nodes - they're
/// attached to whichever profile contains them (`attach_texts`) and ride
/// along in that node's own `texts`, surviving rotation/placement/export the
/// same way a hole does. See `geometry::dxf_import`'s module doc comment.
pub fn import_dxf(path: &str, curve_tolerance: f64) -> Result<Vec<PolygonDto>, String> {
    let drawing = Drawing::load_file(path).map_err(|e| format!("couldn't parse {path} as DXF: {e}"))?;

    let flat = geometry::dxf_import::entities_to_polygons(drawing.entities(), curve_tolerance);
    let texts = geometry::dxf_import::entities_to_texts(drawing.entities());
    let mut tree = geometry::dxf_import::build_polygon_tree(flat);
    geometry::dxf_import::attach_texts(&mut tree, texts);

    Ok(tree.iter().map(PolygonDto::from).collect())
}

/// Writes the given nest result back out to a DXF file at `path` - new
/// scope, not a port (the original app never wrote DXF locally at all, see
/// `docs/PORT_STATUS.md`'s Phase 7 table). Takes exactly what the frontend
/// already has after a `run_nest_command` call (`request.sheets` for the
/// *true*, unpadded geometry - export never uses the internally padded
/// shapes `run_nest` builds - `response.parts_by_id`, and that same call's
/// `response.placements`) rather than re-deriving anything server-side.
///
/// Deliberately takes `parts_by_id` straight from `RunNestResponse`, not a
/// `parts`/quantity list to re-run `expand_parts` on: that id assignment is
/// a plain sequential counter over caller-supplied input order, so re-
/// deriving it from a second, client-resent copy is only ever correct if
/// that copy exactly matches what actually produced `placements`' ids - and
/// nothing enforces that. A mismatch there wouldn't error; `parts_by_id.get(&p.id)`
/// would still resolve to *some* entry, silently writing the wrong part's
/// outline at a placement's coordinates.
pub fn export_dxf(path: &str, request: ExportDxfRequest) -> Result<(), String> {
    if request.sheet_spacing < 0.0 {
        return Err("sheet spacing must be >= 0".into());
    }

    let true_sheets: Vec<LayeredPolygon> = request.sheets.into_iter().map(Into::into).collect();
    let mut parts_by_id: HashMap<usize, LayeredPolygon> = request.parts_by_id.into_iter().map(|(id, dto)| (id, dto.into())).collect();

    let layouts: Vec<SheetLayout> = request
        .placements
        .into_iter()
        .map(|sp| {
            let sheet = true_sheets.get(sp.sheet_index).cloned().ok_or_else(|| format!("placement references sheet_index {} out of range", sp.sheet_index))?;
            let parts = sp
                .parts
                .into_iter()
                .map(|p| {
                    // `.remove`, not `.get().cloned()`: `parts_by_id` is
                    // local, owned, and never read again after this loop -
                    // every real id appears in exactly one placement, so
                    // taking ownership here is free (no clone) and, as a
                    // bonus, turns an accidental duplicate placement id
                    // into a hard "unknown part id" error (the second
                    // occurrence finds it already removed) instead of
                    // silently succeeding twice.
                    let shape = parts_by_id.remove(&p.id).ok_or_else(|| format!("placement references unknown part id {}", p.id))?;
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
    run_nest_with_progress(request, |_, _, _| {}, || false, |_, _, _| {})
}

/// Everything `run_nest_with_progress` and `run_nest_live_preview` both need
/// before they diverge: validated, padded sheets/parts and the placement
/// config to run against. Kept as its own struct/function (not inlined
/// twice) so the ~15 validation checks below and the sheet/part padding
/// logic have exactly one place they can go stale, not two.
struct PreparedNestInputs {
    sheets: Vec<LayeredPolygon>,
    /// Padded (via `geometry::clearance::prepare_part`) - what the engine
    /// actually places against.
    parts_by_id: HashMap<usize, LayeredPolygon>,
    /// True, unpadded geometry - what `RunNestResponse::parts_by_id` reports
    /// back to the caller.
    parts_by_id_dto: HashMap<usize, PolygonDto>,
    shape_ids: HashMap<usize, usize>,
    adam: Vec<usize>,
    placement_config: nesting::placement::PlacementConfig,
}

/// Validates `request` and builds the padded sheets/parts both nest-running
/// paths place against - see `PreparedNestInputs`'s own doc comment for why
/// this is shared rather than duplicated. A pure extraction of what used to
/// be `run_nest_with_progress`'s own opening ~80 lines; behavior unchanged.
fn prepare_nest_inputs(request: RunNestRequest) -> Result<PreparedNestInputs, String> {
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
    // These three don't have a panic path behind them the way the checks
    // above do, but they were also entirely unvalidated - a negative
    // curve_tolerance, an out-of-[0,100]-range mutation_rate, or a
    // dominant_part_area_threshold outside (0, 1] silently produces
    // nonsense GA/placement behavior with no feedback at all. Bounds match
    // what `index.html`'s own inputs already constrain client-side
    // (`min`/`max` on `cfg-mutation`/`import-tolerance`/`cfg-dominant`).
    if !(0.0..=100.0).contains(&request.config.mutation_rate) {
        return Err("mutation_rate must be between 0 and 100".into());
    }
    if request.config.curve_tolerance <= 0.0 {
        return Err("curve_tolerance must be > 0".into());
    }
    if !(request.config.dominant_part_area_threshold > 0.0 && request.config.dominant_part_area_threshold <= 1.0) {
        return Err("dominant_part_area_threshold must be between 0 (exclusive) and 1".into());
    }
    let margin = request.config.margin;
    let spacing = request.config.spacing;

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
            Ok(LayeredPolygon { points, layer: sheet.layer.clone(), is_circle: sheet.is_circle, children: sheet.children.clone(), texts: sheet.texts.clone() })
        })
        .collect::<Result<_, &str>>()?;

    let (adam, true_parts_by_id, shape_ids) = expand_parts(request.parts);
    if adam.is_empty() {
        return Err("every part had quantity 0".into());
    }
    // This is the authoritative id -> shape mapping `RunNestResponse::
    // parts_by_id` carries out, so a later `export_dxf_command` call never
    // has to re-derive it from a second, client-resent `parts` list (see
    // that DTO field's own doc comment).
    let parts_by_id_dto: HashMap<usize, PolygonDto> = true_parts_by_id.iter().map(|(&id, part)| (id, PolygonDto::from(part))).collect();
    let parts_by_id: HashMap<usize, LayeredPolygon> = true_parts_by_id
        .iter()
        .map(|(&id, part)| {
            let points = prepare_part(&part.points, spacing).ok_or("spacing leaves a part with no usable outline")?;
            Ok((id, LayeredPolygon { points, layer: part.layer.clone(), is_circle: part.is_circle, children: part.children.clone(), texts: part.texts.clone() }))
        })
        .collect::<Result<_, &str>>()?;

    let placement_config = request.config.placement_config();

    Ok(PreparedNestInputs { sheets, parts_by_id, parts_by_id_dto, shape_ids, adam, placement_config })
}

/// Shared by `run_nest_with_progress` and `run_nest_live_preview` - both
/// end up with a `Vec<nesting::placement::SheetPlacement>` to hand back to
/// the frontend in the same `SheetPlacementDto` shape.
fn to_placements_dto(placements: Vec<nesting::placement::SheetPlacement>) -> Vec<SheetPlacementDto> {
    placements
        .into_iter()
        .map(|sp| SheetPlacementDto {
            sheet_index: sp.sheet_index,
            parts: sp.parts.into_iter().map(|p| PlacedPartDto { id: p.id, x: p.placement.x, y: p.placement.y, rotation: p.rotation }).collect(),
        })
        .collect()
}

/// Same as `run_nest`, but calls `on_progress(generation, total_generations,
/// best_so_far)` after every completed generation - the hook the
/// `run_nest_command` Tauri wrapper uses to `emit` a live "nest-progress"
/// event per generation, so the UI can show what's happening instead of
/// blocking silently until the whole run finishes. Plain `run_nest` (used by
/// every test below and any caller that doesn't care) is just this with a
/// no-op hook and a `should_cancel` that never fires.
///
/// `should_cancel` is checked once per generation (`run_nest_command` wires
/// it to `NestCancelFlag`, set by `cancel_nest_command`); when it returns
/// true the loop stops after whatever generation just finished and the
/// response reports `cancelled: true` with the best result found so far,
/// rather than erroring - a user-requested stop is a normal outcome, not a
/// failure.
///
/// `on_individual_placed(generation, done, total)` forwards
/// `nesting::dispatch::run_generation`'s own per-individual progress hook
/// (see its doc comment) - called once up front with `done: 0` before a
/// generation's individuals start, then again after each one finishes
/// placing. A single individual's placement can be real, tens-of-seconds
/// work against non-trivial geometry; without this, `on_progress` above is
/// the *only* signal, and it only fires once an entire generation
/// completes - which for a slow generation is indistinguishable from the
/// run having stalled.
///
/// Inlines the generation loop `nesting::dispatch::run` would otherwise do,
/// rather than adding a callback parameter to that function - `dispatch`'s
/// own doc comment already calls progress plumbing out as "left to whatever
/// wraps this loop", so this is that wrapper, not a fork of engine logic.
///
// Live preview - `on_generation_improved`/`on_start` params commented out
// here (see `NestConfigDto::live_visualization`'s own comment for why, not
// deleted, easy to restore later). They fired at the exact same trigger
// `RunNestResponse::history` already uses (whenever a result beats the
// current best - not once per generation regardless of whether anything
// changed) and once right after validation with the true/unpadded id ->
// shape map, respectively - `run_nest_command`'s `live_visualization` path
// used them to stream the *full* winning placement to the frontend for a
// live, generation-by-generation replay.
pub fn run_nest_with_progress(
    request: RunNestRequest,
    mut on_progress: impl FnMut(usize, usize, &PlaceResult) + Send,
    should_cancel: impl Fn() -> bool + Sync + Send,
    on_individual_placed: impl Fn(usize, usize, usize) + Sync + Send,
    // mut on_generation_improved: impl FnMut(usize, usize, &PlaceResult) + Send,
    // on_start: impl FnOnce(&HashMap<usize, PolygonDto>),
) -> Result<RunNestResponse, String> {
    // Read before `prepare_nest_inputs` consumes `request` - none of these
    // four are needed by the shared validation/padding logic, only by the
    // GA loop below.
    let max_threads = request.config.max_threads;
    let ga_config = request.config.ga_config();
    let generations = request.config.generations;
    let seed = request.config.seed;

    let PreparedNestInputs { sheets, parts_by_id, parts_by_id_dto, shape_ids, adam, placement_config } = prepare_nest_inputs(request)?;
    // on_start(&parts_by_id_dto);

    let mut ga = GeneticAlgorithm::new(adam, ga_config, Vec::new(), seed);
    // One cache for the whole run - every individual, every generation -
    // not a fresh one per generation/individual. That's what turns the same
    // (part id, part id, rotation, rotation) NFP recurring across the GA's
    // many individuals into a cache hit instead of a recompute; see
    // `nesting::placement::place_parts`'s own doc comment.
    let cache = NfpCache::new();

    // Captured by reference, not moved, into the `move` closure below - all
    // four (`sheets`, `parts_by_id`, `shape_ids`, `cache`) are needed again
    // afterward, to run consolidation against the same cache the GA run
    // already populated. `placement_config` isn't captured this way: the
    // closure needs to mutate its *own* copy over the run (see
    // `widenRotationsIfStalled` below) and hand back whatever it ends up
    // at, for consolidation to use afterward too - a plain `&` wouldn't let
    // it do that.
    let sheets_ref = &sheets;
    let parts_by_id_ref = &parts_by_id;
    let shape_ids_ref = &shape_ids;
    let cache_ref = &cache;
    let initial_placement_config = placement_config.clone();

    // Port of `widenRotationsIfStalled`: if the best result hasn't improved
    // in a while, the search is more likely stuck on a rotation grid too
    // coarse to find a better fit than it is to benefit from trying more of
    // the same angles again - widen it. Doubling (not resizing to an
    // arbitrary count) is what keeps this safe alongside the shared
    // `NfpCache`: {0,90,180,270} is an exact subset of {0,45,90,...,315}, so
    // widening never invalidates NFPs already cached for the coarser
    // angles, only adds new ones to compute.
    //
    // `ROTATION_STAGNATION_LIMIT` no longer matches the original's constant
    // (was 10): a real benchmark session (24-combination grid sweep against
    // the `FLAT.dxf`/`FLAT-struck.dxf` fixtures, see `docs/PORT_STATUS.md`)
    // found `rotations=8` and up is a *strict downgrade* vs `rotations=4`
    // for this job's mostly-rectangular parts (102-103 sheets vs 100-101,
    // every combination tried) - consistent with the already-documented
    // rotation-angle-grid quirk. A live 300-generation run confirmed this
    // in practice: it landed at 102 sheets, worse than a plain
    // never-widened `rotations=4` run's 100, because stagnation-triggered
    // widening fired and pushed past the angle grid that's actually best
    // for this part mix. Raised from 10 to 60 so the mechanism still
    // rescues a genuinely stuck job given enough generations, but won't
    // trigger within a normal run on a job shaped like this one.
    const ROTATION_STAGNATION_LIMIT: usize = 60;
    const ROTATION_CAP: u32 = 32;

    let run_generations = move || {
        let mut placement_config = initial_placement_config;
        let mut best: Option<PlaceResult> = None;
        // Every time `best` actually improves, keep a copy - not just the
        // final one - so the frontend can show "the other nests it tried"
        // (`RunNestResponse::history`), not only the winner. Bounded by how
        // often a genuinely better individual turns up, which in practice
        // is far less than once per generation once the GA converges - not
        // one full snapshot per generation regardless of `generations`.
        let mut history: Vec<(usize, PlaceResult)> = Vec::new();
        let mut cancelled = false;
        let mut generations_since_improvement: usize = 0;
        for generation in 1..=generations {
            if should_cancel() {
                cancelled = true;
                break;
            }
            // `should_cancel` is also passed down into `run_generation`
            // itself (not just checked here, between generations) - a
            // generation is a parallel per-individual placement pass that
            // can take a long time on its own, and without an interior
            // check a stop request would only ever take effect at the
            // boundary between whole generations.
            let results = dispatch::run_generation(&mut ga, sheets_ref, parts_by_id_ref, shape_ids_ref, &placement_config, &should_cancel, &|done, total| {
                on_individual_placed(generation, done, total)
            }, cache_ref);
            let mut improved_this_generation = false;
            for result in results {
                if best.as_ref().is_none_or(|b| is_better_nest(&result, b)) {
                    best = Some(result.clone());
                    // on_generation_improved(generation, generations, &result); // live preview, commented out - see NestConfigDto::live_visualization
                    history.push((generation, result));
                    improved_this_generation = true;
                }
            }
            if let Some(so_far) = &best {
                on_progress(generation, generations, so_far);
            }
            // Re-checked after the generation too: `run_generation` may have
            // been cut short mid-population by the same flag, in which case
            // this loop must stop here rather than starting another
            // generation on a population `run_generation` deliberately left
            // half-evaluated (see its own doc comment).
            if should_cancel() {
                cancelled = true;
                break;
            }

            if improved_this_generation {
                generations_since_improvement = 0;
            } else {
                generations_since_improvement += 1;
                if generations_since_improvement >= ROTATION_STAGNATION_LIMIT && placement_config.rotations < ROTATION_CAP {
                    placement_config.rotations = (placement_config.rotations * 2).min(ROTATION_CAP);
                    ga.set_rotations(placement_config.rotations);
                    generations_since_improvement = 0;
                }
            }
        }
        (best, history, cancelled, placement_config)
    };

    // 0 (the default) means "no cap" - just use rayon's own global pool, no
    // need to spin up a second one. A cap builds a fresh scoped pool for
    // this call only, since rayon's global pool can only be configured once
    // per process (a second `build_global()` call would panic) and
    // different calls may want different caps.
    let (best, history, cancelled, placement_config) = if max_threads > 0 {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(max_threads)
            .build()
            .map_err(|e| format!("couldn't build a {max_threads}-thread pool: {e}"))?;
        pool.install(run_generations)
    } else {
        run_generations()
    };
    // `best` is only ever `None` if no individual was ever placed - either
    // `generations == 0` (the loop body never runs) or a cancel that landed
    // before the very first individual finished. The latter is a normal
    // outcome (see this function's own doc comment: "a user-requested stop
    // is a normal outcome, not a failure"), not an error - report it as a
    // zero result (nothing placed, everything still unplaced) rather than
    // failing the whole call.
    let best = match best {
        Some(b) => b,
        None if cancelled => {
            let mut unplaced_ids: Vec<usize> = parts_by_id_dto.keys().copied().collect();
            unplaced_ids.sort_unstable();
            PlaceResult {
                placements: Vec::new(),
                fitness: 0.0,
                area: 0.0,
                total_area: 0.0,
                utilisation: 0.0,
                unplaced_count: unplaced_ids.len(),
                unplaced_ids,
            }
        }
        None => return Err("ran zero generations".to_string()),
    };

    // `place_parts` opens sheets once and never revisits them - a classic
    // cause of excess sheet usage in single-pass bin-packing (a sheet closed
    // early off one big part can sit mostly empty while a part that would
    // fit its leftover space ends up opening a whole new sheet instead).
    // `refine_consolidation` fixes this up on the already-computed winner,
    // relocating parts between already-open sheets and dropping any sheet
    // that ends up fully drained - budget-capped so it stays cheap relative
    // to the GA run that already ran ahead of it. Skipped when there's
    // nothing to relocate (cancelled-with-zero-parts).
    let best = if best.placements.is_empty() {
        best
    } else {
        let deadline = Instant::now() + Duration::from_secs(2);
        let refined = refine_consolidation(best.placements, &parts_by_id, &shape_ids, &sheets, &placement_config, deadline, &cache);
        if refined.changed {
            let totals = recompute_totals(&refined.allplacements, &parts_by_id, &sheets);
            PlaceResult {
                placements: refined.allplacements,
                fitness: best.fitness,
                area: totals.total_placed_area,
                total_area: totals.total_usable_sheet_area,
                utilisation: totals.utilisation,
                unplaced_count: best.unplaced_count,
                unplaced_ids: best.unplaced_ids,
            }
        } else {
            PlaceResult { placements: refined.allplacements, ..best }
        }
    };

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
        cancelled,
        parts_by_id: parts_by_id_dto,
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
pub async fn run_nest_command(app: tauri::AppHandle, state: tauri::State<'_, NestCancelFlag>, request: RunNestRequest) -> Result<RunNestResponse, String> {
    // Backend-enforced single-flight: reject a second run outright rather
    // than sharing `cancel` between two in-flight runs (whichever cancelled
    // second would silently reset the flag the first run is still reading).
    // `swap` is the check-and-set in one atomic step - two calls racing here
    // can't both observe `false`.
    if state.running.swap(true, Ordering::AcqRel) {
        return Err("a nest is already running".to_string());
    }
    // Reset before starting: a stale `true` left over from a previous run's
    // cancel would otherwise stop this new run at generation 1.
    state.cancel.store(false, Ordering::Relaxed);
    // Cloned before `request` moves into `spawn_blocking` below - a
    // recovered `BestResultDto` needs sheet geometry to render against in a
    // later session, and `request` itself won't survive past this call.
    let request_sheets = request.sheets.clone();
    // Live preview - commented out (see `NestConfigDto::live_visualization`'s
    // own comment for why), so `run_nest_with_progress` only ever gets
    // called the one way below now, not branched on a `live_visualization`
    // flag.
    // let live_visualization = request.config.live_visualization;
    // Cloned once here so the post-run persistence step below can own one -
    // `AppHandle` is cheap to clone (an `Arc` internally).
    let app_for_best = app.clone();
    let cancel_flag = state.cancel.clone();
    let app_for_progress = app.clone();
    let app_for_tick = app;
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_nest_with_progress(
            request,
            move |generation, generations, best_so_far| {
                // A dropped/closing window makes `emit` return an error; there's
                // no meaningful recovery from inside a progress callback, so
                // ignore it rather than aborting an otherwise-successful nest
                // run over a lost UI update.
                let _ = app_for_progress.emit(
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
            },
            move || cancel_flag.load(Ordering::Relaxed),
            // Fires far more often than the progress event above - once up
            // front and once per individual placed, inside a single
            // generation - so the UI has something to show during a slow
            // generation instead of going quiet until it finishes. See
            // `run_nest_with_progress`'s own doc comment for why this is
            // load-bearing, not just a nicety.
            move |generation, done, total| {
                let _ = app_for_tick.emit("nest-tick", NestTickDto { generation, individuals_done: done, individuals_total: total });
            },
            // Live preview args, commented out along with the params
            // themselves in `run_nest_with_progress` - see that function's
            // own comment.
            // move |generation, generations, result: &PlaceResult| {
            //     if !live_visualization {
            //         return;
            //     }
            //     let _ = app_for_live_result.emit(
            //         "nest-live-generation-result",
            //         LiveGenerationResultDto {
            //             generation,
            //             generations,
            //             fitness: result.fitness,
            //             unplaced_count: result.unplaced_count,
            //             placements: to_placements_dto(result.placements.clone()),
            //         },
            //     );
            // },
            // move |parts_by_id| {
            //     if !live_visualization {
            //         return;
            //     }
            //     let _ = app_for_live_start.emit("nest-live-start", parts_by_id);
            // },
        )
    })
    .await
    .map_err(|e| format!("nest task panicked: {e}"));
    state.running.store(false, Ordering::Release);
    // `result` is `Result<Result<RunNestResponse, String>, String>` - the
    // outer `Result` from `spawn_blocking`'s `JoinError`, the inner from
    // `run_nest_with_progress` itself - so both `?`s are needed to reach the
    // actual response before persisting it below.
    let response = result??;

    // Best-effort persistence: a cancelled/empty run has nothing worth
    // keeping, and any I/O failure here must never fail an otherwise
    // successful nest - the frontend already has `response` regardless.
    if !response.placements.is_empty() {
        let candidate = BestResultDto {
            placements: response.placements.clone(),
            fitness: response.fitness,
            utilisation: response.utilisation,
            unplaced_count: response.unplaced_count,
            unplaced_ids: response.unplaced_ids.clone(),
            parts_by_id: response.parts_by_id.clone(),
            sheets: request_sheets,
        };
        tauri::async_runtime::spawn_blocking(move || {
            let path = best_result_file_path(&app_for_best)?;
            let existing: Option<BestResultDto> = std::fs::read_to_string(&path)
                .ok()
                .and_then(|json| serde_json::from_str(&json).ok());
            let should_write = match &existing {
                None => true,
                Some(prev) => is_better_result(
                    candidate.unplaced_count,
                    candidate.placements.len(),
                    candidate.utilisation,
                    prev.unplaced_count,
                    prev.placements.len(),
                    prev.utilisation,
                ),
            };
            if should_write {
                let json = serde_json::to_string_pretty(&candidate).map_err(|e| e.to_string())?;
                std::fs::write(path, json).map_err(|e| e.to_string())?;
            }
            Ok::<(), String>(())
        });
    }

    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::{NestConfigDto, PartDto, PlacementTypeDto, PointDto, TextDto};

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
            texts: Vec::new(),
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
            seed: 0,
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
    fn run_nest_consolidates_a_sparse_sheet_the_dominant_area_shortcut_leaves_behind() {
        // Same shape of scenario as `nesting::consolidation`'s own
        // `drains_a_sparse_sheet_into_another_when_relocation_fits` test, but
        // exercised end to end through `run_nest` - this is the regression
        // test for `refine_consolidation` actually being wired into the
        // command, not just built and unit-tested in isolation. Two 1000x1000
        // sheets; a 950x950 part is 90.25% of a sheet - past the default 90%
        // dominant-area threshold, so `place_parts`'s greedy pass closes that
        // sheet immediately without ever trying the second, much smaller
        // part on it, even though its leftover margin has real room. Without
        // consolidation this nests onto 2 sheets; with it, the small part
        // should get relocated onto sheet 0's margin and the second sheet
        // dropped entirely.
        let request = RunNestRequest {
            sheets: vec![square_dto(1000.0), square_dto(1000.0)],
            parts: vec![PartDto { polygon: square_dto(950.0), quantity: 1 }, PartDto { polygon: square_dto(20.0), quantity: 1 }],
            config: config(1),
        };

        let response = run_nest(request).expect("should nest successfully");

        assert_eq!(response.unplaced_count, 0);
        assert_eq!(response.placements.len(), 1, "consolidation should have drained the second sheet, leaving both parts on one");
        assert_eq!(response.placements[0].parts.len(), 2);
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

    /// Regression test: `mutation_rate`/`curve_tolerance`/
    /// `dominant_part_area_threshold` used to be the only three fields on
    /// `NestConfigDto` with no validation at all - no panic risk behind
    /// them, but a negative `curve_tolerance` or an out-of-range
    /// `dominant_part_area_threshold` would silently produce nonsense GA
    /// behavior with zero feedback to the caller.
    #[test]
    fn run_nest_rejects_out_of_range_mutation_rate_curve_tolerance_and_dominant_threshold() {
        for (mutation_rate, curve_tolerance, dominant) in [
            (-1.0, 0.3, 0.9),   // mutation_rate below 0
            (101.0, 0.3, 0.9),  // mutation_rate above 100
            (15.0, 0.0, 0.9),   // curve_tolerance not > 0
            (15.0, -0.1, 0.9),  // curve_tolerance negative
            (15.0, 0.3, 0.0),   // dominant_part_area_threshold not > 0
            (15.0, 0.3, 1.5),   // dominant_part_area_threshold above 1
        ] {
            let mut cfg = config(1);
            cfg.mutation_rate = mutation_rate;
            cfg.curve_tolerance = curve_tolerance;
            cfg.dominant_part_area_threshold = dominant;
            let request =
                RunNestRequest { sheets: vec![square_dto(100.0)], parts: vec![PartDto { polygon: square_dto(10.0), quantity: 1 }], config: cfg };
            assert!(
                run_nest(request).is_err(),
                "mutation_rate={mutation_rate} curve_tolerance={curve_tolerance} dominant_part_area_threshold={dominant} should be rejected"
            );
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
        let response = run_nest_with_progress(
            request,
            |generation, generations, best_so_far| {
                assert_eq!(generations, 4);
                assert!(best_so_far.fitness.is_finite());
                seen_generations.push(generation);
            },
            || false,
            |_, _, _| {},
        )
        .expect("should nest successfully");

        assert_eq!(seen_generations, vec![1, 2, 3, 4]);
        assert_eq!(response.unplaced_count, 0);
        assert!(!response.cancelled);
    }

    #[test]
    fn run_nest_with_progress_stops_early_when_cancelled() {
        let request = RunNestRequest {
            sheets: vec![square_dto(100.0)],
            parts: vec![PartDto { polygon: square_dto(10.0), quantity: 3 }],
            config: config(20),
        };

        // should_cancel is now `Fn + Sync` (called from multiple rayon
        // threads inside dispatch::run_generation, not just once per
        // generation), so this needs a thread-safe counter, not a plain
        // captured `let mut`.
        let checks = std::sync::atomic::AtomicUsize::new(0);
        let response = run_nest_with_progress(request, |_, _, _| {}, || checks.fetch_add(1, Ordering::Relaxed) >= 2, |_, _, _| {})
            .expect("should still return the best result found so far");

        assert!(response.cancelled);
    }

    #[test]
    fn run_nest_with_progress_reports_per_individual_ticks_within_a_generation() {
        let request = RunNestRequest {
            sheets: vec![square_dto(100.0)],
            parts: vec![PartDto { polygon: square_dto(10.0), quantity: 3 }],
            config: config(2),
        };

        let ticks = std::sync::Mutex::new(Vec::new());
        let response = run_nest_with_progress(request, |_, _, _| {}, || false, |generation, done, total| {
            ticks.lock().unwrap().push((generation, done, total));
        })
        .expect("should nest successfully");

        let ticks = ticks.into_inner().unwrap();
        assert!(!ticks.is_empty(), "should see at least one tick per generation");
        // every tick's generation is within range, and the upfront (done: 0)
        // tick appears before any individual actually finishes for that
        // generation
        for &(generation, _, _) in &ticks {
            assert!((1..=2).contains(&generation));
        }
        assert!(ticks.iter().any(|&(_, done, _)| done == 0), "the upfront tick (0, total) should appear");
        assert_eq!(response.unplaced_count, 0);
    }

    #[test]
    fn run_nest_with_progress_reports_a_graceful_cancelled_result_when_stopped_before_any_placement() {
        // Cancelling immediately (before generation 1 ever gets a result)
        // used to return an Err ("cancelled before any nest was found"),
        // contradicting this function's own doc comment that a
        // user-requested stop is a normal outcome, not a failure. It must
        // now succeed with cancelled: true and every part reported unplaced.
        let request = RunNestRequest {
            sheets: vec![square_dto(100.0)],
            parts: vec![PartDto { polygon: square_dto(10.0), quantity: 3 }],
            config: config(20),
        };

        let response =
            run_nest_with_progress(request, |_, _, _| {}, || true, |_, _, _| {}).expect("an immediate cancel must still succeed gracefully");

        assert!(response.cancelled);
        assert_eq!(response.placements.len(), 0);
        assert_eq!(response.unplaced_count, 3);
        assert_eq!(response.unplaced_ids, vec![0, 1, 2]);
        assert!(response.history.is_empty());
    }

    #[test]
    fn export_dxf_round_trips_a_real_nest_result() {
        let sheets = vec![square_dto(100.0)];
        let parts = vec![PartDto { polygon: square_dto(10.0), quantity: 3 }];
        let request = RunNestRequest { sheets: sheets.clone(), parts, config: config(2) };
        let response = run_nest(request).expect("should nest successfully");

        let out_path = std::env::temp_dir().join("rustynesting_export_dxf_test.dxf");
        let export_request = ExportDxfRequest {
            sheets,
            parts_by_id: response.parts_by_id,
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
        let request = RunNestRequest { sheets: sheets.clone(), parts, config: config(2) };
        let response = run_nest(request).expect("should nest successfully");

        let out_path = std::env::temp_dir().join("rustynesting_export_dxf_no_outline_test.dxf");
        let export_request =
            ExportDxfRequest { sheets, parts_by_id: response.parts_by_id, placements: response.placements, sheet_spacing: 10.0, include_sheet_outline: false };
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
        let request = RunNestRequest { sheets: sheets.clone(), parts, config: config(1) };
        let response = run_nest(request).expect("should nest successfully");

        let export_request =
            ExportDxfRequest { sheets, parts_by_id: response.parts_by_id, placements: response.placements, sheet_spacing: -5.0, include_sheet_outline: false };
        assert!(export_dxf("unused.dxf", export_request).is_err());
    }

    /// Regression test for the export-uses-resent-input bug: `export_dxf`
    /// used to re-run `expand_parts` on a client-resent `parts`/quantity
    /// list to rebuild its own id->shape mapping, which only happened to be
    /// correct if that resent list exactly matched what actually produced
    /// the ids in `placements` - nothing enforced that, and a mismatch
    /// wouldn't error, it would just silently write the wrong part's
    /// outline at a placement's coordinates. Now that `ExportDxfRequest`
    /// takes `parts_by_id` directly (no re-derivation possible - the field
    /// doesn't exist to re-derive from), this proves export genuinely uses
    /// exactly the mapping it's given: two distinguishably-sized parts at
    /// fixed ids, checked by reading back the actual exported geometry's
    /// size, not just a polyline count.
    #[test]
    fn export_dxf_writes_each_placement_using_its_own_ids_mapped_shape() {
        let sheets = vec![square_dto(100.0)];
        let parts_by_id = HashMap::from([(0, square_dto(10.0)), (1, square_dto(30.0))]);
        let placements = vec![SheetPlacementDto {
            sheet_index: 0,
            parts: vec![
                PlacedPartDto { id: 0, x: 0.0, y: 0.0, rotation: 0.0 },
                PlacedPartDto { id: 1, x: 50.0, y: 50.0, rotation: 0.0 },
            ],
        }];

        let out_path = std::env::temp_dir().join("rustynesting_export_dxf_id_mapping_test.dxf");
        let export_request = ExportDxfRequest { sheets, parts_by_id, placements, sheet_spacing: 20.0, include_sheet_outline: false };
        export_dxf(out_path.to_str().unwrap(), export_request).expect("export should succeed");

        let drawing = Drawing::load_file(&out_path).expect("exported file should be a readable DXF");
        let mut widths: Vec<f64> = drawing
            .entities()
            .filter_map(|e| match &e.specific {
                dxf::entities::EntityType::LwPolyline(p) => {
                    let xs: Vec<f64> = p.vertices.iter().map(|v| v.x).collect();
                    let (min, max) = xs.iter().fold((f64::MAX, f64::MIN), |(min, max), &x| (min.min(x), max.max(x)));
                    Some(max - min)
                }
                _ => None,
            })
            .collect();
        widths.sort_by(f64::total_cmp);

        assert_eq!(widths.len(), 2);
        assert!((widths[0] - 10.0).abs() < 1e-6, "id 0's 10x10 part should export at its own size, got {widths:?}");
        assert!((widths[1] - 30.0).abs() < 1e-6, "id 1's 30x30 part should export at its own size, got {widths:?}");

        let _ = std::fs::remove_file(&out_path);
    }

    /// Regression test: a part's `texts` (carried through `PolygonDto` since
    /// import) must still be there after going through `export_dxf`'s own
    /// `PolygonDto -> LayeredPolygon` conversion and placement transform -
    /// not just at the lower `geometry::dxf_export` level (already covered
    /// there), but through this command's actual DTO boundary.
    #[test]
    fn export_dxf_command_carries_a_parts_texts_through_the_dto_boundary() {
        let mut part = square_dto(10.0);
        part.texts.push(TextDto { position: PointDto { x: 1.0, y: 1.0 }, rotation_deg: 0.0, height: 1.5, value: "LABEL".into(), is_multiline: false });

        let sheets = vec![square_dto(100.0)];
        let parts_by_id = HashMap::from([(0, part)]);
        let placements = vec![SheetPlacementDto { sheet_index: 0, parts: vec![PlacedPartDto { id: 0, x: 20.0, y: 0.0, rotation: 0.0 }] }];

        let out_path = std::env::temp_dir().join("rustynesting_export_dxf_text_dto_test.dxf");
        let export_request = ExportDxfRequest { sheets, parts_by_id, placements, sheet_spacing: 20.0, include_sheet_outline: false };
        export_dxf(out_path.to_str().unwrap(), export_request).expect("export should succeed");

        let drawing = Drawing::load_file(&out_path).expect("exported file should be a readable DXF");
        let texts: Vec<&dxf::entities::Text> =
            drawing.entities().filter_map(|e| if let dxf::entities::EntityType::Text(t) = &e.specific { Some(t) } else { None }).collect();
        assert_eq!(texts.len(), 1);
        assert_eq!(texts[0].value, "LABEL");
        // local (1,1) shifted by the part's placement (20,0)
        assert!((texts[0].location.x - 21.0).abs() < 1e-9, "x was {}", texts[0].location.x);
        assert!((texts[0].location.y - 1.0).abs() < 1e-9, "y was {}", texts[0].location.y);

        let _ = std::fs::remove_file(&out_path);
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

    /// End-to-end regression test for the "text is silently removed" bug:
    /// a real DXF file with a closed profile plus a `TEXT` entity inside it
    /// must come back from `import_dxf` with that text attached to the
    /// profile's `PolygonDto`, not dropped on the floor.
    #[test]
    fn import_dxf_attaches_a_text_entity_to_its_containing_profile() {
        use dxf::entities::{Entity, EntityCommon, EntityType, LwPolyline, Text};
        use dxf::{Drawing as DxfDrawing, LwPolylineVertex, Point as DxfPoint};

        let mut drawing = DxfDrawing::new();
        drawing.header.version = dxf::enums::AcadVersion::R2000;

        let mut poly = LwPolyline {
            vertices: vec![
                LwPolylineVertex { x: 0.0, y: 0.0, bulge: 0.0, ..Default::default() },
                LwPolylineVertex { x: 20.0, y: 0.0, bulge: 0.0, ..Default::default() },
                LwPolylineVertex { x: 20.0, y: 20.0, bulge: 0.0, ..Default::default() },
                LwPolylineVertex { x: 0.0, y: 20.0, bulge: 0.0, ..Default::default() },
            ],
            ..Default::default()
        };
        poly.set_is_closed(true);
        drawing.add_entity(Entity {
            common: EntityCommon { layer: "CUT".to_string(), ..Default::default() },
            specific: EntityType::LwPolyline(poly),
        });
        drawing.add_entity(Entity {
            common: EntityCommon { layer: "CUT".to_string(), ..Default::default() },
            specific: EntityType::Text(Text {
                location: DxfPoint::new(5.0, 5.0, 0.0),
                value: "PART-001".to_string(),
                text_height: 2.0,
                ..Default::default()
            }),
        });

        let out_path = std::env::temp_dir().join("rustynesting_import_dxf_text_test.dxf");
        drawing.save_file(out_path.to_str().unwrap()).expect("should write test fixture");

        let polygons = import_dxf(out_path.to_str().unwrap(), 0.3).expect("fixture should parse");
        let _ = std::fs::remove_file(&out_path);

        assert_eq!(polygons.len(), 1);
        assert_eq!(polygons[0].texts.len(), 1, "the TEXT entity inside the profile should be attached to it");
        assert_eq!(polygons[0].texts[0].value, "PART-001");
        assert_eq!(polygons[0].texts[0].position.x, 5.0);
        assert_eq!(polygons[0].texts[0].position.y, 5.0);
    }

    #[test]
    fn is_better_result_prefers_fewer_unplaced_parts_above_all_else() {
        assert!(is_better_result(0, 10, 50.0, 1, 3, 99.0));
        assert!(!is_better_result(1, 3, 99.0, 0, 10, 50.0));
    }

    #[test]
    fn is_better_result_then_prefers_fewer_sheets() {
        assert!(is_better_result(0, 3, 50.0, 0, 5, 99.0));
        assert!(!is_better_result(0, 5, 99.0, 0, 3, 50.0));
    }

    #[test]
    fn is_better_result_finally_prefers_higher_utilisation() {
        assert!(is_better_result(0, 3, 91.0, 0, 3, 90.0));
        assert!(!is_better_result(0, 3, 90.0, 0, 3, 90.0));
    }

    // Live preview - commented out along with `run_nest_with_progress`'s
    // `on_generation_improved`/`on_start` params themselves (see
    // `NestConfigDto::live_visualization`'s own comment for why), since
    // this test exercised exactly those two hooks.
    //
    // /// `on_generation_improved`/`on_start` are what `run_nest_command`'s
    // /// `live_visualization` path relies on: `on_start` must fire exactly
    // /// once, before anything else, with the true id->shape map; `on_generation_improved`
    // /// must fire at the *same* trigger `RunNestResponse::history` already
    // /// uses (not once per generation regardless of whether anything
    // /// changed), always carrying a full, non-empty placement, and the
    // /// number of calls must exactly match `history.len()`.
    // #[test]
    // fn run_nest_with_progress_reports_full_placements_only_on_genuine_improvements() {
    //     let request = RunNestRequest {
    //         sheets: vec![square_dto(100.0)],
    //         parts: vec![PartDto { polygon: square_dto(10.0), quantity: 3 }],
    //         config: config(5),
    //     };
    //
    //     let mut start_seen = 0;
    //     let improvements = std::sync::Mutex::new(Vec::new());
    //     let response = run_nest_with_progress(
    //         request,
    //         |_, _, _| {},
    //         || false,
    //         |_, _, _| {},
    //         |generation, generations, result: &PlaceResult| {
    //             assert_eq!(generations, 5);
    //             assert!(!result.placements.is_empty(), "every reported improvement should carry a real, non-empty placement");
    //             improvements.lock().unwrap().push((generation, result.fitness, result.unplaced_count));
    //         },
    //         |parts_by_id| {
    //             start_seen += 1;
    //             assert_eq!(parts_by_id.len(), 3, "on_start's map should cover every part instance, not just shapes");
    //         },
    //     )
    //     .expect("should nest successfully");
    //
    //     assert_eq!(start_seen, 1, "on_start should fire exactly once, before any placement");
    //     assert_eq!(response.unplaced_count, 0);
    //
    //     let improvements = improvements.into_inner().unwrap();
    //     assert_eq!(improvements.len(), response.history.len(), "on_generation_improved should fire exactly once per history entry, no more");
    //     assert!(!improvements.is_empty(), "at least the first placed individual should count as an improvement");
    //     let (last_generation, last_fitness, last_unplaced) = *improvements.last().unwrap();
    //     assert_eq!(last_fitness, response.fitness, "the last reported improvement should be the same result reported at the top level");
    //     assert_eq!(last_unplaced, response.unplaced_count);
    //     assert_eq!(last_generation, response.history.last().unwrap().generation);
    //     for pair in improvements.windows(2) {
    //         assert!(pair[0].0 <= pair[1].0, "generations should be non-decreasing across reported improvements");
    //     }
    // }
}
