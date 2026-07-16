/**
 * UI helper functions for DeepNest
 * Provides message display, function throttling, and time formatting utilities
 */
/**
 * Display a message in the UI message box with optional error styling
 * @param txt - The message text to display (can include HTML)
 * @param error - If true, applies error styling
 */
export function message(txt, error) {
    const messageElement = document.querySelector("#message");
    const wrapperElement = document.querySelector("#messagewrapper");
    const contentElement = document.querySelector("#messagecontent");
    if (!messageElement || !wrapperElement || !contentElement) {
        return;
    }
    if (error) {
        messageElement.className = "error";
    }
    else {
        messageElement.className = "";
    }
    wrapperElement.className = "active";
    setTimeout(() => {
        messageElement.className += " animated bounce";
    }, 100);
    contentElement.innerHTML = txt;
}
/**
 * Get current timestamp in milliseconds
 */
const _now = Date.now || (() => new Date().getTime());
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
export function throttle(func, wait, options) {
    let context;
    let args = null;
    let result;
    let timeout = null;
    let previous = 0;
    const opts = options || {};
    const later = () => {
        previous = opts.leading === false ? 0 : _now();
        timeout = null;
        result = func.apply(context, args);
        context = null;
        args = null;
    };
    return function (...funcArgs) {
        const now = _now();
        if (!previous && opts.leading === false) {
            previous = now;
        }
        const remaining = wait - (now - previous);
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        context = this;
        args = funcArgs;
        if (remaining <= 0) {
            if (timeout) {
                clearTimeout(timeout);
                timeout = null;
            }
            previous = now;
            result = func.apply(context, args);
            context = null;
            args = null;
        }
        else if (!timeout && opts.trailing !== false) {
            timeout = setTimeout(later, remaining);
        }
        return result;
    };
}
/**
 * Convert milliseconds to a human-readable time string
 * Returns the largest relevant time unit (years, days, hours, minutes, or seconds)
 *
 * @param milliseconds - The duration in milliseconds
 * @returns A human-readable string like "5 hours" or "30 seconds"
 */
export function millisecondsToStr(milliseconds) {
    const numberEnding = (num) => {
        return num > 1 ? "s" : "";
    };
    let temp = Math.floor(milliseconds / 1000);
    const years = Math.floor(temp / 31536000);
    if (years) {
        return years + " year" + numberEnding(years);
    }
    const days = Math.floor((temp %= 31536000) / 86400);
    if (days) {
        return days + " day" + numberEnding(days);
    }
    const hours = Math.floor((temp %= 86400) / 3600);
    if (hours) {
        return hours + " hour" + numberEnding(hours);
    }
    const minutes = Math.floor((temp %= 3600) / 60);
    if (minutes) {
        return minutes + " minute" + numberEnding(minutes);
    }
    const seconds = temp % 60;
    if (seconds) {
        return seconds + " second" + numberEnding(seconds);
    }
    return "0 seconds";
}
//# sourceMappingURL=ui-helpers.js.map