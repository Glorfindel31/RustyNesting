//! Port of `main/nfpDb.ts`'s `NfpCache`: an in-memory cache for the
//! (relatively expensive) NFP computations `geometry::obstacle_nfp` and
//! `geometry::inner_nfp` produce, keyed by `crate::cache_key::nfp_cache_key`
//! (Phase 2's unification of what were two separately-maintained key
//! formats).
//!
//! **Threading, a real change from the original, not a 1:1 port**: the
//! Electron app ran one independent, unshared `NfpCache` per background
//! window (6-8 parallel `BrowserWindow` processes, zero cross-window cache
//! sharing - see the plan's Phase 4 scope). This port shares ONE cache
//! across every rayon worker thread instead, behind a `Mutex` (see
//! `docs/PORT_STATUS.md`'s Phase 4 row: "sharded map or plain mutex - verify
//! contention before reaching for anything fancier"). A plain `Mutex` is the
//! honest default until real contention data says otherwise.
//!
//! **Entry-count bookkeeping simplification**: the original hand-tracks an
//! `entryCount` field to avoid `Object.keys(db).length` being O(n) per
//! insert; Rust's `HashMap::len()` is already O(1), so that field isn't
//! needed here.
//!
//! **Clone-on-read/write, simplified by ownership**: the original must
//! explicitly deep-copy every cached NFP on both insert and read
//! (`new Point(p.x, p.y)` per point) because a live NFP-tracing call mutates
//! `Point.marked` in place on whatever array reference it's given - a cache
//! hit returning a shared reference would let one caller's tracing corrupt
//! what a later caller reads. Rust's `Point` is `Copy`, so `Vec<Point>` /
//! `Vec<Vec<Point>>`'s ordinary `.clone()` already produces an independent
//! copy with its own `marked` flags; no custom clone method needed.

use std::collections::HashMap;
use std::sync::Mutex;

use geometry::point::Point;

use crate::cache_key::nfp_cache_key;

/// Matches `nfpDb.ts`'s `MAX_CACHE_ENTRIES`: above this many entries, stop
/// caching new NFPs (existing entries are kept, just no more added). Bounded
/// memory beats an out-of-memory crash on a long multi-part run.
pub const MAX_CACHE_ENTRIES: usize = 50_000;

/// A cached NFP result - either the obstacle/outer shape (an outer loop plus
/// any hole-restore regions, matching `geometry::obstacle_nfp::ObstacleNfp`)
/// or the inner-fit shape (a flat list of valid-placement regions, matching
/// `geometry::inner_nfp::inner_nfp`'s return type). Mirrors `nfpDb.ts`'s
/// `Nfp | Nfp[]` union - disambiguated there by a caller-supplied `inner`
/// boolean flag, made an explicit, self-describing enum here instead.
#[derive(Clone, Debug)]
pub enum CachedNfp {
    Outer { outer: Vec<Point>, children: Vec<Vec<Point>> },
    Inner(Vec<Vec<Point>>),
}

/// Shared NFP cache. Cheap to construct (`NfpCache::default()`); wrap in an
/// `Arc` to share across rayon worker threads once Phase 4's dispatch loop
/// exists.
#[derive(Default)]
pub struct NfpCache {
    db: Mutex<HashMap<String, CachedNfp>>,
}

impl NfpCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn has(&self, a: &str, b: &str, a_rotation: f64, b_rotation: f64, a_flipped: bool, b_flipped: bool) -> bool {
        let key = nfp_cache_key(a, b, a_rotation, b_rotation, a_flipped, b_flipped);
        self.db.lock().unwrap().contains_key(&key)
    }

    /// Returns an owned, independent copy of the cached entry (if any) - see
    /// the module doc comment for why a shared reference would be unsafe to
    /// hand back once callers start mutating `Point.marked` again.
    pub fn find(&self, a: &str, b: &str, a_rotation: f64, b_rotation: f64, a_flipped: bool, b_flipped: bool) -> Option<CachedNfp> {
        let key = nfp_cache_key(a, b, a_rotation, b_rotation, a_flipped, b_flipped);
        self.db.lock().unwrap().get(&key).cloned()
    }

    /// No-op past `MAX_CACHE_ENTRIES` for a genuinely new key; overwriting an
    /// already-cached key is always allowed (matches the original: the cap
    /// only gates *growth*, not updates).
    pub fn insert(&self, a: &str, b: &str, a_rotation: f64, b_rotation: f64, a_flipped: bool, b_flipped: bool, value: CachedNfp) {
        let key = nfp_cache_key(a, b, a_rotation, b_rotation, a_flipped, b_flipped);
        let mut db = self.db.lock().unwrap();
        if !db.contains_key(&key) && db.len() >= MAX_CACHE_ENTRIES {
            return;
        }
        db.insert(key, value);
    }

    pub fn stats(&self) -> usize {
        self.db.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_outer() -> CachedNfp {
        CachedNfp::Outer {
            outer: vec![Point::new(0.0, 0.0), Point::new(1.0, 0.0), Point::new(1.0, 1.0)],
            children: Vec::new(),
        }
    }

    #[test]
    fn round_trips_an_insert() {
        let cache = NfpCache::new();
        assert!(!cache.has("A", "B", 0.0, 0.0, false, false));

        cache.insert("A", "B", 0.0, 0.0, false, false, sample_outer());

        assert!(cache.has("A", "B", 0.0, 0.0, false, false));
        let found = cache.find("A", "B", 0.0, 0.0, false, false).expect("should be cached");
        match found {
            CachedNfp::Outer { outer, .. } => assert_eq!(outer.len(), 3),
            CachedNfp::Inner(_) => panic!("wrong variant"),
        }
    }

    #[test]
    fn geometrically_identical_rotations_share_a_cache_entry() {
        let cache = NfpCache::new();
        cache.insert("A", "B", 360.0, 0.0, false, false, sample_outer());
        assert!(cache.has("A", "B", 0.0, 0.0, false, false));
    }

    #[test]
    fn miss_returns_none() {
        let cache = NfpCache::new();
        assert!(cache.find("A", "B", 0.0, 0.0, false, false).is_none());
    }

    #[test]
    fn returned_copies_are_independent_of_the_cached_entry() {
        let cache = NfpCache::new();
        cache.insert("A", "B", 0.0, 0.0, false, false, sample_outer());

        let mut first = cache.find("A", "B", 0.0, 0.0, false, false).unwrap();
        if let CachedNfp::Outer { outer, .. } = &mut first {
            outer[0].marked = true;
        }

        let second = cache.find("A", "B", 0.0, 0.0, false, false).unwrap();
        if let CachedNfp::Outer { outer, .. } = second {
            assert!(!outer[0].marked, "mutating one returned copy must not affect another");
        } else {
            panic!("wrong variant");
        }
    }

    #[test]
    fn stops_caching_new_keys_past_the_entry_cap_but_keeps_existing_ones() {
        let cache = NfpCache { db: Mutex::new(HashMap::new()) };
        for i in 0..MAX_CACHE_ENTRIES {
            cache.insert(&i.to_string(), "B", 0.0, 0.0, false, false, sample_outer());
        }
        assert_eq!(cache.stats(), MAX_CACHE_ENTRIES);

        cache.insert("overflow", "B", 0.0, 0.0, false, false, sample_outer());
        assert_eq!(cache.stats(), MAX_CACHE_ENTRIES, "cap should block a brand-new key");
        assert!(!cache.has("overflow", "B", 0.0, 0.0, false, false));

        // an existing key can still be overwritten past the cap
        cache.insert("0", "B", 0.0, 0.0, false, false, sample_outer());
        assert!(cache.has("0", "B", 0.0, 0.0, false, false));
    }
}
