/**
 * Parts View Component
 * Ractive-based parts list with selection, sorting, and deletion functionality.
 * Extracted from page.js (lines 421-714)
 */
import type { Part, ImportedFile, DeepNestInstance, ConfigObject } from "../types/index.js";
/**
 * Ractive event object with original DOM event
 */
interface RactiveEvent {
    original: MouseEvent;
}
/**
 * Ractive instance interface for parts view
 * More specific than the general RactiveInstance to handle custom events
 */
interface PartsViewRactiveInstance {
    /** Update a specific keypath */
    update(keypath?: string): Promise<void>;
    /** Get a value from the data context */
    get<K extends keyof PartsViewData>(keypath: K): PartsViewData[K];
    /** Set a value in the data context */
    set<K extends keyof PartsViewData>(keypath: K, value: PartsViewData[K]): Promise<void>;
    /** Register an event handler with Ractive-specific event signature */
    on(eventName: string, handler: (event: RactiveEvent, ...args: unknown[]) => boolean | void): void;
}
/**
 * Ractive component data interface for parts list
 */
interface PartsViewData {
    parts: Part[];
    imports: ImportedFile[];
    getSelected: () => Part[];
    getSheets: () => Part[];
    serializeSvg: (svg: SVGElement) => string;
    partrenderer: (part: Part) => string;
    partLabel: (part: Part, index: number) => string;
}
/**
 * Resize callback type
 */
export type ResizeCallback = (event?: {
    rect: {
        width: number;
    };
}) => void;
/**
 * Options for PartsView initialization
 */
/**
 * Minimal interface for Electron's native message box dialog
 */
interface MessageBoxDialog {
    showMessageBox(options: {
        type: string;
        buttons: string[];
        defaultId: number;
        cancelId: number;
        message: string;
    }): Promise<{
        response: number;
    }>;
}
export interface PartsViewOptions {
    /** DeepNest instance for accessing parts and imports */
    deepNest: DeepNestInstance;
    /** Configuration object */
    config: ConfigObject;
    /** Electron native dialog, used for the delete confirmation prompt */
    dialog?: MessageBoxDialog;
    /** Callback to resize the parts list */
    resizeCallback?: ResizeCallback;
}
/**
 * Parts View Service class
 * Manages the Ractive-based parts list with selection, sorting, and deletion
 */
export declare class PartsViewService {
    /** DeepNest instance */
    private deepNest;
    /** Configuration object */
    private config;
    /** Main Ractive instance for parts list */
    private ractive;
    /** Dimension label Ractive component */
    private labelComponent;
    /** Tracks if mouse button is currently down */
    private mouseDown;
    /** Throttled update function */
    private throttledUpdate;
    /** Resize callback */
    private resizeCallback;
    /** Electron native dialog, used for the delete confirmation prompt */
    private dialog;
    /** Flag to track if service has been initialized */
    private initialized;
    /**
     * Create a new PartsViewService instance
     * @param options - Configuration options
     */
    constructor(options: PartsViewOptions);
    /**
     * Set the resize callback function
     * @param callback - Function to call when resize is needed
     */
    setResizeCallback(callback: ResizeCallback): void;
    /**
     * Create the dimension label Ractive component
     * This component displays part dimensions in the current unit system
     */
    private createLabelComponent;
    /**
     * Toggle selection state of a part
     * @param part - The part to toggle
     */
    private togglePart;
    /**
     * Apply SVG pan/zoom library to the currently visible import
     */
    applyZoom(): void;
    /**
     * Set up zoom control button event listeners for an import
     * @param importIndex - Index of the import
     */
    private setupZoomControls;
    /**
     * Delete all selected parts, after confirmation
     */
    deleteParts(): Promise<void>;
    /**
     * Attach sorting functionality to table headers
     */
    attachSort(): void;
    /**
     * Update the parts data in Ractive
     */
    update(): void;
    /**
     * Update the imports data in Ractive
     */
    updateImports(): void;
    /**
     * Update units-related computed properties
     */
    updateUnits(): void;
    /**
     * Initialize the Ractive instance for parts list
     */
    private initializeRactive;
    /**
     * Set up mouse tracking for drag selection
     */
    private setupMouseTracking;
    /**
     * Create throttled update function
     */
    private createThrottledUpdate;
    /**
     * Bind Ractive event handlers
     */
    private bindRactiveEvents;
    /**
     * Set up keyboard event listener for delete key
     */
    private setupKeyboardEvents;
    /**
     * Initialize the parts view service
     * Sets up Ractive, event handlers, and keyboard shortcuts
     */
    initialize(): void;
    /**
     * Get the Ractive instance
     * @returns The Ractive instance or null if not initialized
     */
    getRactive(): PartsViewRactiveInstance | null;
    /**
     * Refresh the entire view (parts and imports)
     */
    refresh(): void;
    /**
     * Create and return a new PartsViewService instance
     * @param options - Configuration options
     * @returns New PartsViewService instance
     */
    static create(options: PartsViewOptions): PartsViewService;
}
/**
 * Factory function to create a parts view service
 * @param options - Configuration options
 * @returns New PartsViewService instance
 */
export declare function createPartsViewService(options: PartsViewOptions): PartsViewService;
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
export declare function initializePartsView(deepNest: DeepNestInstance, config: ConfigObject, resizeCallback?: ResizeCallback): PartsViewService;
export {};
