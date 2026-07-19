//! Writes a nested layout back out to DXF - **new scope, not a port**: the
//! original Electron app never wrote DXF locally at all (see
//! `docs/PORT_STATUS.md`'s Phase 7 table). Every placed part (and sheet, if
//! requested) becomes one `LWPOLYLINE` per layer-tagged node - the part's
//! own tree (true outer boundary plus every child/hole), not just its
//! outer profile, so a part's interior layers (e.g. drilled holes) survive
//! the round trip the same way they do on import.
//!
//! Multiple sheets can't share one DXF drawing space without overlapping,
//! since a DXF file is a single flat coordinate system - each sheet used in
//! the result is laid out left-to-right, separated by `sheet_spacing`, in
//! the order given.
//!
//! **Simplification, not a bug**: a part that was a true circle on import
//! (`LayeredPolygon::is_circle`) is written back out as its tessellated
//! polygon approximation (`LWPOLYLINE`), not a true DXF `CIRCLE` entity -
//! reusing `rotate_layered_polygon`/`shift_layered_polygon`'s existing
//! points-only transform keeps this to one code path instead of two, at
//! the cost of a real circle re-importing as a many-sided polygon instead
//! of a circle. Visually indistinguishable at normal curve tolerances;
//! revisit if a caller actually needs true circle round-tripping.
//!
//! Each node's `texts` (labels/part numbers attached on import - see
//! `dxf_import`'s module doc) are written back out too, as the same entity
//! kind (`TEXT`/`MTEXT`) they came from, already transformed by whatever
//! `rotate_layered_polygon`/`shift_layered_polygon` calls the caller applied
//! to the shape - `add_node` just emits their current position/rotation
//! as-is, the same way it does for `points`.

use dxf::entities::{Entity, EntityCommon, EntityType, LwPolyline, MText, Text};
use dxf::{Drawing, LwPolylineVertex, Point as DxfPoint};

use crate::dxf_import::{rotate_layered_polygon, shift_layered_polygon, LayeredPolygon, TextAnnotation};
use crate::polygon::get_polygon_bounds;

/// One part's true (unpadded) geometry plus where the engine placed it -
/// mirrors `nesting::placement::PlacedPart` but carries the actual shape
/// (with its hole/layer tree) rather than just an id, since this module
/// has no `parts_by_id` lookup of its own to resolve one.
#[derive(Clone, Debug)]
pub struct PlacedShape {
    pub shape: LayeredPolygon,
    pub x: f64,
    pub y: f64,
    pub rotation: f64,
}

/// One sheet actually used by the result, plus every part placed on it.
#[derive(Clone, Debug)]
pub struct SheetLayout {
    pub sheet: LayeredPolygon,
    pub parts: Vec<PlacedShape>,
}

/// Lays every sheet out left-to-right (separated by `sheet_spacing`) and
/// writes one `LWPOLYLINE` per layer-tagged node - the sheet's own outline
/// too, if `include_sheet_outline` is set. Returns the in-memory `Drawing`;
/// saving it to a path is the caller's job (`Drawing::save_file`).
pub fn export_dxf(sheets: &[SheetLayout], sheet_spacing: f64, include_sheet_outline: bool) -> Drawing {
    let mut drawing = Drawing::new();
    // Drawing::new()'s default header targets R12 (pre-dates LWPOLYLINE,
    // introduced in R2000/AC1015) - the writer silently drops any entity
    // type unsupported by the target version, so every LWPOLYLINE this
    // function adds below would otherwise vanish with no error at all
    // (confirmed by writing then re-reading a minimal file: an empty
    // ENTITIES section, no panic, no Err).
    drawing.header.version = dxf::enums::AcadVersion::R2000;
    let mut cursor_x = 0.0;

    for layout in sheets {
        let sheet_bounds = get_polygon_bounds(&layout.sheet.points);
        let (offset_x, sheet_width) = match sheet_bounds {
            Some(b) => (cursor_x - b.x, b.width),
            None => (cursor_x, 0.0),
        };
        let offset_y = sheet_bounds.map(|b| -b.y).unwrap_or(0.0);

        if include_sheet_outline {
            let shifted = shift_layered_polygon(&layout.sheet, offset_x, offset_y);
            add_node(&mut drawing, &shifted);
        }

        for placed in &layout.parts {
            let rotated = rotate_layered_polygon(&placed.shape, placed.rotation);
            let positioned = shift_layered_polygon(&rotated, placed.x + offset_x, placed.y + offset_y);
            add_node(&mut drawing, &positioned);
        }

        cursor_x += sheet_width + sheet_spacing;
    }

    drawing
}

/// Adds one `LWPOLYLINE` for `shape.points` on `shape.layer`, then recurses
/// into every child - a shape (part or sheet) is a tree, and every node in
/// it needs to survive the round trip on its own original layer.
fn add_node(drawing: &mut Drawing, shape: &LayeredPolygon) {
    if shape.points.len() >= 2 {
        let mut poly = LwPolyline {
            vertices: shape.points.iter().map(|p| LwPolylineVertex { x: p.x, y: p.y, bulge: 0.0, ..Default::default() }).collect(),
            ..Default::default()
        };
        poly.set_is_closed(true);
        drawing.add_entity(Entity {
            common: EntityCommon { layer: shape.layer.clone(), ..Default::default() },
            specific: EntityType::LwPolyline(poly),
        });
    }
    for text in &shape.texts {
        add_text(drawing, &shape.layer, text);
    }
    for child in &shape.children {
        add_node(drawing, child);
    }
}

/// Writes one `TextAnnotation` back out as the same entity kind it was
/// parsed from - see `dxf_import::entity_to_text`'s doc comment for the
/// `TEXT`-is-degrees-`MTEXT`-is-radians rotation quirk this has to invert
/// symmetrically on the way back out.
fn add_text(drawing: &mut Drawing, layer: &str, text: &TextAnnotation) {
    let specific = if text.is_multiline {
        EntityType::MText(MText {
            insertion_point: DxfPoint::new(text.position.x, text.position.y, 0.0),
            initial_text_height: text.height,
            text: text.value.clone(),
            rotation_angle: text.rotation_deg.to_radians(),
            ..Default::default()
        })
    } else {
        EntityType::Text(Text {
            location: DxfPoint::new(text.position.x, text.position.y, 0.0),
            text_height: text.height,
            value: text.value.clone(),
            rotation: text.rotation_deg,
            ..Default::default()
        })
    };
    drawing.add_entity(Entity {
        common: EntityCommon { layer: layer.to_string(), ..Default::default() },
        specific,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::point::Point;

    fn square(size: f64) -> LayeredPolygon {
        LayeredPolygon {
            points: vec![Point::new(0.0, 0.0), Point::new(size, 0.0), Point::new(size, size), Point::new(0.0, size)],
            layer: "CUT".into(),
            is_circle: None,
            children: Vec::new(),
            texts: Vec::new(),
        }
    }

    fn entities_on_layer<'a>(drawing: &'a Drawing, layer: &str) -> Vec<&'a LwPolyline> {
        drawing
            .entities()
            .filter_map(|e| match &e.specific {
                EntityType::LwPolyline(p) if e.common.layer == layer => Some(p),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn one_sheet_one_part_writes_two_polylines_by_default() {
        let layout = SheetLayout {
            sheet: {
                let mut s = square(100.0);
                s.layer = "SHEET".into();
                s
            },
            parts: vec![PlacedShape { shape: square(10.0), x: 5.0, y: 5.0, rotation: 0.0 }],
        };

        let drawing = export_dxf(std::slice::from_ref(&layout), 20.0, true);

        assert_eq!(entities_on_layer(&drawing, "SHEET").len(), 1, "sheet outline should be written when requested");
        assert_eq!(entities_on_layer(&drawing, "CUT").len(), 1);
    }

    #[test]
    fn sheet_outline_is_omitted_when_not_requested() {
        let layout = SheetLayout {
            sheet: {
                let mut s = square(100.0);
                s.layer = "SHEET".into();
                s
            },
            parts: vec![PlacedShape { shape: square(10.0), x: 5.0, y: 5.0, rotation: 0.0 }],
        };

        let drawing = export_dxf(std::slice::from_ref(&layout), 20.0, false);

        assert_eq!(entities_on_layer(&drawing, "SHEET").len(), 0);
        assert_eq!(entities_on_layer(&drawing, "CUT").len(), 1);
    }

    #[test]
    fn a_holes_layer_survives_the_export() {
        let mut part = square(20.0);
        part.children.push({
            let mut hole = square(5.0);
            hole.layer = "DRILL".into();
            hole
        });
        let layout = SheetLayout { sheet: square(100.0), parts: vec![PlacedShape { shape: part, x: 0.0, y: 0.0, rotation: 0.0 }] };

        let drawing = export_dxf(std::slice::from_ref(&layout), 20.0, false);

        assert_eq!(entities_on_layer(&drawing, "CUT").len(), 1, "the part's own outer layer");
        assert_eq!(entities_on_layer(&drawing, "DRILL").len(), 1, "the hole's own layer must survive the round trip");
    }

    #[test]
    fn two_sheets_are_laid_out_side_by_side_without_overlap() {
        let layouts = vec![
            SheetLayout { sheet: square(100.0), parts: Vec::new() },
            SheetLayout { sheet: square(100.0), parts: vec![PlacedShape { shape: square(10.0), x: 0.0, y: 0.0, rotation: 0.0 }] },
        ];

        let drawing = export_dxf(&layouts, 15.0, false);

        // the second sheet's part should start at 100 (first sheet's
        // width) + 15 (spacing) = 115, not overlap the first sheet's [0,100] span
        let parts = entities_on_layer(&drawing, "CUT");
        assert_eq!(parts.len(), 1);
        let min_x = parts[0].vertices.iter().map(|v| v.x).fold(f64::INFINITY, f64::min);
        assert!((min_x - 115.0).abs() < 1e-6, "expected the second sheet's part to start at x=115, got {min_x}");
    }

    /// Regression test for the "text is silently dropped" bug: a part's
    /// attached `TEXT` must survive the full rotate+shift+export pipeline,
    /// ending up at the part's actual placed position/rotation, not its
    /// local pre-placement one.
    #[test]
    fn a_parts_attached_text_is_written_out_at_its_placed_position() {
        let mut part = square(10.0);
        part.texts.push(TextAnnotation { position: Point::new(1.0, 0.0), rotation_deg: 0.0, height: 2.0, value: "PART-7".into(), is_multiline: false });

        // placed at (50, 30) rotated 90 degrees
        let layout = SheetLayout { sheet: square(200.0), parts: vec![PlacedShape { shape: part, x: 50.0, y: 30.0, rotation: 90.0 }] };
        let drawing = export_dxf(std::slice::from_ref(&layout), 20.0, false);

        let texts: Vec<&Text> = drawing.entities().filter_map(|e| if let EntityType::Text(t) = &e.specific { Some(t) } else { None }).collect();
        assert_eq!(texts.len(), 1);
        let text = texts[0];
        assert_eq!(text.value, "PART-7");
        // local (1,0) rotated 90 degrees -> (0,1), then shifted by (50,30)
        assert!((text.location.x - 50.0).abs() < 1e-9, "x was {}", text.location.x);
        assert!((text.location.y - 31.0).abs() < 1e-9, "y was {}", text.location.y);
        assert!((text.rotation - 90.0).abs() < 1e-9, "rotation was {}", text.rotation);
        assert_eq!(text.text_height, 2.0);
    }

    #[test]
    fn a_parts_attached_mtext_round_trips_with_the_rotation_unit_converted_back_to_radians() {
        let mut part = square(10.0);
        part.texts.push(TextAnnotation { position: Point::new(0.0, 0.0), rotation_deg: 90.0, height: 3.0, value: "MULTI".into(), is_multiline: true });

        let layout = SheetLayout { sheet: square(200.0), parts: vec![PlacedShape { shape: part, x: 0.0, y: 0.0, rotation: 0.0 }] };
        let drawing = export_dxf(std::slice::from_ref(&layout), 20.0, false);

        let mtexts: Vec<&MText> = drawing.entities().filter_map(|e| if let EntityType::MText(t) = &e.specific { Some(t) } else { None }).collect();
        assert_eq!(mtexts.len(), 1);
        assert_eq!(mtexts[0].text, "MULTI");
        assert!((mtexts[0].rotation_angle - std::f64::consts::FRAC_PI_2).abs() < 1e-9, "MTEXT rotation must be written back in radians, got {}", mtexts[0].rotation_angle);
    }
}
