/**
 * Navigation Component
 * Handles tab switching logic for the sidebar navigation and dark mode toggle.
 * Extracted from page.js (lines 168-199)
 */
import { getElements, getElement, addClass, removeClass, toggleClass, hasClass, } from "../utils/dom-utils.js";
/**
 * DOM element selectors used by the navigation component
 */
const SELECTORS = {
    /** Side navigation list items */
    SIDENAV_TABS: "#sidenav li",
    /** Currently active tab in sidenav */
    ACTIVE_TAB: "#sidenav li.active",
    /** Currently active page */
    ACTIVE_PAGE: ".page.active",
};
/**
 * CSS classes used by navigation
 */
const CSS_CLASSES = {
    ACTIVE: "active",
    DISABLED: "disabled",
    PAGE: "page",
    DARK_MODE: "dark-mode",
};
/**
 * Local storage keys
 */
const STORAGE_KEYS = {
    DARK_MODE: "darkMode",
};
/**
 * Special tab IDs that have custom behavior
 */
const SPECIAL_TABS = {
    DARK_MODE: "darkmode_tab",
};
/**
 * Navigation Service class
 * Manages tab switching and dark mode toggle functionality
 */
export class NavigationService {
    /** Callback to resize UI elements when needed */
    resizeCallback = null;
    /** Flag to track if navigation has been initialized */
    initialized = false;
    /**
     * Create a new NavigationService instance
     * @param options - Optional configuration options
     */
    constructor(options) {
        if (options?.resizeCallback) {
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
     * Initialize dark mode from local storage preference
     * Should be called early in the page lifecycle
     */
    initializeDarkMode() {
        const darkMode = localStorage.getItem(STORAGE_KEYS.DARK_MODE) === "true";
        if (darkMode) {
            addClass(document.body, CSS_CLASSES.DARK_MODE);
        }
    }
    /**
     * Check if dark mode is currently enabled
     * @returns True if dark mode is active
     */
    isDarkMode() {
        return hasClass(document.body, CSS_CLASSES.DARK_MODE);
    }
    /**
     * Toggle dark mode on/off
     * Persists the preference to local storage
     */
    toggleDarkMode() {
        toggleClass(document.body, CSS_CLASSES.DARK_MODE);
        localStorage.setItem(STORAGE_KEYS.DARK_MODE, hasClass(document.body, CSS_CLASSES.DARK_MODE).toString());
    }
    /**
     * Enable dark mode explicitly
     */
    enableDarkMode() {
        addClass(document.body, CSS_CLASSES.DARK_MODE);
        localStorage.setItem(STORAGE_KEYS.DARK_MODE, "true");
    }
    /**
     * Disable dark mode explicitly
     */
    disableDarkMode() {
        removeClass(document.body, CSS_CLASSES.DARK_MODE);
        localStorage.setItem(STORAGE_KEYS.DARK_MODE, "false");
    }
    /**
     * Switch to a specific tab by its page ID
     * @param pageId - The ID of the page to switch to (without # prefix)
     * @returns True if the tab was switched successfully
     */
    switchToTab(pageId) {
        // Find the tab with the matching data-page attribute
        const tabs = getElements(SELECTORS.SIDENAV_TABS);
        const tabsArray = Array.from(tabs);
        const targetTab = tabsArray.find((tab) => tab.dataset.page === pageId);
        if (!targetTab) {
            return false;
        }
        // Check if tab is already active or disabled
        if (hasClass(targetTab, CSS_CLASSES.ACTIVE) ||
            hasClass(targetTab, CSS_CLASSES.DISABLED)) {
            return false;
        }
        // Deactivate current tab and page
        const activeTab = getElement(SELECTORS.ACTIVE_TAB);
        const activePage = getElement(SELECTORS.ACTIVE_PAGE);
        if (activeTab) {
            activeTab.className = "";
        }
        if (activePage) {
            activePage.className = CSS_CLASSES.PAGE;
        }
        // Activate new tab and page
        targetTab.className = CSS_CLASSES.ACTIVE;
        const tabPage = getElement(`#${pageId}`);
        if (tabPage) {
            tabPage.className = `${CSS_CLASSES.PAGE} ${CSS_CLASSES.ACTIVE}`;
            // Call resize if switching to home tab
            if (pageId === "home" && this.resizeCallback) {
                this.resizeCallback();
            }
        }
        return true;
    }
    /**
     * Handle tab click events
     * @param tab - The tab element that was clicked
     * @returns False to prevent default behavior, undefined otherwise
     */
    handleTabClick(tab) {
        // Dark mode handler
        if (tab.id === SPECIAL_TABS.DARK_MODE) {
            this.toggleDarkMode();
            return undefined;
        }
        // Check if tab is already active or disabled
        if (tab.className === CSS_CLASSES.ACTIVE ||
            tab.className === CSS_CLASSES.DISABLED) {
            return false;
        }
        // Deactivate current tab and page
        const activeTab = getElement(SELECTORS.ACTIVE_TAB);
        const activePage = getElement(SELECTORS.ACTIVE_PAGE);
        if (activeTab) {
            activeTab.className = "";
        }
        if (activePage) {
            activePage.className = CSS_CLASSES.PAGE;
        }
        // Activate clicked tab
        tab.className = CSS_CLASSES.ACTIVE;
        // Activate corresponding page
        const pageId = tab.dataset.page;
        if (pageId) {
            const tabPage = getElement(`#${pageId}`);
            if (tabPage) {
                tabPage.className = `${CSS_CLASSES.PAGE} ${CSS_CLASSES.ACTIVE}`;
                // Call resize if switching to home tab
                if (tabPage.getAttribute("id") === "home" && this.resizeCallback) {
                    this.resizeCallback();
                }
            }
        }
        return false;
    }
    /**
     * Bind click event handlers to all navigation tabs
     * Call this after the DOM is ready
     */
    bindEventHandlers() {
        if (this.initialized) {
            return;
        }
        const tabs = getElements(SELECTORS.SIDENAV_TABS);
        tabs.forEach((tab) => {
            tab.addEventListener("click", (event) => {
                event.preventDefault();
                this.handleTabClick(tab);
            });
        });
        this.initialized = true;
    }
    /**
     * Initialize the navigation service
     * Sets up dark mode and binds event handlers
     */
    initialize() {
        this.initializeDarkMode();
        this.bindEventHandlers();
    }
    /**
     * Get the currently active tab element
     * @returns The active tab element or null
     */
    getActiveTab() {
        return getElement(SELECTORS.ACTIVE_TAB);
    }
    /**
     * Get the currently active page ID
     * @returns The active page ID or null
     */
    getActivePageId() {
        const activePage = getElement(SELECTORS.ACTIVE_PAGE);
        return activePage?.id || null;
    }
    /**
     * Check if a specific tab is active
     * @param pageId - The page ID to check
     * @returns True if the tab is active
     */
    isTabActive(pageId) {
        return this.getActivePageId() === pageId;
    }
    /**
     * Enable a previously disabled tab
     * @param pageId - The page ID of the tab to enable
     */
    enableTab(pageId) {
        const tabs = getElements(SELECTORS.SIDENAV_TABS);
        tabs.forEach((tab) => {
            if (tab.dataset.page === pageId && hasClass(tab, CSS_CLASSES.DISABLED)) {
                removeClass(tab, CSS_CLASSES.DISABLED);
            }
        });
    }
    /**
     * Disable a tab to prevent switching to it
     * @param pageId - The page ID of the tab to disable
     */
    disableTab(pageId) {
        const tabs = getElements(SELECTORS.SIDENAV_TABS);
        tabs.forEach((tab) => {
            if (tab.dataset.page === pageId && !hasClass(tab, CSS_CLASSES.DISABLED)) {
                addClass(tab, CSS_CLASSES.DISABLED);
            }
        });
    }
    /**
     * Create and return a new NavigationService instance
     * @param options - Optional configuration options
     * @returns New NavigationService instance
     */
    static create(options) {
        return new NavigationService(options);
    }
}
/**
 * Factory function to create a navigation service
 * @param options - Optional configuration options
 * @returns New NavigationService instance
 */
export function createNavigationService(options) {
    return NavigationService.create(options);
}
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
export function initializeNavigation(resizeCallback) {
    const service = new NavigationService({ resizeCallback });
    service.initialize();
    return service;
}
//# sourceMappingURL=navigation.js.map