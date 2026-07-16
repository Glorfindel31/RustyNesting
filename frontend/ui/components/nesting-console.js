/**
 * Nesting Console Component
 * Live throughput stats (placements/sec, generation, best fitness) and an
 * error/warning log for the running nest. Derives placements/sec from
 * background-response traffic that already flows into this renderer
 * (deepnest.js's eventEmitter *is* ipcRenderer - see main/index.html), and
 * listens on background-log for failures relayed from background windows.
 */
import { IPC_CHANNELS } from "../types/index.js";
import { getElement, addClass, removeClass } from "../utils/dom-utils.js";
/**
 * DOM element selectors used by the nesting console
 */
const SELECTORS = {
    PANEL: "#nestconsole",
    TOGGLE_BTN: "#toggleconsole",
    PROGRESS_BAR: "#progressbar",
    RATE_STAT: "#console-rate",
    GEN_STAT: "#console-gen",
    FITNESS_STAT: "#console-fitness",
    THREADS_STAT: "#console-threads",
    LOG_LIST: "#nestlog",
};
/**
 * CSS classes used by the nesting console
 */
const CSS_CLASSES = {
    ACTIVE: "active",
    LOG_ERROR: "log-error",
    LOG_WARN: "log-warn",
    LOG_INFO: "log-info",
};
/** background-progress reports 0-0.5 for NFP calculation, 0.5-1 for placement (see background.js) */
const NFP_PHASE_WEIGHT = 0.5;
/** Only log a phase update once progress moves at least this far, to avoid flooding the log */
const PROGRESS_LOG_STEP = 0.1;
// ponytail: fixed cap, trim oldest entries - no virtualization needed at this scale
const MAX_LOG_ENTRIES = 200;
const TICK_MS = 1000;
/**
 * Nesting Console Service
 * Shows live nesting throughput and surfaces errors that were previously silent
 */
export class NestingConsoleService {
    deepNest;
    config;
    ipcRenderer;
    /** Total background-response messages seen since the last reset */
    completedCount = 0;
    /** completedCount snapshot at the previous tick, for the per-second delta */
    lastTickCount = 0;
    /** Tracks deepNest.working across ticks to detect a fresh run starting */
    wasWorking = false;
    /** Latest background-progress fraction (0-1) per in-flight individual index */
    inFlight = new Map();
    /** Last fraction we logged per individual, so the log only gets an entry every PROGRESS_LOG_STEP */
    lastLoggedProgress = new Map();
    initialized = false;
    constructor(options) {
        this.deepNest = options.deepNest;
        this.config = options.config;
        this.ipcRenderer = options.ipcRenderer;
    }
    /**
     * Reset counters and log for a fresh nesting run
     */
    resetCounters() {
        this.completedCount = 0;
        this.lastTickCount = 0;
        this.inFlight.clear();
        this.lastLoggedProgress.clear();
        const logList = getElement(SELECTORS.LOG_LIST);
        if (logList) {
            logList.innerHTML = "";
        }
    }
    /**
     * Drive the shared progress bar from completed/populationSize, plus the fractional
     * progress of whatever's still in flight - otherwise the bar (and the "nothing is
     * happening" impression) sits frozen for the entire NFP-calculation phase of an
     * individual, since background-response only fires once that individual is fully done.
     */
    updateProgressBar() {
        const bar = getElement(SELECTORS.PROGRESS_BAR);
        if (!bar) {
            return;
        }
        const populationSize = this.config.getSync("populationSize") || 1;
        let inFlightTotal = 0;
        for (const fraction of this.inFlight.values()) {
            inFlightTotal += fraction;
        }
        const progress = Math.min((this.completedCount + inFlightTotal) / populationSize, 1);
        const style = `width: ${parseInt(String(progress * 100))}%${progress < 0.01 ? "; transition: none" : ""}`;
        bar.setAttribute("style", style);
    }
    /**
     * Handle a background-progress update for one individual. Surfaces which phase
     * (NFP calculation vs. placement) is running and how far it's gotten, throttled so
     * a long NFP pass (thousands of pair computations) doesn't flood the log.
     */
    handleProgress(payload) {
        if (payload.progress < 0) {
            this.inFlight.delete(payload.index);
            this.lastLoggedProgress.delete(payload.index);
            this.updateProgressBar();
            return;
        }
        this.inFlight.set(payload.index, payload.progress);
        const last = this.lastLoggedProgress.get(payload.index) ?? -1;
        if (payload.progress - last >= PROGRESS_LOG_STEP || last < 0) {
            this.lastLoggedProgress.set(payload.index, payload.progress);
            const inNfpPhase = payload.progress < NFP_PHASE_WEIGHT;
            const phasePercent = inNfpPhase
                ? (payload.progress / NFP_PHASE_WEIGHT) * 100
                : ((payload.progress - NFP_PHASE_WEIGHT) / NFP_PHASE_WEIGHT) * 100;
            const phaseLabel = inNfpPhase ? "computing NFPs" : "placing parts";
            this.appendLogEntry({
                level: "info",
                index: payload.index,
                message: `individual ${payload.index}: ${phaseLabel} (${phasePercent.toFixed(0)}%)`,
            });
        }
        this.updateProgressBar();
    }
    /**
     * Refresh the stat tiles - called once per tick
     */
    renderStats() {
        const rateEl = getElement(SELECTORS.RATE_STAT);
        const genEl = getElement(SELECTORS.GEN_STAT);
        const fitnessEl = getElement(SELECTORS.FITNESS_STAT);
        const threadsEl = getElement(SELECTORS.THREADS_STAT);
        const rate = this.completedCount - this.lastTickCount;
        this.lastTickCount = this.completedCount;
        if (rateEl) {
            rateEl.textContent = String(rate);
        }
        if (genEl) {
            genEl.textContent = String(this.deepNest.generationCount ?? 0);
        }
        if (fitnessEl) {
            const best = this.deepNest.nests[0];
            fitnessEl.textContent = best ? best.fitness.toFixed(0) : "-";
        }
        if (threadsEl) {
            threadsEl.textContent = String(this.config.getSync("threads"));
        }
    }
    /**
     * Append one log entry, trimming the oldest past MAX_LOG_ENTRIES
     */
    appendLogEntry(payload) {
        const logList = getElement(SELECTORS.LOG_LIST);
        if (!logList) {
            return;
        }
        const time = new Date().toLocaleTimeString();
        const entry = document.createElement("li");
        entry.className =
            payload.level === "error" ? CSS_CLASSES.LOG_ERROR :
                payload.level === "warn" ? CSS_CLASSES.LOG_WARN :
                    CSS_CLASSES.LOG_INFO;
        entry.textContent = `[${time}] ${payload.message}`;
        logList.appendChild(entry);
        while (logList.children.length > MAX_LOG_ENTRIES) {
            const first = logList.firstChild;
            if (!first) {
                break;
            }
            logList.removeChild(first);
        }
        logList.scrollTop = logList.scrollHeight;
    }
    /**
     * Runs once per TICK_MS: detects a fresh run and refreshes stat tiles
     */
    tick() {
        if (this.deepNest.working && !this.wasWorking) {
            this.resetCounters();
        }
        this.wasWorking = this.deepNest.working;
        this.renderStats();
    }
    /**
     * Bind toggle button and IPC listeners
     */
    bindEventHandlers() {
        const toggleBtn = getElement(SELECTORS.TOGGLE_BTN);
        const panel = getElement(SELECTORS.PANEL);
        if (toggleBtn && panel) {
            toggleBtn.addEventListener("click", (event) => {
                event.preventDefault();
                if (panel.classList.contains(CSS_CLASSES.ACTIVE)) {
                    removeClass(panel, CSS_CLASSES.ACTIVE);
                }
                else {
                    addClass(panel, CSS_CLASSES.ACTIVE);
                }
            });
        }
        this.ipcRenderer.on(IPC_CHANNELS.BACKGROUND_RESPONSE, (_event, ...args) => {
            this.completedCount++;
            const payload = args[0];
            if (payload && typeof payload.index === "number") {
                this.inFlight.delete(payload.index);
                this.lastLoggedProgress.delete(payload.index);
            }
            this.updateProgressBar();
        });
        this.ipcRenderer.on(IPC_CHANNELS.BACKGROUND_LOG, (_event, ...args) => {
            this.appendLogEntry(args[0]);
        });
        this.ipcRenderer.on(IPC_CHANNELS.BACKGROUND_PROGRESS, (_event, ...args) => {
            this.handleProgress(args[0]);
        });
    }
    /**
     * Initialize the nesting console: bind handlers and start the stats tick
     */
    initialize() {
        if (this.initialized) {
            return;
        }
        this.bindEventHandlers();
        setInterval(() => this.tick(), TICK_MS);
        this.initialized = true;
    }
    /**
     * Create and return a new NestingConsoleService instance
     */
    static create(options) {
        return new NestingConsoleService(options);
    }
}
/**
 * Factory function to create a nesting console service
 */
export function createNestingConsoleService(options) {
    return NestingConsoleService.create(options);
}
//# sourceMappingURL=nesting-console.js.map