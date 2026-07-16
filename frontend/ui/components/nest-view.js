/**
 * Nest View Component
 * Ractive-based nest result display with selection and visualization.
 * Extracted from page.js (lines 1463-1697)
 */
import { getElement, getElements, createSvgElement, setAttributes, serializeSvg, setInnerHtml, createTranslate, createCssTransform, } from "../utils/dom-utils.js";
import { millisecondsToStr } from "../utils/ui-helpers.js";
/**
 * DOM element selectors used by the nest view component
 */
const SELECTORS = {
    /** Container for the nest content */
    NEST_CONTENT: "#nestcontent",
    /** Template for the nest view */
    NEST_TEMPLATE: "#nest-template",
    /** Container for the nest SVG display */
    NEST_DISPLAY: "#nestdisplay",
    /** Nest SVG element */
    NEST_SVG: "#nestsvg",
    /** Part elements in SVG */
    NEST_SVG_PARTS: "#nestsvg .part",
    /** Sheet elements in SVG */
    NEST_SVG_SHEETS: "#nestsvg .sheet",
    /** Merged line elements in SVG */
    NEST_SVG_MERGED: "#nestsvg .merged",
};
/**
 * CSS classes used by the nest view
 */
const CSS_CLASSES = {
    PART: "part",
    SHEET: "sheet",
    ACTIVE: "active",
    MERGED: "merged",
};
/**
 * Nest View Service class
 * Manages the Ractive-based nest display with selection and visualization
 */
export class NestViewService {
    /** DeepNest instance */
    deepNest;
    /** Configuration object */
    config;
    /** Main Ractive instance for nest view */
    ractive = null;
    /** Flag to track if service has been initialized */
    initialized = false;
    /**
     * Create a new NestViewService instance
     * @param options - Configuration options
     */
    constructor(options) {
        this.deepNest = options.deepNest;
        this.config = options.config;
    }
    /**
     * Display a nesting result in the SVG viewport
     * Creates/updates SVG elements for sheets and placed parts
     * @param n - The nesting result to display
     */
    displayNest(n) {
        // Create svg if not exist
        let svg = getElement(SELECTORS.NEST_SVG);
        if (!svg) {
            const newSvg = createSvgElement("svg");
            newSvg.setAttribute("id", "nestsvg");
            const nestDisplay = getElement(SELECTORS.NEST_DISPLAY);
            if (nestDisplay) {
                setInnerHtml(nestDisplay, serializeSvg(newSvg));
            }
            svg = getElement(SELECTORS.NEST_SVG);
        }
        if (!svg) {
            return;
        }
        // Remove active class from parts and sheets
        const parts = getElements(SELECTORS.NEST_SVG_PARTS);
        parts.forEach((p) => {
            p.setAttribute("class", CSS_CLASSES.PART);
        });
        const sheets = getElements(SELECTORS.NEST_SVG_SHEETS);
        sheets.forEach((p) => {
            p.setAttribute("class", CSS_CLASSES.SHEET);
        });
        // Remove laser markers (merged lines)
        const merged = getElements(SELECTORS.NEST_SVG_MERGED);
        merged.forEach((p) => {
            p.remove();
        });
        let svgWidth = 0;
        let svgHeight = 0;
        // Create elements if they don't exist, show them otherwise
        n.placements.forEach((s) => {
            // Create sheet if it doesn't exist
            let groupElement = getElement(`#sheet${s.sheetid}`);
            if (!groupElement) {
                const group = createSvgElement("g");
                group.setAttribute("id", `sheet${s.sheetid}`);
                group.setAttribute("data-index", String(s.sheetid));
                svg.appendChild(group);
                groupElement = getElement(`#sheet${s.sheetid}`);
                if (groupElement && this.deepNest.parts[s.sheet]) {
                    this.deepNest.parts[s.sheet].svgelements.forEach((e) => {
                        const node = e.cloneNode(false);
                        node.setAttribute("stroke", "#ffffff");
                        node.setAttribute("fill", "none");
                        node.removeAttribute("style");
                        groupElement.appendChild(node);
                    });
                }
            }
            if (!groupElement) {
                return;
            }
            // Reset class (make visible)
            groupElement.setAttribute("class", `${CSS_CLASSES.SHEET} ${CSS_CLASSES.ACTIVE}`);
            const sheetBounds = this.deepNest.parts[s.sheet].bounds;
            groupElement.setAttribute("transform", createTranslate(-sheetBounds.x, svgHeight - sheetBounds.y));
            if (svgWidth < sheetBounds.width) {
                svgWidth = sheetBounds.width;
            }
            s.sheetplacements.forEach((p) => {
                let partElement = getElement(`#part${p.id}`);
                if (!partElement) {
                    const part = this.deepNest.parts[p.source];
                    const partGroup = createSvgElement("g");
                    partGroup.setAttribute("id", `part${p.id}`);
                    part.svgelements.forEach((e, index) => {
                        const node = e.cloneNode(false);
                        if (index === 0) {
                            node.setAttribute("fill", `url(#part${p.source}hatch)`);
                            node.setAttribute("fill-opacity", "0.5");
                        }
                        else {
                            node.setAttribute("fill", "#404247");
                        }
                        node.removeAttribute("style");
                        node.setAttribute("stroke", "#ffffff");
                        partGroup.appendChild(node);
                    });
                    svg.appendChild(partGroup);
                    // Create hatch pattern if it doesn't exist
                    if (!getElement(`#part${p.source}hatch`)) {
                        const pattern = createSvgElement("pattern");
                        pattern.setAttribute("id", `part${p.source}hatch`);
                        pattern.setAttribute("patternUnits", "userSpaceOnUse");
                        let psize = parseInt(String(this.deepNest.parts[s.sheet].bounds.width / 120));
                        psize = psize || 10;
                        pattern.setAttribute("width", String(psize));
                        pattern.setAttribute("height", String(psize));
                        const path = createSvgElement("path");
                        path.setAttribute("d", `M-1,1 l2,-2 M0,${psize} l${psize},-${psize} M${psize - 1},${psize + 1} l2,-2`);
                        const hue = 360 * (p.source / this.deepNest.parts.length);
                        path.setAttribute("style", `stroke: hsl(${hue}, 100%, 80%) !important; stroke-width:1`);
                        pattern.appendChild(path);
                        groupElement.appendChild(pattern);
                    }
                    partElement = getElement(`#part${p.id}`);
                }
                else {
                    // Ensure correct z layering
                    svg.appendChild(partElement);
                }
                if (partElement) {
                    // Reset class (make visible)
                    partElement.setAttribute("class", `${CSS_CLASSES.PART} ${CSS_CLASSES.ACTIVE}`);
                    // Position part with CSS transform
                    partElement.setAttribute("style", `transform: ${createCssTransform(p.x - sheetBounds.x, p.y + svgHeight - sheetBounds.y, p.rotation)}`);
                    // Add merge lines if present
                    if (p.mergedSegments && p.mergedSegments.length > 0) {
                        for (let i = 0; i < p.mergedSegments.length; i++) {
                            const s1 = p.mergedSegments[i][0];
                            const s2 = p.mergedSegments[i][1];
                            const line = createSvgElement("line");
                            line.setAttribute("class", CSS_CLASSES.MERGED);
                            line.setAttribute("x1", String(s1.x - sheetBounds.x));
                            line.setAttribute("x2", String(s2.x - sheetBounds.x));
                            line.setAttribute("y1", String(s1.y + svgHeight - sheetBounds.y));
                            line.setAttribute("y2", String(s2.y + svgHeight - sheetBounds.y));
                            svg.appendChild(line);
                        }
                    }
                }
            });
            // Put next sheet below
            svgHeight += 1.1 * sheetBounds.height;
        });
        // Activate merged lines after delay for animation
        setTimeout(() => {
            const mergedElements = getElements(SELECTORS.NEST_SVG_MERGED);
            mergedElements.forEach((p) => {
                p.setAttribute("class", `${CSS_CLASSES.MERGED} ${CSS_CLASSES.ACTIVE}`);
            });
        }, 1500);
        // Set SVG viewBox
        setAttributes(svg, {
            width: "100%",
            height: "100%",
            viewBox: `0 0 ${svgWidth} ${svgHeight}`,
        });
    }
    /**
     * Initialize the Ractive instance for nest view
     */
    initializeRactive() {
        const deepNest = this.deepNest;
        const config = this.config;
        // Create main Ractive instance
        this.ractive = new Ractive({
            el: SELECTORS.NEST_CONTENT,
            template: SELECTORS.NEST_TEMPLATE,
            data: {
                nests: deepNest.nests,
                getSelected: function () {
                    const ne = this.get("nests");
                    return ne.filter((n) => n.selected);
                },
                getNestedPartSources: function (n) {
                    const sources = [];
                    for (let i = 0; i < n.placements.length; i++) {
                        const sheet = n.placements[i];
                        for (let j = 0; j < sheet.sheetplacements.length; j++) {
                            sources.push(sheet.sheetplacements[j].source);
                        }
                    }
                    return sources;
                },
                getColorBySource: function (id) {
                    return `hsl(${360 * (id / deepNest.parts.length)}, 100%, 80%)`;
                },
                getPartsPlaced: function () {
                    const ne = this.get("nests");
                    const selected = ne.filter((n) => n.selected);
                    if (selected.length === 0) {
                        return "";
                    }
                    const selectedNest = selected.pop();
                    let num = 0;
                    for (let i = 0; i < selectedNest.placements.length; i++) {
                        const sheet = selectedNest.placements[i];
                        num += sheet.sheetplacements.length;
                    }
                    let total = 0;
                    for (let i = 0; i < deepNest.parts.length; i++) {
                        if (!deepNest.parts[i].sheet) {
                            total += deepNest.parts[i].quantity;
                        }
                    }
                    return `${num}/${total}`;
                },
                getUtilisation: function () {
                    const getSelected = this.get("getSelected");
                    const selected = getSelected();
                    if (selected.length === 0)
                        return "-";
                    return selected[0].utilisation.toFixed(2);
                },
                getTimeSaved: function () {
                    const ne = this.get("nests");
                    const selected = ne.filter((n) => n.selected);
                    if (selected.length === 0) {
                        return "0 seconds";
                    }
                    const selectedNest = selected.pop();
                    const totalLength = selectedNest.mergedLength;
                    const scale = config.getSync("scale");
                    const lengthInches = totalLength / scale;
                    // Assume 2 inches per second cut speed
                    const seconds = lengthInches / 2;
                    return millisecondsToStr(seconds * 1000);
                },
            },
        });
    }
    /**
     * Bind Ractive event handlers
     */
    bindRactiveEvents() {
        if (!this.ractive) {
            return;
        }
        const deepNest = this.deepNest;
        // Handle nest selection
        this.ractive.on("selectnest", (_e, ...args) => {
            const n = args[0];
            // Deselect all nests
            for (let i = 0; i < deepNest.nests.length; i++) {
                deepNest.nests[i].selected = false;
            }
            // Select this nest
            n.selected = true;
            // Update UI
            this.update();
            this.displayNest(n);
        });
    }
    /**
     * Update the nests data in Ractive
     */
    update() {
        if (this.ractive) {
            this.ractive.update("nests");
        }
    }
    /**
     * Initialize the nest view service
     * Sets up Ractive and event handlers
     */
    initialize() {
        if (this.initialized) {
            return;
        }
        this.initializeRactive();
        this.bindRactiveEvents();
        this.initialized = true;
    }
    /**
     * Get the Ractive instance
     * @returns The Ractive instance or null if not initialized
     */
    getRactive() {
        return this.ractive;
    }
    /**
     * Get the displayNest function bound to this instance
     * Useful for passing to callbacks
     * @returns Bound displayNest function
     */
    getDisplayNestCallback() {
        return this.displayNest.bind(this);
    }
    /**
     * Create and return a new NestViewService instance
     * @param options - Configuration options
     * @returns New NestViewService instance
     */
    static create(options) {
        return new NestViewService(options);
    }
}
/**
 * Factory function to create a nest view service
 * @param options - Configuration options
 * @returns New NestViewService instance
 */
export function createNestViewService(options) {
    return NestViewService.create(options);
}
/**
 * Initialize nest view with a simple functional API
 * For use cases where a full service instance is not needed
 *
 * @param deepNest - DeepNest instance
 * @param config - Configuration object
 * @returns The initialized NestViewService instance
 *
 * @example
 * // Simple initialization
 * const nestView = initializeNestView(window.DeepNest, window.config);
 *
 * // Later, display a nest
 * nestView.displayNest(selectedNest);
 */
export function initializeNestView(deepNest, config) {
    const service = new NestViewService({ deepNest, config });
    service.initialize();
    return service;
}
//# sourceMappingURL=nest-view.js.map