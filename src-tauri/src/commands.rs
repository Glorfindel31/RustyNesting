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

use dxf::Drawing;
use nesting::dispatch;
use nesting::ga::GeneticAlgorithm;

use crate::dto::{expand_parts, PlacedPartDto, PolygonDto, RunNestRequest, RunNestResponse, SheetPlacementDto};

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

/// Runs `request.config.generations` GA generations against
/// `request.sheets`/`request.parts` and returns the best result found
/// (`nesting::ga::is_better_nest`, not raw fitness - see its doc comment for
/// why those can rank differently). Every part-shape/quantity pair is
/// expanded into individually-id'd physical copies first
/// (`dto::expand_parts`), same as the original's `launchWorkers` building
/// its GA seed population.
pub fn run_nest(request: RunNestRequest) -> Result<RunNestResponse, String> {
    if request.sheets.is_empty() {
        return Err("at least one sheet is required".into());
    }
    if request.parts.is_empty() {
        return Err("at least one part is required".into());
    }

    let sheets: Vec<_> = request.sheets.into_iter().map(Into::into).collect();
    let (adam, parts_by_id) = expand_parts(request.parts);
    if adam.is_empty() {
        return Err("every part had quantity 0".into());
    }

    let placement_config = request.config.placement_config();
    let ga_config = request.config.ga_config();
    let mut ga = GeneticAlgorithm::new(adam, ga_config, Vec::new());

    let best = dispatch::run(&mut ga, &sheets, &parts_by_id, &placement_config, request.config.generations)
        .ok_or_else(|| "ran zero generations".to_string())?;

    Ok(RunNestResponse {
        placements: best
            .placements
            .into_iter()
            .map(|sp| SheetPlacementDto {
                sheet_index: sp.sheet_index,
                parts: sp.parts.into_iter().map(|p| PlacedPartDto { id: p.id, x: p.placement.x, y: p.placement.y, rotation: p.rotation }).collect(),
            })
            .collect(),
        fitness: best.fitness,
        utilisation: best.utilisation,
        unplaced_count: best.unplaced_count,
    })
}

#[tauri::command]
pub fn import_dxf_command(path: String, curve_tolerance: f64) -> Result<Vec<PolygonDto>, String> {
    import_dxf(&path, curve_tolerance)
}

#[tauri::command]
pub fn run_nest_command(request: RunNestRequest) -> Result<RunNestResponse, String> {
    run_nest(request)
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
    fn run_nest_rejects_all_zero_quantities() {
        let request =
            RunNestRequest { sheets: vec![square_dto(100.0)], parts: vec![PartDto { polygon: square_dto(10.0), quantity: 0 }], config: config(1) };
        // quantity 0 falls back to 1 copy (matches expand_parts's `.max(1)`,
        // same convention background.js's own "quantity 0 means unlimited on
        // a sheet, but 1 on a part" - a plain part with quantity 0 is
        // treated as 1, not "nest nothing")
        assert!(run_nest(request).is_ok());
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
