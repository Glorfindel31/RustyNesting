/**
 * Sheet Dialog Component
 * Handles the add sheet dialog for creating rectangular sheets.
 * Extracted from page.js (lines 928-982)
 */
import type { DeepNestInstance, ConfigObject, RactiveInstance, PartsViewData } from "../types/index.js";
/**
 * Callback type for resize function
 * Called after a sheet is added to resize UI elements
 */
export type ResizeCallback = () => void;
/**
 * Callback type for updating the parts list
 */
export type UpdatePartsCallback = () => void;
/**
 * Options for SheetDialog initialization
 */
export interface SheetDialogOptions {
    /** DeepNest instance for importing the sheet */
    deepNest: DeepNestInstance;
    /** Configuration object for units and scale */
    config: ConfigObject;
    /** Ractive instance for updating the parts list */
    ractive?: RactiveInstance<PartsViewData>;
    /** Callback to resize UI elements after adding a sheet */
    resizeCallback?: ResizeCallback;
    /** Callback to update parts list (alternative to ractive) */
    updatePartsCallback?: UpdatePartsCallback;
}
/**
 * Sheet Dialog Service class
 * Manages the add sheet dialog for creating rectangular sheets (bins)
 */
export declare class SheetDialogService {
    /** DeepNest instance */
    private deepNest;
    /** Configuration object */
    private config;
    /** Ractive instance for parts list */
    private ractive;
    /** Callback to resize UI elements */
    private resizeCallback;
    /** Callback to update parts list */
    private updatePartsCallback;
    /** Flag to track if service has been initialized */
    private initialized;
    /**
     * Create a new SheetDialogService instance
     * @param options - Configuration options
     */
    constructor(options: SheetDialogOptions);
    /**
     * Set the Ractive instance for updating parts list
     * @param ractive - The Ractive instance
     */
    setRactive(ractive: RactiveInstance<PartsViewData>): void;
    /**
     * Set the resize callback function
     * @param callback - Function to call when resize is needed
     */
    setResizeCallback(callback: ResizeCallback): void;
    /**
     * Set the update parts callback function
     * @param callback - Function to call to update parts list
     */
    setUpdatePartsCallback(callback: UpdatePartsCallback): void;
    /**
     * Open the add sheet dialog
     * Shows the parts tools area with the sheet input form
     */
    openDialog(): void;
    /**
     * Close the add sheet dialog
     * Hides the parts tools area
     */
    closeDialog(): void;
    /**
     * Get the conversion factor based on current units and scale
     * @returns The conversion factor to apply to input dimensions
     */
    private getConversionFactor;
    /**
     * Validate a dimension input
     * @param input - The input element to validate
     * @returns True if valid, false otherwise
     */
    private validateInput;
    /**
     * Clear the input fields and remove error states
     */
    private clearInputs;
    /**
     * Create a rectangular sheet SVG
     * @param width - Sheet width in SVG units
     * @param height - Sheet height in SVG units
     * @returns Serialized SVG string
     */
    private createSheetSvg;
    /**
     * Add a new sheet with the specified dimensions
     * @param width - Sheet width in user units (mm or inches)
     * @param height - Sheet height in user units (mm or inches)
     * @returns True if the sheet was added successfully
     */
    addSheet(width: number, height: number): boolean;
    /**
     * Handle the confirm button click
     * Validates inputs, creates the sheet, and updates the UI
     * @returns False to prevent default behavior, undefined otherwise
     */
    handleConfirm(): boolean | undefined;
    /**
     * Bind event handlers to dialog buttons
     * Call this after the DOM is ready
     */
    bindEventHandlers(): void;
    /**
     * Initialize the sheet dialog service
     * Sets up event handlers for dialog buttons
     */
    initialize(): void;
    /**
     * Check if the dialog is currently open
     * @returns True if the dialog is open
     */
    isOpen(): boolean;
    /**
     * Create and return a new SheetDialogService instance
     * @param options - Configuration options
     * @returns New SheetDialogService instance
     */
    static create(options: SheetDialogOptions): SheetDialogService;
}
/**
 * Factory function to create a sheet dialog service
 * @param options - Configuration options
 * @returns New SheetDialogService instance
 */
export declare function createSheetDialogService(options: SheetDialogOptions): SheetDialogService;
/**
 * Initialize sheet dialog with a simple functional API
 * For use cases where a full service instance is not needed
 *
 * @param deepNest - DeepNest instance
 * @param config - Configuration object
 * @param ractive - Optional Ractive instance for parts list
 * @param resizeCallback - Optional resize callback
 * @returns The initialized SheetDialogService instance
 *
 * @example
 * // Simple initialization
 * const sheetDialog = initializeSheetDialog(
 *   window.DeepNest,
 *   window.config,
 *   ractive,
 *   () => resize()
 * );
 *
 * // Later, open the dialog programmatically
 * sheetDialog.openDialog();
 *
 * // Or add a sheet directly
 * sheetDialog.addSheet(300, 200); // 300x200 in current units
 */
export declare function initializeSheetDialog(deepNest: DeepNestInstance, config: ConfigObject, ractive?: RactiveInstance<PartsViewData>, resizeCallback?: ResizeCallback): SheetDialogService;
