/**
 * UI helper functions for DeepNest
 * Provides message display, function throttling, and time formatting utilities
 */
import type { ThrottleOptions } from "../types/index.js";
/**
 * Display a message in the UI message box with optional error styling
 * @param txt - The message text to display (can include HTML)
 * @param error - If true, applies error styling
 */
export declare function message(txt: string, error?: boolean): void;
/**
 * Throttle a function to limit how often it can be called
 * Based on Underscore.js throttle implementation
 *
 * @param func - The function to throttle
 * @param wait - Minimum time in milliseconds between calls
 * @param options - Configuration options
 * @param options.leading - If false, disable firing on leading edge (default: true)
 * @param options.trailing - If false, disable firing on trailing edge (default: true)
 * @returns A throttled version of the function
 */
export declare function throttle<T extends (...args: unknown[]) => unknown>(func: T, wait: number, options?: ThrottleOptions): (...args: Parameters<T>) => ReturnType<T> | undefined;
/**
 * Convert milliseconds to a human-readable time string
 * Returns the largest relevant time unit (years, days, hours, minutes, or seconds)
 *
 * @param milliseconds - The duration in milliseconds
 * @returns A human-readable string like "5 hours" or "30 seconds"
 */
export declare function millisecondsToStr(milliseconds: number): string;
