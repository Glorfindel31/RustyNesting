/**
 * Nest View Component
 * Ractive-based nest result display with selection and visualization.
 * Extracted from page.js (lines 1463-1697)
 */
import type { DeepNestInstance, ConfigObject, SelectableNestingResult } from "../types/index.js";
/**
 * Ractive event object with original DOM event
 */
interface RactiveEvent {
    original: MouseEvent;
}
/**
 * Ractive instance interface for nest view
 */
interface NestViewRactiveInstance {
    /** Update a specific keypath */
    update(keypath?: string): Promise<void>;
    /** Get a value from the data context */
    get<K extends keyof NestViewData>(keypath: K): NestViewData[K];
    /** Set a value in the data context */
    set<K extends keyof NestViewData>(keypath: K, value: NestViewData[K]): Promise<void>;
    /** Register an event handler with Ractive-specific event signature */
    on(eventName: string, handler: (event: RactiveEvent, ...args: unknown[]) => boolean | void): void;
}
/**
 * Ractive component data interface for nest display
 */
interface NestViewData {
    nests: SelectableNestingResult[];
    getSelected: () => SelectableNestingResult[];
    getNestedPartSources: (n: SelectableNestingResult) => number[];
    getColorBySource: (id: number) => string;
    getPartsPlaced: () => string;
    getUtilisation: () => string;
    getTimeSaved: () => string;
}
/**
 * Options for NestView initialization
 */
export interface NestViewOptions {
    /** DeepNest instance for accessing nests and parts */
    deepNest: DeepNestInstance;
    /** Configuration object */
    config: ConfigObject;
}
/**
 * Nest View Service class
 * Manages the Ractive-based nest display with selection and visualization
 */
export declare class NestViewService {
    /** DeepNest instance */
    private deepNest;
    /** Configuration object */
    private config;
    /** Main Ractive instance for nest view */
    private ractive;
    /** Flag to track if service has been initialized */
    private initialized;
    /**
     * Create a new NestViewService instance
     * @param options - Configuration options
     */
    constructor(options: NestViewOptions);
    /**
     * Display a nesting result in the SVG viewport
     * Creates/updates SVG elements for sheets and placed parts
     * @param n - The nesting result to display
     */
    displayNest(n: SelectableNestingResult): void;
    /**
     * Initialize the Ractive instance for nest view
     */
    private initializeRactive;
    /**
     * Bind Ractive event handlers
     */
    private bindRactiveEvents;
    /**
     * Update the nests data in Ractive
     */
    update(): void;
    /**
     * Initialize the nest view service
     * Sets up Ractive and event handlers
     */
    initialize(): void;
    /**
     * Get the Ractive instance
     * @returns The Ractive instance or null if not initialized
     */
    getRactive(): NestViewRactiveInstance | null;
    /**
     * Get the displayNest function bound to this instance
     * Useful for passing to callbacks
     * @returns Bound displayNest function
     */
    getDisplayNestCallback(): (n: SelectableNestingResult) => void;
    /**
     * Create and return a new NestViewService instance
     * @param options - Configuration options
     * @returns New NestViewService instance
     */
    static create(options: NestViewOptions): NestViewService;
}
/**
 * Factory function to create a nest view service
 * @param options - Configuration options
 * @returns New NestViewService instance
 */
export declare function createNestViewService(options: NestViewOptions): NestViewService;
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
export declare function initializeNestView(deepNest: DeepNestInstance, config: ConfigObject): NestViewService;
export {};
