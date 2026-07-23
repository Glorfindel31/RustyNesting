// Two pure client-side display preferences - accent color and text scale -
// applied as CSS custom-property overrides on <html> (an inline style on
// the root always wins over the :root defaults in app.css, no extra
// specificity tricks needed) and persisted the same way i18n.js persists
// language: one localStorage key each, applied once on load, re-applied on
// change. Every font-size in app.css is in rem, relative to <html>'s own
// font-size - scaling that one property scales the whole UI proportionally
// instead of needing per-element size math here.

const ACCENT_KEY = "rustynesting-accent";
const SCALE_KEY = "rustynesting-scale";

// The five swatches are quick-pick shortcuts, not the only allowed values -
// setAccent/getAccent below validate against HEX_RE (any valid hex color),
// not against this list, so the hex input can set anything.
export const ACCENTS = ["#ffc400", "#ff6a3d", "#4fd15c", "#4fc3f7", "#ff4fd8"];
const DEFAULT_ACCENT = ACCENTS[0];
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// Multiplier on <html>'s base 16px font-size - deliberately just three
// steps (not a free slider) to match the "small/normal/big" labels the UI
// shows, not a raw pixel value.
export const SCALES = { small: 0.875, normal: 1, large: 1.15 };

export function getAccent() {
  const saved = localStorage.getItem(ACCENT_KEY);
  return saved && HEX_RE.test(saved) ? saved : DEFAULT_ACCENT;
}

export function getScaleName() {
  const saved = localStorage.getItem(SCALE_KEY);
  return SCALES[saved] ? saved : "normal";
}

export function setAccent(color) {
  const value = HEX_RE.test(color) ? color : DEFAULT_ACCENT;
  localStorage.setItem(ACCENT_KEY, value);
  document.documentElement.style.setProperty("--accent", value);
}

export function setScale(scaleName) {
  const name = SCALES[scaleName] ? scaleName : "normal";
  localStorage.setItem(SCALE_KEY, name);
  document.documentElement.style.setProperty("--text-scale", SCALES[name]);
}

export function applySavedPrefs() {
  setAccent(getAccent());
  setScale(getScaleName());
}
