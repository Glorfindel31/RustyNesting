/**
 * Export Service
 * Handles SVG/DXF/JSON export functionality for nesting results
 * Manages file save dialogs, format conversion, and file writing
 */
import { DEFAULT_CONVERSION_SERVER } from "../types/index.js";
import { message } from "../utils/ui-helpers.js";
/**
 * File filters for export dialogs
 */
const SVG_FILE_FILTERS = [
    { name: "SVG", extensions: ["svg"] }
];
const DXF_FILE_FILTERS = [
    { name: "DXF/DWG", extensions: ["dxf", "dwg"] }
];
/**
 * Filename for the emergency recovery snapshot, written to NEST_DIRECTORY
 */
const RECOVERY_FILE_NAME = "recovery.json";
/**
 * Export Service class
 * Handles export operations for nesting results to various formats
 * Follows the pattern from main/deepnest.js ES6 class structure
 */
export class ExportService {
    /** Electron dialog for file save dialogs */
    dialog = null;
    /** Electron remote for accessing global variables */
    remote = null;
    /** Node.js file system module */
    fs = null;
    /** HTTP client for conversion requests */
    httpClient = null;
    /** FormData constructor for file upload */
    FormData = null;
    /** Configuration getter */
    config = null;
    /** DeepNest instance for accessing parts and nests */
    deepNest = null;
    /** SvgParser instance for line merging operations */
    svgParser = null;
    /** Export button element for spinner state */
    exportButton = null;
    /** Flag to track if export is busy */
    isExporting = false;
    /**
     * Create a new ExportService instance
     * Dependencies are injected for testability
     */
    constructor(options) {
        if (options) {
            this.dialog = options.dialog || null;
            this.remote = options.remote || null;
            this.fs = options.fs || null;
            this.httpClient = options.httpClient || null;
            this.FormData = options.FormData || null;
            this.config = options.config || null;
            this.deepNest = options.deepNest || null;
            this.svgParser = options.svgParser || null;
            this.exportButton = options.exportButton || null;
        }
    }
    /**
     * Set the dialog module for file save dialogs
     * @param dialog - Electron dialog module
     */
    setDialog(dialog) {
        this.dialog = dialog;
    }
    /**
     * Set the remote module for accessing globals
     * @param remote - Electron remote module
     */
    setRemote(remote) {
        this.remote = remote;
    }
    /**
     * Set the file system module
     * @param fs - Node.js fs module
     */
    setFileSystem(fs) {
        this.fs = fs;
    }
    /**
     * Set the HTTP client for conversion requests
     * @param httpClient - HTTP client (e.g., axios)
     */
    setHttpClient(httpClient) {
        this.httpClient = httpClient;
    }
    /**
     * Set the FormData constructor
     * @param FormData - FormData constructor
     */
    setFormDataConstructor(FormData) {
        this.FormData = FormData;
    }
    /**
     * Set the configuration getter
     * @param config - Configuration object with getSync method
     */
    setConfig(config) {
        this.config = config;
    }
    /**
     * Set the DeepNest instance
     * @param deepNest - DeepNest instance for accessing parts and nests
     */
    setDeepNest(deepNest) {
        this.deepNest = deepNest;
    }
    /**
     * Set the SvgParser instance for line merging operations
     * @param svgParser - SvgParser instance
     */
    setSvgParser(svgParser) {
        this.svgParser = svgParser;
    }
    /**
     * Set the export button element for spinner state
     * @param button - Export button element
     */
    setExportButton(button) {
        this.exportButton = button;
    }
    /**
     * Get the conversion server URL from config or use default
     * @returns Conversion server URL
     */
    getConversionServerUrl() {
        if (!this.config) {
            return DEFAULT_CONVERSION_SERVER;
        }
        const configUrl = this.config.getSync("conversionServer");
        return configUrl || DEFAULT_CONVERSION_SERVER;
    }
    /**
     * Get the currently selected nesting result
     * @returns Selected nesting result or null if none selected
     */
    getSelectedNest() {
        if (!this.deepNest) {
            return null;
        }
        const selected = this.deepNest.nests.filter((n) => n.selected);
        if (selected.length === 0) {
            return null;
        }
        return selected[selected.length - 1];
    }
    /**
     * Show the export button as loading
     */
    setExportLoading(loading) {
        if (this.exportButton) {
            if (loading) {
                this.exportButton.className = "button export spinner";
            }
            else {
                this.exportButton.className = "button export";
            }
        }
    }
    /**
     * Export the selected nest result to JSON file
     * Saves to the NEST_DIRECTORY as exports.json
     * @returns True if export was successful
     */
    exportToJson() {
        if (!this.remote || !this.fs || !this.deepNest) {
            return false;
        }
        const nestDirectory = this.remote.getGlobal("NEST_DIRECTORY");
        if (!nestDirectory) {
            return false;
        }
        const filePath = nestDirectory + "exports.json";
        const selected = this.getSelectedNest();
        if (!selected) {
            return false;
        }
        const fileData = JSON.stringify(selected);
        this.fs.writeFileSync(filePath, fileData);
        this.clearRecoveryFile();
        return true;
    }
    /**
     * Get the path of the emergency recovery file, if a nest directory is available
     */
    getRecoveryFilePath() {
        if (!this.remote) {
            return null;
        }
        const nestDirectory = this.remote.getGlobal("NEST_DIRECTORY");
        return nestDirectory ? nestDirectory + RECOVERY_FILE_NAME : null;
    }
    /**
     * Remove the recovery snapshot once the user has explicitly exported a result -
     * only an explicit export counts as "safe", so a plain app close (crash or not)
     * intentionally leaves the snapshot in place for the next-launch recovery prompt.
     */
    clearRecoveryFile() {
        const filePath = this.getRecoveryFilePath();
        if (!filePath || !this.fs || !this.fs.existsSync || !this.fs.unlinkSync) {
            return;
        }
        if (this.fs.existsSync(filePath)) {
            this.fs.unlinkSync(filePath);
        }
    }
    /**
     * Overwrite the recovery snapshot with the given nest (always the current best).
     * Called continuously during nesting so a crash never loses the best result.
     * @param nest - The nest result to snapshot
     */
    saveRecoveryFile(nest) {
        const filePath = this.getRecoveryFilePath();
        if (!filePath || !this.fs) {
            return false;
        }
        this.fs.writeFileSync(filePath, JSON.stringify(nest));
        return true;
    }
    /**
     * On startup, check for a leftover recovery snapshot (e.g. from a crash) and
     * offer to export it. Removes the snapshot afterwards either way, so the user
     * isn't asked again next launch.
     */
    async checkForRecovery() {
        const filePath = this.getRecoveryFilePath();
        if (!filePath || !this.fs || !this.fs.existsSync || !this.fs.readFileSync || !this.fs.unlinkSync) {
            return;
        }
        if (!this.fs.existsSync(filePath)) {
            return;
        }
        if (!this.dialog || !this.dialog.showMessageBox) {
            return;
        }
        const { response } = await this.dialog.showMessageBox({
            type: "question",
            buttons: ["Export...", "Discard"],
            defaultId: 0,
            title: "Recover last nesting result",
            message: "Deepnest found a nesting result from a previous session that was never exported. Export it now?",
        });
        if (response === 0) {
            let savePath = this.dialog.showSaveDialogSync({
                title: "Export recovered nest",
                filters: [{ name: "JSON", extensions: ["json"] }],
            });
            if (savePath) {
                if (!savePath.toLowerCase().endsWith(".json")) {
                    savePath = savePath + ".json";
                }
                this.fs.writeFileSync(savePath, this.fs.readFileSync(filePath).toString());
            }
        }
        this.fs.unlinkSync(filePath);
    }
    /**
     * Show save dialog and export to SVG
     * @returns True if export was successful
     */
    exportToSvg() {
        if (!this.dialog || !this.fs) {
            message("Export dependencies not available", true);
            return false;
        }
        let fileName = this.dialog.showSaveDialogSync({
            title: "Export deepnest SVG",
            filters: SVG_FILE_FILTERS,
        });
        if (fileName === undefined) {
            return false;
        }
        // Ensure .svg extension
        if (!fileName.toLowerCase().endsWith(".svg")) {
            fileName = fileName + ".svg";
        }
        const selected = this.getSelectedNest();
        if (!selected) {
            return false;
        }
        const svgContent = this.generateSvgExport(selected);
        this.fs.writeFileSync(fileName, svgContent);
        this.clearRecoveryFile();
        return true;
    }
    /**
     * Show save dialog and export to DXF via conversion server
     * @returns Promise that resolves to true if export was successful
     */
    async exportToDxf() {
        if (!this.dialog || !this.fs || !this.httpClient || !this.FormData) {
            message("Export dependencies not available", true);
            return false;
        }
        let fileName = this.dialog.showSaveDialogSync({
            title: "Export deepnest DXF",
            filters: DXF_FILE_FILTERS,
        });
        if (fileName === undefined) {
            return false;
        }
        // Ensure .dxf or .dwg extension
        if (!fileName.toLowerCase().endsWith(".dxf") && !fileName.toLowerCase().endsWith(".dwg")) {
            fileName = fileName + ".dxf";
        }
        const selected = this.getSelectedNest();
        if (!selected) {
            return false;
        }
        const url = this.getConversionServerUrl();
        this.setExportLoading(true);
        try {
            // Generate SVG with DXF scaling
            const svgContent = this.generateSvgExport(selected, { forDxfConversion: true });
            const formData = new this.FormData();
            formData.append("fileUpload", Buffer.from(svgContent), {
                filename: "deepnest.svg",
                contentType: "image/svg+xml",
            });
            formData.append("format", "dxf");
            const response = await this.httpClient.post(url, formData.getBuffer(), {
                headers: formData.getHeaders(),
                responseType: "text",
            });
            const body = response.data;
            // Check for error responses
            if (body.substring(0, 5) === "error") {
                message(body, true);
                return false;
            }
            if (body.includes('"error"') && body.includes('"error_id"')) {
                const jsonErr = JSON.parse(body);
                message(`There was an Error while converting: ${jsonErr.error_id}<br>Please use this code to open an issue on github.com/deepnest-next/deepnest`, true);
                return false;
            }
            this.fs.writeFileSync(fileName, body);
            this.clearRecoveryFile();
            return true;
        }
        catch (err) {
            const error = err;
            const errorData = error.response?.data || error.message;
            if (typeof errorData === "string" &&
                errorData.includes('"error"') &&
                errorData.includes('"error_id"')) {
                const jsonErr = JSON.parse(errorData);
                message(`There was an Error while converting: ${jsonErr.error_id}<br>Please use this code to open an issue on github.com/deepnest-next/deepnest`, true);
            }
            else {
                message(`Could not contact file conversion server: ${JSON.stringify(err)}<br>Please use this code to open an issue on github.com/deepnest-next/deepnest`, true);
            }
            return false;
        }
        finally {
            this.setExportLoading(false);
        }
    }
    /**
     * Generate SVG content from a nesting result
     * Core function that builds the SVG document from placements
     * @param nestResult - The nesting result to export
     * @param options - Export options
     * @returns SVG content as string
     */
    generateSvgExport(nestResult, options = {}) {
        if (!this.deepNest || !this.config) {
            throw new Error("DeepNest or config not available");
        }
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        let svgWidth = 0;
        let svgHeight = 0;
        let sheetNumber = 0;
        const parts = this.deepNest.parts;
        const exportWithSheetBoundaries = !!this.config.getSync("exportWithSheetBoundboarders");
        const exportWithSheetsSpace = !!this.config.getSync("exportWithSheetsSpace");
        const exportWithSheetsSpaceValue = this.config.getSync("exportWithSheetsSpaceValue") || 0;
        // Process each sheet placement
        nestResult.placements.forEach((s) => {
            sheetNumber++;
            const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
            svg.appendChild(group);
            // Add sheet boundary if configured
            if (exportWithSheetBoundaries) {
                this.addSheetBoundary(group, parts[s.sheet]);
            }
            const sheetBounds = parts[s.sheet].bounds;
            // Position the group
            group.setAttribute("transform", `translate(${-sheetBounds.x} ${svgHeight - sheetBounds.y})`);
            // Track maximum width
            if (svgWidth < sheetBounds.width) {
                svgWidth = sheetBounds.width;
            }
            // Add each part placement
            s.sheetplacements.forEach((p) => {
                const part = parts[p.source];
                const partGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
                // Clone all SVG elements from the part
                part.svgelements.forEach((e) => {
                    const node = e.cloneNode(false);
                    // Handle image elements with relative paths
                    if (node.tagName === "image") {
                        const relPath = node.getAttribute("data-href");
                        if (relPath) {
                            node.setAttribute("href", relPath);
                        }
                        node.removeAttribute("data-href");
                    }
                    partGroup.appendChild(node);
                });
                group.appendChild(partGroup);
                // Position and rotate the part
                partGroup.setAttribute("transform", `translate(${p.x} ${p.y}) rotate(${p.rotation})`);
                partGroup.setAttribute("id", String(p.id));
            });
            // Update height for next sheet
            svgHeight += sheetBounds.height;
            // Add spacing between sheets (except after last sheet)
            if (exportWithSheetsSpace && sheetNumber < nestResult.placements.length) {
                svgHeight += exportWithSheetsSpaceValue;
            }
        });
        // Calculate final dimensions with scaling
        this.applyDimensions(svg, svgWidth, svgHeight, options);
        // Apply line merging if configured
        this.applyLineMerging(svg, nestResult);
        return new XMLSerializer().serializeToString(svg);
    }
    /**
     * Add sheet boundary to a group
     * @param group - SVG group element
     * @param sheetPart - Part representing the sheet
     */
    addSheetBoundary(group, sheetPart) {
        sheetPart.svgelements.forEach((e) => {
            const node = e.cloneNode(false);
            node.setAttribute("stroke", "#00ff00");
            node.setAttribute("fill", "none");
            group.appendChild(node);
        });
    }
    /**
     * Apply dimensions and viewBox to the SVG element
     * @param svg - SVG element
     * @param width - Content width in SVG units
     * @param height - Content height in SVG units
     * @param options - Export options
     */
    applyDimensions(svg, width, height, options) {
        if (!this.config) {
            return;
        }
        let scale = this.config.getSync("scale");
        // Apply DXF export scale if converting to DXF
        if (options.forDxfConversion) {
            const dxfExportScale = Number(this.config.getSync("dxfExportScale")) || 1;
            scale /= dxfExportScale;
        }
        // Convert scale based on units
        const units = this.config.getSync("units");
        if (units === "mm") {
            scale /= 25.4;
        }
        // Set dimensions with unit suffix
        const unitSuffix = units === "inch" ? "in" : "mm";
        svg.setAttribute("width", `${width / scale}${unitSuffix}`);
        svg.setAttribute("height", `${height / scale}${unitSuffix}`);
        svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    }
    /**
     * Apply line merging optimization if configured
     * @param svg - SVG element
     * @param nestResult - Nesting result with merged length info
     */
    applyLineMerging(svg, nestResult) {
        if (!this.config || !this.svgParser) {
            return;
        }
        const mergeLines = this.config.getSync("mergeLines");
        const mergedLength = nestResult.mergedLength;
        if (mergeLines && mergedLength && mergedLength > 0) {
            const curveTolerance = this.config.getSync("curveTolerance");
            // Apply SVG processing for line optimization
            this.svgParser.applyTransform(svg);
            this.svgParser.flatten(svg);
            this.svgParser.splitLines(svg);
            this.svgParser.mergeOverlap(svg, 0.1 * curveTolerance);
            this.svgParser.mergeLines(svg);
            // Set stroke and fill for all non-group, non-image elements
            const elements = Array.prototype.slice.call(svg.children);
            elements.forEach((e) => {
                if (e.tagName !== "g" && e.tagName !== "image") {
                    e.setAttribute("fill", "none");
                    e.setAttribute("stroke", "#000000");
                }
            });
        }
    }
    /**
     * Export to the specified format
     * @param format - Export format (svg, dxf, or json)
     * @returns Promise that resolves to true if export was successful
     */
    async export(format) {
        if (this.isExporting) {
            return false;
        }
        this.isExporting = true;
        try {
            switch (format) {
                case "svg":
                    return this.exportToSvg();
                case "dxf":
                    return await this.exportToDxf();
                case "json":
                    return this.exportToJson();
                default:
                    message(`Unsupported export format: ${format}`, true);
                    return false;
            }
        }
        finally {
            this.isExporting = false;
        }
    }
    /**
     * Check if export is currently in progress
     * @returns True if exporting
     */
    isExportInProgress() {
        return this.isExporting;
    }
    /**
     * Check if there is a selected nest result available for export
     * @returns True if a nest result is selected
     */
    hasSelectedNest() {
        return this.getSelectedNest() !== null;
    }
    /**
     * Get supported export formats
     * @returns Array of supported format strings
     */
    static getSupportedFormats() {
        return ["svg", "dxf", "json"];
    }
    /**
     * Get file filters for a specific format
     * @param format - Export format
     * @returns Array of file filters
     */
    static getFileFilters(format) {
        switch (format) {
            case "svg":
                return [...SVG_FILE_FILTERS];
            case "dxf":
                return [...DXF_FILE_FILTERS];
            default:
                return [];
        }
    }
    /**
     * Create and return a new ExportService instance
     * @param options - Optional configuration options
     * @returns New ExportService instance
     */
    static create(options) {
        return new ExportService(options);
    }
}
/**
 * Factory function to create an export service
 * @param options - Optional configuration options
 * @returns New ExportService instance
 */
export function createExportService(options) {
    return ExportService.create(options);
}
//# sourceMappingURL=export.service.js.map