/**
 * Import Service
 * Handles SVG/DXF/DWG file import with conversion server API
 * Manages file selection, reading, and conversion workflow
 */
import { DEFAULT_CONVERSION_SERVER } from "../types/index.js";
import { message } from "../utils/ui-helpers.js";
/**
 * Supported file extensions for import
 */
const SUPPORTED_EXTENSIONS = {
    SVG: [".svg"],
    NEEDS_CONVERSION: [".ps", ".eps", ".dxf", ".dwg"],
};
/**
 * File filters for the open dialog
 */
const FILE_FILTERS = [
    { name: "CAD formats", extensions: ["svg", "ps", "eps", "dxf", "dwg"] },
    { name: "SVG/EPS/PS", extensions: ["svg", "eps", "ps"] },
    { name: "DXF/DWG", extensions: ["dxf", "dwg"] },
];
/**
 * Import Service class
 * Handles file import operations with support for SVG and conversion of other formats
 * Follows the pattern from main/deepnest.js ES6 class structure
 */
export class ImportService {
    /** Electron dialog for file selection */
    dialog = null;
    /** Electron remote for accessing global variables */
    remote = null;
    /** Node.js file system module */
    fs = null;
    /** Node.js path module */
    path = null;
    /** HTTP client for conversion requests */
    httpClient = null;
    /** FormData constructor for file upload */
    FormData = null;
    /** SVG pre-processor for cleaning input */
    svgPreProcessor = null;
    /** Configuration getter */
    config = null;
    /** DeepNest instance for importing parts */
    deepNest = null;
    /** Ractive instance for updating UI */
    ractive = null;
    /** Callback for attaching sort behavior after import */
    attachSortCallback = null;
    /** Callback for applying zoom after import */
    applyZoomCallback = null;
    /** Callback for resizing parts view after import */
    resizeCallback = null;
    /** Flag to track if import button is busy */
    isImporting = false;
    /**
     * Create a new ImportService instance
     * Dependencies are injected for testability
     */
    constructor(options) {
        if (options) {
            this.dialog = options.dialog || null;
            this.remote = options.remote || null;
            this.fs = options.fs || null;
            this.path = options.path || null;
            this.httpClient = options.httpClient || null;
            this.FormData = options.FormData || null;
            this.svgPreProcessor = options.svgPreProcessor || null;
            this.config = options.config || null;
            this.deepNest = options.deepNest || null;
            this.ractive = options.ractive || null;
            this.attachSortCallback = options.attachSortCallback || null;
            this.applyZoomCallback = options.applyZoomCallback || null;
            this.resizeCallback = options.resizeCallback || null;
        }
    }
    /**
     * Set the dialog module for file selection
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
     * Set the path module
     * @param path - Node.js path module
     */
    setPath(path) {
        this.path = path;
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
     * Set the SVG pre-processor
     * @param svgPreProcessor - SVG pre-processor instance
     */
    setSvgPreProcessor(svgPreProcessor) {
        this.svgPreProcessor = svgPreProcessor;
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
     * @param deepNest - DeepNest instance for importing parts
     */
    setDeepNest(deepNest) {
        this.deepNest = deepNest;
    }
    /**
     * Set the Ractive instance for UI updates
     * @param ractive - Ractive instance
     */
    setRactive(ractive) {
        this.ractive = ractive;
    }
    /**
     * Set callbacks for post-import actions
     * @param callbacks - Object containing callback functions
     */
    setCallbacks(callbacks) {
        if (callbacks.attachSort) {
            this.attachSortCallback = callbacks.attachSort;
        }
        if (callbacks.applyZoom) {
            this.applyZoomCallback = callbacks.applyZoom;
        }
        if (callbacks.resize) {
            this.resizeCallback = callbacks.resize;
        }
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
     * Check if a file extension requires conversion
     * @param extension - File extension (with leading dot)
     * @returns True if the file needs conversion
     */
    needsConversion(extension) {
        const lowerExt = extension.toLowerCase();
        return SUPPORTED_EXTENSIONS.NEEDS_CONVERSION.some((ext) => ext === lowerExt);
    }
    /**
     * Check if a file extension is a DXF file
     * @param extension - File extension (with leading dot)
     * @returns True if the file is a DXF
     */
    isDxf(extension) {
        return extension.toLowerCase() === ".dxf";
    }
    /**
     * Load files from the nest directory on startup
     * @returns Promise that resolves when all files are loaded
     */
    async loadNestDirectoryFiles() {
        if (!this.remote || !this.fs) {
            return;
        }
        const nestDirectory = this.remote.getGlobal("NEST_DIRECTORY");
        if (!nestDirectory) {
            return;
        }
        try {
            const files = this.fs.readdirSync(nestDirectory);
            const svgFiles = files
                .filter((file) => file.includes(".svg"))
                .sort();
            for (const file of svgFiles) {
                await this.processFile(nestDirectory + file);
            }
        }
        catch {
            // Directory may not exist, silently continue
        }
    }
    /**
     * Show the file open dialog and import selected files
     * @returns Promise that resolves when import is complete
     */
    async showImportDialog() {
        if (!this.dialog) {
            message("Dialog module not available", true);
            return;
        }
        if (this.isImporting) {
            return;
        }
        this.isImporting = true;
        try {
            const result = await this.dialog.showOpenDialog({
                filters: FILE_FILTERS,
                properties: ["openFile", "multiSelections"],
            });
            if (result.canceled) {
                return;
            }
            for (const filePath of result.filePaths) {
                await this.processFile(filePath);
            }
        }
        finally {
            this.isImporting = false;
        }
    }
    /**
     * Process a file for import
     * Routes to appropriate handler based on file extension
     * @param filePath - Full path to the file
     */
    async processFile(filePath) {
        if (!this.path) {
            message("Path module not available", true);
            return;
        }
        const ext = this.path.extname(filePath);
        const filename = this.path.basename(filePath);
        if (ext.toLowerCase() === ".svg") {
            await this.readSvgFile(filePath);
        }
        else if (this.needsConversion(ext)) {
            await this.convertAndImport(filePath, filename, ext);
        }
    }
    /**
     * Read and import an SVG file directly
     * @param filePath - Full path to the SVG file
     */
    async readSvgFile(filePath) {
        if (!this.fs || !this.path) {
            message("File system modules not available", true);
            return;
        }
        return new Promise((resolve) => {
            this.fs.readFile(filePath, "utf-8", (err, data) => {
                if (err) {
                    message("An error occurred reading the file: " + err.message, true);
                    resolve();
                    return;
                }
                const filename = this.path.basename(filePath);
                const dirpath = this.path.dirname(filePath);
                this.processSvgData(data, filename, dirpath);
                resolve();
            });
        });
    }
    /**
     * Convert a non-SVG file to SVG using the conversion server
     * @param filePath - Full path to the file
     * @param filename - Base filename
     * @param ext - File extension
     */
    async convertAndImport(filePath, filename, ext) {
        if (!this.fs || !this.httpClient || !this.FormData) {
            message("Required modules not available for conversion", true);
            return;
        }
        const url = this.getConversionServerUrl();
        try {
            const fileBuffer = this.fs.readFileSync(filePath);
            const formData = new this.FormData();
            formData.append("fileUpload", fileBuffer, {
                filename: filename,
                contentType: "application/dxf",
            });
            formData.append("format", "svg");
            const response = await this.httpClient.post(url, formData.getBuffer(), {
                headers: formData.getHeaders(),
                responseType: "text",
            });
            const body = response.data;
            // Check for error responses
            if (body.substring(0, 5) === "error") {
                message(body, true);
                return;
            }
            if (body.includes('"error"') && body.includes('"error_id"')) {
                const jsonErr = JSON.parse(body);
                message(`There was an Error while converting: ${jsonErr.error_id}<br>Please use this code to open an issue on github.com/deepnest-next/deepnest`, true);
                return;
            }
            // Calculate scaling factor for DXF files
            let scalingFactor = null;
            let dxfFlag = false;
            if (this.isDxf(ext)) {
                scalingFactor = Number(this.config?.getSync("dxfImportScale")) || 1;
                dxfFlag = true;
            }
            // Process the converted SVG
            // Note: dirpath is null for converted files as they won't have embedded images
            this.processSvgData(body, filename, null, scalingFactor, dxfFlag);
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
        }
    }
    /**
     * Process SVG data (either from file or conversion)
     * Optionally runs through SVG pre-processor
     * @param data - SVG content as string
     * @param filename - Original filename
     * @param dirpath - Directory path for resolving relative paths (null for converted files)
     * @param scalingFactor - Optional scaling factor
     * @param dxfFlag - Whether this is a converted DXF file
     */
    processSvgData(data, filename, dirpath, scalingFactor = null, dxfFlag = false) {
        const useSvgPreProcessor = this.config?.getSync("useSvgPreProcessor");
        if (useSvgPreProcessor && this.svgPreProcessor) {
            try {
                const scale = Number(this.config?.getSync("scale")) || 72;
                const svgResult = this.svgPreProcessor.loadSvgString(data, scale);
                if (!svgResult.success) {
                    message(svgResult.result, true);
                    return;
                }
                this.importData(svgResult.result, filename, dirpath, scalingFactor, dxfFlag);
            }
            catch (e) {
                const error = e;
                message("Error processing SVG: " + error.message, true);
            }
        }
        else {
            this.importData(data, filename, dirpath, scalingFactor, dxfFlag);
        }
    }
    /**
     * Import SVG data into DeepNest and update the UI
     * @param data - SVG content as string
     * @param filename - Original filename
     * @param dirpath - Directory path for resolving relative paths
     * @param scalingFactor - Optional scaling factor
     * @param dxfFlag - Whether this is a converted DXF file
     */
    importData(data, filename, dirpath, scalingFactor = null, dxfFlag = false) {
        if (!this.deepNest) {
            message("DeepNest instance not available", true);
            return;
        }
        // Import the SVG into DeepNest
        this.deepNest.importsvg(filename, dirpath, data, scalingFactor, dxfFlag);
        // Deselect all previous imports
        this.deepNest.imports.forEach((im) => {
            im.selected = false;
        });
        // Select the newly imported file
        if (this.deepNest.imports.length > 0) {
            this.deepNest.imports[this.deepNest.imports.length - 1].selected = true;
        }
        // Update Ractive views
        this.updateViews();
    }
    /**
     * Update Ractive views and trigger post-import callbacks
     */
    updateViews() {
        if (this.ractive) {
            this.ractive.update("imports");
            this.ractive.update("parts");
        }
        if (this.attachSortCallback) {
            this.attachSortCallback();
        }
        if (this.applyZoomCallback) {
            this.applyZoomCallback();
        }
        if (this.resizeCallback) {
            this.resizeCallback();
        }
    }
    /**
     * Import SVG data directly (for programmatic use)
     * @param svgString - SVG content as string
     * @param filename - Filename to associate with the import
     * @param options - Optional import options
     * @returns Array of parts created from the import
     */
    importSvgString(svgString, filename, options) {
        if (!this.deepNest) {
            message("DeepNest instance not available", true);
            return null;
        }
        const dirpath = options?.dirpath ?? null;
        const scalingFactor = options?.scalingFactor ?? null;
        const dxfFlag = options?.dxfFlag ?? false;
        const usePreProcessor = options?.usePreProcessor ?? false;
        let processedData = svgString;
        if (usePreProcessor && this.svgPreProcessor) {
            try {
                const scale = Number(this.config?.getSync("scale")) || 72;
                const svgResult = this.svgPreProcessor.loadSvgString(svgString, scale);
                if (!svgResult.success) {
                    message(svgResult.result, true);
                    return null;
                }
                processedData = svgResult.result;
            }
            catch (e) {
                const error = e;
                message("Error processing SVG: " + error.message, true);
                return null;
            }
        }
        const parts = this.deepNest.importsvg(filename, dirpath, processedData, scalingFactor, dxfFlag);
        // Deselect all previous imports
        this.deepNest.imports.forEach((im) => {
            im.selected = false;
        });
        // Select the newly imported file
        if (this.deepNest.imports.length > 0) {
            this.deepNest.imports[this.deepNest.imports.length - 1].selected = true;
        }
        // Update views
        this.updateViews();
        return parts;
    }
    /**
     * Check if import is currently in progress
     * @returns True if importing
     */
    isImportInProgress() {
        return this.isImporting;
    }
    /**
     * Get the file filters used for the import dialog
     * @returns Array of file filters
     */
    static getFileFilters() {
        return [...FILE_FILTERS];
    }
    /**
     * Get the supported file extensions
     * @returns Object with SVG and conversion extension arrays
     */
    static getSupportedExtensions() {
        return SUPPORTED_EXTENSIONS;
    }
    /**
     * Create and return a new ImportService instance
     * @param options - Optional configuration options
     * @returns New ImportService instance
     */
    static create(options) {
        return new ImportService(options);
    }
}
/**
 * Factory function to create an import service
 * @param options - Optional configuration options
 * @returns New ImportService instance
 */
export function createImportService(options) {
    return ImportService.create(options);
}
//# sourceMappingURL=import.service.js.map