/**
 * Type definitions for DeepNest UI components
 * Extends core types from index.d.ts with UI-specific interfaces
 */
/**
 * Default configuration values
 */
export const DEFAULT_CONVERSION_SERVER = "https://converter.deepnest.app/convert";
/**
 * IPC channel names used by the application
 */
export const IPC_CHANNELS = {
    LOAD_PRESETS: "load-presets",
    SAVE_PRESET: "save-preset",
    DELETE_PRESET: "delete-preset",
    READ_CONFIG: "read-config",
    WRITE_CONFIG: "write-config",
    BACKGROUND_START: "background-start",
    BACKGROUND_STOP: "background-stop",
    BACKGROUND_PROGRESS: "background-progress",
    BACKGROUND_RESPONSE: "background-response",
    BACKGROUND_LOG: "background-log",
    SET_PLACEMENTS: "setPlacements",
};
//# sourceMappingURL=index.js.map