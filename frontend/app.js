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

const el = (id) => document.getElementById(id);

function setStatus(id, message, isError) {
  const node = el(id);
  node.textContent = message;
  node.classList.toggle("error", Boolean(isError));
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
function renderShapeSvg(shape, transformPoints, isRoot = true) {
  const pts = transformPoints(shape.points);
  let markup = `<polygon points="${pointsToPath(pts)}" fill="none" stroke="${colorForLayer(shape.layer)}" stroke-width="${isRoot ? 1.4 : 1}" vector-effect="non-scaling-stroke" />`;
  for (const child of shape.children ?? []) markup += renderShapeSvg(child, transformPoints, false);
  return markup;
}

function shapeThumbnailSvg(shape) {
  const bounds = boundsOf(shape.points);
  const pad = Math.max(bounds.w, bounds.h, 1) * 0.08;
  const vbW = bounds.w + pad * 2;
  const vbH = bounds.h + pad * 2;
  const transform = (points) => toSvgPoints(points, bounds).map((p) => ({ x: p.x + pad, y: p.y + pad }));
  return `<svg class="thumb" viewBox="0 0 ${vbW.toFixed(2)} ${vbH.toFixed(2)}" width="56" height="56">${renderShapeSvg(shape, transform)}</svg>`;
}

async function handleImport() {
  const path = el("dxf-path").value.trim();
  const tolerance = Number(el("import-tolerance").value);
  if (!path) {
    setStatus("import-status", "enter a file path", true);
    return;
  }

  setStatus("import-status", "importing...", false);
  logLine(`import: ${path} (tolerance ${tolerance})`);
  el("btn-import").disabled = true;
  try {
    importedShapes = await invoke("import_dxf_command", { path, curve_tolerance: tolerance });
    setStatus("import-status", `${importedShapes.length} shape(s) imported`, false);
    logLine(`import ok: ${importedShapes.length} shape(s)`);
    renderShapesTable();
    el("panel-shapes").hidden = false;
    el("panel-config").hidden = false;
  } catch (err) {
    setStatus("import-status", String(err), true);
    logLine(`import failed: ${err}`);
  } finally {
    el("btn-import").disabled = false;
  }
}

function renderShapesTable() {
  const body = el("shapes-body");
  body.innerHTML = "";
  importedShapes.forEach((shape, i) => {
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
  });
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
  try {
    const response = await invoke("run_nest_command", { request });
    setStatus("run-status", "done", false);
    logLine(
      `nest done: fitness=${response.fitness.toFixed(1)} sheets=${response.placements.length} unplaced=${response.unplaced_count} util=${response.utilisation.toFixed(1)}%`
    );
    renderResult(response, request);
    el("panel-result").hidden = false;
  } catch (err) {
    setStatus("run-status", String(err), true);
    logLine(`nest failed: ${err}`);
  } finally {
    el("btn-run").disabled = false;
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

function renderResult(response, request) {
  const stats = el("result-stats");
  stats.innerHTML = `
    <div><dt>FITNESS</dt><dd>${response.fitness.toFixed(1)}</dd></div>
    <div><dt>UTILISATION</dt><dd>${response.utilisation.toFixed(1)}%</dd></div>
    <div><dt>UNPLACED</dt><dd>${response.unplaced_count}</dd></div>
    <div><dt>SHEETS USED</dt><dd>${response.placements.length}</dd></div>
  `;

  const partById = idToShape(request);
  const sheetsEl = el("sheets");
  sheetsEl.innerHTML = "";

  for (const placement of response.placements) {
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

el("btn-import").addEventListener("click", handleImport);
el("btn-run").addEventListener("click", handleRunNest);

// Live per-generation stats while a nest run is in progress, emitted by
// run_nest_command (see src-tauri/src/commands.rs's run_nest_with_progress)
// - the Rust-side counterpart to this UI's console panel.
window.__TAURI__.event.listen("nest-progress", (event) => {
  const p = event.payload;
  logLine(`gen ${p.generation}/${p.generations}: fitness=${p.best_fitness.toFixed(1)} sheets=${p.sheets_used} unplaced=${p.unplaced_count} util=${p.utilisation.toFixed(1)}%`);
});
