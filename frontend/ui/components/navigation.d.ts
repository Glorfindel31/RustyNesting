/**
 * Navigation Component
 * Handles tab switching logic for the sidebar navigation and dark mode toggle.
 * Extracted from page.js (lines 168-199)
 */
/**
 * Callback type for resize function
 * Called when switching to the home page to resize UI elements
 */
export type ResizeCallback = () => void;
/**
 * Options for navigation initialization
 */
export interface NavigationOptions {
    /** Callback to call when resizing is needed (e.g., switching to home tab) */
    resizeCallback?: ResizeCallback;
}
/**
 * Navigation Service class
 * Manages tab switching and dark mode toggle functionality
 */
export declare class NavigationService {
    /** Callback to resize UI elements when needed */
    private resizeCallback;
    /** Flag to track if navigation has been initialized */
    private initialized;
    /**
     * Create a new NavigationService instance
     * @param options - Optional configuration options
     */
    constructor(options?: NavigationOptions);
    /**
     * Set the resize callback function
     * @param callback - Function to call when resize is needed
     */
    setResizeCallback(callback: ResizeCallback): void;
    /**
     * Initialize dark mode from local storage preference
     * Should be called early in the page lifecycle
     */
    initializeDarkMode(): void;
    /**
     * Check if dark mode is currently enabled
     * @returns True if dark mode is active
     */
    isDarkMode(): boolean;
    /**
     * Toggle dark mode on/off
     * Persists the preference to local storage
     */
    toggleDarkMode(): void;
    /**
     * Enable dark mode explicitly
     */
    enableDarkMode(): void;
    /**
     * Disable dark mode explicitly
     */
    disableDarkMode(): void;
    /**
     * Switch to a specific tab by its page ID
     * @param pageId - The ID of the page to switch to (without # prefix)
     * @returns True if the tab was switched successfully
     */
    switchToTab(pageId: string): boolean;
    /**
     * Handle tab click events
     * @param tab - The tab element that was clicked
     * @returns False to prevent default behavior, undefined otherwise
     */
    private handleTabClick;
    /**
     * Bind click event handlers to all navigation tabs
     * Call this after the DOM is ready
     */
    bindEventHandlers(): void;
    /**
     * Initialize the navigation service
     * Sets up dark mode and binds event handlers
     */
    initialize(): void;
    /**
     * Get the currently active tab element
     * @returns The active tab element or null
     */
    getActiveTab(): HTMLLIElement | null;
    /**
     * Get the currently active page ID
     * @returns The active page ID or null
     */
    getActivePageId(): string | null;
    /**
     * Check if a specific tab is active
     * @param pageId - The page ID to check
     * @returns True if the tab is active
     */
    isTabActive(pageId: string): boolean;
    /**
     * Enable a previously disabled tab
     * @param pageId - The page ID of the tab to enable
     */
    enableTab(pageId: string): void;
    /**
     * Disable a tab to prevent switching to it
     * @param pageId - The page ID of the tab to disable
     */
    disableTab(pageId: string): void;
    /**
     * Create and return a new NavigationService instance
     * @param options - Optional configuration options
     * @returns New NavigationService instance
     */
    static create(options?: NavigationOptions): NavigationService;
}
/**
 * Factory function to create a navigation service
 * @param options - Optional configuration options
 * @returns New NavigationService instance
 */
export declare function createNavigationService(options?: NavigationOptions): NavigationService;
/**
 * Initialize navigation with a simple functional API
 * For use cases where a full service instance is not needed
 *
 * @param resizeCallback - Optional resize callback for home tab
 * @returns The initialized NavigationService instance
 *
 * @example
 * // Simple initialization
 * const nav = initializeNavigation(() => resizePartsList());
 *
 * // Later, switch tabs programmatically
 * nav.switchToTab('config');
 */
export declare function initializeNavigation(resizeCallback?: ResizeCallback): NavigationService;
