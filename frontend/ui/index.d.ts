/**
 * Main UI Entry Point
 * Orchestrates initialization of all UI modules for DeepNest
 * This file replaces the monolithic page.js with modular TypeScript components
 */
import { ConfigService } from "./services/config.service.js";
import { PresetService } from "./services/preset.service.js";
import { ImportService } from "./services/import.service.js";
import { ExportService } from "./services/export.service.js";
import { NestingService } from "./services/nesting.service.js";
import { NavigationService } from "./components/navigation.js";
import { PartsViewService } from "./components/parts-view.js";
import { NestViewService } from "./components/nest-view.js";
import { SheetDialogService } from "./components/sheet-dialog.js";
/**
 * Module instances for cross-module communication
 */
declare let configService: ConfigService;
declare let presetService: PresetService;
declare let importService: ImportService;
declare let exportService: ExportService;
declare let nestingService: NestingService;
declare let navigationService: NavigationService;
declare let partsViewService: PartsViewService;
declare let nestViewService: NestViewService;
declare let sheetDialogService: SheetDialogService;
/**
 * Export service instances for external access if needed
 */
export { configService, presetService, importService, exportService, nestingService, navigationService, partsViewService, nestViewService, sheetDialogService, };
