/**
 * Main UI Entry Point
 * Orchestrates initialization of all UI modules for DeepNest
 * This file replaces the monolithic page.js with modular TypeScript components
 */
// Service imports
import { createConfigService, BOOLEAN_CONFIG_KEYS } from "./services/config.service.js";
import { createPresetService } from "./services/preset.service.js";
import { createImportService } from "./services/import.service.js";
import { createExportService } from "./services/export.service.js";
import { createNestingService } from "./services/nesting.service.js";
// Component imports
import { createNavigationService } from "./components/navigation.js";
import { createPartsViewService } from "./components/parts-view.js";
import { createNestViewService } from "./components/nest-view.js";
import { createSheetDialogService } from "./components/sheet-dialog.js";
import { createNestingConsoleService } from "./components/nesting-console.js";
// Utility imports
import { message } from "./utils/ui-helpers.js";
import { getElement, getElements } from "./utils/dom-utils.js";
/**
 * Get the DeepNest global with proper typing
 */
function getDeepNest() {
    return DeepNest;
}
/**
 * Get the SvgParser global with proper typing
 */
function getSvgParser() {
    return SvgParser;
}
/**
 * Execute a callback when the DOM is ready
 * @param fn - The callback function to execute
 */
function ready(fn) {
    if (document.readyState !== "loading") {
        fn();
    }
    else {
        document.addEventListener("DOMContentLoaded", fn);
    }
}
/**
 * Module instances for cross-module communication
 */
let configService;
let presetService;
let importService;
let exportService;
let nestingService;
let navigationService;
let partsViewService;
let nestViewService;
let sheetDialogService;
let nestingConsoleService;
/**
 * Electron and Node.js module references
 */
let ipcRenderer;
let electronRemote;
let fs;
let FormData;
let axios;
let path;
let svgPreProcessor;
/**
 * Resize function for parts list
 * Adjusts the parts table headers when resizing
 */
function resize(event) {
    const parts = getElement("#parts");
    if (event && parts) {
        parts.style.width = event.rect.width + "px";
    }
    const headers = getElements("#parts table th");
    headers.forEach((th) => {
        const span = th.querySelector("span");
        if (span) {
            span.style.width = th.offsetWidth + "px";
        }
    });
}
/**
 * Update the config form UI with current values
 * @param c - The configuration object
 */
function updateForm(c) {
    // Update unit radio buttons
    let unitInput;
    if (c.units === "inch") {
        unitInput = document.querySelector('#configform input[value=inch]');
    }
    else {
        unitInput = document.querySelector('#configform input[value=mm]');
    }
    if (unitInput) {
        unitInput.checked = true;
    }
    // Update unit labels
    const labels = document.querySelectorAll("span.unit-label");
    labels.forEach((l) => {
        l.innerText = c.units;
    });
    // Update scale input
    const scaleInput = document.querySelector("#inputscale");
    if (scaleInput) {
        if (c.units === "inch") {
            scaleInput.value = String(c.scale);
        }
        else {
            // mm
            scaleInput.value = String(c.scale / 25.4);
        }
    }
    // Update all other config inputs
    const inputs = document.querySelectorAll("#config input, #config select");
    inputs.forEach((i) => {
        const inputElement = i;
        const inputId = inputElement.getAttribute("id");
        // Skip preset-related inputs
        if (inputId && ["presetSelect", "presetName"].includes(inputId)) {
            return;
        }
        const key = inputElement.getAttribute("data-config");
        if (!key) {
            return;
        }
        if (key === "units" || key === "scale") {
            return;
        }
        const value = c[key];
        if (inputElement.getAttribute("data-conversion") === "true") {
            const scaleValue = scaleInput ? Number(scaleInput.value) : c.scale;
            inputElement.value = String(value / scaleValue);
        }
        else if (BOOLEAN_CONFIG_KEYS.includes(key)) {
            inputElement.checked = value;
        }
        else if (value !== undefined) {
            inputElement.value = String(value);
        }
    });
}
/**
 * Load presets into the dropdown
 */
async function loadPresetList() {
    const presets = await presetService.loadPresets();
    const presetSelect = getElement("#presetSelect");
    if (!presetSelect) {
        return;
    }
    // Clear dropdown (except first option)
    while (presetSelect.options.length > 1) {
        presetSelect.remove(1);
    }
    // Add presets to dropdown
    for (const name in presets) {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        presetSelect.appendChild(option);
    }
}
/**
 * Initialize preset modal functionality
 */
function initializePresetModal() {
    const savePresetBtn = getElement("#savePresetBtn");
    const loadPresetBtn = getElement("#loadPresetBtn");
    const deletePresetBtn = getElement("#deletePresetBtn");
    const presetSelect = getElement("#presetSelect");
    const presetModal = getElement("#preset-modal");
    const confirmSavePresetBtn = getElement("#confirmSavePreset");
    const presetNameInput = getElement("#presetName");
    if (!presetModal) {
        return;
    }
    const closeModalBtn = presetModal.querySelector(".close");
    // Save preset button click - opens modal
    if (savePresetBtn) {
        savePresetBtn.addEventListener("click", (e) => {
            e.preventDefault();
            if (presetNameInput) {
                presetNameInput.value = "";
            }
            presetModal.style.display = "block";
            document.body.classList.add("modal-open");
            if (presetNameInput) {
                presetNameInput.focus();
            }
        });
    }
    // Close modal when clicking X
    if (closeModalBtn) {
        closeModalBtn.addEventListener("click", (e) => {
            e.preventDefault();
            presetModal.style.display = "none";
            document.body.classList.remove("modal-open");
        });
    }
    // Close modal when clicking outside
    window.addEventListener("click", (event) => {
        if (event.target === presetModal) {
            presetModal.style.display = "none";
            document.body.classList.remove("modal-open");
        }
    });
    // Confirm save preset
    if (confirmSavePresetBtn) {
        confirmSavePresetBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            const name = presetNameInput?.value.trim() || "";
            if (!name) {
                alert("Please enter a preset name");
                return;
            }
            try {
                await presetService.savePreset(name, configService.getSync());
                presetModal.style.display = "none";
                document.body.classList.remove("modal-open");
                await loadPresetList();
                if (presetSelect) {
                    presetSelect.value = name;
                }
                message("Preset saved successfully!");
            }
            catch {
                message("Error saving preset", true);
            }
        });
    }
    // Load preset button click
    if (loadPresetBtn) {
        loadPresetBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            const selectedPreset = presetSelect?.value || "";
            if (!selectedPreset) {
                message("Please select a preset to load");
                return;
            }
            try {
                const presetConfig = await presetService.getPreset(selectedPreset);
                if (presetConfig) {
                    // Preserve user profile
                    const tempAccess = configService.getSync("access_token");
                    const tempId = configService.getSync("id_token");
                    // Apply preset settings
                    configService.setSync(presetConfig);
                    // Restore user profile
                    if (tempAccess !== undefined) {
                        configService.setSync("access_token", tempAccess);
                    }
                    if (tempId !== undefined) {
                        configService.setSync("id_token", tempId);
                    }
                    // Update UI and notify DeepNest
                    const cfgValues = configService.getSync();
                    getDeepNest().config(cfgValues);
                    updateForm(cfgValues);
                    message("Preset loaded successfully!");
                }
                else {
                    message("Selected preset not found", true);
                }
            }
            catch {
                message("Error loading preset", true);
            }
        });
    }
    // Delete preset button click
    if (deletePresetBtn) {
        deletePresetBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            const selectedPreset = presetSelect?.value || "";
            if (!selectedPreset) {
                message("Please select a preset to delete");
                return;
            }
            if (confirm(`Are you sure you want to delete the preset "${selectedPreset}"?`)) {
                try {
                    await presetService.deletePreset(selectedPreset);
                    await loadPresetList();
                    if (presetSelect) {
                        presetSelect.selectedIndex = 0;
                    }
                    message("Preset deleted successfully!");
                }
                catch {
                    message("Error deleting preset", true);
                }
            }
        });
    }
}
/**
 * Initialize config form change handlers
 */
function initializeConfigForm() {
    const inputs = document.querySelectorAll("#config input, #config select");
    inputs.forEach((i) => {
        const inputElement = i;
        const inputId = inputElement.getAttribute("id");
        // Skip preset-related inputs
        if (inputId && ["presetSelect", "presetName"].includes(inputId)) {
            return;
        }
        inputElement.addEventListener("change", () => {
            let val = inputElement.value;
            const key = inputElement.getAttribute("data-config");
            if (!key) {
                return;
            }
            // Handle scale conversion
            if (key === "scale") {
                if (configService.getSync("units") === "mm") {
                    val = Number(val) * 25.4; // Store scale config in inches
                }
            }
            // Handle boolean inputs (checkboxes)
            if (BOOLEAN_CONFIG_KEYS.includes(key)) {
                val = inputElement.checked;
            }
            // Handle unit conversion
            if (inputElement.getAttribute("data-conversion") === "true") {
                let conversion = configService.getSync("scale");
                if (configService.getSync("units") === "mm") {
                    conversion /= 25.4;
                }
                val = Number(val) * conversion;
            }
            // Show spinner during save
            if (inputElement.parentNode) {
                inputElement.parentNode.className = "progress";
            }
            // Update config
            configService.setSync(key, val);
            const cfgValues = configService.getSync();
            getDeepNest().config(cfgValues);
            updateForm(cfgValues);
            // Remove spinner
            if (inputElement.parentNode) {
                inputElement.parentNode.className = "";
            }
            // Update unit-related Ractive bindings
            if (key === "units" && partsViewService) {
                partsViewService.updateUnits();
            }
        });
        // Config explanation hover handlers
        inputElement.onmouseover = () => {
            const configKey = inputElement.getAttribute("data-config");
            if (configKey) {
                document.querySelectorAll(".config_explain").forEach((el) => {
                    el.className = "config_explain";
                });
                const selected = document.querySelector("#explain_" + configKey);
                if (selected) {
                    selected.className = "config_explain active";
                }
            }
        };
        inputElement.onmouseleave = () => {
            document.querySelectorAll(".config_explain").forEach((el) => {
                el.className = "config_explain";
            });
        };
    });
    // Reset to defaults button
    const setDefaultBtn = getElement("#setdefault");
    if (setDefaultBtn) {
        setDefaultBtn.onclick = (e) => {
            e.preventDefault();
            // Preserve user profile
            const tempAccess = configService.getSync("access_token");
            const tempId = configService.getSync("id_token");
            configService.resetToDefaultsSync();
            // Restore user profile
            if (tempAccess !== undefined) {
                configService.setSync("access_token", tempAccess);
            }
            if (tempId !== undefined) {
                configService.setSync("id_token", tempId);
            }
            const cfgValues = configService.getSync();
            getDeepNest().config(cfgValues);
            updateForm(cfgValues);
            return false;
        };
    }
    // Add spinner elements to each form dd
    const ddElements = document.querySelectorAll("#configform dd");
    ddElements.forEach((d) => {
        const spinner = document.createElement("div");
        spinner.className = "spinner";
        d.appendChild(spinner);
    });
}
/**
 * Initialize drag/drop prevention
 */
function initializeDragDropPrevention() {
    document.ondragover = document.ondrop = (ev) => {
        ev.preventDefault();
    };
    document.body.ondrop = (ev) => {
        ev.preventDefault();
    };
}
/**
 * Initialize message close handler
 */
function initializeMessageClose() {
    const messageClose = getElement("#message a.close");
    if (messageClose) {
        messageClose.onclick = () => {
            const wrapper = getElement("#messagewrapper");
            if (wrapper) {
                wrapper.className = "";
            }
            return false;
        };
    }
}
/**
 * Initialize parts list resize functionality
 */
function initializePartsResize() {
    interact(".parts-drag")
        .resizable({
        preserveAspectRatio: false,
        edges: { left: false, right: true, bottom: false, top: false },
    })
        .on("resizemove", resize);
    window.addEventListener("resize", () => {
        resize();
    });
    // Initial resize
    resize();
}
/**
 * Initialize version info display
 */
function initializeVersionInfo() {
    try {
        const pjson = require("../package.json");
        const versionElement = getElement("#package-version");
        if (versionElement) {
            versionElement.innerText = pjson.version;
        }
    }
    catch {
        // Ignore if package.json is not accessible
    }
}
/**
 * Initialize all services
 */
async function initializeServices() {
    // Create config service and set up window.config
    configService = await createConfigService(ipcRenderer);
    window.config = configService;
    // Create preset service
    presetService = createPresetService(ipcRenderer);
    // Get config values and configure DeepNest
    const cfgValues = configService.getSync();
    getDeepNest().config(cfgValues);
    updateForm(cfgValues);
}
/**
 * Initialize all components
 */
function initializeComponents() {
    // Initialize navigation with dark mode
    navigationService = createNavigationService({ resizeCallback: resize });
    navigationService.initialize();
    // Initialize parts view
    partsViewService = createPartsViewService({
        deepNest: getDeepNest(),
        config: configService,
        dialog: electronRemote.dialog,
        resizeCallback: resize,
    });
    partsViewService.initialize();
    // Initialize nest view
    nestViewService = createNestViewService({
        deepNest: getDeepNest(),
        config: configService,
    });
    nestViewService.initialize();
    // Set window.nest reference for backward compatibility
    window.nest = nestViewService.getRactive();
    // Initialize sheet dialog
    sheetDialogService = createSheetDialogService({
        deepNest: getDeepNest(),
        config: configService,
        // Use updatePartsCallback instead of ractive to avoid type conflicts
        updatePartsCallback: () => partsViewService.update(),
        resizeCallback: resize,
    });
    sheetDialogService.initialize();
    // Initialize nesting console (live throughput stats + error log)
    nestingConsoleService = createNestingConsoleService({
        deepNest: getDeepNest(),
        config: configService,
        ipcRenderer,
    });
    nestingConsoleService.initialize();
    // Initialize import service
    importService = createImportService({
        dialog: electronRemote.dialog,
        remote: electronRemote,
        fs: fs,
        path: path,
        httpClient: axios.default,
        FormData: FormData,
        svgPreProcessor: svgPreProcessor,
        config: configService,
        deepNest: getDeepNest(),
        ractive: partsViewService.getRactive(),
        attachSortCallback: () => partsViewService.attachSort(),
        applyZoomCallback: () => partsViewService.applyZoom(),
        resizeCallback: resize,
    });
    // Initialize export service
    exportService = createExportService({
        dialog: electronRemote.dialog,
        remote: electronRemote,
        fs: fs,
        httpClient: axios.default,
        FormData: FormData,
        config: configService,
        deepNest: getDeepNest(),
        svgParser: getSvgParser(),
        // Note: exportButton set separately after initialization via setExportButton
    });
    // Set export button after creation - HTMLElement already has className
    const exportButton = getElement("#export");
    if (exportButton) {
        // Cast is safe: HTMLElement has className property which is what ExportButtonElement adds
        exportService.setExportButton(exportButton);
    }
    // Initialize nesting service
    nestingService = createNestingService({
        fs: fs,
        ipcRenderer: ipcRenderer,
        deepNest: getDeepNest(),
        // Note: nestRactive set separately to avoid type conflicts
        displayNestFn: nestViewService.getDisplayNestCallback(),
        saveJsonFn: () => exportService.exportToJson(),
        saveRecoveryFn: (nest) => exportService.saveRecoveryFile(nest),
        updatePartsCallback: () => partsViewService.update(),
    });
    // Set nestRactive separately to avoid type conflicts
    const nestRactive = nestViewService.getRactive();
    if (nestRactive) {
        nestingService.setNestRactive(nestRactive);
    }
    nestingService.bindEventHandlers();
}
/**
 * Initialize import button handler
 */
function initializeImportButton() {
    const importButton = getElement("#import");
    if (importButton) {
        importButton.onclick = async () => {
            if (importButton.className.includes("disabled") || importButton.className.includes("spinner")) {
                return false;
            }
            importButton.className = "button import disabled";
            try {
                importButton.className = "button import spinner";
                await importService.showImportDialog();
            }
            finally {
                importButton.className = "button import";
            }
            return false;
        };
    }
}
/**
 * Initialize export button handlers
 */
function initializeExportButtons() {
    // JSON export
    const exportJsonBtn = getElement("#exportjson");
    if (exportJsonBtn) {
        exportJsonBtn.onclick = () => {
            exportService.exportToJson();
            return false;
        };
    }
    // SVG export
    const exportSvgBtn = getElement("#exportsvg");
    if (exportSvgBtn) {
        exportSvgBtn.onclick = () => {
            exportService.exportToSvg();
            return false;
        };
    }
    // DXF export
    const exportDxfBtn = getElement("#exportdxf");
    if (exportDxfBtn) {
        exportDxfBtn.onclick = async () => {
            await exportService.exportToDxf();
            return false;
        };
    }
}
/**
 * Load initial SVG files from nest directory
 */
async function loadInitialFiles() {
    await importService.loadNestDirectoryFiles();
}
/**
 * Main initialization function
 * Called when the DOM is ready
 */
async function initialize() {
    // Load required Electron and Node.js modules
    const electron = require("electron");
    ipcRenderer = electron.ipcRenderer;
    electronRemote = require("@electron/remote");
    fs = require("graceful-fs");
    FormData = require("form-data");
    axios = require("axios");
    path = require("path");
    svgPreProcessor = require("@deepnest/svg-preprocessor");
    // Disable Ractive debug mode
    Ractive.DEBUG = false;
    // Initialize services first
    await initializeServices();
    // Initialize preset list
    await loadPresetList();
    // Initialize UI components
    initializeComponents();
    // Offer to export any unsaved result left behind by a crash/unexpected shutdown
    await exportService.checkForRecovery();
    // Initialize UI handlers
    initializePresetModal();
    initializeConfigForm();
    initializeDragDropPrevention();
    initializeMessageClose();
    initializePartsResize();
    initializeVersionInfo();
    initializeImportButton();
    initializeExportButtons();
    // Load initial files from nest directory
    await loadInitialFiles();
    // Set up loginWindow reference
    window.loginWindow = null;
}
// Start initialization when DOM is ready
ready(initialize);
/**
 * Export service instances for external access if needed
 */
export { configService, presetService, importService, exportService, nestingService, navigationService, partsViewService, nestViewService, sheetDialogService, };
//# sourceMappingURL=index.js.map