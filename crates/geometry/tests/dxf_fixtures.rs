//! Integration test against a real DXF fixture (copied from the Electron
//! repo's tests/assets/FLAT.dxf into tests/fixtures/ per the plan's repo
//! structure) - a real laser/CNC-cut sheet layout with a `drilling` layer
//! containing thousands of small circles, exactly the scenario that drove
//! the DXF-only, layer-retaining scope change recorded in docs/PORT_STATUS.md.

use dxf::Drawing;
use geometry::dxf_import::entities_to_polygons;

fn fixture_path(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures")
        .join(name)
}

#[test]
fn loads_and_converts_the_flat_dxf_fixture() {
    let drawing = Drawing::load_file(fixture_path("FLAT.dxf")).expect("FLAT.dxf should parse");

    let entity_count = drawing.entities().count();
    assert!(entity_count > 3000, "expected thousands of entities, got {entity_count}");

    let polygons = entities_to_polygons(drawing.entities(), 0.01);
    assert!(!polygons.is_empty(), "expected at least some closed profiles");

    // the fixture is known (via manual inspection) to use these three layers
    let layers: std::collections::HashSet<&str> = polygons.iter().map(|p| p.layer.as_str()).collect();
    assert!(layers.contains("drilling"), "expected a `drilling` layer, got {layers:?}");

    // every circle-derived polygon must carry isCircle metadata with a positive radius
    let circle_polys: Vec<_> = polygons.iter().filter(|p| p.is_circle.is_some()).collect();
    assert!(!circle_polys.is_empty(), "expected circle entities to convert with isCircle metadata");
    for p in &circle_polys {
        let c = p.is_circle.unwrap();
        assert!(c.r > 0.0, "circle radius should be positive, got {}", c.r);
        assert!(p.points.len() >= 3, "circle should tessellate to at least a triangle");
    }
}

#[test]
fn loads_the_struck_flat_dxf_fixture_without_error() {
    let drawing = Drawing::load_file(fixture_path("FLAT-struck.dxf")).expect("FLAT-struck.dxf should parse");
    let polygons = entities_to_polygons(drawing.entities(), 0.01);
    assert!(!polygons.is_empty());
}
