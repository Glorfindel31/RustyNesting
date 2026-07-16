/**
 * Parts View Component
 * Ractive-based parts list with selection, sorting, and deletion functionality.
 * Extracted from page.js (lines 421-714)
 */
import { getElement, getElements, createSvgElement, serializeSvg, removeFromParent, setAttributes, } from "../utils/dom-utils.js";
import { throttle } from "../utils/ui-helpers.js";
/**
 * DOM element selectors used by the parts view component
 */
const SELECTORS = {
    /** Container for the parts list */
    HOME_CONTENT: "#homecontent",
    /** Template for the parts list */
    TEMPLATE_PART_LIST: "#template-part-list",
    /** Table headers for sorting */
    PARTS_TABLE_HEADERS: "#parts table thead th",
    /** Parts container */
    PARTS_CONTAINER: "#parts",
    /** Parts table */
    PARTS_TABLE: "#parts table",
};
/**
 * CSS classes used by the parts view
 */
const CSS_CLASSES = {
    ACTIVE: "active",
    ASC: "asc",
    DESC: "desc",
};
/**
 * Data attributes used for sorting
 */
const DATA_ATTRIBUTES = {
    SORT_FIELD: "data-sort-field",
};
/**
 * Parts View Service class
 * Manages the Ractive-based parts list with selection, sorting, and deletion
 */
export class PartsViewService {
    /** DeepNest instance */
    deepNest;
    /** Configuration object */
    config;
    /** Main Ractive instance for parts list */
    ractive = null;
    /** Dimension label Ractive component */
    labelComponent = null;
    /** Tracks if mouse button is currently down */
    mouseDown = 0;
    /** Throttled update function */
    throttledUpdate = null;
    /** Resize callback */
    resizeCallback = null;
    /** Electron native dialog, used for the delete confirmation prompt */
    dialog = null;
    /** Flag to track if service has been initialized */
    initialized = false;
    /**
     * Create a new PartsViewService instance
     * @param options - Configuration options
     */
    constructor(options) {
        this.deepNest = options.deepNest;
        this.config = options.config;
        if (options.dialog) {
            this.dialog = options.dialog;
        }
        if (options.resizeCallback) {
            this.resizeCallback = options.resizeCallback;
        }
    }
    /**
     * Set the resize callback function
     * @param callback - Function to call when resize is needed
     */
    setResizeCallback(callback) {
        this.resizeCallback = callback;
    }
    /**
     * Create the dimension label Ractive component
     * This component displays part dimensions in the current unit system
     */
    createLabelComponent() {
        const config = this.config;
        return Ractive.extend({
            template: "{{label}}",
            computed: {
                label: function () {
                    const bounds = this.get("bounds");
                    const width = bounds.width;
                    const height = bounds.height;
                    const units = config.getSync("units");
                    const conversion = config.getSync("scale");
                    // trigger computed dependency chain
                    this.get("getUnits");
                    if (units === "mm") {
                        return (((25.4 * width) / conversion).toFixed(1) +
                            "mm x " +
                            ((25.4 * height) / conversion).toFixed(1) +
                            "mm");
                    }
                    else {
                        return ((width / conversion).toFixed(1) +
                            "in x " +
                            (height / conversion).toFixed(1) +
                            "in");
                    }
                },
            },
        });
    }
    /**
     * Toggle selection state of a part
     * @param part - The part to toggle
     */
    togglePart(part) {
        if (part.selected) {
            part.selected = false;
            for (let i = 0; i < part.svgelements.length; i++) {
                part.svgelements[i].removeAttribute("class");
            }
        }
        else {
            part.selected = true;
            for (let i = 0; i < part.svgelements.length; i++) {
                part.svgelements[i].setAttribute("class", CSS_CLASSES.ACTIVE);
            }
        }
    }
    /**
     * Apply SVG pan/zoom library to the currently visible import
     */
    applyZoom() {
        if (this.deepNest.imports.length === 0) {
            return;
        }
        for (let i = 0; i < this.deepNest.imports.length; i++) {
            const importItem = this.deepNest.imports[i];
            if (importItem.selected) {
                // Store current pan/zoom state if exists
                let pan = false;
                let zoom = false;
                if (importItem.zoom) {
                    pan = importItem.zoom.getPan();
                    zoom = importItem.zoom.getZoom();
                }
                // Initialize svgPanZoom
                importItem.zoom = svgPanZoom("#import-" + i + " svg", {
                    zoomEnabled: true,
                    controlIconsEnabled: false,
                    fit: true,
                    center: true,
                    maxZoom: 500,
                    minZoom: 0.01,
                });
                // Restore previous state
                if (zoom !== false) {
                    importItem.zoom.zoom(zoom);
                }
                if (pan !== false) {
                    importItem.zoom.pan(pan);
                }
                // Set up zoom control buttons
                this.setupZoomControls(i);
            }
        }
    }
    /**
     * Set up zoom control button event listeners for an import
     * @param importIndex - Index of the import
     */
    setupZoomControls(importIndex) {
        const deepNest = this.deepNest;
        const zoomInBtn = getElement(`#import-${importIndex} .zoomin`);
        const zoomOutBtn = getElement(`#import-${importIndex} .zoomout`);
        const zoomResetBtn = getElement(`#import-${importIndex} .zoomreset`);
        if (zoomInBtn) {
            zoomInBtn.addEventListener("click", (ev) => {
                ev.preventDefault();
                const selectedImport = deepNest.imports.find((e) => e.selected);
                if (selectedImport?.zoom) {
                    selectedImport.zoom.zoomIn();
                }
            });
        }
        if (zoomOutBtn) {
            zoomOutBtn.addEventListener("click", (ev) => {
                ev.preventDefault();
                const selectedImport = deepNest.imports.find((e) => e.selected);
                if (selectedImport?.zoom) {
                    selectedImport.zoom.zoomOut();
                }
            });
        }
        if (zoomResetBtn) {
            zoomResetBtn.addEventListener("click", (ev) => {
                ev.preventDefault();
                const selectedImport = deepNest.imports.find((e) => e.selected);
                if (selectedImport?.zoom) {
                    selectedImport.zoom.resetZoom().resetPan();
                }
            });
        }
    }
    /**
     * Delete all selected parts, after confirmation
     */
    async deleteParts() {
        const selectedCount = this.deepNest.parts.filter((p) => p.selected).length;
        if (selectedCount === 0) {
            return;
        }
        const label = selectedCount === 1 ? "this part" : `these ${selectedCount} parts`;
        if (this.dialog) {
            // Electron's native async dialog, not window.confirm() - the browser's blocking
            // confirm()/alert() is known to leave the renderer's keyboard focus routing broken
            // afterward in Electron (inputs stop receiving keystrokes until you click away and
            // back), since it pauses the JS engine rather than going through a real native
            // window Electron manages the focus lifecycle for.
            const { response } = await this.dialog.showMessageBox({
                type: "warning",
                buttons: ["Cancel", "Delete"],
                defaultId: 0,
                cancelId: 0,
                message: `Delete ${label}? This can't be undone.`,
            });
            if (response !== 1) {
                return;
            }
        }
        else if (!confirm(`Delete ${label}? This can't be undone.`)) {
            return;
        }
        for (let i = 0; i < this.deepNest.parts.length; i++) {
            if (this.deepNest.parts[i].selected) {
                // Remove SVG elements from DOM
                for (let j = 0; j < this.deepNest.parts[i].svgelements.length; j++) {
                    const node = this.deepNest.parts[i].svgelements[j];
                    removeFromParent(node);
                }
                // Remove from parts array
                this.deepNest.parts.splice(i, 1);
                i--;
            }
        }
        // Update UI
        this.update();
        this.updateImports();
        if (this.deepNest.imports.length > 0) {
            this.applyZoom();
        }
        if (this.resizeCallback) {
            this.resizeCallback();
        }
    }
    /**
     * Attach sorting functionality to table headers
     */
    attachSort() {
        const headers = getElements(SELECTORS.PARTS_TABLE_HEADERS);
        headers.forEach((header) => {
            header.addEventListener("click", () => {
                const sortField = header.getAttribute(DATA_ATTRIBUTES.SORT_FIELD);
                if (!sortField) {
                    return;
                }
                const reverse = header.className === CSS_CLASSES.ASC;
                // Sort parts
                this.deepNest.parts.sort((a, b) => {
                    const av = a[sortField];
                    const bv = b[sortField];
                    if (av === undefined || av === null || bv === undefined || bv === null) {
                        return 0;
                    }
                    if (av < bv) {
                        return reverse ? 1 : -1;
                    }
                    if (av > bv) {
                        return reverse ? -1 : 1;
                    }
                    return 0;
                });
                // Update header classes
                headers.forEach((h) => {
                    h.className = "";
                });
                header.className = reverse ? CSS_CLASSES.DESC : CSS_CLASSES.ASC;
                // Update UI
                this.update();
            });
        });
    }
    /**
     * Update the parts data in Ractive
     */
    update() {
        if (this.ractive) {
            this.ractive.update("parts");
        }
    }
    /**
     * Update the imports data in Ractive
     */
    updateImports() {
        if (this.ractive) {
            this.ractive.update("imports");
        }
    }
    /**
     * Update units-related computed properties
     */
    updateUnits() {
        if (this.ractive) {
            this.ractive.update("getUnits");
        }
    }
    /**
     * Initialize the Ractive instance for parts list
     */
    initializeRactive() {
        // Disable Ractive debug mode
        Ractive.DEBUG = false;
        // Create label component
        this.labelComponent = this.createLabelComponent();
        const deepNest = this.deepNest;
        const config = this.config;
        // Create main Ractive instance
        this.ractive = new Ractive({
            el: SELECTORS.HOME_CONTENT,
            template: SELECTORS.TEMPLATE_PART_LIST,
            data: {
                parts: deepNest.parts,
                imports: deepNest.imports,
                getSelected: function () {
                    const parts = this.get("parts");
                    return parts.filter((p) => p.selected);
                },
                getSheets: function () {
                    const parts = this.get("parts");
                    return parts.filter((p) => p.sheet);
                },
                serializeSvg: function (svg) {
                    return serializeSvg(svg);
                },
                partrenderer: function (part) {
                    const svg = createSvgElement("svg");
                    setAttributes(svg, {
                        width: part.bounds.width + 10 + "px",
                        height: part.bounds.height + 10 + "px",
                        viewBox: part.bounds.x -
                            5 +
                            " " +
                            (part.bounds.y - 5) +
                            " " +
                            (part.bounds.width + 10) +
                            " " +
                            (part.bounds.height + 10),
                    });
                    part.svgelements.forEach((e) => {
                        svg.appendChild(e.cloneNode(false));
                    });
                    return serializeSvg(svg);
                },
                // [nameFile]-[numberInTheList].[fileExtension], e.g. "bracket-3.dxf" - lets
                // parts pulled from the same file (or identical-looking shapes) be told apart
                // at a glance instead of showing only their size.
                partLabel: function (part, index) {
                    const filename = part.filename || "part";
                    const dot = filename.lastIndexOf(".");
                    const base = dot > 0 ? filename.slice(0, dot) : filename;
                    const ext = dot > 0 ? filename.slice(dot + 1) : "";
                    const label = `${base}-${index + 1}`;
                    return ext ? `${label}.${ext}` : label;
                },
            },
            computed: {
                getUnits: function () {
                    const units = config.getSync("units");
                    return units === "mm" ? "mm" : "in";
                },
            },
            components: { dimensionLabel: this.labelComponent },
        });
    }
    /**
     * Set up mouse tracking for drag selection
     */
    setupMouseTracking() {
        document.body.onmousedown = () => {
            this.mouseDown = 1;
        };
        document.body.onmouseup = () => {
            this.mouseDown = 0;
        };
    }
    /**
     * Create throttled update function
     */
    createThrottledUpdate() {
        const updateFn = () => {
            this.updateImports();
            this.applyZoom();
        };
        this.throttledUpdate = throttle(updateFn, 500);
    }
    /**
     * Bind Ractive event handlers
     */
    bindRactiveEvents() {
        if (!this.ractive) {
            return;
        }
        const ractive = this.ractive;
        const deepNest = this.deepNest;
        // Handle part selection on click/mouseover
        ractive.on("selecthandler", (e, ...args) => {
            const part = args[0];
            // Don't handle if clicking on an input
            if (e.original.target.nodeName === "INPUT") {
                return true;
            }
            if (this.mouseDown > 0 || e.original.type === "mousedown") {
                this.togglePart(part);
                ractive.update("parts");
                if (this.throttledUpdate) {
                    this.throttledUpdate();
                }
            }
            return;
        });
        // Handle select all toggle
        ractive.on("selectall", () => {
            const selectedCount = deepNest.parts.filter((p) => p.selected).length;
            const toggleOn = selectedCount < deepNest.parts.length;
            deepNest.parts.forEach((p) => {
                if (p.selected !== toggleOn) {
                    this.togglePart(p);
                }
                p.selected = toggleOn;
            });
            ractive.update("parts");
            ractive.update("imports");
            if (deepNest.imports.length > 0) {
                this.applyZoom();
            }
        });
        // Handle import tab selection
        ractive.on("importselecthandler", (_e, ...args) => {
            const im = args[0];
            if (im.selected) {
                return false;
            }
            deepNest.imports.forEach((i) => {
                i.selected = false;
            });
            im.selected = true;
            ractive.update("imports");
            this.applyZoom();
            return;
        });
        // Handle import deletion
        ractive.on("importdelete", (_e, ...args) => {
            const im = args[0];
            let index = deepNest.imports.indexOf(im);
            deepNest.imports.splice(index, 1);
            if (deepNest.imports.length > 0) {
                if (!deepNest.imports[index]) {
                    index = 0;
                }
                deepNest.imports[index].selected = true;
            }
            ractive.update("imports");
            if (deepNest.imports.length > 0) {
                this.applyZoom();
            }
        });
        // Handle delete button/event
        ractive.on("delete", () => {
            this.deleteParts();
        });
    }
    /**
     * Set up keyboard event listener for delete key
     */
    setupKeyboardEvents() {
        document.body.addEventListener("keydown", (e) => {
            // Delete key (8 = backspace, 46 = delete)
            if (e.keyCode === 8 || e.keyCode === 46) {
                // Don't hijack backspace while editing a field (e.g. the quantity input) -
                // deleteParts() also confirms now, but it shouldn't even be asked here.
                const target = e.target;
                const tag = target?.tagName;
                if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) {
                    return;
                }
                this.deleteParts();
            }
        });
    }
    /**
     * Initialize the parts view service
     * Sets up Ractive, event handlers, and keyboard shortcuts
     */
    initialize() {
        if (this.initialized) {
            return;
        }
        this.initializeRactive();
        this.setupMouseTracking();
        this.createThrottledUpdate();
        this.bindRactiveEvents();
        this.setupKeyboardEvents();
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
     * Refresh the entire view (parts and imports)
     */
    refresh() {
        this.update();
        this.updateImports();
        this.attachSort();
        this.applyZoom();
        if (this.resizeCallback) {
            this.resizeCallback();
        }
    }
    /**
     * Create and return a new PartsViewService instance
     * @param options - Configuration options
     * @returns New PartsViewService instance
     */
    static create(options) {
        return new PartsViewService(options);
    }
}
/**
 * Factory function to create a parts view service
 * @param options - Configuration options
 * @returns New PartsViewService instance
 */
export function createPartsViewService(options) {
    return PartsViewService.create(options);
}
/**
 * Initialize parts view with a simple functional API
 * For use cases where a full service instance is not needed
 *
 * @param deepNest - DeepNest instance
 * @param config - Configuration object
 * @param resizeCallback - Optional resize callback
 * @returns The initialized PartsViewService instance
 *
 * @example
 * // Simple initialization
 * const partsView = initializePartsView(window.DeepNest, window.config, resize);
 *
 * // Later, update parts
 * partsView.update();
 */
export function initializePartsView(deepNest, config, resizeCallback) {
    const service = new PartsViewService({ deepNest, config, resizeCallback });
    service.initialize();
    return service;
}
//# sourceMappingURL=parts-view.js.map