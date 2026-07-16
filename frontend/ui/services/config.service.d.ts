/**
 * Configuration Service
 * Manages application configuration with synchronous get/set interface
 * and persists settings via IPC to the main process
 */
import type { UIConfig, ConfigObject, PlacementType, UnitType } from "../types/index.js";
interface IpcRenderer {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}
/**
 * Default configuration values
 * Scale and distances are stored in native units (inches)
 */
export declare const DEFAULT_CONFIG: Readonly<UIConfig>;
/**
 * Keys that represent boolean configuration values (checkboxes in UI)
 */
export declare const BOOLEAN_CONFIG_KEYS: ReadonlyArray<keyof UIConfig>;
/**
 * Configuration Service class
 * Provides synchronous-style get/set interface for configuration management
 * Follows the pattern from main/deepnest.js ES6 class structure
 */
export declare class ConfigService implements ConfigObject {
    /** IPC renderer for communicating with main process */
    private ipcRenderer;
    /** Current configuration values */
    private config;
    /** Whether the service has been initialized */
    private initialized;
    units: UnitType;
    scale: number;
    spacing: number;
    curveTolerance: number;
    clipperScale: number;
    rotations: number;
    threads: number;
    populationSize: number;
    mutationRate: number;
    placementType: PlacementType;
    mergeLines: boolean;
    timeRatio: number;
    simplify: boolean;
    dxfImportScale: number;
    dxfExportScale: number;
    endpointTolerance: number;
    conversionServer: string;
    useSvgPreProcessor: boolean;
    useQuantityFromFileName: boolean;
    exportWithSheetBoundboarders: boolean;
    exportWithSheetsSpace: boolean;
    exportWithSheetsSpaceValue: number;
    dominantPartAreaThreshold: number;
    access_token?: string;
    id_token?: string;
    /**
     * Create a new ConfigService instance
     * @param ipcRenderer - Electron IPC renderer for persistence (optional for testing)
     */
    constructor(ipcRenderer?: IpcRenderer);
    /**
     * Initialize the service by loading persisted configuration
     * Must be called before using the service
     * @returns Promise that resolves when initialization is complete
     */
    initialize(): Promise<void>;
    /**
     * Merge saved configuration with current config
     * @param savedConfig - Configuration object to merge
     */
    private mergeConfig;
    /**
     * Set a configuration value with proper type handling
     * @param key - The configuration key
     * @param value - The value to set
     */
    private setConfigValue;
    /**
     * Synchronize instance properties with internal config object
     */
    private syncFromConfig;
    /**
     * Get a configuration value or the entire config object
     * Maintains compatibility with electron-settings style interface
     * @param key - Optional key to retrieve specific value
     * @returns The value for the key, or entire config if no key provided
     */
    getSync<K extends keyof UIConfig>(key?: K): K extends keyof UIConfig ? UIConfig[K] : UIConfig;
    /**
     * Set configuration values
     * Maintains compatibility with electron-settings style interface
     * @param keyOrObject - Key to set, or object with multiple values
     * @param value - Value to set (when keyOrObject is a string)
     */
    setSync<K extends keyof UIConfig>(keyOrObject: K | Partial<UIConfig>, value?: UIConfig[K]): void;
    /**
     * Reset all configuration to default values
     * Preserves access_token and id_token (user profile)
     */
    resetToDefaultsSync(): void;
    /**
     * Persist current configuration to storage via IPC
     * Called automatically after setSync operations
     */
    private persist;
    /**
     * Check if a key represents a boolean configuration value
     * @param key - Configuration key to check
     * @returns True if the key is a boolean config
     */
    static isBooleanKey(key: string): boolean;
    /**
     * Get the conversion factor based on current units
     * @returns Conversion factor for SVG units
     */
    getConversionFactor(): number;
    /**
     * Convert a value from user units to SVG units
     * @param value - Value in user units
     * @returns Value in SVG units
     */
    toSvgUnits(value: number): number;
    /**
     * Convert a value from SVG units to user units
     * @param value - Value in SVG units
     * @returns Value in user units
     */
    fromSvgUnits(value: number): number;
    /**
     * Get scale value adjusted for current unit setting
     * @returns Scale value in current units
     */
    getScaleInUnits(): number;
    /**
     * Set scale from a value in current units
     * @param scaleInUnits - Scale value in current units (mm or inch)
     */
    setScaleFromUnits(scaleInUnits: number): void;
    /**
     * Create a ConfigObject that can be assigned to window.config
     * This creates a proxy-like object that maintains backward compatibility
     * @param ipcRenderer - Electron IPC renderer
     * @returns Promise resolving to ConfigObject
     */
    static create(ipcRenderer: IpcRenderer): Promise<ConfigService>;
}
/**
 * Factory function to create and initialize the config service
 * @param ipcRenderer - Electron IPC renderer
 * @returns Promise resolving to initialized ConfigService
 */
export declare function createConfigService(ipcRenderer: IpcRenderer): Promise<ConfigService>;
/**
 * Type guard to check if a value is a valid PlacementType
 * @param value - Value to check
 * @returns True if the value is a valid PlacementType
 */
export declare function isValidPlacementType(value: unknown): value is PlacementType;
/**
 * Type guard to check if a value is a valid UnitType
 * @param value - Value to check
 * @returns True if the value is a valid UnitType
 */
export declare function isValidUnitType(value: unknown): value is UnitType;
export {};
