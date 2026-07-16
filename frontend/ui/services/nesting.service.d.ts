/**
 * Nesting Service
 * Handles nesting start/stop/display control for the nesting workflow
 * Manages the transition between main view and nest view, and controls
 * the nesting process lifecycle
 *
 * Unlike its sibling services (import/export/config), this one queries the DOM
 * directly (getElementById/querySelector) instead of going through Ractive bindings -
 * sanctioned exception, not drift: nest start/stop/progress UI is driven by raw
 * button/panel state that has no corresponding Ractive-bound model.
 */
import type { DeepNestInstance, SelectableNestingResult, RactiveInstance, NestViewData } from "../types/index.js";
/**
 * File system interface for cache operations
 */
interface FileSystem {
    existsSync(path: string): boolean;
    readdirSync(path: string): string[];
    lstatSync(path: string): {
        isDirectory(): boolean;
    };
    unlinkSync(path: string): void;
    rmdirSync(path: string): void;
}
/**
 * IPC renderer interface for Electron communication
 */
interface IpcRenderer {
    send(channel: string, ...args: unknown[]): void;
}
/**
 * Display callback function type
 */
export type DisplayCallback = () => void;
/**
 * Progress callback function type
 */
export type ProgressCallback = ((progress: {
    index: number;
    progress: number;
}) => void) | null;
/**
 * Display nest function type
 * Called to render a specific nesting result in the UI
 */
export type DisplayNestFunction = (nest: SelectableNestingResult) => void;
/**
 * Save JSON function type
 * Called to save the current nesting result to JSON file
 */
export type SaveJsonFunction = () => void;
/**
 * Save recovery function type
 * Called with the current best nest every time it improves, so an
 * emergency snapshot survives a crash without waiting for "Stop nest"
 */
export type SaveRecoveryFunction = (nest: SelectableNestingResult) => void;
/**
 * Nesting Service class
 * Manages the nesting workflow including start, stop, and display operations
 * Follows the pattern from main/deepnest.js ES6 class structure
 */
export declare class NestingService {
    /** File system module for cache operations */
    private fs;
    /** IPC renderer for background process communication */
    private ipcRenderer;
    /** DeepNest instance for nesting operations */
    private deepNest;
    /** Ractive instance for nest view UI updates */
    private nestRactive;
    /** Function to display a specific nesting result */
    private displayNestFn;
    /** Function to save current result to JSON */
    private saveJsonFn;
    /** Function to snapshot the current best result for crash recovery */
    private saveRecoveryFn;
    /** Function to refresh the parts list UI (e.g. after selecting oversized parts) */
    private updatePartsCallback;
    /** Flag indicating if nesting is being started */
    private isStarting;
    /** Flag indicating if nesting is being stopped */
    private isStopping;
    /**
     * Create a new NestingService instance
     * Dependencies are injected for testability
     */
    constructor(options?: {
        fs?: FileSystem;
        ipcRenderer?: IpcRenderer;
        deepNest?: DeepNestInstance;
        nestRactive?: RactiveInstance<NestViewData>;
        displayNestFn?: DisplayNestFunction;
        saveJsonFn?: SaveJsonFunction;
        saveRecoveryFn?: SaveRecoveryFunction;
        updatePartsCallback?: () => void;
    });
    /**
     * Set the file system module for cache operations
     * @param fs - Node.js fs module
     */
    setFileSystem(fs: FileSystem): void;
    /**
     * Set the IPC renderer for background process communication
     * @param ipcRenderer - Electron IPC renderer
     */
    setIpcRenderer(ipcRenderer: IpcRenderer): void;
    /**
     * Set the DeepNest instance
     * @param deepNest - DeepNest instance for nesting operations
     */
    setDeepNest(deepNest: DeepNestInstance): void;
    /**
     * Set the Ractive instance for nest view UI updates
     * @param nestRactive - Ractive instance
     */
    setNestRactive(nestRactive: RactiveInstance<NestViewData>): void;
    /**
     * Set the function to display a specific nesting result
     * @param displayNestFn - Display function
     */
    setDisplayNestFunction(displayNestFn: DisplayNestFunction): void;
    /**
     * Set the function to save results to JSON
     * @param saveJsonFn - Save JSON function
     */
    setSaveJsonFunction(saveJsonFn: SaveJsonFunction): void;
    /**
     * Set the function that snapshots the current best result for crash recovery
     * @param saveRecoveryFn - Save recovery function
     */
    setSaveRecoveryFunction(saveRecoveryFn: SaveRecoveryFunction): void;
    /**
     * Delete the NFP cache directory contents
     * This clears cached no-fit polygon calculations
     */
    deleteCache(): void;
    /**
     * Recursively delete a folder and its contents
     * @param path - Path to the folder to delete
     */
    private deleteFolderRecursive;
    /**
     * Check if there is at least one sheet in the parts list
     * @returns True if at least one part is marked as a sheet
     */
    hasSheet(): boolean;
    /**
     * Check if there are any parts to nest
     * @returns True if there are parts in the list
     */
    hasParts(): boolean;
    /**
     * Check if nesting is currently running
     * @returns True if nesting is in progress
     */
    isWorking(): boolean;
    /**
     * Switch the UI to the nest view
     */
    private switchToNestView;
    /**
     * Switch the UI back to the main view
     */
    private switchToMainView;
    /**
     * Enable the export button
     */
    private enableExportButton;
    /**
     * Disable the export button
     */
    private disableExportButton;
    /**
     * Clear progress indicators in the UI
     */
    private clearProgressIndicators;
    /**
     * Update the stop/start button state
     * @param state - Button state: "stop", "stop-disabled", or "start"
     */
    private updateStopButton;
    /**
     * Create the display callback for nesting results
     * This callback is called when a new nesting result is available
     * @returns Display callback function bound to this service
     */
    private createDisplayCallback;
    /**
     * Start the nesting process
     * @param progressCallback - Optional callback for progress updates
     * @returns True if nesting was started successfully
     */
    startNesting(progressCallback?: ProgressCallback): boolean;
    /**
     * Stop the nesting process
     * @returns True if nesting was stopped successfully
     */
    stopNesting(): boolean;
    /**
     * Handle the stop/start toggle button click
     * Toggles between stop and start states
     */
    handleStopStartToggle(): void;
    /**
     * Go back to the main view
     * Stops any running nesting and resets the state
     */
    goBack(): void;
    /**
     * Get the current nesting results
     * @returns Array of nesting results
     */
    getNests(): SelectableNestingResult[];
    /**
     * Get the currently selected nesting result
     * @returns Selected nesting result or null
     */
    getSelectedNest(): SelectableNestingResult | null;
    /**
     * Select a specific nesting result and display it
     * @param nest - The nesting result to select
     */
    selectNest(nest: SelectableNestingResult): void;
    /**
     * Bind event handlers to DOM elements
     * Call this after the DOM is ready
     */
    bindEventHandlers(): void;
    /**
     * Create and return a new NestingService instance
     * @param options - Optional configuration options
     * @returns New NestingService instance
     */
    static create(options?: ConstructorParameters<typeof NestingService>[0]): NestingService;
}
/**
 * Factory function to create a nesting service
 * @param options - Optional configuration options
 * @returns New NestingService instance
 */
export declare function createNestingService(options?: ConstructorParameters<typeof NestingService>[0]): NestingService;
export {};
