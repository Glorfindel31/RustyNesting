//! Pure geometry math: Clipper2 wrapper, NFP-tracing primitives, SVG import.
//! Zero I/O, zero threading — see RUST-REWRITE-PLAN.md Phase 1.

use clipper2::{FillRule, Paths};

/// Phase 0 smoke test: exercises the Clipper2 C++ FFI link, not real logic.
pub fn clipper2_links() -> bool {
    let path_a: Paths = vec![(0.0, 0.0), (4.0, 0.0), (4.0, 4.0), (0.0, 4.0)].into();
    let path_b: Paths = vec![(2.0, 2.0), (6.0, 2.0), (6.0, 6.0), (2.0, 6.0)].into();

    path_a
        .to_clipper_subject()
        .add_clip(path_b)
        .union(FillRule::default())
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipper2_binding_builds_and_links() {
        assert!(clipper2_links());
    }
}
