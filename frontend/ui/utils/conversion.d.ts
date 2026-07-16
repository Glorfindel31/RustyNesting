/**
 * Unit and scale conversion utilities for DeepNest
 * Provides helpers for converting between SVG units, real-world units (inches/mm),
 * and handling scale factor transformations.
 *
 * Key concepts:
 * - Scale is stored internally in units/inch format
 * - When working with mm, scale needs adjustment by the INCHES_TO_MM factor
 * - Conversion factor = scale / 25.4 (for mm) or scale (for inches)
 */
import type { UnitType } from "../types/index.js";
/**
 * Conversion factor from inches to millimeters
 */
export declare const INCHES_TO_MM = 25.4;
/**
 * Get the scale value converted to the current unit system for display
 * Scale is stored internally in units/inch, so for mm we divide by 25.4
 *
 * @param scale - The stored scale value (in units/inch)
 * @param units - The current unit system ("mm" or "inch")
 * @returns The scale value in the current unit system
 *
 * @example
 * // If scale is 72 (72 pixels per inch)
 * getScaleInUnits(72, "inch") // returns 72
 * getScaleInUnits(72, "mm")   // returns 2.834... (72 / 25.4)
 */
export declare function getScaleInUnits(scale: number, units: UnitType): number;
/**
 * Convert a scale value from the current unit system to storage format (units/inch)
 *
 * @param value - The scale value in the current unit system
 * @param units - The current unit system ("mm" or "inch")
 * @returns The scale value in units/inch format for storage
 *
 * @example
 * // User enters 2.834 in mm mode
 * setScaleFromUnits(2.834, "mm")   // returns 72 (2.834 * 25.4)
 * setScaleFromUnits(72, "inch")    // returns 72
 */
export declare function setScaleFromUnits(value: number, units: UnitType): number;
/**
 * Get the conversion factor for converting between SVG units and real-world units
 * This is used for converting measurements like spacing, tolerance, etc.
 *
 * @param scale - The stored scale value (in units/inch)
 * @param units - The current unit system ("mm" or "inch")
 * @returns The conversion factor (SVG units per real unit)
 *
 * @example
 * // With scale = 72 (72 pixels per inch)
 * getConversionFactor(72, "inch") // returns 72 (72 SVG units per inch)
 * getConversionFactor(72, "mm")   // returns 2.834... (72/25.4 SVG units per mm)
 */
export declare function getConversionFactor(scale: number, units: UnitType): number;
/**
 * Convert a real-world measurement to SVG units
 *
 * @param value - The measurement in real-world units
 * @param scale - The stored scale value (in units/inch)
 * @param units - The current unit system ("mm" or "inch")
 * @returns The measurement in SVG units
 *
 * @example
 * // Convert 10mm to SVG units with scale = 72
 * toSvgUnits(10, 72, "mm")   // returns 28.34... (10 * 72/25.4)
 * // Convert 1 inch to SVG units with scale = 72
 * toSvgUnits(1, 72, "inch")  // returns 72
 */
export declare function toSvgUnits(value: number, scale: number, units: UnitType): number;
/**
 * Convert an SVG measurement to real-world units
 *
 * @param value - The measurement in SVG units
 * @param scale - The stored scale value (in units/inch)
 * @param units - The current unit system ("mm" or "inch")
 * @returns The measurement in real-world units
 *
 * @example
 * // Convert 72 SVG units to real-world units with scale = 72
 * fromSvgUnits(72, 72, "inch")  // returns 1 (inch)
 * fromSvgUnits(72, 72, "mm")    // returns 25.4 (mm)
 */
export declare function fromSvgUnits(value: number, scale: number, units: UnitType): number;
/**
 * Format a dimension value with unit suffix
 *
 * @param value - The dimension in SVG units
 * @param scale - The stored scale value (in units/inch)
 * @param units - The current unit system ("mm" or "inch")
 * @param precision - Number of decimal places (default: 1)
 * @returns Formatted string like "10.5mm" or "2.3in"
 *
 * @example
 * formatDimension(72, 72, "inch")  // returns "1.0in"
 * formatDimension(72, 72, "mm")    // returns "25.4mm"
 */
export declare function formatDimension(value: number, scale: number, units: UnitType, precision?: number): string;
/**
 * Format a bounding box as a dimension string (width x height)
 *
 * @param width - The width in SVG units
 * @param height - The height in SVG units
 * @param scale - The stored scale value (in units/inch)
 * @param units - The current unit system ("mm" or "inch")
 * @param precision - Number of decimal places (default: 1)
 * @returns Formatted string like "10.5mm x 20.3mm" or "2.3in x 4.5in"
 *
 * @example
 * formatBounds(72, 144, 72, "inch")  // returns "1.0in x 2.0in"
 * formatBounds(72, 144, 72, "mm")    // returns "25.4mm x 50.8mm"
 */
export declare function formatBounds(width: number, height: number, scale: number, units: UnitType, precision?: number): string;
/**
 * Get the unit suffix string for the current unit system
 *
 * @param units - The current unit system ("mm" or "inch")
 * @returns The unit suffix ("mm" or "in")
 */
export declare function getUnitSuffix(units: UnitType): string;
/**
 * Get the export scale factor adjusted for DXF export and units
 *
 * @param scale - The stored scale value (in units/inch)
 * @param units - The current unit system ("mm" or "inch")
 * @param dxfExportScale - Optional DXF export scale factor
 * @returns The adjusted scale factor for export
 *
 * @example
 * // For SVG export in inches with scale = 72
 * getExportScale(72, "inch")           // returns 72
 * // For SVG export in mm with scale = 72
 * getExportScale(72, "mm")             // returns 2.834...
 * // For DXF export with dxfExportScale = 1
 * getExportScale(72, "inch", 1)        // returns 72
 */
export declare function getExportScale(scale: number, units: UnitType, dxfExportScale?: number): number;
/**
 * Convert SVG dimension to export dimension with unit suffix
 *
 * @param svgValue - The dimension in SVG units
 * @param scale - The stored scale value (in units/inch)
 * @param units - The current unit system ("mm" or "inch")
 * @param dxfExportScale - Optional DXF export scale factor
 * @returns The dimension value in real units
 */
export declare function toExportDimension(svgValue: number, scale: number, units: UnitType, dxfExportScale?: number): number;
/**
 * Convert length from SVG units to inches
 * Useful for time calculations (e.g., laser cut time)
 *
 * @param svgLength - The length in SVG units
 * @param scale - The stored scale value (in units/inch)
 * @returns The length in inches
 *
 * @example
 * toInches(72, 72)  // returns 1 (inch)
 * toInches(144, 72) // returns 2 (inches)
 */
export declare function toInches(svgLength: number, scale: number): number;
/**
 * Convert length from inches to SVG units
 *
 * @param inches - The length in inches
 * @param scale - The stored scale value (in units/inch)
 * @returns The length in SVG units
 */
export declare function fromInches(inches: number, scale: number): number;
