// Minimal Phase 6 UI: talks directly to the Rust engine via Tauri's
// import_dxf_command/run_nest_command. Deliberately not an adaptation of
// the legacy Ractive UI (frontend/deepnest.js, frontend/ui/**) - that code
// assumes a Node-integrated Electron renderer (require("electron"),
// require("@electron/remote"), require("axios"), etc.) that doesn't exist
// in Tauri's webview, and much of it (SVG import, a remote DXF-conversion
// service) targets features this project's DXF-only scope already dropped.
// Kept as reference, not wired up. See docs/PORT_STATUS.md's Phase 6 table.

const invoke = window.__TAURI__.core.invoke;

/** @type {{layer: string, points: {x:number,y:number}[], is_circle: unknown, children: unknown[]}[]} */
let importedShapes = [];

// Remembered across a run so a later action (picking a different history
// entry, exporting) doesn't need to re-invoke the engine - it's all
// already in the last response.
let lastNestRequest = null;
let currentSnapshot = null;
// The authoritative id -> shape mapping from the last run_nest_command
// response (RunNestResponse::parts_by_id) - used for both rendering and
// export, instead of each independently re-deriving its own id->shape
// mapping from request.parts/quantities (fragile: has to exactly mirror
// dto::expand_parts's sequential id assignment, and export_dxf used to do
// exactly this server-side too - see that command's own doc comment for
// the silent-corruption risk this replaces).
let lastPartsById = null;
// Set at the start of each run so the "nest-tick" listener below can turn
// (generation, individuals_done/individuals_total) into an overall
// percentage - the tick event itself doesn't carry the total generation
// count, only run_nest_command's own request did.
let currentGenerations = 0;

// Live preview - commented out (2026), never worked reliably; not deleted
// so it's easy to pick back up later. See index.html's matching commented-
// out #cfg-live-viz/#live-preview-section and src-tauri's
// NestConfigDto::live_visualization/run_nest_with_progress.
/*
let liveViewActive = false;
let liveShapesById = {};
let liveSheetEls = {};
let liveQueue = [];
let liveTicking = false;
*/

const el = (id) => document.getElementById(id);

function setStatus(id, message, isError) {
  const node = el(id);
  node.textContent = message;
  node.classList.toggle("error", Boolean(isError));
}

function setBusy(spinnerId, busy) {
  el(spinnerId).hidden = !busy;
}

// A running log of what the app is doing, like the old Electron UI's
// console - import/run start, success, failure, and (via the
// "nest-progress" event below) live per-generation stats while a run is in
// progress, instead of the UI just going quiet until the whole run returns.
function logLine(message) {
  const node = el("console-log");
  const time = new Date().toLocaleTimeString();
  const line = `[${time}] ${message}`;
  node.textContent += line + "\n";
  node.scrollTop = node.scrollHeight;
  // Fire-and-forget: also append to the on-disk log
  // (<app_log_dir>/rustynesting.log) so this history survives past the
  // window closing - the console panel above is DOM-only and empties every
  // restart, which made a bad run impossible to look at after the fact.
  invoke("append_log_command", { line }).catch(() => {});
}

// Locks/unlocks every import/role/config control while a nest is running,
// so a config change mid-run can't silently apply to a request that's
// already in flight (buildRequest() already snapshotted its own copy, but
// letting the user edit fields that look "live" while ignored was
// confusing on its own).
function setControlsLocked(locked) {
  const selector =
    "#panel-import input, #panel-import select, #panel-import button, #panel-shapes input, #panel-shapes select, #panel-shapes button, #panel-config input, #panel-config select, #panel-config button:not(#btn-run):not(#btn-stop)";
  document.querySelectorAll(selector).forEach((node) => {
    node.disabled = locked;
  });
}

function boundsOf(points) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minx = Math.min(...xs);
  const miny = Math.min(...ys);
  return { minx, miny, w: Math.max(...xs) - minx, h: Math.max(...ys) - miny };
}

// DXF/CAD coordinates are y-up; SVG coordinates are y-down. Rendering raw
// points would mirror the layout vertically compared to how it looks in a
// CAD viewer - flip within the sheet's own bounding box instead.
function toSvgPoints(points, sheetBounds) {
  return points.map((p) => ({ x: p.x - sheetBounds.minx, y: sheetBounds.h - (p.y - sheetBounds.miny) }));
}

// Real DXF layers are arbitrary user-given names (cut/etch/drill/whatever a
// given job uses), so there's no fixed palette to draw from - hash the name
// to a hue instead. Same layer name always gets the same color, in both the
// shape thumbnails and the nested result, without needing a legend or any
// per-job configuration.
function colorForLayer(layer) {
  let hash = 0;
  for (let i = 0; i < layer.length; i++) hash = (hash * 31 + layer.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360}, 85%, 65%)`;
}

// Recursively draws a shape and every nested child (holes, interior
// features on other layers) - a DXF part is a tree, not just its outer
// boundary, and dropping the children was silently discarding layer
// identity the app is supposed to preserve end to end. `transformPoints`
// does whatever coordinate mapping the caller needs (thumbnail-local bounds,
// or rotate+translate+sheet-relative for a placed part) - every node in the
// tree shares the same rigid transform since children are defined relative
// to the same local origin as their parent.
const UNPLACED_COLOR = "#ff5a4a"; // matches --error in app.css

// `strokeOverride`, when given, replaces colorForLayer for every node in the
// tree - used to render an unplaced part entirely in the "error" color
// regardless of its real layer, so it reads as "this one's a problem" at a
// glance rather than blending in with normally-colored parts.
function renderShapeSvg(shape, transformPoints, isRoot = true, strokeOverride = null) {
  const pts = transformPoints(shape.points);
  const stroke = strokeOverride ?? colorForLayer(shape.layer);
  let markup = `<polygon points="${pointsToPath(pts)}" fill="none" stroke="${stroke}" stroke-width="${isRoot ? 1.4 : 1}" vector-effect="non-scaling-stroke" />`;
  for (const child of shape.children ?? []) markup += renderShapeSvg(child, transformPoints, false, strokeOverride);
  return markup;
}

function shapeThumbnailSvg(shape, strokeOverride = null) {
  const bounds = boundsOf(shape.points);
  const pad = Math.max(bounds.w, bounds.h, 1) * 0.08;
  const vbW = bounds.w + pad * 2;
  const vbH = bounds.h + pad * 2;
  const transform = (points) => toSvgPoints(points, bounds).map((p) => ({ x: p.x + pad, y: p.y + pad }));
  return `<svg class="thumb" viewBox="0 0 ${vbW.toFixed(2)} ${vbH.toFixed(2)}" width="56" height="56">${renderShapeSvg(shape, transform, true, strokeOverride)}</svg>`;
}

// Imports every path in `paths` (one import_dxf_command call each - the
// command only reads a single file) and appends their shapes onto whatever
// was already imported, so multiple files/drops accumulate into one part
// pool instead of each import replacing the last. A failure on one file is
// logged and skipped rather than aborting the rest of the batch.
async function importPaths(paths) {
  if (paths.length === 0) return;
  const tolerance = Number(el("import-tolerance").value);

  setStatus("import-status", `importing ${paths.length} file(s)...`, false);
  el("btn-import").disabled = true;
  setBusy("import-spinner", true);
  let imported = 0;
  for (const path of paths) {
    logLine(`import: ${path} (tolerance ${tolerance})`);
    try {
      const shapes = await invoke("import_dxf_command", { path, curve_tolerance: tolerance });
      importedShapes = importedShapes.concat(shapes);
      imported += shapes.length;
      logLine(`import ok: ${shapes.length} shape(s) from ${path}`);
    } catch (err) {
      logLine(`import failed for ${path}: ${err}`);
    }
  }
  el("btn-import").disabled = false;
  setBusy("import-spinner", false);

  if (imported > 0) {
    setStatus("import-status", `${imported} shape(s) imported (${importedShapes.length} total)`, false);
    renderShapesTable();
    el("panel-shapes").hidden = false;
    el("panel-config").hidden = false;
  } else {
    setStatus("import-status", "no shapes imported - see console", true);
  }
}

function handleToggleShapes() {
  const body = el("shapes-collapsible");
  const button = el("btn-toggle-shapes");
  const collapsed = !body.hidden;
  body.hidden = collapsed;
  button.textContent = collapsed ? "EXPAND" : "COLLAPSE";
}

async function handleBrowse() {
  const selected = await window.__TAURI__.dialog.open({
    multiple: true,
    filters: [{ name: "DXF", extensions: ["dxf"] }],
  });
  if (!selected) return; // user cancelled
  const paths = Array.isArray(selected) ? selected : [selected];
  await importPaths(paths);
}

// Appends rows for any shape not yet rendered, rather than clearing and
// rebuilding the whole table - importing happens incrementally now (a
// second file, a dropped file, a hand-added rectangle), and rebuilding
// every row from scratch would silently discard whatever ROLE/QTY the user
// already set on earlier rows.
function renderShapesTable() {
  const body = el("shapes-body");
  for (let i = body.children.length; i < importedShapes.length; i++) {
    const shape = importedShapes[i];
    const { w, h } = boundsOf(shape.points);
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${i}</td>
      <td>${shape.layer}</td>
      <td>${shape.points.length}</td>
      <td>${w.toFixed(1)} × ${h.toFixed(1)}</td>
      <td>${shapeThumbnailSvg(shape)}</td>
      <td>
        <select data-role="${i}">
          <option value="part">PART</option>
          <option value="sheet">SHEET</option>
          <option value="skip">SKIP</option>
        </select>
      </td>
      <td><input type="number" data-qty="${i}" value="1" min="0" step="1" /></td>
      <td><span class="dominant-flag" data-dominant="${i}"></span></td>
    `;
    body.appendChild(row);
  }
  updateDominantIndicators();
}

// Shoelace formula - matches geometry::polygon::polygon_area exactly (only
// the magnitude matters here, not winding direction).
function polygonArea(points) {
  let area = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const j = (i + n - 1) % n;
    area += (points[j].x + points[i].x) * (points[j].y - points[i].y);
  }
  return Math.abs(0.5 * area);
}

// Live preview of nesting::placement::place_parts's own "part_area >=
// dominant_part_area_threshold * sheet_area" check - a part that trips this
// isn't excluded from nesting, it still gets placed, it just closes
// whichever sheet it lands on immediately afterward instead of sharing it.
// Reference sheet is the LARGEST shape currently marked SHEET: a part that
// clears the bar against the biggest available sheet clears it against
// every smaller one too, so this only flags parts that are *always*
// dominant regardless of which sheet they end up on - a deliberate
// under-flag for mixed sheet sizes rather than a per-sheet-size breakdown.
function updateDominantIndicators() {
  const dominantInput = el("cfg-dominant");
  if (!dominantInput) return;
  const threshold = Number(dominantInput.value);

  let maxSheetArea = 0;
  importedShapes.forEach((shape, i) => {
    const roleEl = document.querySelector(`[data-role="${i}"]`);
    if (roleEl?.value === "sheet") {
      maxSheetArea = Math.max(maxSheetArea, polygonArea(shape.points));
    }
  });

  importedShapes.forEach((shape, i) => {
    const cell = document.querySelector(`[data-dominant="${i}"]`);
    if (!cell) return;
    const roleEl = document.querySelector(`[data-role="${i}"]`);
    const isDominant = roleEl?.value === "part" && maxSheetArea > 0 && polygonArea(shape.points) >= threshold * maxSheetArea;
    cell.textContent = isDominant ? "CLOSES SHEET" : "";
  });
}

// Lets the user define a sheet or part directly by size, instead of
// needing a DXF file for it - e.g. a stock sheet size that isn't in any
// DXF on hand yet. Built the same shape as an imported PolygonDto so it
// flows through buildRequest/renderShapesTable unchanged.
function handleAddRectangle() {
  const width = Number(el("rect-width").value);
  const height = Number(el("rect-height").value);
  const layer = el("rect-layer").value.trim() || "CUSTOM";
  if (!(width > 0) || !(height > 0)) {
    setStatus("import-status", "width and height must both be greater than 0", true);
    return;
  }

  importedShapes.push({
    layer,
    points: [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ],
    is_circle: null,
    children: [],
  });
  logLine(`added custom rectangle: ${width} x ${height} (layer "${layer}")`);
  renderShapesTable();
  el("panel-shapes").hidden = false;
  el("panel-config").hidden = false;
}

function shapeToPolygonDto(shape) {
  return { points: shape.points, layer: shape.layer, is_circle: shape.is_circle ?? null, children: shape.children ?? [], texts: shape.texts ?? [] };
}

function buildRequest() {
  const sheets = [];
  const parts = [];

  importedShapes.forEach((shape, i) => {
    const role = document.querySelector(`[data-role="${i}"]`).value;
    const qty = Number(document.querySelector(`[data-qty="${i}"]`).value);
    if (role === "sheet") {
      for (let n = 0; n < Math.max(qty, 1); n++) sheets.push(shapeToPolygonDto(shape));
    } else if (role === "part" && qty > 0) {
      parts.push({ polygon: shapeToPolygonDto(shape), quantity: qty });
    }
  });

  const config = {
    placement_type: el("cfg-placement-type").value,
    rotations: Number(el("cfg-rotations").value),
    population_size: Number(el("cfg-population").value),
    mutation_rate: Number(el("cfg-mutation").value),
    dominant_part_area_threshold: Number(el("cfg-dominant").value),
    curve_tolerance: Number(el("import-tolerance").value),
    generations: Number(el("cfg-generations").value),
    margin: Number(el("cfg-margin").value),
    spacing: Number(el("cfg-spacing").value),
    max_threads: Number(el("cfg-max-threads").value),
    seed: Number(el("cfg-seed").value),
    // live_visualization: el("cfg-live-viz").checked, // live preview, commented out - see index.html
  };

  return { sheets, parts, config };
}

async function handleRunNest() {
  const request = buildRequest();
  if (request.sheets.length === 0) {
    setStatus("run-status", "mark at least one shape as SHEET", true);
    return;
  }
  if (request.parts.length === 0) {
    setStatus("run-status", "mark at least one shape as PART with quantity > 0", true);
    return;
  }

  const partInstances = request.parts.reduce((n, p) => n + p.quantity, 0);
  currentGenerations = request.config.generations;
  setStatus("run-status", "nesting...", false);
  logLine(
    request.config.live_visualization
      ? `live preview: ${request.sheets.length} sheet(s), ${partInstances} part instance(s), one placement pass`
      : `nest: ${request.sheets.length} sheet(s), ${partInstances} part instance(s), ${request.config.generations} generation(s)`
  );
  invoke("save_config_command", { config: request.config }).catch((err) => logLine(`could not save config: ${err}`));
  el("btn-run").disabled = true;
  el("btn-stop").hidden = false;
  el("btn-stop").disabled = false;
  setControlsLocked(true);
  setBusy("run-spinner", true);
  el("run-progress").hidden = false;
  el("run-progress-fill").style.width = "0%";

  lastNestRequest = request;
  /* Live preview - commented out, see index.html/app.js's other commented-out live-preview blocks.
  liveViewActive = request.config.live_visualization;
  liveShapesById = {};
  liveSheetEls = {};
  liveQueue.length = 0; // discard anything still queued/animating from a previous live run
  syncLivePreviewSectionVisibility();
  el("live-sheets").innerHTML = "";
  */

  try {
    const response = await invoke("run_nest_command", { request });
    setStatus("run-status", response.cancelled ? "stopped early" : "done", false);
    logLine(
      `nest ${response.cancelled ? "stopped early" : "done"}: fitness=${response.fitness.toFixed(1)} sheets=${response.placements.length} unplaced=${response.unplaced_count} util=${response.utilisation.toFixed(1)}%`
    );
    if (!response.cancelled) {
      el("run-progress-fill").style.width = "100%";
    }
    renderResult(response, request);
    el("panel-result").hidden = false;
  } catch (err) {
    setStatus("run-status", String(err), true);
    logLine(`nest failed: ${err}`);
  } finally {
    // liveViewActive = false; // live preview, commented out
    el("btn-run").disabled = false;
    el("btn-stop").hidden = true;
    setControlsLocked(false);
    setBusy("run-spinner", false);
    el("run-progress").hidden = true;
  }
}

async function handleStopNest() {
  // Cancellation is checked per-part inside place_parts itself (not just
  // between individuals/generations), so this takes effect within roughly
  // one part's worth of computation - not instant at the OS level, but
  // close enough in practice that no "still finishing up" caveat is needed
  // here anymore.
  logLine("stop requested");
  el("btn-stop").disabled = true;
  try {
    await invoke("cancel_nest_command");
  } catch (err) {
    logLine(`stop request failed: ${err}`);
    el("btn-stop").disabled = false; // let the user try again instead of getting stuck
  }
}

function rotatedTranslatedPoints(points, rotationDeg, dx, dy) {
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return points.map((p) => ({ x: p.x * cos - p.y * sin + dx, y: p.x * sin + p.y * cos + dy }));
}

function pointsToPath(points) {
  return points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
}

// A rough, honest guess at *why* a part didn't place - the engine itself
// doesn't produce a structured reason, just "didn't fit in the best attempt
// found". The one thing we CAN check independently is whether the part's
// own bounding box could ever fit any available sheet's bounding box at
// all (in either orientation) - if not, it's not a "try more generations"
// problem, it's genuinely too big.
function unplacedReason(shape, request) {
  const { w, h } = boundsOf(shape.points);
  const fitsSomeSheet = request.sheets.some((sheetDto) => {
    const sb = boundsOf(sheetDto.points);
    return (w <= sb.w && h <= sb.h) || (w <= sb.h && h <= sb.w);
  });
  return fitsSomeSheet
    ? "Didn't find room in this run - try more generations, a smaller margin/spacing, or fewer competing parts."
    : "Too large to fit on any available sheet at all (checked its own width/height against every sheet's), even by itself.";
}

// Renders one candidate nest (either the final response's own top-level
// fields, or one entry from its `history`) - both have the exact same
// shape (placements/fitness/utilisation/unplaced_count/unplaced_ids), so
// one renderer covers whichever the user picks in the VIEW ATTEMPT select.
function renderSnapshot(snapshot, request) {
  currentSnapshot = snapshot;

  const stats = el("result-stats");
  stats.innerHTML = `
    <div><dt>FITNESS</dt><dd>${snapshot.fitness.toFixed(1)}</dd></div>
    <div><dt>UTILISATION</dt><dd>${snapshot.utilisation.toFixed(1)}%</dd></div>
    <div><dt>UNPLACED</dt><dd>${snapshot.unplaced_count}</dd></div>
    <div><dt>SHEETS USED</dt><dd>${snapshot.placements.length}</dd></div>
  `;

  const unplacedSection = el("unplaced-section");
  const unplacedList = el("unplaced-list");
  unplacedList.innerHTML = "";
  const unplacedIds = snapshot.unplaced_ids ?? [];
  unplacedSection.hidden = unplacedIds.length === 0;
  for (const id of unplacedIds) {
    const shape = lastPartsById[id];
    if (!shape) continue;
    const item = document.createElement("div");
    item.className = "unplaced-item";
    item.title = unplacedReason(shape, request);
    item.innerHTML = `${shapeThumbnailSvg(shape, UNPLACED_COLOR)}<span>#${id} ${shape.layer}</span>`;
    unplacedList.appendChild(item);
  }

  const sheetsEl = el("sheets");
  sheetsEl.innerHTML = "";

  for (const placement of snapshot.placements) {
    const sheetDto = request.sheets[placement.sheet_index];
    const sheetBounds = boundsOf(sheetDto.points);
    const { w, h } = sheetBounds;
    const scale = Math.min(700 / Math.max(w, 1), 500 / Math.max(h, 1));

    const wrapper = document.createElement("div");
    wrapper.className = "sheet";

    const svgParts = placement.parts
      .map((p) => {
        const shape = lastPartsById[p.id];
        if (!shape) return "";
        const transform = (points) => toSvgPoints(rotatedTranslatedPoints(points, p.rotation, p.x, p.y), sheetBounds);
        return renderShapeSvg(shape, transform);
      })
      .join("");

    wrapper.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" width="${(w * scale).toFixed(0)}" height="${(h * scale).toFixed(0)}">
        <polygon points="${pointsToPath(toSvgPoints(sheetDto.points, sheetBounds))}" fill="none" stroke="#8a8a8a" stroke-width="${1 / scale}" />
        ${svgParts}
      </svg>
      <div class="caption">SHEET ${placement.sheet_index} — ${placement.parts.length} part(s)</div>
    `;
    sheetsEl.appendChild(wrapper);
  }
}

// Populates the VIEW ATTEMPT select from response.history (every nest that
// beat the previous best, not just the final winner) and renders whichever
// one is selected - defaulting to the last (the same one the top-level
// response fields describe).
function renderResult(response, request) {
  lastNestRequest = request;
  lastPartsById = response.parts_by_id;

  const historyRow = el("history-row");
  const select = el("history-select");
  const history = response.history?.length ? response.history : [response];
  historyRow.hidden = history.length <= 1;

  select.innerHTML = history
    .map((h, i) => {
      const isLast = i === history.length - 1;
      const label = `#${i + 1} gen ${h.generation ?? "-"}${isLast ? " (best)" : ""} - fitness ${h.fitness.toFixed(0)}, ${h.unplaced_count} unplaced`;
      return `<option value="${i}">${label}</option>`;
    })
    .join("");
  select.value = String(history.length - 1);
  select.onchange = () => renderSnapshot(history[Number(select.value)], request);

  renderSnapshot(history[history.length - 1], request);
}

async function handleExport() {
  if (!currentSnapshot || !lastNestRequest || !lastPartsById) return;

  const sheetSpacing = Number(el("export-spacing").value);
  if (!(sheetSpacing >= 0)) {
    setStatus("export-status", "sheet spacing must be 0 or more", true);
    return;
  }
  const includeSheetOutline = el("export-outline").checked;

  const path = await window.__TAURI__.dialog.save({
    defaultPath: "nest.dxf",
    filters: [{ name: "DXF", extensions: ["dxf"] }],
  });
  if (!path) return; // user cancelled

  const request = {
    sheets: lastNestRequest.sheets,
    // The authoritative id -> shape mapping run_nest_command itself built
    // (RunNestResponse::parts_by_id), not a re-sent parts/quantity list for
    // export_dxf to re-derive its own mapping from - see that DTO field's
    // doc comment for the silent-corruption risk this avoids.
    parts_by_id: lastPartsById,
    placements: currentSnapshot.placements,
    sheet_spacing: sheetSpacing,
    include_sheet_outline: includeSheetOutline,
  };

  setStatus("export-status", "exporting...", false);
  logLine(`export: ${path} (sheet spacing ${sheetSpacing}mm, sheet outline ${includeSheetOutline ? "on" : "off"})`);
  el("btn-export").disabled = true;
  try {
    await invoke("export_dxf_command", { path, request });
    setStatus("export-status", "exported", false);
    logLine(`export ok: ${path}`);
  } catch (err) {
    setStatus("export-status", String(err), true);
    logLine(`export failed: ${err}`);
  } finally {
    el("btn-export").disabled = false;
  }
}

el("btn-import").addEventListener("click", handleBrowse);
el("btn-add-rect").addEventListener("click", handleAddRectangle);
el("btn-run").addEventListener("click", handleRunNest);
el("btn-stop").addEventListener("click", handleStopNest);
el("btn-toggle-shapes").addEventListener("click", handleToggleShapes);
el("btn-export").addEventListener("click", handleExport);

// Live percentage readout + dominant-part re-check on every slider move.
el("cfg-dominant").addEventListener("input", () => {
  el("cfg-dominant-value").textContent = `${Math.round(Number(el("cfg-dominant").value) * 100)}%`;
  updateDominantIndicators();
});

/* Live preview - commented out, see index.html/app.js's other commented-out live-preview blocks.
el("cfg-live-viz-speed").addEventListener("input", () => {
  el("cfg-live-viz-speed-value").textContent = `${el("cfg-live-viz-speed").value}ms`;
});

function syncLivePreviewSectionVisibility() {
  el("live-preview-section").hidden = !el("cfg-live-viz").checked;
}
el("cfg-live-viz").addEventListener("change", syncLivePreviewSectionVisibility);
*/

// Delegated (not per-row) since rows are added dynamically after this
// listener is wired - a shape's ROLE changes which shapes count as "sheet"
// for the dominant-area comparison, so it needs the same re-check.
el("shapes-body").addEventListener("change", (event) => {
  if (event.target.matches("[data-role]")) {
    updateDominantIndicators();
  }
});

// Restores the config panel to whatever was last saved
// (save_config_command, called right before every run) so a new session
// starts from the previous one's settings instead of index.html's
// hardcoded defaults - lets a follow-up session actually see what the last
// test run used.
async function loadSavedConfig() {
  let saved;
  try {
    saved = await invoke("load_config_command");
  } catch (err) {
    logLine(`could not load saved config: ${err}`);
    return;
  }
  if (!saved) return;
  el("cfg-placement-type").value = saved.placement_type;
  el("cfg-rotations").value = saved.rotations;
  el("cfg-population").value = saved.population_size;
  el("cfg-mutation").value = saved.mutation_rate;
  el("cfg-dominant").value = saved.dominant_part_area_threshold;
  el("cfg-dominant-value").textContent = `${Math.round(saved.dominant_part_area_threshold * 100)}%`;
  el("cfg-generations").value = saved.generations;
  el("cfg-margin").value = saved.margin;
  el("cfg-spacing").value = saved.spacing;
  el("cfg-max-threads").value = saved.max_threads;
  el("cfg-seed").value = saved.seed ?? 0;
  // el("cfg-live-viz").checked = Boolean(saved.live_visualization); // live preview, commented out
  // syncLivePreviewSectionVisibility();
  el("import-tolerance").value = saved.curve_tolerance;
  updateDominantIndicators();
  logLine("restored config from last session");
}
loadSavedConfig();

// Offers to restore the best nest result ever saved to disk
// (run_nest_command persists it after every run that beats the previous
// best - see that command's own doc comment) so a fresh session doesn't
// start blank after closing the app mid-work. Renders through the same
// renderSnapshot() the live run flow uses - a recovered result has no
// `history` (only the winning snapshot was ever persisted), so it's shown
// as a single-entry view rather than through renderResult()'s history select.
async function tryRecoverBestResult() {
  let best;
  try {
    best = await invoke("load_best_result_command");
  } catch (err) {
    logLine(`could not load saved best result: ${err}`);
    return;
  }
  if (!best) return;

  const recover = await window.__TAURI__.dialog.ask(
    `A saved nest result from a previous session exists (${best.placements.length} sheet(s), ${best.utilisation.toFixed(1)}% utilisation). Recover it?`,
    { title: "Recover last session?", kind: "info" },
  );

  if (!recover) {
    try {
      await invoke("clear_best_result_command");
    } catch (err) {
      logLine(`could not clear saved best result: ${err}`);
    }
    return;
  }

  lastPartsById = best.parts_by_id;
  const request = { sheets: best.sheets };
  lastNestRequest = request;
  el("history-row").hidden = true;
  renderSnapshot(best, request);
  el("panel-result").hidden = false;
  logLine("recovered best result from a previous session");
}
tryRecoverBestResult();

// Live per-generation stats while a nest run is in progress, emitted by
// run_nest_command (see src-tauri/src/commands.rs's run_nest_with_progress)
// - the Rust-side counterpart to this UI's console panel.
window.__TAURI__.event.listen("nest-progress", (event) => {
  const p = event.payload;
  logLine(`gen ${p.generation}/${p.generations}: fitness=${p.best_fitness.toFixed(1)} sheets=${p.sheets_used} unplaced=${p.unplaced_count} util=${p.utilisation.toFixed(1)}%`);
  el("run-progress-fill").style.width = `${((100 * p.generation) / p.generations).toFixed(1)}%`;
});

// Fires far more often than "nest-progress" above - once up front and once
// per individual placed, inside a single generation - so the console and
// progress bar keep moving during a slow generation instead of sitting
// still (a single individual's placement against real, non-trivial
// geometry can take tens of seconds, and without this there was no signal
// at all between "generation started" and "generation finished").
window.__TAURI__.event.listen("nest-tick", (event) => {
  const t = event.payload;
  logLine(t.individuals_done === 0 ? `gen ${t.generation}: starting (${t.individuals_total} to place)...` : `gen ${t.generation}: ${t.individuals_done}/${t.individuals_total} individuals placed`);
  if (currentGenerations > 0) {
    const fraction = t.individuals_total > 0 ? t.individuals_done / t.individuals_total : 0;
    const overall = ((t.generation - 1 + fraction) / currentGenerations) * 100;
    el("run-progress-fill").style.width = `${overall.toFixed(1)}%`;
  }
});

// Live preview - commented out (2026), never worked reliably; not deleted
// so it's easy to pick back up later. See index.html's matching commented-
// out #cfg-live-viz/#live-preview-section and src-tauri's
// NestConfigDto::live_visualization/run_nest_with_progress (also commented
// out) for the backend half of this.
/*
window.__TAURI__.event.listen("nest-live-start", (event) => {
  if (!liveViewActive) return; // stale event from a run that already finished/failed
  liveShapesById = event.payload;
  liveSheetEls = {};
  el("live-sheets").innerHTML = "";
  el("live-caption").textContent = "";
  logLine(`live preview: starting (${Object.keys(liveShapesById).length} part instance(s))`);
});

function renderLivePart(sheetIndex, part) {
  if (!lastNestRequest) return;
  const shape = liveShapesById[part.id];
  if (!shape) return;

  let sheetEl = liveSheetEls[sheetIndex];
  if (!sheetEl) {
    const sheetDto = lastNestRequest.sheets[sheetIndex];
    const sheetBounds = boundsOf(sheetDto.points);
    const { w, h } = sheetBounds;
    const scale = Math.min(700 / Math.max(w, 1), 500 / Math.max(h, 1));

    const wrapper = document.createElement("div");
    wrapper.className = "sheet";
    wrapper.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" width="${(w * scale).toFixed(0)}" height="${(h * scale).toFixed(0)}">
        <polygon points="${pointsToPath(toSvgPoints(sheetDto.points, sheetBounds))}" fill="none" stroke="#8a8a8a" stroke-width="${1 / scale}" />
      </svg>
      <div class="caption">SHEET ${sheetIndex} — <span data-count>0</span> part(s)</div>
    `;
    el("live-sheets").appendChild(wrapper);
    sheetEl = { svg: wrapper.querySelector("svg"), sheetBounds, count: 0, caption: wrapper.querySelector("[data-count]") };
    liveSheetEls[sheetIndex] = sheetEl;
  }

  const transform = (points) => toSvgPoints(rotatedTranslatedPoints(points, part.rotation, part.x, part.y), sheetEl.sheetBounds);
  sheetEl.svg.insertAdjacentHTML("beforeend", renderShapeSvg(shape, transform));
  sheetEl.count += 1;
  sheetEl.caption.textContent = String(sheetEl.count);
}

function tickLiveQueue() {
  if (liveQueue.length === 0) {
    liveTicking = false;
    return;
  }
  const item = liveQueue.shift();
  switch (item.type) {
    case "generation-start":
      liveSheetEls = {};
      el("live-sheets").innerHTML = "";
      el("live-caption").textContent =
        `GEN ${item.generation}/${item.generations} — fitness ${item.fitness.toFixed(1)}` +
        (item.unplaced_count > 0 ? ` — ${item.unplaced_count} unplaced` : "");
      break;
    case "part-placed":
      renderLivePart(item.sheet_index, item.part);
      break;
  }
  setTimeout(tickLiveQueue, Number(el("cfg-live-viz-speed").value));
}

function ensureLiveTicking() {
  if (liveTicking) return;
  liveTicking = true;
  tickLiveQueue();
}

window.__TAURI__.event.listen("nest-live-generation-result", (event) => {
  if (!liveViewActive) return;
  const { generation, generations, fitness, unplaced_count, placements } = event.payload;
  liveQueue.push({ type: "generation-start", generation, generations, fitness, unplaced_count });
  for (const sheetPlacement of placements) {
    for (const part of sheetPlacement.parts) {
      liveQueue.push({ type: "part-placed", sheet_index: sheetPlacement.sheet_index, part });
    }
  }
  ensureLiveTicking();
});
*/

// Drag-and-drop DXF import - Tauri delivers dropped-file paths as a core
// window event (needs `dragDropEnabled: true` in tauri.conf.json's window
// config; not a plugin, so no extra capability beyond core:event:default).
const dropzone = el("dropzone");
window.__TAURI__.event.listen("tauri://drag-enter", () => dropzone.classList.add("drag-over"));
window.__TAURI__.event.listen("tauri://drag-leave", () => dropzone.classList.remove("drag-over"));
window.__TAURI__.event.listen("tauri://drag-drop", (event) => {
  dropzone.classList.remove("drag-over");
  const paths = event.payload.paths.filter((p) => p.toLowerCase().endsWith(".dxf"));
  if (paths.length < event.payload.paths.length) {
    logLine(`ignored ${event.payload.paths.length - paths.length} dropped file(s) that weren't .dxf`);
  }
  importPaths(paths);
});
