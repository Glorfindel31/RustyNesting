/**
 * DOM manipulation utilities for DeepNest
 * Provides type-safe helpers for common DOM operations including
 * element selection, creation, class manipulation, and SVG handling.
 */
/**
 * SVG namespace URI used for creating SVG elements
 */
export declare const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
/**
 * Execute a callback when the DOM is ready
 * @param callback - Function to execute when DOM is ready
 */
export declare function documentReady(callback: () => void): void;
/**
 * Type-safe querySelector wrapper
 * @param selector - CSS selector string
 * @param parent - Parent element to search within (defaults to document)
 * @returns The matching element or null
 *
 * @example
 * const button = getElement<HTMLButtonElement>('#submit-btn');
 * const nested = getElement<HTMLDivElement>('.child', parentElement);
 */
export declare function getElement<T extends Element = Element>(selector: string, parent?: Document | Element): T | null;
/**
 * Type-safe querySelectorAll wrapper
 * @param selector - CSS selector string
 * @param parent - Parent element to search within (defaults to document)
 * @returns NodeList of matching elements
 *
 * @example
 * const buttons = getElements<HTMLButtonElement>('.btn');
 * buttons.forEach(btn => btn.disabled = true);
 */
export declare function getElements<T extends Element = Element>(selector: string, parent?: Document | Element): NodeListOf<T>;
/**
 * Type-safe getElementById wrapper
 * @param id - Element ID (without # prefix)
 * @returns The matching element or null
 *
 * @example
 * const form = getElementById<HTMLFormElement>('config-form');
 */
export declare function getElementById<T extends HTMLElement = HTMLElement>(id: string): T | null;
/**
 * Create an SVG element with the correct namespace
 * @param tagName - SVG element tag name (e.g., 'svg', 'rect', 'g')
 * @returns The created SVG element
 *
 * @example
 * const svg = createSvgElement('svg');
 * svg.setAttribute('width', '100');
 * const rect = createSvgElement('rect');
 * svg.appendChild(rect);
 */
export declare function createSvgElement<K extends keyof SVGElementTagNameMap>(tagName: K): SVGElementTagNameMap[K];
export declare function createSvgElement(tagName: string): SVGElement;
/**
 * Create an HTML element
 * @param tagName - HTML element tag name
 * @returns The created HTML element
 *
 * @example
 * const div = createHtmlElement('div');
 * div.className = 'container';
 */
export declare function createHtmlElement<K extends keyof HTMLElementTagNameMap>(tagName: K): HTMLElementTagNameMap[K];
/**
 * Add a CSS class to an element
 * @param element - Target element
 * @param className - Class name to add
 *
 * @example
 * addClass(button, 'active');
 */
export declare function addClass(element: Element, className: string): void;
/**
 * Remove a CSS class from an element
 * @param element - Target element
 * @param className - Class name to remove
 *
 * @example
 * removeClass(button, 'active');
 */
export declare function removeClass(element: Element, className: string): void;
/**
 * Toggle a CSS class on an element
 * @param element - Target element
 * @param className - Class name to toggle
 * @param force - Optional force add (true) or remove (false)
 * @returns true if class is now present, false otherwise
 *
 * @example
 * toggleClass(element, 'expanded');
 * toggleClass(element, 'visible', true); // force add
 */
export declare function toggleClass(element: Element, className: string, force?: boolean): boolean;
/**
 * Check if an element has a CSS class
 * @param element - Target element
 * @param className - Class name to check
 * @returns true if element has the class
 *
 * @example
 * if (hasClass(button, 'disabled')) return;
 */
export declare function hasClass(element: Element, className: string): boolean;
/**
 * Set multiple attributes on an element at once
 * @param element - Target element
 * @param attributes - Object with attribute name-value pairs
 *
 * @example
 * setAttributes(rect, {
 *   x: '0',
 *   y: '0',
 *   width: '100',
 *   height: '100'
 * });
 */
export declare function setAttributes(element: Element, attributes: Record<string, string>): void;
/**
 * Remove an attribute from an element
 * @param element - Target element
 * @param attributeName - Name of attribute to remove
 *
 * @example
 * removeAttribute(element, 'style');
 */
export declare function removeAttribute(element: Element, attributeName: string): void;
/**
 * Get a data attribute value from an element
 * @param element - Target element
 * @param dataKey - Data attribute key (without 'data-' prefix)
 * @returns The attribute value or null if not present
 *
 * @example
 * const configKey = getDataAttribute(input, 'config'); // gets data-config
 */
export declare function getDataAttribute(element: Element, dataKey: string): string | null;
/**
 * Set a data attribute on an element
 * @param element - Target element
 * @param dataKey - Data attribute key (without 'data-' prefix)
 * @param value - Value to set
 *
 * @example
 * setDataAttribute(element, 'index', '5'); // sets data-index="5"
 */
export declare function setDataAttribute(element: Element, dataKey: string, value: string): void;
/**
 * Serialize an SVG element to a string
 * @param svg - SVG element to serialize
 * @returns XML string representation of the SVG
 *
 * @example
 * const svgString = serializeSvg(svgElement);
 * fs.writeFileSync('output.svg', svgString);
 */
export declare function serializeSvg(svg: SVGElement): string;
/**
 * Clear all child nodes from an element
 * @param element - Element to clear
 *
 * @example
 * clearChildren(container);
 */
export declare function clearChildren(element: Element): void;
/**
 * Remove a node from its parent
 * @param node - Node to remove
 * @returns true if the node was removed, false if it had no parent
 *
 * @example
 * removeFromParent(childElement);
 */
export declare function removeFromParent(node: Node): boolean;
/**
 * Clone an SVG element (shallow clone without children events)
 * @param element - SVG element to clone
 * @returns A shallow clone of the element
 *
 * @example
 * const clonedPath = cloneSvgElement(pathElement);
 */
export declare function cloneSvgElement<T extends SVGElement>(element: T): T;
/**
 * Clone an SVG element with all its children (deep clone)
 * @param element - SVG element to clone
 * @returns A deep clone of the element
 *
 * @example
 * const clonedGroup = cloneSvgElementDeep(groupElement);
 */
export declare function cloneSvgElementDeep<T extends SVGElement>(element: T): T;
/**
 * Set the display style of an element
 * @param element - Target element
 * @param visible - Whether to show (true) or hide (false) the element
 * @param displayValue - Display value when visible (default: 'block')
 *
 * @example
 * setVisible(modal, true);
 * setVisible(dropdown, false);
 */
export declare function setVisible(element: HTMLElement, visible: boolean, displayValue?: string): void;
/**
 * Set the style property of an element
 * @param element - Target element
 * @param property - CSS property name (camelCase)
 * @param value - CSS property value
 *
 * @example
 * setStyle(element, 'width', '100px');
 * setStyle(element, 'backgroundColor', '#fff');
 */
export declare function setStyle(element: HTMLElement, property: keyof CSSStyleDeclaration, value: string): void;
/**
 * Set multiple style properties on an element at once
 * @param element - Target element
 * @param styles - Object with CSS property-value pairs
 *
 * @example
 * setStyles(element, {
 *   width: '100px',
 *   height: '50px',
 *   display: 'flex'
 * });
 */
export declare function setStyles(element: HTMLElement, styles: Partial<CSSStyleDeclaration>): void;
/**
 * Add an event listener to an element
 * @param element - Target element
 * @param eventType - Event type (e.g., 'click', 'change')
 * @param handler - Event handler function
 * @param options - Optional event listener options
 *
 * @example
 * addListener(button, 'click', (e) => handleClick(e));
 * addListener(input, 'change', handleChange, { once: true });
 */
export declare function addListener<K extends keyof HTMLElementEventMap>(element: HTMLElement, eventType: K, handler: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions): void;
/**
 * Remove an event listener from an element
 * @param element - Target element
 * @param eventType - Event type
 * @param handler - Event handler function to remove
 *
 * @example
 * removeListener(button, 'click', handleClick);
 */
export declare function removeListener<K extends keyof HTMLElementEventMap>(element: HTMLElement, eventType: K, handler: (event: HTMLElementEventMap[K]) => void): void;
/**
 * Prevent default behavior and stop propagation of an event
 * @param event - Event to prevent
 *
 * @example
 * link.addEventListener('click', (e) => {
 *   preventEvent(e);
 *   // custom handling
 * });
 */
export declare function preventEvent(event: Event): void;
/**
 * Set innerHTML of an element safely
 * Note: Be cautious about XSS when using innerHTML with user input
 * @param element - Target element
 * @param html - HTML string to set
 *
 * @example
 * setInnerHtml(container, '<div class="content">Hello</div>');
 */
export declare function setInnerHtml(element: Element, html: string): void;
/**
 * Set innerText of an element (safe from XSS)
 * @param element - Target element
 * @param text - Text content to set
 *
 * @example
 * setInnerText(label, 'New label text');
 */
export declare function setInnerText(element: HTMLElement, text: string): void;
/**
 * Get the computed style of an element
 * @param element - Target element
 * @param property - CSS property to get
 * @returns The computed style value
 *
 * @example
 * const width = getComputedStyleValue(element, 'width');
 */
export declare function getComputedStyleValue(element: Element, property: string): string;
/**
 * Create an SVG viewBox string from dimensions
 * @param x - X origin
 * @param y - Y origin
 * @param width - ViewBox width
 * @param height - ViewBox height
 * @returns Formatted viewBox string
 *
 * @example
 * svg.setAttribute('viewBox', createViewBox(0, 0, 100, 100));
 */
export declare function createViewBox(x: number, y: number, width: number, height: number): string;
/**
 * Create a transform translate string
 * @param x - X translation
 * @param y - Y translation
 * @returns Formatted translate transform string
 *
 * @example
 * group.setAttribute('transform', createTranslate(50, 100));
 */
export declare function createTranslate(x: number, y: number): string;
/**
 * Create a CSS transform translate/rotate string
 * @param x - X translation in pixels
 * @param y - Y translation in pixels
 * @param rotation - Rotation in degrees (optional)
 * @returns Formatted CSS transform string
 *
 * @example
 * element.style.transform = createCssTransform(100, 50, 45);
 */
export declare function createCssTransform(x: number, y: number, rotation?: number): string;
