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
  node.textContent += `[${time}] ${message}\n`;
  node.scrollTop = node.scrollHeight;
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
    `;
    body.appendChild(row);
  }
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
  return { points: shape.points, layer: shape.layer, is_circle: shape.is_circle ?? null, children: shape.children ?? [] };
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
  };

  return { sheets, parts, config };
}

// Mirrors dto::expand_parts's id assignment exactly: sequential ids
// starting at 0, in request.parts order, one per physical copy - needed
// client-side to know which imported shape a returned placement's `id`
// refers to, since the response only carries id/x/y/rotation, not geometry.
function idToShape(request) {
  const map = new Map();
  let nextId = 0;
  for (const part of request.parts) {
    for (let n = 0; n < part.quantity; n++) {
      map.set(nextId, part.polygon);
      nextId++;
    }
  }
  return map;
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
  setStatus("run-status", "nesting...", false);
  logLine(`nest: ${request.sheets.length} sheet(s), ${partInstances} part instance(s), ${request.config.generations} generation(s)`);
  el("btn-run").disabled = true;
  setBusy("run-spinner", true);
  el("run-progress").hidden = false;
  el("run-progress-fill").style.width = "0%";
  try {
    const response = await invoke("run_nest_command", { request });
    setStatus("run-status", "done", false);
    logLine(
      `nest done: fitness=${response.fitness.toFixed(1)} sheets=${response.placements.length} unplaced=${response.unplaced_count} util=${response.utilisation.toFixed(1)}%`
    );
    el("run-progress-fill").style.width = "100%";
    renderResult(response, request);
    el("panel-result").hidden = false;
  } catch (err) {
    setStatus("run-status", String(err), true);
    logLine(`nest failed: ${err}`);
  } finally {
    el("btn-run").disabled = false;
    setBusy("run-spinner", false);
    el("run-progress").hidden = true;
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

  const partById = idToShape(request);

  const unplacedSection = el("unplaced-section");
  const unplacedList = el("unplaced-list");
  unplacedList.innerHTML = "";
  const unplacedIds = snapshot.unplaced_ids ?? [];
  unplacedSection.hidden = unplacedIds.length === 0;
  for (const id of unplacedIds) {
    const shape = partById.get(id);
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
        const shape = partById.get(p.id);
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
  if (!currentSnapshot || !lastNestRequest) return;

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
    parts: lastNestRequest.parts,
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
el("btn-toggle-shapes").addEventListener("click", handleToggleShapes);
el("btn-export").addEventListener("click", handleExport);

// Live per-generation stats while a nest run is in progress, emitted by
// run_nest_command (see src-tauri/src/commands.rs's run_nest_with_progress)
// - the Rust-side counterpart to this UI's console panel.
window.__TAURI__.event.listen("nest-progress", (event) => {
  const p = event.payload;
  logLine(`gen ${p.generation}/${p.generations}: fitness=${p.best_fitness.toFixed(1)} sheets=${p.sheets_used} unplaced=${p.unplaced_count} util=${p.utilisation.toFixed(1)}%`);
  el("run-progress-fill").style.width = `${((100 * p.generation) / p.generations).toFixed(1)}%`;
});

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
