//! Per-generation dispatch, replacing `main/deepnest.js`'s `launchWorkers`:
//! a 100ms-poll loop that IPC-dispatched one individual at a time to up to
//! `config.threads` separate Electron `BrowserWindow` worker processes,
//! tracking each one's `processing`/`fitness` state by hand to know when a
//! slot freed up.
//!
//! **Replaced by construction, not ported 1:1**: `rayon`'s parallel
//! iteration is synchronous - it blocks the calling thread until every item
//! finishes - so there's no polling loop, no `processing` flag, no manually
//! tracking how many workers are busy. One `par_iter()` call evaluates an
//! entire generation's population at once, capped by rayon's own thread
//! pool instead of a hand-rolled `running < config.threads` check. This is
//! what `docs/PORT_STATUS.md`'s Phase 4 row means by "eliminates the
//! ~7500-buffered-insert IPC flood by construction" - there's no IPC here
//! at all, every worker is a thread in the same process sharing memory.
//!
//! **Not ported here**: progress/log event plumbing (the original's
//! `eventEmitter.send(...)` calls), thread-count tuning against
//! `config.threads` (rayon's default global pool is used as-is - Phase 9's
//! "verify, don't assume" row is where that gets checked against real data,
//! not guessed at here), and `widenRotationsIfStalled`/`refineStalledBest`
//! (need `run`'s caller to track stagnation across calls - left to whatever
//! wraps this loop, same reasoning as the sheets `docs/PORT_STATUS.md` Phase
//! 4 row this superseded).

use std::collections::HashMap;

use rayon::prelude::*;

use geometry::dxf_import::LayeredPolygon;

use crate::ga::{is_better_nest, GeneticAlgorithm};
use crate::placement::{place_parts, NestPart, PlaceResult, PlacementConfig};

/// Evaluates every individual in the current generation's population in
/// parallel, assigns each one's `fitness`, then advances the GA
/// (`GeneticAlgorithm::generation()`). Returns the `PlaceResult` for every
/// individual actually (re-)placed this call - useful for a caller that
/// wants to track the best-so-far result, not just the best fitness (see
/// `is_better_nest`'s doc comment for why those can rank differently).
///
/// Individuals that already carry a `fitness` are skipped, not
/// re-evaluated. The only way that happens is `GeneticAlgorithm::generation`'s
/// elitism (`new_population = vec![self.population[0].clone()]`), which
/// carries the surviving elite's already-correct fitness forward unchanged
/// - its genes didn't change, so its placement result didn't either.
/// Matches the original (`launchWorkers`'s dispatch loop skips any
/// individual whose `.fitness` is already truthy) and skips a real,
/// otherwise-redundant placement computation every generation.
pub fn run_generation(
    ga: &mut GeneticAlgorithm,
    sheets: &[LayeredPolygon],
    parts_by_id: &HashMap<usize, LayeredPolygon>,
    placement_config: &PlacementConfig,
) -> Vec<PlaceResult> {
    let evaluated: Vec<(usize, PlaceResult)> = ga
        .population
        .par_iter()
        .enumerate()
        .filter(|(_, individual)| individual.fitness.is_none())
        .map(|(idx, individual)| {
            let nest_parts: Vec<NestPart> = individual
                .placement
                .iter()
                .zip(&individual.rotation)
                .map(|(&id, &rotation)| NestPart {
                    id,
                    polygon: parts_by_id.get(&id).expect("every gene id must have a matching part").clone(),
                    rotation,
                })
                .collect();
            (idx, place_parts(sheets, nest_parts, placement_config))
        })
        .collect();

    for (idx, result) in &evaluated {
        ga.population[*idx].fitness = Some(result.fitness);
    }

    let results: Vec<PlaceResult> = evaluated.into_iter().map(|(_, result)| result).collect();
    ga.generation();
    results
}

/// Runs `generations` full generations, tracking the best result seen
/// across all of them via `is_better_nest` (not raw GA fitness, which
/// bundles in placement-strategy shape penalties that don't map to "which
/// result would I actually want"). `None` only if `generations == 0`.
pub fn run(
    ga: &mut GeneticAlgorithm,
    sheets: &[LayeredPolygon],
    parts_by_id: &HashMap<usize, LayeredPolygon>,
    placement_config: &PlacementConfig,
    generations: usize,
) -> Option<PlaceResult> {
    let mut best: Option<PlaceResult> = None;
    for _ in 0..generations {
        let results = run_generation(ga, sheets, parts_by_id, placement_config);
        for result in results {
            if best.as_ref().is_none_or(|b| is_better_nest(&result, b)) {
                best = Some(result);
            }
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ga::GaConfig;
    use crate::placement::{PlacementType, DEFAULT_DOMINANT_PART_AREA_THRESHOLD};
    use geometry::point::Point;

    fn square(size: f64) -> LayeredPolygon {
        LayeredPolygon {
            points: vec![
                Point::new(0.0, 0.0),
                Point::new(size, 0.0),
                Point::new(size, size),
                Point::new(0.0, size),
            ],
            layer: "0".into(),
            is_circle: None,
            children: Vec::new(),
        }
    }

    fn placement_config() -> PlacementConfig {
        PlacementConfig {
            placement_type: PlacementType::Gravity,
            rotations: 1,
            dominant_part_area_threshold: DEFAULT_DOMINANT_PART_AREA_THRESHOLD,
            curve_tolerance: 0.3,
        }
    }

    fn setup(part_count: usize) -> (GeneticAlgorithm, Vec<LayeredPolygon>, HashMap<usize, LayeredPolygon>) {
        let parts_by_id: HashMap<usize, LayeredPolygon> = (0..part_count).map(|id| (id, square(10.0))).collect();
        let adam: Vec<usize> = (0..part_count).collect();
        let ga = GeneticAlgorithm::new(adam, GaConfig { population_size: 6, mutation_rate: 20.0, rotations: 1 }, Vec::new());
        let sheets = vec![square(100.0)];
        (ga, sheets, parts_by_id)
    }

    #[test]
    fn run_generation_evaluates_new_individuals_and_skips_the_carried_over_elite() {
        let (mut ga, sheets, parts_by_id) = setup(4);
        let cfg = placement_config();

        // first call: every individual is freshly constructed with no
        // fitness yet, so all of them get placed.
        let results = run_generation(&mut ga, &sheets, &parts_by_id, &cfg);
        assert_eq!(results.len(), 6);
        for result in &results {
            assert_eq!(result.unplaced_count, 0, "4 small squares should all fit on one 100x100 sheet");
        }

        // generation() already replaced ga.population with the next
        // generation's population by the time this returns - same size.
        // population[0] is the surviving elite (a literal clone of the
        // fittest individual just evaluated), so it carries its fitness
        // forward unchanged; every other slot is a freshly mated/mutated
        // child with no fitness yet, matching the original (a newly bred
        // individual has no fitness until it's placed).
        assert_eq!(ga.population.len(), 6);
        assert!(ga.population[0].fitness.is_some(), "elite survivor should carry its fitness forward");
        for individual in &ga.population[1..] {
            assert!(individual.fitness.is_none());
        }

        // second call: the carried-over elite must NOT be re-placed - only
        // population_size - 1 fresh results this time.
        let results2 = run_generation(&mut ga, &sheets, &parts_by_id, &cfg);
        assert_eq!(results2.len(), 5, "the elite survivor should be skipped, not re-placed");
    }

    #[test]
    fn run_tracks_the_best_result_across_multiple_generations() {
        let (mut ga, sheets, parts_by_id) = setup(5);
        let cfg = placement_config();

        let best = run(&mut ga, &sheets, &parts_by_id, &cfg, 3).expect("3 generations should produce a best result");

        assert_eq!(best.unplaced_count, 0);
        assert!(best.fitness.is_finite());
    }

    #[test]
    fn run_returns_none_for_zero_generations() {
        let (mut ga, sheets, parts_by_id) = setup(3);
        let cfg = placement_config();
        assert!(run(&mut ga, &sheets, &parts_by_id, &cfg, 0).is_none());
    }
}
