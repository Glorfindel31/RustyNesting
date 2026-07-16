/**
 * Nesting Console Component
 * Live throughput stats (placements/sec, generation, best fitness) and an
 * error/warning log for the running nest. Derives placements/sec from
 * background-response traffic that already flows into this renderer
 * (deepnest.js's eventEmitter *is* ipcRenderer - see main/index.html), and
 * listens on background-log for failures relayed from background windows.
 */
import type { DeepNestInstance, ConfigObject } from "../types/index.js";
/**
 * Minimal IPC renderer interface for Electron communication
 */
interface IpcRenderer {
    on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
}
/**
 * Options for NestingConsole initialization
 */
export interface NestingConsoleOptions {
    /** DeepNest instance for reading nests/generationCount/working state */
    deepNest: DeepNestInstance;
    /** Configuration object for reading populationSize/threads */
    config: ConfigObject;
    /** Electron IPC renderer for background-response/background-log */
    ipcRenderer: IpcRenderer;
}
/**
 * Nesting Console Service
 * Shows live nesting throughput and surfaces errors that were previously silent
 */
export declare class NestingConsoleService {
    private deepNest;
    private config;
    private ipcRenderer;
    /** Total background-response messages seen since the last reset */
    private completedCount;
    /** completedCount snapshot at the previous tick, for the per-second delta */
    private lastTickCount;
    /** Tracks deepNest.working across ticks to detect a fresh run starting */
    private wasWorking;
    /** Latest background-progress fraction (0-1) per in-flight individual index */
    private inFlight;
    /** Last fraction we logged per individual, so the log only gets an entry every PROGRESS_LOG_STEP */
    private lastLoggedProgress;
    private initialized;
    constructor(options: NestingConsoleOptions);
    /**
     * Reset counters and log for a fresh nesting run
     */
    private resetCounters;
    /**
     * Drive the shared progress bar from completed/populationSize, plus the fractional
     * progress of whatever's still in flight - otherwise the bar (and the "nothing is
     * happening" impression) sits frozen for the entire NFP-calculation phase of an
     * individual, since background-response only fires once that individual is fully done.
     */
    private updateProgressBar;
    /**
     * Handle a background-progress update for one individual. Surfaces which phase
     * (NFP calculation vs. placement) is running and how far it's gotten, throttled so
     * a long NFP pass (thousands of pair computations) doesn't flood the log.
     */
    private handleProgress;
    /**
     * Refresh the stat tiles - called once per tick
     */
    private renderStats;
    /**
     * Append one log entry, trimming the oldest past MAX_LOG_ENTRIES
     */
    private appendLogEntry;
    /**
     * Runs once per TICK_MS: detects a fresh run and refreshes stat tiles
     */
    private tick;
    /**
     * Bind toggle button and IPC listeners
     */
    private bindEventHandlers;
    /**
     * Initialize the nesting console: bind handlers and start the stats tick
     */
    initialize(): void;
    /**
     * Create and return a new NestingConsoleService instance
     */
    static create(options: NestingConsoleOptions): NestingConsoleService;
}
/**
 * Factory function to create a nesting console service
 */
export declare function createNestingConsoleService(options: NestingConsoleOptions): NestingConsoleService;
export {};
