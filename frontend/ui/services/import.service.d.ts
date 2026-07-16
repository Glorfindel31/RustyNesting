/**
 * Import Service
 * Handles SVG/DXF/DWG file import with conversion server API
 * Manages file selection, reading, and conversion workflow
 */
import type { UIConfig, Part, DeepNestInstance, RactiveInstance, PartsViewData } from "../types/index.js";
/**
 * File filter options for the open dialog
 */
interface FileFilter {
    name: string;
    extensions: string[];
}
/**
 * Open dialog options
 */
interface OpenDialogOptions {
    filters: FileFilter[];
    properties: ("openFile" | "multiSelections")[];
}
/**
 * Open dialog result
 */
interface OpenDialogResult {
    canceled: boolean;
    filePaths: string[];
}
/**
 * Dialog interface for Electron's dialog module
 */
interface ElectronDialog {
    showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogResult>;
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
    readFileSync(path: string): Buffer;
    readFile(path: string, encoding: string, callback: (err: Error | null, data: string) => void): void;
    readdirSync(path: string): string[];
}
/**
 * Path module interface
 */
interface PathModule {
    extname(path: string): string;
    basename(path: string): string;
    dirname(path: string): string;
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
 * SVG Pre-processor result
 */
interface SvgPreProcessorResult {
    success: boolean;
    result: string;
}
/**
 * SVG Pre-processor interface
 */
interface SvgPreProcessor {
    loadSvgString(svgString: string, scale: number): SvgPreProcessorResult;
}
/**
 * Config getter interface
 */
interface ConfigGetter {
    getSync<K extends keyof UIConfig>(key?: K): K extends keyof UIConfig ? UIConfig[K] : UIConfig;
}
/**
 * Supported file extensions for import
 */
declare const SUPPORTED_EXTENSIONS: {
    readonly SVG: readonly [".svg"];
    readonly NEEDS_CONVERSION: readonly [".ps", ".eps", ".dxf", ".dwg"];
};
/**
 * Import Service class
 * Handles file import operations with support for SVG and conversion of other formats
 * Follows the pattern from main/deepnest.js ES6 class structure
 */
export declare class ImportService {
    /** Electron dialog for file selection */
    private dialog;
    /** Electron remote for accessing global variables */
    private remote;
    /** Node.js file system module */
    private fs;
    /** Node.js path module */
    private path;
    /** HTTP client for conversion requests */
    private httpClient;
    /** FormData constructor for file upload */
    private FormData;
    /** SVG pre-processor for cleaning input */
    private svgPreProcessor;
    /** Configuration getter */
    private config;
    /** DeepNest instance for importing parts */
    private deepNest;
    /** Ractive instance for updating UI */
    private ractive;
    /** Callback for attaching sort behavior after import */
    private attachSortCallback;
    /** Callback for applying zoom after import */
    private applyZoomCallback;
    /** Callback for resizing parts view after import */
    private resizeCallback;
    /** Flag to track if import button is busy */
    private isImporting;
    /**
     * Create a new ImportService instance
     * Dependencies are injected for testability
     */
    constructor(options?: {
        dialog?: ElectronDialog;
        remote?: ElectronRemote;
        fs?: FileSystem;
        path?: PathModule;
        httpClient?: HttpClient;
        FormData?: FormDataConstructor;
        svgPreProcessor?: SvgPreProcessor;
        config?: ConfigGetter;
        deepNest?: DeepNestInstance;
        ractive?: RactiveInstance<PartsViewData>;
        attachSortCallback?: () => void;
        applyZoomCallback?: () => void;
        resizeCallback?: () => void;
    });
    /**
     * Set the dialog module for file selection
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
     * Set the path module
     * @param path - Node.js path module
     */
    setPath(path: PathModule): void;
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
     * Set the SVG pre-processor
     * @param svgPreProcessor - SVG pre-processor instance
     */
    setSvgPreProcessor(svgPreProcessor: SvgPreProcessor): void;
    /**
     * Set the configuration getter
     * @param config - Configuration object with getSync method
     */
    setConfig(config: ConfigGetter): void;
    /**
     * Set the DeepNest instance
     * @param deepNest - DeepNest instance for importing parts
     */
    setDeepNest(deepNest: DeepNestInstance): void;
    /**
     * Set the Ractive instance for UI updates
     * @param ractive - Ractive instance
     */
    setRactive(ractive: RactiveInstance<PartsViewData>): void;
    /**
     * Set callbacks for post-import actions
     * @param callbacks - Object containing callback functions
     */
    setCallbacks(callbacks: {
        attachSort?: () => void;
        applyZoom?: () => void;
        resize?: () => void;
    }): void;
    /**
     * Get the conversion server URL from config or use default
     * @returns Conversion server URL
     */
    private getConversionServerUrl;
    /**
     * Check if a file extension requires conversion
     * @param extension - File extension (with leading dot)
     * @returns True if the file needs conversion
     */
    private needsConversion;
    /**
     * Check if a file extension is a DXF file
     * @param extension - File extension (with leading dot)
     * @returns True if the file is a DXF
     */
    private isDxf;
    /**
     * Load files from the nest directory on startup
     * @returns Promise that resolves when all files are loaded
     */
    loadNestDirectoryFiles(): Promise<void>;
    /**
     * Show the file open dialog and import selected files
     * @returns Promise that resolves when import is complete
     */
    showImportDialog(): Promise<void>;
    /**
     * Process a file for import
     * Routes to appropriate handler based on file extension
     * @param filePath - Full path to the file
     */
    processFile(filePath: string): Promise<void>;
    /**
     * Read and import an SVG file directly
     * @param filePath - Full path to the SVG file
     */
    private readSvgFile;
    /**
     * Convert a non-SVG file to SVG using the conversion server
     * @param filePath - Full path to the file
     * @param filename - Base filename
     * @param ext - File extension
     */
    private convertAndImport;
    /**
     * Process SVG data (either from file or conversion)
     * Optionally runs through SVG pre-processor
     * @param data - SVG content as string
     * @param filename - Original filename
     * @param dirpath - Directory path for resolving relative paths (null for converted files)
     * @param scalingFactor - Optional scaling factor
     * @param dxfFlag - Whether this is a converted DXF file
     */
    private processSvgData;
    /**
     * Import SVG data into DeepNest and update the UI
     * @param data - SVG content as string
     * @param filename - Original filename
     * @param dirpath - Directory path for resolving relative paths
     * @param scalingFactor - Optional scaling factor
     * @param dxfFlag - Whether this is a converted DXF file
     */
    private importData;
    /**
     * Update Ractive views and trigger post-import callbacks
     */
    private updateViews;
    /**
     * Import SVG data directly (for programmatic use)
     * @param svgString - SVG content as string
     * @param filename - Filename to associate with the import
     * @param options - Optional import options
     * @returns Array of parts created from the import
     */
    importSvgString(svgString: string, filename: string, options?: {
        dirpath?: string | null;
        scalingFactor?: number | null;
        dxfFlag?: boolean;
        usePreProcessor?: boolean;
    }): Part[] | null;
    /**
     * Check if import is currently in progress
     * @returns True if importing
     */
    isImportInProgress(): boolean;
    /**
     * Get the file filters used for the import dialog
     * @returns Array of file filters
     */
    static getFileFilters(): FileFilter[];
    /**
     * Get the supported file extensions
     * @returns Object with SVG and conversion extension arrays
     */
    static getSupportedExtensions(): typeof SUPPORTED_EXTENSIONS;
    /**
     * Create and return a new ImportService instance
     * @param options - Optional configuration options
     * @returns New ImportService instance
     */
    static create(options?: ConstructorParameters<typeof ImportService>[0]): ImportService;
}
/**
 * Factory function to create an import service
 * @param options - Optional configuration options
 * @returns New ImportService instance
 */
export declare function createImportService(options?: ConstructorParameters<typeof ImportService>[0]): ImportService;
export {};
