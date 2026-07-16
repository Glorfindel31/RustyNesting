/**
 * Preset Service
 * Manages preset save/load/delete operations via IPC
 * Provides a clean interface for preset management in the renderer process
 */
import type { UIConfig, PresetConfig } from "../types/index.js";
interface IpcRenderer {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}
/**
 * Preset Service class
 * Handles preset operations via IPC communication with the main process
 * Follows the pattern from main/deepnest.js ES6 class structure
 */
export declare class PresetService {
    /** IPC renderer for communicating with main process */
    private ipcRenderer;
    /** Cached presets to avoid unnecessary IPC calls */
    private cachedPresets;
    /** Whether the cache is valid */
    private cacheValid;
    /**
     * Create a new PresetService instance
     * @param ipcRenderer - Electron IPC renderer for communication (optional for testing)
     */
    constructor(ipcRenderer?: IpcRenderer);
    /**
     * Migrate legacy conversion server URLs to the current server
     * This handles presets that were saved with old deepnest.io URLs
     * @param configString - JSON string of config to migrate
     * @returns Migrated config string
     */
    private migrateConversionServer;
    /**
     * Load all presets from storage
     * @returns Promise resolving to preset configuration object
     */
    loadPresets(): Promise<PresetConfig>;
    /**
     * Get list of preset names
     * @returns Promise resolving to array of preset names
     */
    getPresetNames(): Promise<string[]>;
    /**
     * Get a specific preset configuration by name
     * @param name - Name of the preset to retrieve
     * @returns Promise resolving to parsed config or null if not found
     */
    getPreset(name: string): Promise<Partial<UIConfig> | null>;
    /**
     * Save a preset with the given name
     * @param name - Name for the preset
     * @param config - Configuration to save (will be stringified if object)
     * @returns Promise resolving when save is complete
     * @throws Error if name is empty or save fails
     */
    savePreset(name: string, config: UIConfig | string): Promise<void>;
    /**
     * Delete a preset by name
     * @param name - Name of the preset to delete
     * @returns Promise resolving when delete is complete
     * @throws Error if name is empty or delete fails
     */
    deletePreset(name: string): Promise<void>;
    /**
     * Check if a preset exists
     * @param name - Name of the preset to check
     * @returns Promise resolving to true if preset exists
     */
    hasPreset(name: string): Promise<boolean>;
    /**
     * Invalidate the preset cache
     * Call this when presets may have changed externally
     */
    invalidateCache(): void;
    /**
     * Create and return a new PresetService instance
     * @param ipcRenderer - Electron IPC renderer
     * @returns New PresetService instance
     */
    static create(ipcRenderer: IpcRenderer): PresetService;
}
/**
 * Factory function to create a preset service
 * @param ipcRenderer - Electron IPC renderer
 * @returns New PresetService instance
 */
export declare function createPresetService(ipcRenderer: IpcRenderer): PresetService;
export {};
