/*!
 * Deepnest
 * Licensed under GPLv3
 */

import { Point } from '../build/util/point.js';
import { HullPolygon } from '../build/util/HullPolygon.js';
import { appendBenchmarkLine, appendRunSummaryRow, gitRevision } from './benchmarkLogger.js';

const { simplifyPolygon: simplifyPoly } = require("@deepnest/svg-preprocessor");

// Cheap upfront sanity check: does each part's bounding box fit within some sheet
// type, in either orientation (0 or 90 degrees)? This is a bounding-box check only -
// not the real polygon NFP fit - so it can't produce false "doesn't fit" positives for
// oddly-shaped sheets, but it catches the common "part is just bigger than the sheet"
// case instantly instead of the real placement loop discovering it minutes later after
// retrying it on every sheet. ponytail: doesn't check intermediate rotation angles
// (e.g. 45 degrees with rotations=8) - only the two axis-aligned orientations.
// Returns the actual (oversized) part objects, not just a message, so the caller can
// select them in the UI.
function findOversizedParts(parts) {
  var sheetSizes = parts
    .filter(function (p) { return p.sheet; })
    .map(function (p) { return GeometryUtil.getPolygonBounds(p.polygontree); });

  if (sheetSizes.length === 0) {
    return [];
  }

  return parts.filter(function (p) {
    if (p.sheet) {
      return false;
    }
    var b = GeometryUtil.getPolygonBounds(p.polygontree);
    return !sheetSizes.some(function (s) {
      return (b.width <= s.width && b.height <= s.height) ||
        (b.width <= s.height && b.height <= s.width);
    });
  });
}

// Ranks nest results for display: fewer unplaced parts first (a trial that leaves
// parts out is never "better" just for using fewer sheets or packing tighter), then
// fewer sheets, then higher material utilisation. Deliberately not the raw GA fitness
// score, which bundles in things (gravity/box/hull shape penalties, edge-merge
// savings) that don't map to "which result would I actually want to export".
function isBetterNest(a, b) {
  var aUnplaced = a.unplacedCount || 0;
  var bUnplaced = b.unplacedCount || 0;
  if (aUnplaced !== bUnplaced) {
    return aUnplaced < bUnplaced;
  }
  var aSheets = a.placements ? a.placements.length : Infinity;
  var bSheets = b.placements ? b.placements.length : Infinity;
  if (aSheets !== bSheets) {
    return aSheets < bSheets;
  }
  return (a.utilisation || 0) > (b.utilisation || 0);
}

// Alternate initial-population seed orderings for GeneticAlgorithm, alongside the
// existing decreasing-area sort in launchWorkers(). Every individual used to be a
// mutation of ONE area-sorted order, so early generations only ever explored small
// variations of the same starting idea - these give the GA a couple of genuinely
// different starting points instead. Both non-mutating (.slice().sort()) - safe to
// reuse the same poly object references, since per-slot rotation lives in an
// individual's parallel `rotation` array, never on the poly object itself.
export function sortByDecreasingBBoxDimension(parts) {
  return parts.slice().sort(function (a, b) {
    var ab = GeometryUtil.getPolygonBounds(a);
    var bb = GeometryUtil.getPolygonBounds(b);
    return Math.max(bb.width, bb.height) - Math.max(ab.width, ab.height);
  });
}

// Perimeter/area is a cheap proxy for "irregular/fiddly shape" - placing those first
// while there's maximal open space to fit their concavities into tends to leave the
// remaining open space easier for later (often smaller, more regular) parts to fill.
export function sortByDecreasingIrregularity(parts) {
  function ratio(p) {
    var perimeter = 0;
    for (var i = 0; i < p.length; i++) {
      var a = p[i], b = p[(i + 1) % p.length];
      perimeter += Math.hypot(b.x - a.x, b.y - a.y);
    }
    return perimeter / Math.max(1e-9, Math.abs(GeometryUtil.polygonArea(p)));
  }
  return parts.slice().sort(function (a, b) {
    return ratio(b) - ratio(a);
  });
}

var config = {
  clipperScale: 10000000,
  curveTolerance: 0.3,
  spacing: 0,
  rotations: 4,
  populationSize: 10,
  mutationRate: 10,
  threads: 4,
  placementType: "gravity",
  mergeLines: true,
  timeRatio: 0.5,
  scale: 72,
  simplify: false,
  overlapTolerance: 0.0001,
  // A part occupying this fraction (or more) of a sheet's area is treated as "claims
  // the whole sheet" - no attempt is made to fit anything else alongside it. Pure
  // performance heuristic, trades away rare marginal packing gains for not wasting
  // time on combinations that almost never work out once one part dominates a sheet.
  dominantPartAreaThreshold: 0.9,
};

export class DeepNest {
  constructor(eventEmitter) {
    var svg = null;

    // list of imported files
    // import: {filename: 'blah.svg', svg: svgroot}
    this.imports = [];

    // list of all extracted parts
    // part: {name: 'part name', quantity: ...}
    this.parts = [];

    // a pure polygonal representation of parts that lives only during the nesting step
    this.partsTree = [];

    this.working = false;

    this.GA = null;
    this.workerTimer = null;

    this.progressCallback = null;
    this.displayCallback = null;
    // a running list of placements
    this.nests = [];
    // number of GA generations completed for the current run
    this.generationCount = 0;

    // Post-placement sheet-consolidation refinement (see refineConsolidation() in
    // main/background.js) - only ever runs on the current displayed best, triggered
    // from the background-response handler below. _refinePending guards "at most one
    // refine in flight" and lets a stale/superseded response be ignored; the sheets
    // data a refine request needs is cached here each time launchWorkers() rebuilds it.
    this._refineCounter = 0;
    this._refinePending = null;
    this._lastSheetsForRefine = null;
    // Guards start()'s IPC listener registrations against Stop -> Start duplication -
    // see the check in start() for why.
    this._listenersRegistered = false;
    // Snapshot of the current champion's gene data (see refineStalledBest() below) -
    // captured whenever a new best is found, reused to re-run refinement on that same
    // champion later without depending on this.GA.population, which gets reassigned
    // every generation.
    this._championRefineGenes = null;

    this.eventEmitter = eventEmitter;

    // mirror background-log (NFP phase timing, unplaced-part warnings, etc.) into the
    // same benchmark file as the per-generation rows, so a slow/incomplete first
    // generation still leaves a trail instead of just a gap until the next "===" run header
    this.eventEmitter.on('background-log', (event, payload) => {
      appendBenchmarkLine(`[${payload.level}] ${payload.message}`);
    });
  }

  importsvg(
    filename,
    dirpath,
    svgstring,
    scalingFactor,
    dxfFlag
  ) {
    // parse svg
    // config.scale is the default scale, and may not be applied
    // scalingFactor is an absolute scaling that must be applied regardless of input svg contents
    var svg = window.SvgParser.load(dirpath, svgstring, config.scale, scalingFactor);
    svg = window.SvgParser.cleanInput(dxfFlag);

    if (filename) {
      this.imports.push({
        filename: filename,
        svg: svg,
      });
    }

    var parts = this.getParts(svg.children, filename);
    for (var i = 0; i < parts.length; i++) {
      this.parts.push(parts[i]);
    }

    return parts;
  };

  // debug function
  renderPolygon(poly, svg, highlight) {
    if (!poly || poly.length == 0) {
      return;
    }
    var polyline = window.document.createElementNS(
      "http://www.w3.org/2000/svg",
      "polyline"
    );

    for (var i = 0; i < poly.length; i++) {
      var p = svg.createSVGPoint();
      p.x = poly[i].x;
      p.y = poly[i].y;
      polyline.points.appendItem(p);
    }
    if (highlight) {
      polyline.setAttribute("class", highlight);
    }
    svg.appendChild(polyline);
  };

  // debug function
  renderPoints(points, svg, highlight) {
    for (var i = 0; i < points.length; i++) {
      var circle = window.document.createElementNS(
        "http://www.w3.org/2000/svg",
        "circle"
      );
      circle.setAttribute("r", "5");
      circle.setAttribute("cx", points[i].x);
      circle.setAttribute("cy", points[i].y);
      circle.setAttribute("class", highlight);

      svg.appendChild(circle);
    }
  };

  getHull(polygon) {
    var points = [];
    for (let i = 0; i < polygon.length; i++) {
      points.push({
        x: polygon[i].x,
        y: polygon[i].y
      });
    }
    var hullpoints = HullPolygon.hull(points);

    if (!hullpoints) {
      return null;
    }
    return hullpoints;
  };

  // use RDP simplification, then selectively offset
  simplifyPolygon(polygon, inside) {
    var tolerance = 4 * config.curveTolerance;

    // give special treatment to line segments above this length (squared)
    var fixedTolerance =
      40 * config.curveTolerance * 40 * config.curveTolerance;
    var i, j, k;
    var self = this;

    if (config.simplify) {
      /*
      // use convex hull
      var hull = new ConvexHullGrahamScan();
      for(var i=0; i<polygon.length; i++){
        hull.addPoint(polygon[i].x, polygon[i].y);
      }

      return hull.getHull();*/
      var hull = this.getHull(polygon);
      if (hull) {
        return hull;
      } else {
        return polygon;
      }
    }

    var cleaned = this.cleanPolygon(polygon);
    if (cleaned && cleaned.length > 1) {
      polygon = cleaned;
    } else {
      return polygon;
    }

    // polygon to polyline
    var copy = polygon.slice(0);
    copy.push(copy[0]);

    // mark all segments greater than ~0.25 in to be kept
    // the PD simplification algo doesn't care about the accuracy of long lines, only the absolute distance of each point
    // we care a great deal
    for (var i = 0; i < copy.length - 1; i++) {
      var p1 = copy[i];
      var p2 = copy[i + 1];
      var sqd = (p2.x - p1.x) * (p2.x - p1.x) + (p2.y - p1.y) * (p2.y - p1.y);
      if (sqd > fixedTolerance) {
        p1.marked = true;
        p2.marked = true;
      }
    }

    var simple = simplifyPoly(copy, tolerance, true);
    // now a polygon again
    simple.pop();

    // could be dirty again (self intersections and/or coincident points)
    simple = this.cleanPolygon(simple);

    // simplification process reduced poly to a line or point
    if (!simple) {
      simple = polygon;
    }

    var offsets = this.polygonOffset(simple, inside ? -tolerance : tolerance);

    var offset = null;
    var offsetArea = 0;
    var holes = [];
    for (i = 0; i < offsets.length; i++) {
      var area = GeometryUtil.polygonArea(offsets[i]);
      if (offset == null || area < offsetArea) {
        offset = offsets[i];
        offsetArea = area;
      }
      if (area > 0) {
        holes.push(offsets[i]);
      }
    }

    // mark any points that are exact
    for (var i = 0; i < simple.length; i++) {
      var seg = [simple[i], simple[i + 1 == simple.length ? 0 : i + 1]];
      var index1 = find(seg[0], polygon);
      var index2 = find(seg[1], polygon);

      if (
        index1 + 1 == index2 ||
        index2 + 1 == index1 ||
        (index1 == 0 && index2 == polygon.length - 1) ||
        (index2 == 0 && index1 == polygon.length - 1)
      ) {
        seg[0].exact = true;
        seg[1].exact = true;
      }
    }

    var numshells = 4;
    var shells = [];

    for (var j = 1; j < numshells; j++) {
      var delta = j * (tolerance / numshells);
      delta = inside ? -delta : delta;
      var shell = this.polygonOffset(simple, delta);
      if (shell.length > 0) {
        shell = shell[0];
      }
      shells[j] = shell;
    }

    if (!offset) {
      return polygon;
    }

    // selective reversal of offset
    for (var i = 0; i < offset.length; i++) {
      var o = offset[i];
      var target = getTarget(o, simple, 2 * tolerance);

      // reverse point offset and try to find exterior points
      var test = clone(offset);
      test[i] = { x: target.x, y: target.y };

      if (!exterior(test, polygon, inside)) {
        o.x = target.x;
        o.y = target.y;
      } else {
        // a shell is an intermediate offset between simple and offset
        for (var j = 1; j < numshells; j++) {
          if (shells[j]) {
            var shell = shells[j];
            var delta = j * (tolerance / numshells);
            target = getTarget(o, shell, 2 * delta);
            var test = clone(offset);
            test[i] = { x: target.x, y: target.y };
            if (!exterior(test, polygon, inside)) {
              o.x = target.x;
              o.y = target.y;
              break;
            }
          }
        }
      }
    }

    // straighten long lines
    // a rounded rectangle would still have issues at this point, as the long sides won't line up straight

    var straightened = false;

    for (var i = 0; i < offset.length; i++) {
      var p1 = offset[i];
      var p2 = offset[i + 1 == offset.length ? 0 : i + 1];

      var sqd = (p2.x - p1.x) * (p2.x - p1.x) + (p2.y - p1.y) * (p2.y - p1.y);

      if (sqd < fixedTolerance) {
        continue;
      }
      for (var j = 0; j < simple.length; j++) {
        var s1 = simple[j];
        var s2 = simple[j + 1 == simple.length ? 0 : j + 1];

        var sqds =
          (p2.x - p1.x) * (p2.x - p1.x) + (p2.y - p1.y) * (p2.y - p1.y);

        if (sqds < fixedTolerance) {
          continue;
        }

        if (
          (GeometryUtil.almostEqual(s1.x, s2.x) ||
            GeometryUtil.almostEqual(s1.y, s2.y)) && // we only really care about vertical and horizontal lines
          GeometryUtil.withinDistance(p1, s1, 2 * tolerance) &&
          GeometryUtil.withinDistance(p2, s2, 2 * tolerance) &&
          (!GeometryUtil.withinDistance(
            p1,
            s1,
            config.curveTolerance / 1000
          ) ||
            !GeometryUtil.withinDistance(
              p2,
              s2,
              config.curveTolerance / 1000
            ))
        ) {
          p1.x = s1.x;
          p1.y = s1.y;
          p2.x = s2.x;
          p2.y = s2.y;
          straightened = true;
        }
      }
    }

    //if(straightened){
    var Ac = toClipperCoordinates(offset);
    ClipperLib.JS.ScaleUpPath(Ac, 10000000);
    var Bc = toClipperCoordinates(polygon);
    ClipperLib.JS.ScaleUpPath(Bc, 10000000);

    var combined = new ClipperLib.Paths();
    var clipper = new ClipperLib.Clipper();

    clipper.AddPath(Ac, ClipperLib.PolyType.ptSubject, true);
    clipper.AddPath(Bc, ClipperLib.PolyType.ptSubject, true);

    // the line straightening may have made the offset smaller than the simplified
    if (
      clipper.Execute(
        ClipperLib.ClipType.ctUnion,
        combined,
        ClipperLib.PolyFillType.pftNonZero,
        ClipperLib.PolyFillType.pftNonZero
      )
    ) {
      var largestArea = null;
      for (var i = 0; i < combined.length; i++) {
        var n = toNestCoordinates(combined[i], 10000000);
        var sarea = -GeometryUtil.polygonArea(n);
        if (largestArea === null || largestArea < sarea) {
          offset = n;
          largestArea = sarea;
        }
      }
    }
    //}

    cleaned = this.cleanPolygon(offset);
    if (cleaned && cleaned.length > 1) {
      offset = cleaned;
    }

    // mark any points that are exact (for line merge detection)
    for (var i = 0; i < offset.length; i++) {
      var seg = [offset[i], offset[i + 1 == offset.length ? 0 : i + 1]];
      var index1 = find(seg[0], polygon);
      var index2 = find(seg[1], polygon);

      if (
        index1 + 1 == index2 ||
        index2 + 1 == index1 ||
        (index1 == 0 && index2 == polygon.length - 1) ||
        (index2 == 0 && index1 == polygon.length - 1)
      ) {
        seg[0].exact = true;
        seg[1].exact = true;
      }
    }

    if (!inside && holes && holes.length > 0) {
      offset.children = holes;
    }

    return offset;

    function getTarget(point, simple, tol) {
      var inrange = [];
      // find closest points within 2 offset deltas
      for (var j = 0; j < simple.length; j++) {
        var s = simple[j];
        var d2 = (o.x - s.x) * (o.x - s.x) + (o.y - s.y) * (o.y - s.y);
        if (d2 < tol * tol) {
          inrange.push({ point: s, distance: d2 });
        }
      }

      var target;
      if (inrange.length > 0) {
        var filtered = inrange.filter(function (p) {
          return p.point.exact;
        });

        // use exact points when available, normal points when not
        inrange = filtered.length > 0 ? filtered : inrange;

        inrange.sort(function (a, b) {
          return a.distance - b.distance;
        });

        target = inrange[0].point;
      } else {
        var mind = null;
        for (var j = 0; j < simple.length; j++) {
          var s = simple[j];
          var d2 = (o.x - s.x) * (o.x - s.x) + (o.y - s.y) * (o.y - s.y);
          if (mind === null || d2 < mind) {
            target = s;
            mind = d2;
          }
        }
      }

      return target;
    }

    // returns true if any complex vertices fall outside the simple polygon
    function exterior(simple, complex, inside) {
      // find all protruding vertices
      for (var i = 0; i < complex.length; i++) {
        var v = complex[i];
        if (
          !inside &&
          !self.pointInPolygon(v, simple) &&
          find(v, simple) === null
        ) {
          return true;
        }
        if (
          inside &&
          self.pointInPolygon(v, simple) &&
          !find(v, simple) === null
        ) {
          return true;
        }
      }
      return false;
    }

    function toClipperCoordinates(polygon) {
      var clone = [];
      for (var i = 0; i < polygon.length; i++) {
        clone.push({
          X: polygon[i].x,
          Y: polygon[i].y,
        });
      }

      return clone;
    }

    function toNestCoordinates(polygon, scale) {
      var clone = [];
      for (var i = 0; i < polygon.length; i++) {
        clone.push({
          x: polygon[i].X / scale,
          y: polygon[i].Y / scale,
        });
      }

      return clone;
    }

    function find(v, p) {
      for (var i = 0; i < p.length; i++) {
        if (
          GeometryUtil.withinDistance(v, p[i], config.curveTolerance / 1000)
        ) {
          return i;
        }
      }
      return null;
    }

    function clone(p) {
      var newp = [];
      for (var i = 0; i < p.length; i++) {
        newp.push({
          x: p[i].x,
          y: p[i].y,
        });
      }

      return newp;
    }
  };

  config(c) {
    // clean up inputs

    if (!c) {
      return config;
    }

    if (
      c.curveTolerance &&
      !GeometryUtil.almostEqual(parseFloat(c.curveTolerance), 0)
    ) {
      config.curveTolerance = parseFloat(c.curveTolerance);
    }

    if ("spacing" in c) {
      config.spacing = parseFloat(c.spacing);
    }

    if (c.rotations && parseInt(c.rotations) > 0) {
      config.rotations = parseInt(c.rotations);
      // Base value a new run resets to - separate from config.rotations itself, which
      // widenRotationsIfStalled() mutates in place over the course of a run (see
      // launchWorkers()). Without this, a widened value would leak into the next run
      // instead of starting fresh at what the user actually configured.
      this._userConfiguredRotations = config.rotations;
    }

    if (c.populationSize && parseInt(c.populationSize) > 2) {
      config.populationSize = parseInt(c.populationSize);
    }

    if (c.mutationRate && parseInt(c.mutationRate) > 0) {
      config.mutationRate = parseInt(c.mutationRate);
    }

    if (c.threads && parseInt(c.threads) > 0) {
      // max 8 threads
      config.threads = Math.min(parseInt(c.threads), 8);
    }

    if (c.placementType) {
      config.placementType = String(c.placementType);
    }

    if (c.mergeLines === true || c.mergeLines === false) {
      config.mergeLines = !!c.mergeLines;
    }

    if (c.simplify === true || c.simplify === false) {
      config.simplify = !!c.simplify;
    }

    var n = Number(c.timeRatio);
    if (typeof n == "number" && !isNaN(n) && isFinite(n)) {
      config.timeRatio = n;
    }

    if (c.scale && parseFloat(c.scale) > 0) {
      config.scale = parseFloat(c.scale);
    }

    if ("dominantPartAreaThreshold" in c) {
      var dpat = parseFloat(c.dominantPartAreaThreshold);
      if (!isNaN(dpat) && dpat > 0 && dpat <= 1) {
        config.dominantPartAreaThreshold = dpat;
      }
    }

    window.SvgParser.config({
      tolerance: config.curveTolerance,
      endpointTolerance: c.endpointTolerance,
    });

    //nfpCache = {};
    //binPolygon = null;
    this.GA = null;

    return config;
  };

  pointInPolygon(point, polygon) {
    // scaling is deliberately coarse to filter out points that lie *on* the polygon
    var p = this.svgToClipper(polygon, 1000);
    var pt = new ClipperLib.IntPoint(1000 * point.x, 1000 * point.y);

    return ClipperLib.Clipper.PointInPolygon(pt, p) > 0;
  };

  /*this.simplifyPolygon = function(polygon, concavehull){
    function clone(p){
      var newp = [];
      for(var i=0; i<p.length; i++){
        newp.push({
          x: p[i].x,
          y: p[i].y
          //fuck: p[i].fuck
        });
      }
      return newp;
    }
    if(concavehull){
      var hull = concavehull;
    }
    else{
      var hull = new ConvexHullGrahamScan();
      for(var i=0; i<polygon.length; i++){
        hull.addPoint(polygon[i].x, polygon[i].y);
      }

      hull = hull.getHull();
    }

    var hullarea = Math.abs(GeometryUtil.polygonArea(hull));

    var concave = [];
    var detail = [];

    // fill concave[] with convex points, ensuring same order as initial polygon
    for(i=0; i<polygon.length; i++){
      var p = polygon[i];
      var found = false;
      for(var j=0; j<hull.length; j++){
        var hp = hull[j];
        if(GeometryUtil.almostEqual(hp.x, p.x) && GeometryUtil.almostEqual(hp.y, p.y)){
          found = true;
          break;
        }
      }

      if(found){
        concave.push(p);
        //p.fuck = i+'yes';
      }
      else{
        detail.push(p);
        //p.fuck = i+'no';
      }
    }

    var cindex = -1;
    var simple = [];

    for(i=0; i<polygon.length; i++){
      var p = polygon[i];
      if(concave.indexOf(p) > -1){
        cindex = concave.indexOf(p);
        simple.push(p);
      }
      else{

        var test = clone(concave);
        test.splice(cindex < 0 ? 0 : cindex+1,0,p);

        var outside = false;
        for(var j=0; j<detail.length; j++){
          if(detail[j] == p){
            continue;
          }
          if(!this.pointInPolygon(detail[j], test)){
            //console.log(detail[j], test);
            outside = true;
            break;
          }
        }

        if(outside){
          continue;
        }

        var testarea =  Math.abs(GeometryUtil.polygonArea(test));
        //console.log(testarea, hullarea);
        if(testarea/hullarea < 0.98){
          simple.push(p);
        }
      }
    }

    return simple;
  }*/

  // assuming no intersections, return a tree where odd leaves are parts and even ones are holes
  // might be easier to use the DOM, but paths can't have paths as children. So we'll just make our own tree.
  getParts(paths, filename) {
    var j;
    var polygons = [];

    var numChildren = paths.length;
    for (var i = 0; i < numChildren; i++) {
      if (window.SvgParser.polygonElements.indexOf(paths[i].tagName) < 0) {
        continue;
      }

      // don't use open paths
      if (!window.SvgParser.isClosed(paths[i], 2 * config.curveTolerance)) {
        continue;
      }

      var rawpoly = window.SvgParser.polygonify(paths[i]);
      var circleData = rawpoly.isCircle;
      var poly = this.cleanPolygon(rawpoly);

      // todo: warn user if poly could not be processed and is excluded from the nest
      if (
        poly &&
        poly.length > 2 &&
        Math.abs(GeometryUtil.polygonArea(poly)) >
        config.curveTolerance * config.curveTolerance
      ) {
        poly.source = i;
        // exact circle metadata survives simplification/cleaning untouched, since
        // it's carried separately from the tessellated points (see svgparser.js polygonify)
        if (circleData) {
          poly.isCircle = circleData;
        }
        polygons.push(poly);
      }
    }

    // turn the list into a tree
    // root level nodes of the tree are parts
    toTree(polygons);

    function toTree(list, idstart) {
      function svgToClipper(polygon) {
        var clip = [];
        for (var i = 0; i < polygon.length; i++) {
          clip.push({ X: polygon[i].x, Y: polygon[i].y });
        }

        ClipperLib.JS.ScaleUpPath(clip, config.clipperScale);

        return clip;
      }
      function pointInClipperPolygon(point, polygon) {
        var pt = new ClipperLib.IntPoint(
          config.clipperScale * point.x,
          config.clipperScale * point.y
        );

        return ClipperLib.Clipper.PointInPolygon(pt, polygon) > 0;
      }
      var parents = [];

      // assign a unique id to each leaf
      var id = idstart || 0;

      // Precompute bounds + clipper coordinates once per shape instead of rebuilding
      // list[j]'s clipper polygon on every (i,j) pair - for files with thousands of
      // shapes (e.g. a perforated panel with thousands of small holes), this loop is
      // O(n^2) either way, but recomputing svgToClipper(list[j]) inside it made it
      // effectively O(n^3)-ish in wasted work. A cheap bbox containment check (p must
      // fit inside list[j]'s bounds) also rejects the vast majority of non-child pairs
      // before paying for the exact per-point polygon test.
      var listBounds = list.map(function (poly) {
        return GeometryUtil.getPolygonBounds(poly);
      });
      var listClipper = list.map(svgToClipper);

      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        var pb = listBounds[i];

        var ischild = false;
        for (var j = 0; j < list.length; j++) {
          if (j == i) {
            continue;
          }
          if (p.length < 2) {
            continue;
          }

          var jb = listBounds[j];
          var eps = 1e-6 * Math.max(jb.width, jb.height, 1);
          if (
            pb.x < jb.x - eps ||
            pb.y < jb.y - eps ||
            pb.x + pb.width > jb.x + jb.width + eps ||
            pb.y + pb.height > jb.y + jb.height + eps
          ) {
            continue;
          }

          var inside = 0;
          var fullinside = Math.min(10, p.length);

          // sample about 10 points
          var clipper_polygon = listClipper[j];

          for (var k = 0; k < fullinside; k++) {
            if (pointInClipperPolygon(p[k], clipper_polygon) === true) {
              inside++;
            }
          }

          //console.log(inside, fullinside);

          if (inside > 0.5 * fullinside) {
            if (!list[j].children) {
              list[j].children = [];
            }
            list[j].children.push(p);
            p.parent = list[j];
            ischild = true;
            break;
          }
        }

        if (!ischild) {
          parents.push(p);
        }
      }

      for (var i = 0; i < list.length; i++) {
        if (parents.indexOf(list[i]) < 0) {
          list.splice(i, 1);
          i--;
        }
      }

      for (var i = 0; i < parents.length; i++) {
        parents[i].id = id;
        id++;
      }

      for (var i = 0; i < parents.length; i++) {
        if (parents[i].children) {
          id = toTree(parents[i].children, id);
        }
      }

      return id;
    }

    // construct part objects with metadata
    var parts = [];
    var svgelements = Array.prototype.slice.call(paths);
    var openelements = svgelements.slice(); // elements that are not a part of the poly tree but may still be a part of the part (images, lines, possibly text..)

    for (var i = 0; i < polygons.length; i++) {
      var part = {};
      part.polygontree = polygons[i];
      part.svgelements = [];

      var bounds = GeometryUtil.getPolygonBounds(part.polygontree);
      part.bounds = bounds;
      part.area = bounds.width * bounds.height;
      part.quantity = 1;
      part.filename = filename;

      if (part.filename === "BACKGROUND.svg") {
        part.sheet = true;
      }

      if (
        window.config.getSync("useQuantityFromFileName") &&
        part.filename &&
        part.filename !== null
      ) {
        const fileNameParts = part.filename.split(".");
        if (fileNameParts.length >= 3) {
          const fileNameQuantityPart = fileNameParts[fileNameParts.length - 2];
          const quantity = parseInt(fileNameQuantityPart, 10);
          if (!isNaN(quantity)) {
            part.quantity = quantity;
          }
        }
      }

      // load root element
      part.svgelements.push(svgelements[part.polygontree.source]);
      var index = openelements.indexOf(svgelements[part.polygontree.source]);
      if (index > -1) {
        openelements.splice(index, 1);
      }

      // load all elements that lie within the outer polygon
      for (var j = 0; j < svgelements.length; j++) {
        if (
          j != part.polygontree.source &&
          findElementById(j, part.polygontree)
        ) {
          part.svgelements.push(svgelements[j]);
          index = openelements.indexOf(svgelements[j]);
          if (index > -1) {
            openelements.splice(index, 1);
          }
        }
      }

      parts.push(part);
    }

    function findElementById(id, tree) {
      if (id == tree.source) {
        return true;
      }

      if (tree.children && tree.children.length > 0) {
        for (var i = 0; i < tree.children.length; i++) {
          if (findElementById(id, tree.children[i])) {
            return true;
          }
        }
      }

      return false;
    }

    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      // the elements left are either erroneous or open
      // we want to include open segments that also lie within the part boundaries
      for (var j = 0; j < openelements.length; j++) {
        var el = openelements[j];
        if (el.tagName == "line") {
          var x1 = Number(el.getAttribute("x1"));
          var x2 = Number(el.getAttribute("x2"));
          var y1 = Number(el.getAttribute("y1"));
          var y2 = Number(el.getAttribute("y2"));
          var start = { x: x1, y: y1 };
          var end = { x: x2, y: y2 };
          var mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };

          if (
            this.pointInPolygon(start, part.polygontree) === true ||
            this.pointInPolygon(end, part.polygontree) === true ||
            this.pointInPolygon(mid, part.polygontree) === true
          ) {
            part.svgelements.push(el);
            openelements.splice(j, 1);
            j--;
          }
        } else if (el.tagName == "image") {
          var x = Number(el.getAttribute("x"));
          var y = Number(el.getAttribute("y"));
          var width = Number(el.getAttribute("width"));
          var height = Number(el.getAttribute("height"));

          var mid = new Point(x + width / 2, y + height / 2);

          var transformString = el.getAttribute("transform");
          if (transformString) {
            var transform = window.SvgParser.transformParse(transformString);
            if (transform) {
              mid = transform.calc(mid);
            }
          }
          // just test midpoint for images
          if (this.pointInPolygon(mid, part.polygontree) === true) {
            part.svgelements.push(el);
            openelements.splice(j, 1);
            j--;
          }
        } else if (el.tagName == "path" || el.tagName == "polyline") {
          var k;
          if (el.tagName == "path") {
            var p = window.SvgParser.polygonifyPath(el);
          } else {
            var p = [];
            for (k = 0; k < el.points.length; k++) {
              p.push({
                x: el.points[k].x,
                y: el.points[k].y,
              });
            }
          }

          if (p.length < 2) {
            continue;
          }

          var found = false;
          var next = p[1];
          for (k = 0; k < p.length; k++) {
            if (this.pointInPolygon(p[k], part.polygontree) === true) {
              found = true;
              break;
            }

            if (k >= p.length - 1) {
              next = p[0];
            } else {
              next = p[k + 1];
            }

            // also test for midpoints in case of single line edge case
            var mid = {
              x: (p[k].x + next.x) / 2,
              y: (p[k].y + next.y) / 2,
            };
            if (this.pointInPolygon(mid, part.polygontree) === true) {
              found = true;
              break;
            }
          }
          if (found) {
            part.svgelements.push(el);
            openelements.splice(j, 1);
            j--;
          }
        } else {
          // something went wrong
          //console.log('part not processed: ',el);
        }
      }
    }

    for (j = 0; j < openelements.length; j++) {
      var el = openelements[j];
      if (
        el.tagName == "line" ||
        el.tagName == "polyline" ||
        el.tagName == "path"
      ) {
        el.setAttribute("class", "error");
      }
    }

    return parts;
  };

  cloneTree(tree) {
    var newtree = [];
    tree.forEach(function (t) {
      newtree.push({ x: t.x, y: t.y, exact: t.exact });
    });

    var self = this;
    if (tree.children && tree.children.length > 0) {
      newtree.children = [];
      tree.children.forEach(function (c) {
        newtree.children.push(self.cloneTree(c));
      });
    }

    // carry exact circle metadata through the clone - rotation/position are unchanged here,
    // so the tag copies straight across (see background.js rotatePolygon for the rotated case)
    if (tree.isCircle) {
      newtree.isCircle = { cx: tree.isCircle.cx, cy: tree.isCircle.cy, r: tree.isCircle.r };
    }

    return newtree;
  };

  // Parts whose bounding box doesn't fit any defined sheet in either orientation -
  // for the UI to check (and block on) before starting a nest, see findOversizedParts.
  getOversizedParts() {
    return findOversizedParts(this.parts);
  }

  // progressCallback is called when progress is made
  // displayCallback is called when a new placement has been made
  start(p, d) {
    this.progressCallback = p;
    this.displayCallback = d;

    var parts = [];

    /*while(this.nests.length > 0){
      this.nests.pop();
    }*/

    // send only bare essentials through ipc
    for (var i = 0; i < this.parts.length; i++) {
      parts.push({
        quantity: this.parts[i].quantity,
        sheet: this.parts[i].sheet,
        polygontree: this.cloneTree(this.parts[i].polygontree),
        filename: this.parts[i].filename,
      });
    }

    for (var i = 0; i < parts.length; i++) {
      if (parts[i].sheet) {
        offsetTree(
          parts[i].polygontree,
          -0.5 * config.spacing,
          this.polygonOffset.bind(this),
          this.simplifyPolygon.bind(this),
          true
        );
      } else {
        offsetTree(
          parts[i].polygontree,
          0.5 * config.spacing,
          this.polygonOffset.bind(this),
          this.simplifyPolygon.bind(this)
        );
      }
    }

    // offset tree recursively
    function offsetTree(t, offset, offsetFunction, simpleFunction, inside) {
      var simple = t;
      if (simpleFunction) {
        simple = simpleFunction(t, !!inside);
      }

      var offsetpaths = [simple];
      if (offset > 0) {
        offsetpaths = offsetFunction(simple, offset);
      }

      if (offsetpaths.length > 0) {
        //var cleaned = cleanFunction(offsetpaths[0]);

        // replace array items in place
        Array.prototype.splice.apply(t, [0, t.length].concat(offsetpaths[0]));
      }

      if (simple.children && simple.children.length > 0) {
        if (!t.children) {
          t.children = [];
        }

        for (var i = 0; i < simple.children.length; i++) {
          t.children.push(simple.children[i]);
        }
      }

      if (t.children && t.children.length > 0) {
        for (var i = 0; i < t.children.length; i++) {
          offsetTree(
            t.children[i],
            -offset,
            offsetFunction,
            simpleFunction,
            !inside
          );
        }
      }
    }

    var self = this;
    this.working = true;

    if (!this.workerTimer) {
      this.workerTimer = setInterval(function () {
        self.launchWorkers.call(
          self,
          parts,
          config,
          this.progressCallback,
          this.displayCallback
        );
        //progressCallback(progress);
      }, 100);
    }

    // Guarded against re-registration: start() runs again on every Stop -> Start
    // cycle (stop() only clears the workerTimer, it doesn't remove these), and
    // ipcRenderer.on() has no built-in dedup - without this, each cycle stacked
    // another full duplicate listener on top, so a single IPC message ended up
    // re-running this handler (nests-list insertion, refine triggers, etc.) once per
    // accumulated Start click instead of once.
    if (this._listenersRegistered) {
      return;
    }
    this._listenersRegistered = true;

    this.eventEmitter.on("background-response", (event, payload) => {
      this.eventEmitter.send("setPlacements", payload);
      console.log("ipc response", payload);
      if (!this.GA) {
        // user might have quit while we're away
        return;
      }
      this.GA.population[payload.index].processing = false;
      this.GA.population[payload.index].fitness = payload.fitness;

      // Every trial is ranked into the results list (not just ones that beat the
      // single current best), best first - so the list reads as a leaderboard of
      // everything tried instead of only successive personal records. Kept to a
      // bounded size (DEEPNEST_LONGLIST env var raises it from 10 to 100).
      var maxNests = process.env.DEEPNEST_LONGLIST ? 100 : 10;
      var insertAt = this.nests.length;
      for (var i = 0; i < this.nests.length; i++) {
        if (isBetterNest(payload, this.nests[i])) {
          insertAt = i;
          break;
        }
      }
      if (insertAt < maxNests) {
        this.nests.splice(insertAt, 0, payload);
        if (this.nests.length > maxNests) {
          this.nests.length = maxNests;
        }
        if (this.displayCallback) {
          this.displayCallback();
        }

        // Only the true displayed best is worth the expensive consolidation pass -
        // bounds total refine cost to "how many times a new best was found", which
        // gets rarer as the GA converges. _refinePending caps it to one in flight.
        // this.GA.population[payload.index] is safe to read synchronously here:
        // generation() (which reassigns population to brand-new individuals) only
        // runs later, off the 100ms launchWorkers timer, never inside this handler.
        if (insertAt === 0 && this._lastSheetsForRefine && this.GA) {
          var individual = this.GA.population[payload.index];
          if (individual) {
            var refineIds = [], refineSources = [], refineChildren = [], refineFilenames = [];
            for (var j = 0; j < individual.placement.length; j++) {
              refineIds[j] = individual.placement[j].id;
              refineSources[j] = individual.placement[j].source;
              refineChildren[j] = individual.placement[j].children;
              refineFilenames[j] = individual.placement[j].filename;
            }
            // Snapshot regardless of whether we can dispatch right now (below) -
            // refineStalledBest() reuses this to re-run refinement on this same
            // champion later, since geometry/ids never change once placed, only
            // positions do.
            this._championRefineGenes = { individual: individual, ids: refineIds, sources: refineSources, children: refineChildren, filenames: refineFilenames };

            if (!this._refinePending) {
              var refineId = ++this._refineCounter;
              this._refinePending = { id: refineId, targetPayload: payload };
              this.eventEmitter.send("background-refine", {
                id: refineId,
                index: payload.index,
                placements: payload.placements,
                individual: individual,
                sheets: this._lastSheetsForRefine.sheets,
                sheetids: this._lastSheetsForRefine.sheetids,
                sheetsources: this._lastSheetsForRefine.sheetsources,
                sheetchildren: this._lastSheetsForRefine.sheetchildren,
                config: config,
                ids: refineIds,
                sources: refineSources,
                children: refineChildren,
                filenames: refineFilenames,
              });
            }
          }
        }
      }
    });

    // Companion to the failure path in main.js's background-start handler - a
    // dispatch can fail when every window in the fixed-size pool is busy (e.g. a
    // background-refine request is occupying one), and deepnest.js already flagged
    // this individual `processing = true` before sending. Without this, it would
    // never retry and the whole generation would hang waiting on a fitness value
    // that's never coming (see refineStalledBest() above, which competes for the
    // same pool).
    this.eventEmitter.on("background-start-failed", (event, payload) => {
      if (!this.GA) {
        return;
      }
      var individual = this.GA.population[payload.index];
      if (individual) {
        individual.processing = false;
      }
    });

    this.eventEmitter.on("background-refine-response", (event, refined) => {
      if (!this._refinePending || refined.id !== this._refinePending.id) {
        // Stale/superseded response (or nothing pending) - ignore.
        return;
      }
      var target = this._refinePending.targetPayload;
      this._refinePending = null;
      if (refined.failed) {
        return;
      }
      // Mutated in place - this is the exact object already sitting in this.nests
      // (wherever it's since been re-sorted to); if it's since been evicted from the
      // top-K list entirely, this is simply inert.
      Object.assign(target, {
        placements: refined.placements,
        area: refined.area,
        totalarea: refined.totalarea,
        mergedLength: refined.mergedLength,
        utilisation: refined.utilisation,
      });
      if (this.displayCallback) {
        this.displayCallback();
      }
    });
  };

  padNumber(n, width, z) {
    z = z || '0';
    n = n + '';
    return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
  }

  // If the run's best result hasn't improved in a while, the search is more likely
  // stuck on a rotation grid too coarse to find a better fit than it is to benefit from
  // trying more of the same angles again - widen it. Doubling (not resizing to an
  // arbitrary count) is what keeps this safe alongside the shared NFP cache
  // (main.js/main/background.js): {0,90,180,270} is an exact subset of
  // {0,45,90,...,315}, so widening never invalidates NFPs already cached for the
  // coarser angles - it only adds new ones to compute.
  widenRotationsIfStalled(best) {
    var ROTATION_STAGNATION_LIMIT = 10;
    var ROTATION_CAP = 32;

    if (best && (!this._bestNestForStagnation || isBetterNest(best, this._bestNestForStagnation))) {
      this._bestNestForStagnation = best;
      this._generationsSinceImprovement = 0;
      return;
    }

    this._generationsSinceImprovement = (this._generationsSinceImprovement || 0) + 1;
    if (this._generationsSinceImprovement < ROTATION_STAGNATION_LIMIT || config.rotations >= ROTATION_CAP) {
      return;
    }

    config.rotations = Math.min(ROTATION_CAP, config.rotations * 2);
    this._generationsSinceImprovement = 0;
    appendBenchmarkLine(`[info] no improvement for ${ROTATION_STAGNATION_LIMIT} generations - widening rotations to ${config.rotations}`);
  }

  // Re-runs refineConsolidation() on the current champion while the GA is stalled,
  // not just when a strictly new best is found (the only other trigger, in the
  // background-response handler above). refineConsolidation is itself budget-capped
  // (20 iterations/2s/15 target-sheets tried per part - see main/background.js) so on
  // a job with 100+ sheets a single pass often doesn't fully converge (hitCap: true),
  // and once no new best appears that capped-out pass never gets another shot even
  // though repeat passes are cheap: getInnerNfp reads through the shared NFP cache, so
  // most of the geometry work is already memoized from earlier passes. Rides the same
  // _generationsSinceImprovement counter widenRotationsIfStalled() maintains, firing
  // every REFINE_STAGNATION_INTERVAL generations of no improvement instead of once.
  //
  // Uses the gene snapshot _championRefineGenes (captured when this champion was
  // first found) instead of this.GA.population[best.index] - by the time the GA has
  // stalled for several generations, that population slot has long since been
  // reassigned to unrelated individuals from later generations.
  refineStalledBest(best) {
    var REFINE_STAGNATION_INTERVAL = 5;
    if (
      !best ||
      this._refinePending ||
      !this._lastSheetsForRefine ||
      !this._championRefineGenes ||
      !this._generationsSinceImprovement ||
      this._generationsSinceImprovement % REFINE_STAGNATION_INTERVAL !== 0
    ) {
      return;
    }

    var genes = this._championRefineGenes;
    var refineId = ++this._refineCounter;
    this._refinePending = { id: refineId, targetPayload: best };
    this.eventEmitter.send("background-refine", {
      id: refineId,
      index: best.index,
      placements: best.placements,
      individual: genes.individual,
      sheets: this._lastSheetsForRefine.sheets,
      sheetids: this._lastSheetsForRefine.sheetids,
      sheetsources: this._lastSheetsForRefine.sheetsources,
      sheetchildren: this._lastSheetsForRefine.sheetchildren,
      config: config,
      ids: genes.ids,
      sources: genes.sources,
      children: genes.children,
      filenames: genes.filenames,
    });
  }

  launchWorkers(
    parts,
    config,
    progressCallback,
    displayCallback
  ) {
    function shuffle(array) {
      var currentIndex = array.length,
        temporaryValue,
        randomIndex;

      // While there remain elements to shuffle...
      while (0 !== currentIndex) {
        // Pick a remaining element...
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex -= 1;

        // And swap it with the current element.
        temporaryValue = array[currentIndex];
        array[currentIndex] = array[randomIndex];
        array[randomIndex] = temporaryValue;
      }

      return array;
    }

    var i, j;

    if (this.GA === null) {
      // initiate new GA

      var adam = [];
      var id = 0;
      for (var i = 0; i < parts.length; i++) {
        if (!parts[i].sheet) {
          for (var j = 0; j < parts[i].quantity; j++) {
            var poly = this.cloneTree(parts[i].polygontree); // deep copy
            poly.id = id; // id is the unique id of all parts that will be nested, including cloned duplicates
            poly.source = i; // source is the id of each unique part from the main part list
            poly.filename = parts[i].filename;

            adam.push(poly);
            id++;
          }
        }
      }

      // seed with decreasing area
      adam.sort(function (a, b) {
        return (
          Math.abs(GeometryUtil.polygonArea(b)) -
          Math.abs(GeometryUtil.polygonArea(a))
        );
      });

      // A couple of genuinely different starting orders, alongside the area-sorted
      // `adam` above - see sortByDecreasingBBoxDimension/sortByDecreasingIrregularity.
      var extraSeeds = [
        sortByDecreasingBBoxDimension(adam),
        sortByDecreasingIrregularity(adam),
      ];

      // Start fresh at the user-configured rotation count, in case a previous run
      // widened it (see widenRotationsIfStalled()) - widening is scoped to a single
      // run's search, not a permanent config change.
      config.rotations = this._userConfiguredRotations || config.rotations;
      this._generationsSinceImprovement = 0;
      this._bestNestForStagnation = null;
      this._championRefineGenes = null;

      this.GA = new GeneticAlgorithm(adam, config, extraSeeds);
      this.generationCount = 0;
      this._benchmarkStart = Date.now();
      this._benchmarkPartCount = adam.length;
      appendBenchmarkLine(
        `=== ${new Date().toISOString()} rev=${gitRevision()} parts=${adam.length} threads=${config.threads} population=${config.populationSize} rotations=${config.rotations} placementType=${config.placementType} ===`
      );
      appendBenchmarkLine('timestamp,elapsed_s,generation,best_fitness,sheets_used');
      //console.log(GA.population[1].placement);
    }

    // check if current generation is finished
    var finished = true;
    for (var i = 0; i < this.GA.population.length; i++) {
      if (!this.GA.population[i].fitness) {
        finished = false;
        break;
      }
    }

    if (finished) {
      console.log("new generation!");
      var best = this.nests[0];
      appendBenchmarkLine([
        new Date().toISOString(),
        ((Date.now() - this._benchmarkStart) / 1000).toFixed(1),
        this.generationCount,
        best ? best.fitness.toFixed(0) : '',
        best ? best.placements.length : '',
      ].join(','));
      // all individuals have been evaluated, start next generation
      this.GA.generation();
      this.generationCount++;
      this.widenRotationsIfStalled(best);
      this.refineStalledBest(best);
    }

    var running = this.GA.population.filter(function (p) {
      return !!p.processing;
    }).length;

    var sheets = [];
    var sheetids = [];
    var sheetsources = [];
    var sheetchildren = [];
    var sid = 0;

    // quantity 0 on a sheet means "unlimited" - supply enough copies to cover the
    // worst case (every part gets its own sheet), so you don't have to guess a number
    // that's "big enough". Real part quantity is already known from the same parts list.
    // Quantity can arrive as a string from the UI's number input, where "0" is truthy -
    // Number(...) it first so a literal "0" is correctly treated as "unlimited" instead
    // of silently producing zero sheets (and so summing doesn't concatenate strings).
    var totalPartInstances = 0;
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i].sheet) {
        totalPartInstances += Number(parts[i].quantity) || 0;
      }
    }

    for (var i = 0; i < parts.length; i++) {
      if (parts[i].sheet) {
        var poly = parts[i].polygontree;
        var sheetQuantity = Number(parts[i].quantity) || totalPartInstances || 1;
        for (var j = 0; j < sheetQuantity; j++) {
          sheets.push(poly);
          sheetids.push(this.padNumber(sid, 4) + '-' + this.padNumber(j, 4));
          sheetsources.push(i);
          sheetchildren.push(poly.children);
        }
        sid++;
      }
    }

    // Cached so the background-response handler's refine-trigger below can build a
    // background-refine request without needing `parts`/`this.padNumber` in scope -
    // same sheets data every background-start dispatch this tick already uses.
    this._lastSheetsForRefine = { sheets: sheets, sheetids: sheetids, sheetsources: sheetsources, sheetchildren: sheetchildren };

    for (var i = 0; i < this.GA.population.length; i++) {
      if (
        running < config.threads &&
        !this.GA.population[i].processing &&
        !this.GA.population[i].fitness
      ) {
        this.GA.population[i].processing = true;

        // hash values on arrays don't make it across ipc, store them in an array and reassemble on the other side....
        var ids = [];
        var sources = [];
        var children = [];
        var filenames = [];

        for (var j = 0; j < this.GA.population[i].placement.length; j++) {
          var id = this.GA.population[i].placement[j].id;
          var source = this.GA.population[i].placement[j].source;
          var child = this.GA.population[i].placement[j].children;
          var filename = this.GA.population[i].placement[j].filename;
          ids[j] = id;
          sources[j] = source;
          children[j] = child;
          filenames[j] = filename;
        }

        this.eventEmitter.send("background-start", {
          index: i,
          sheets: sheets,
          sheetids: sheetids,
          sheetsources: sheetsources,
          sheetchildren: sheetchildren,
          individual: this.GA.population[i],
          config: config,
          ids: ids,
          sources: sources,
          children: children,
          filenames: filenames,
        });
        running++;
      }
    }
  };

  // use the clipper library to return an offset to the given polygon. Positive offset expands the polygon, negative contracts
  // note that this returns an array of polygons
  polygonOffset(polygon, offset) {
    if (!offset || offset == 0 || GeometryUtil.almostEqual(offset, 0)) {
      return polygon;
    }

    var p = this.svgToClipper(polygon);

    var miterLimit = 4;
    var co = new ClipperLib.ClipperOffset(
      miterLimit,
      config.curveTolerance * config.clipperScale
    );
    co.AddPath(
      p,
      ClipperLib.JoinType.jtMiter,
      ClipperLib.EndType.etClosedPolygon
    );

    var newpaths = new ClipperLib.Paths();
    co.Execute(newpaths, offset * config.clipperScale);

    var result = [];
    for (var i = 0; i < newpaths.length; i++) {
      result.push(this.clipperToSvg(newpaths[i]));
    }

    return result;
  };

  // returns a less complex polygon that satisfies the curve tolerance
  cleanPolygon(polygon) {
    var p = this.svgToClipper(polygon);
    // remove self-intersections and find the biggest polygon that's left
    var simple = ClipperLib.Clipper.SimplifyPolygon(
      p,
      ClipperLib.PolyFillType.pftNonZero
    );

    if (!simple || simple.length == 0) {
      return null;
    }

    var biggest = simple[0];
    var biggestarea = Math.abs(ClipperLib.Clipper.Area(biggest));
    for (var i = 1; i < simple.length; i++) {
      var area = Math.abs(ClipperLib.Clipper.Area(simple[i]));
      if (area > biggestarea) {
        biggest = simple[i];
        biggestarea = area;
      }
    }

    // clean up singularities, coincident points and edges
    var clean = ClipperLib.Clipper.CleanPolygon(
      biggest,
      0.01 * config.curveTolerance * config.clipperScale
    );

    if (!clean || clean.length == 0) {
      return null;
    }

    var cleaned = this.clipperToSvg(clean);

    // remove duplicate endpoints
    var start = cleaned[0];
    var end = cleaned[cleaned.length - 1];
    if (
      start == end ||
      (GeometryUtil.almostEqual(start.x, end.x) &&
        GeometryUtil.almostEqual(start.y, end.y))
    ) {
      cleaned.pop();
    }

    return cleaned;
  };

  // converts a polygon from normal float coordinates to integer coordinates used by clipper, as well as x/y -> X/Y
  svgToClipper(polygon, scale) {
    var clip = [];
    for (var i = 0; i < polygon.length; i++) {
      clip.push({ X: polygon[i].x, Y: polygon[i].y });
    }

    ClipperLib.JS.ScaleUpPath(clip, scale || config.clipperScale);

    return clip;
  };

  clipperToSvg(polygon) {
    var normal = [];

    for (var i = 0; i < polygon.length; i++) {
      normal.push({
        x: polygon[i].X / config.clipperScale,
        y: polygon[i].Y / config.clipperScale,
      });
    }

    return normal;
  };

  // returns an array of SVG elements that represent the placement, for export or rendering
  applyPlacement(placement) {
    var clone = [];
    for (var i = 0; i < parts.length; i++) {
      clone.push(parts[i].cloneNode(false));
    }

    var svglist = [];

    for (var i = 0; i < placement.length; i++) {
      var newsvg = svg.cloneNode(false);
      newsvg.setAttribute(
        "viewBox",
        "0 0 " + binBounds.width + " " + binBounds.height
      );
      newsvg.setAttribute("width", binBounds.width + "px");
      newsvg.setAttribute("height", binBounds.height + "px");
      var binclone = bin.cloneNode(false);

      binclone.setAttribute("class", "bin");
      binclone.setAttribute(
        "transform",
        "translate(" + -binBounds.x + " " + -binBounds.y + ")"
      );
      newsvg.appendChild(binclone);

      for (var j = 0; j < placement[i].length; j++) {
        var p = placement[i][j];
        var part = tree[p.id];

        // the original path could have transforms and stuff on it, so apply our transforms on a group
        var partgroup = document.createElementNS(svg.namespaceURI, "g");
        partgroup.setAttribute(
          "transform",
          "translate(" + p.x + " " + p.y + ") rotate(" + p.rotation + ")"
        );
        partgroup.appendChild(clone[part.source]);

        if (part.children && part.children.length > 0) {
          var flattened = _flattenTree(part.children, true);
          for (var k = 0; k < flattened.length; k++) {
            var c = clone[flattened[k].source];
            if (flattened[k].hole) {
              c.setAttribute("class", "hole");
            }
            partgroup.appendChild(c);
          }
        }

        newsvg.appendChild(partgroup);
      }

      svglist.push(newsvg);
    }

    // flatten the given tree into a list
    function _flattenTree(t, hole) {
      var flat = [];
      for (var i = 0; i < t.length; i++) {
        flat.push(t[i]);
        t[i].hole = hole;
        if (t[i].children && t[i].children.length > 0) {
          flat = flat.concat(_flattenTree(t[i].children, !hole));
        }
      }

      return flat;
    }

    return svglist;
  };

  stop() {
    this.working = false;
    // Undo widenRotationsIfStalled()'s in-run widening as soon as the run ends -
    // stop() doesn't null out this.GA (that only happens on reset(), e.g. "back"),
    // so without this a Stop -> Start would resume at the widened value instead of
    // what's configured, since launchWorkers() only re-reads it when GA is null.
    if (this._userConfiguredRotations) {
      config.rotations = this._userConfiguredRotations;
    }
    if (this.GA && this.GA.population && this.GA.population.length > 0) {
      this.GA.population.forEach(function (i) {
        i.processing = false;
      });
    }
    if (this.workerTimer) {
      clearInterval(this.workerTimer);
      this.workerTimer = null;
    }
    if (this._benchmarkStart) {
      var best = this.nests[0];
      var elapsed = (Date.now() - this._benchmarkStart) / 1000;
      appendBenchmarkLine(
        `--- stopped after ${elapsed.toFixed(1)}s, ${this.generationCount} generations, best_fitness=${best ? best.fitness.toFixed(0) : 'n/a'} ---`
      );
      var partsTotal = this._benchmarkPartCount || 0;
      var unplaced = best ? best.unplacedCount || 0 : '';
      appendRunSummaryRow([
        new Date().toISOString(),
        gitRevision(),
        elapsed.toFixed(1),
        this.generationCount,
        partsTotal,
        config.threads,
        config.populationSize,
        config.rotations,
        config.mutationRate,
        config.placementType,
        config.mergeLines,
        config.spacing,
        config.dominantPartAreaThreshold,
        config.timeRatio,
        config.simplify,
        config.curveTolerance,
        best ? best.fitness.toFixed(0) : '',
        best ? best.placements.length : '',
        best ? partsTotal - unplaced : '',
        unplaced,
        best ? (best.utilisation || 0).toFixed(1) : '',
      ]);
      this._benchmarkStart = null;
    }
  };

  reset() {
    this.GA = null;
    while (this.nests.length > 0) {
      this.nests.pop();
    }
    this.progressCallback = null;
    this.displayCallback = null;
    this.generationCount = 0;
  };
}

export class GeneticAlgorithm {
  constructor(adam, config, extraSeeds) {
    this.config = config || {
      populationSize: 10,
      mutationRate: 10,
      rotations: 4,
    };

    // population is an array of individuals. Each individual is a object representing the order of insertion and the angle each part is rotated
    this.population = [{ placement: adam, rotation: this.randomAngles(adam.length) }];

    // A couple of alternate starting orders (see sortByDecreasingBBoxDimension/
    // sortByDecreasingIrregularity in launchWorkers()) get their own population slot
    // instead of only ever being mutations of `adam` - gives the GA more than one
    // starting idea to work from. `adam` (population[0]) stays the unmutated elite.
    var seeds = (extraSeeds || []).filter(function (o) { return o && o.length === adam.length; });
    for (var s = 0; s < seeds.length && this.population.length < this.config.populationSize; s++) {
      this.population.push({ placement: seeds[s], rotation: this.randomAngles(adam.length) });
    }

    while (this.population.length < config.populationSize) {
      var mutant = this.mutate(this.population[0]);
      this.population.push(mutant);
    }
  }

  randomAngles(length) {
    var angles = [];
    for (var i = 0; i < length; i++) {
      angles.push(
        Math.floor(Math.random() * this.config.rotations) *
        (360 / this.config.rotations)
      );
    }
    return angles;
  }

  // returns a mutated individual with the given mutation rate
  mutate(individual) {
    // The shared NFP cache (main/background.js) is keyed by {sourceA, sourceB,
    // rotationA, rotationB} - a cache hit needs the exact same rotation pair seen
    // before. Rerolling rotation at the same rate as part-order mutation means a
    // config.mutationRate tuned aggressively for order exploration (60-96%, seen in
    // real benchmark runs) rerolls nearly every part's rotation every generation too,
    // so the cache never saturates: measured ~7,400 NFP cache misses per individual
    // on individual #1 of a run, STILL ~7,360 on average 1,200+ individuals later -
    // it never converges. Capping the rotation-reroll roll independently lets order
    // exploration stay as aggressive as the user wants without also destroying cache
    // locality.
    var ROTATION_MUTATION_RATE_CAP = 15;
    var rotationMutationChance = 0.01 * Math.min(this.config.mutationRate, ROTATION_MUTATION_RATE_CAP);

    var clone = {
      placement: individual.placement.slice(0),
      rotation: individual.rotation.slice(0),
    };
    for (var i = 0; i < clone.placement.length; i++) {
      var rand = Math.random();
      if (rand < 0.01 * this.config.mutationRate) {
        // swap current part with next part
        var j = i + 1;

        if (j < clone.placement.length) {
          var temp = clone.placement[i];
          clone.placement[i] = clone.placement[j];
          clone.placement[j] = temp;
        }
      }

      rand = Math.random();
      if (rand < rotationMutationChance) {
        clone.rotation[i] =
          Math.floor(Math.random() * this.config.rotations) *
          (360 / this.config.rotations);
      }
    }

    // Secondary, coarser-grained operator: the adjacent swap above can only move a
    // part one slot per mutation event, so escaping a bad ordering takes many
    // generations of accumulated small swaps. Relocate removes one part and
    // reinserts it at a random different slot in a single step - a bigger jump.
    // Rolled once per individual (not once per part like the swap above), since
    // it's more disruptive - independently rolling it per-part would let the whole
    // order get reshuffled in one generation.
    if (clone.placement.length > 1 && Math.random() < 0.01 * this.config.mutationRate) {
      var from = Math.floor(Math.random() * clone.placement.length);
      var to = Math.floor(Math.random() * (clone.placement.length - 1));
      if (to >= from) {
        to++;
      }
      clone.placement.splice(to, 0, clone.placement.splice(from, 1)[0]);
      clone.rotation.splice(to, 0, clone.rotation.splice(from, 1)[0]);
    }

    return clone;
  };

  // single point crossover
  mate(male, female) {
    var cutpoint = Math.round(
      Math.min(Math.max(Math.random(), 0.1), 0.9) * (male.placement.length - 1)
    );

    var gene1 = male.placement.slice(0, cutpoint);
    var rot1 = male.rotation.slice(0, cutpoint);

    var gene2 = female.placement.slice(0, cutpoint);
    var rot2 = female.rotation.slice(0, cutpoint);

    for (var i = 0; i < female.placement.length; i++) {
      if (!contains(gene1, female.placement[i].id)) {
        gene1.push(female.placement[i]);
        rot1.push(female.rotation[i]);
      }
    }

    for (var i = 0; i < male.placement.length; i++) {
      if (!contains(gene2, male.placement[i].id)) {
        gene2.push(male.placement[i]);
        rot2.push(male.rotation[i]);
      }
    }

    function contains(gene, id) {
      for (var i = 0; i < gene.length; i++) {
        if (gene[i].id == id) {
          return true;
        }
      }
      return false;
    }

    return [
      { placement: gene1, rotation: rot1 },
      { placement: gene2, rotation: rot2 },
    ];
  };

  generation() {
    // Individuals with higher fitness are more likely to be selected for mating
    this.population.sort(function (a, b) {
      return a.fitness - b.fitness;
    });

    // fittest individual is preserved in the new generation (elitism)
    var newpopulation = [this.population[0]];

    while (newpopulation.length < this.population.length) {
      var male = this.randomWeightedIndividual();
      var female = this.randomWeightedIndividual(male);

      // each mating produces two children
      var children = this.mate(male, female);

      // slightly mutate children
      newpopulation.push(this.mutate(children[0]));

      if (newpopulation.length < this.population.length) {
        newpopulation.push(this.mutate(children[1]));
      }
    }

    this.population = newpopulation;
  };

  // returns a random individual from the population, weighted to the front of the list (lower fitness value is more likely to be selected)
  randomWeightedIndividual(exclude) {
    var pop = this.population.slice(0);

    if (exclude && pop.indexOf(exclude) >= 0) {
      pop.splice(pop.indexOf(exclude), 1);
    }

    var rand = Math.random();

    var lower = 0;
    var weight = 1 / pop.length;
    var upper = weight;

    for (var i = 0; i < pop.length; i++) {
      // if the random number falls between lower and upper bounds, select this individual
      if (rand > lower && rand < upper) {
        return pop[i];
      }
      lower = upper;
      upper += 2 * weight * ((pop.length - i) / pop.length);
    }

    return pop[0];
  };
}
