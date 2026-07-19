//! Unified NFP cache-key format, replacing the two duplicated
//! implementations in the Electron app: `NfpCache.makeKey`/`normalizeRotation`
//! (`main/nfpDb.ts`) and `nfpCacheKey`/`normalizeNfpRotation` (`main.js`,
//! kept manually in sync with a comment reminding whoever touches one to
//! update the other - this file is the whole reason that reminder can be
//! deleted instead of honored).
//!
//! **Caller convention to preserve** (not enforced by this function itself,
//! since it's a property of *how the inner-NFP cache is queried*, not of the
//! key format): `getInnerNfp` always hardcodes `Arotation: 0` when looking up
//! an inner-fit NFP (`background.js`: `window.db.find({A: A.source, B:
//! B.source, Arotation: 0, Brotation: B.rotation}, true)`), since the
//! container polygon conceptually doesn't rotate in that scenario - only `B`
//! does. Whatever calls this from the `nesting` cache layer (Phase 4/5) must
//! keep passing `0` for `a_rotation` on inner-NFP lookups, the same way both
//! original implementations' callers did.

/// Normalizes a rotation value to `[0, 360)`. Matches both original
/// implementations exactly: `parseInt(rotation) || 0` (fall back to 0 for
/// anything that doesn't parse as an integer, including NaN) then
/// `((n % 360) + 360) % 360` (handles negative values correctly, unlike a
/// plain `% 360`).
#[must_use]
pub fn normalize_rotation(rotation: f64) -> i64 {
    let n = if rotation.is_finite() { rotation.trunc() as i64 } else { 0 };
    ((n % 360) + 360) % 360
}

/// Port of `NfpCache.makeKey` / `nfpCacheKey`: the single NFP cache-key
/// format both call sites now share. `a`/`b` are the part/sheet source
/// identifiers (`A.source`/`B.source` in the original); `a_flipped`/
/// `b_flipped` default to `false` in every call site found in the Electron
/// repo (the fields exist in the key format but nothing ever actually sets
/// them true - no mirrored-part feature exists yet) but are kept as real
/// parameters rather than dropped, since they're part of the on-the-wire key
/// format this must stay compatible with.
#[must_use]
pub fn nfp_cache_key(a: &str, b: &str, a_rotation: f64, b_rotation: f64, a_flipped: bool, b_flipped: bool) -> String {
    let a_rotation = normalize_rotation(a_rotation);
    let b_rotation = normalize_rotation(b_rotation);
    let a_flipped = if a_flipped { "1" } else { "0" };
    let b_flipped = if b_flipped { "1" } else { "0" };
    format!("{a}-{b}-{a_rotation}-{b_rotation}-{a_flipped}-{b_flipped}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_a_plain_angle() {
        assert_eq!(normalize_rotation(90.0), 90);
    }

    #[test]
    fn folds_a_full_rotation_cycle_back_to_zero() {
        // the ">= not >" quirk this guards against lives in background.js's
        // rotation-increment loop (Phase 3/4), not in this function itself -
        // this modulo formula already handles any integer input correctly,
        // boundary or not
        assert_eq!(normalize_rotation(360.0), 0);
        assert_eq!(normalize_rotation(720.0), 0);
    }

    #[test]
    fn normalizes_a_negative_rotation() {
        assert_eq!(normalize_rotation(-90.0), 270);
    }

    #[test]
    fn non_finite_rotation_falls_back_to_zero() {
        assert_eq!(normalize_rotation(f64::NAN), 0);
    }

    #[test]
    fn key_format_matches_the_original_five_dash_layout() {
        let key = nfp_cache_key("partA", "partB", 90.0, 180.0, false, false);
        assert_eq!(key, "partA-partB-90-180-0-0");
    }

    #[test]
    fn geometrically_identical_angles_share_a_key() {
        let k1 = nfp_cache_key("A", "B", 360.0, 0.0, false, false);
        let k2 = nfp_cache_key("A", "B", 0.0, 0.0, false, false);
        assert_eq!(k1, k2);
    }

    #[test]
    fn flipped_flags_change_the_key() {
        let k1 = nfp_cache_key("A", "B", 0.0, 0.0, false, false);
        let k2 = nfp_cache_key("A", "B", 0.0, 0.0, true, false);
        assert_ne!(k1, k2);
    }
}
