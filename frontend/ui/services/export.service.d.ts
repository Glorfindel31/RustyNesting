/**
 * Export Service
 * Handles SVG/DXF/JSON export functionality for nesting results
 * Manages file save dialogs, format conversion, and file writing
 */
import type { UIConfig, DeepNestInstance, SelectableNestingResult, SvgParserInstance } from "../types/index.js";
/**
 * File filter options for the save dialog
 */
interface FileFilter {
    name: string;
    extensions: string[];
}
/**
 * Save dialog options
 */
interface SaveDialogOptions {
    title: string;
    filters: FileFilter[];
}
/**
 * Dialog interface for Electron's dialog module
 */
interface ElectronDialog {
    showSaveDialogSync(options: SaveDialogOptions): string | undefined;
    showMessageBox?(options: {
        type?: string;
        buttons: string[];
        defaultId?: number;
        title?: string;
        message: string;
    }): Promise<{
        response: number;
    }>;
}
/**
 * Remote interface for Electron's remote module
 */
interface ElectronRemote {
    getGlobal(name: string): string | undefined;
}
/**
 * File system interface for Node.js fs module
 */
interface FileSystem {
    writeFileSync(path: string, data: string): void;
    existsSync?(path: string): boolean;
    readFileSync?(path: string): string | Buffer;
    unlinkSync?(path: string): void;
}
/**
 * Axios-like HTTP client interface
 */
interface HttpClient {
    post(url: string, data: Buffer, options: {
        headers: Record<string, string>;
        responseType: string;
    }): Promise<{
        data: string;
    }>;
}
/**
 * FormData-like interface for file upload
 */
interface FormDataLike {
    append(name: string, value: Buffer | string, options?: {
        filename?: string;
        contentType?: string;
    }): void;
    getBuffer(): Buffer;
    getHeaders(): Record<string, string>;
}
/**
 * FormData constructor interface
 */
interface FormDataConstructor {
    new (): FormDataLike;
}
/**
 * Config getter interface
 */
interface ConfigGetter {
    getSync<K extends keyof UIConfig>(key?: K): K extends keyof UIConfig ? UIConfig[K] : UIConfig;
}
/**
 * Export button element interface
 */
interface ExportButtonElement extends HTMLElement {
    className: string;
}
/**
 * Export options for SVG generation
 */
export interface ExportOptions {
    /** Whether this export is for DXF conversion (affects scaling) */
    forDxfConversion?: boolean;
}
/**
 * Export file formats
 */
export type ExportFormat = "svg" | "dxf" | "json";
/**
 * Export Service class
 * Handles export operations for nesting results to various formats
 * Follows the pattern from main/deepnest.js ES6 class structure
 */
export declare class ExportService {
    /** Electron dialog for file save dialogs */
    private dialog;
    /** Electron remote for accessing global variables */
    private remote;
    /** Node.js file system module */
    private fs;
    /** HTTP client for conversion requests */
    private httpClient;
    /** FormData constructor for file upload */
    private FormData;
    /** Configuration getter */
    private config;
    /** DeepNest instance for accessing parts and nests */
    private deepNest;
    /** SvgParser instance for line merging operations */
    private svgParser;
    /** Export button element for spinner state */
    private exportButton;
    /** Flag to track if export is busy */
    private isExporting;
    /**
     * Create a new ExportService instance
     * Dependencies are injected for testability
     */
    constructor(options?: {
        dialog?: ElectronDialog;
        remote?: ElectronRemote;
        fs?: FileSystem;
        httpClient?: HttpClient;
        FormData?: FormDataConstructor;
        config?: ConfigGetter;
        deepNest?: DeepNestInstance;
        svgParser?: SvgParserInstance;
        exportButton?: ExportButtonElement;
    });
    /**
     * Set the dialog module for file save dialogs
     * @param dialog - Electron dialog module
     */
    setDialog(dialog: ElectronDialog): void;
    /**
     * Set the remote module for accessing globals
     * @param remote - Electron remote module
     */
    setRemote(remote: ElectronRemote): void;
    /**
     * Set the file system module
     * @param fs - Node.js fs module
     */
    setFileSystem(fs: FileSystem): void;
    /**
     * Set the HTTP client for conversion requests
     * @param httpClient - HTTP client (e.g., axios)
     */
    setHttpClient(httpClient: HttpClient): void;
    /**
     * Set the FormData constructor
     * @param FormData - FormData constructor
     */
    setFormDataConstructor(FormData: FormDataConstructor): void;
    /**
     * Set the configuration getter
     * @param config - Configuration object with getSync method
     */
    setConfig(config: ConfigGetter): void;
    /**
     * Set the DeepNest instance
     * @param deepNest - DeepNest instance for accessing parts and nests
     */
    setDeepNest(deepNest: DeepNestInstance): void;
    /**
     * Set the SvgParser instance for line merging operations
     * @param svgParser - SvgParser instance
     */
    setSvgParser(svgParser: SvgParserInstance): void;
    /**
     * Set the export button element for spinner state
     * @param button - Export button element
     */
    setExportButton(button: ExportButtonElement): void;
    /**
     * Get the conversion server URL from config or use default
     * @returns Conversion server URL
     */
    private getConversionServerUrl;
    /**
     * Get the currently selected nesting result
     * @returns Selected nesting result or null if none selected
     */
    private getSelectedNest;
    /**
     * Show the export button as loading
     */
    private setExportLoading;
    /**
     * Export the selected nest result to JSON file
     * Saves to the NEST_DIRECTORY as exports.json
     * @returns True if export was successful
     */
    exportToJson(): boolean;
    /**
     * Get the path of the emergency recovery file, if a nest directory is available
     */
    private getRecoveryFilePath;
    /**
     * Remove the recovery snapshot once the user has explicitly exported a result -
     * only an explicit export counts as "safe", so a plain app close (crash or not)
     * intentionally leaves the snapshot in place for the next-launch recovery prompt.
     */
    private clearRecoveryFile;
    /**
     * Overwrite the recovery snapshot with the given nest (always the current best).
     * Called continuously during nesting so a crash never loses the best result.
     * @param nest - The nest result to snapshot
     */
    saveRecoveryFile(nest: SelectableNestingResult): boolean;
    /**
     * On startup, check for a leftover recovery snapshot (e.g. from a crash) and
     * offer to export it. Removes the snapshot afterwards either way, so the user
     * isn't asked again next launch.
     */
    checkForRecovery(): Promise<void>;
    /**
     * Show save dialog and export to SVG
     * @returns True if export was successful
     */
    exportToSvg(): boolean;
    /**
     * Show save dialog and export to DXF via conversion server
     * @returns Promise that resolves to true if export was successful
     */
    exportToDxf(): Promise<boolean>;
    /**
     * Generate SVG content from a nesting result
     * Core function that builds the SVG document from placements
     * @param nestResult - The nesting result to export
     * @param options - Export options
     * @returns SVG content as string
     */
    generateSvgExport(nestResult: SelectableNestingResult, options?: ExportOptions): string;
    /**
     * Add sheet boundary to a group
     * @param group - SVG group element
     * @param sheetPart - Part representing the sheet
     */
    private addSheetBoundary;
    /**
     * Apply dimensions and viewBox to the SVG element
     * @param svg - SVG element
     * @param width - Content width in SVG units
     * @param height - Content height in SVG units
     * @param options - Export options
     */
    private applyDimensions;
    /**
     * Apply line merging optimization if configured
     * @param svg - SVG element
     * @param nestResult - Nesting result with merged length info
     */
    private applyLineMerging;
    /**
     * Export to the specified format
     * @param format - Export format (svg, dxf, or json)
     * @returns Promise that resolves to true if export was successful
     */
    export(format: ExportFormat): Promise<boolean>;
    /**
     * Check if export is currently in progress
     * @returns True if exporting
     */
    isExportInProgress(): boolean;
    /**
     * Check if there is a selected nest result available for export
     * @returns True if a nest result is selected
     */
    hasSelectedNest(): boolean;
    /**
     * Get supported export formats
     * @returns Array of supported format strings
     */
    static getSupportedFormats(): ExportFormat[];
    /**
     * Get file filters for a specific format
     * @param format - Export format
     * @returns Array of file filters
     */
    static getFileFilters(format: ExportFormat): FileFilter[];
    /**
     * Create and return a new ExportService instance
     * @param options - Optional configuration options
     * @returns New ExportService instance
     */
    static create(options?: ConstructorParameters<typeof ExportService>[0]): ExportService;
}
/**
 * Factory function to create an export service
 * @param options - Optional configuration options
 * @returns New ExportService instance
 */
export declare function createExportService(options?: ConstructorParameters<typeof ExportService>[0]): ExportService;
export {};
