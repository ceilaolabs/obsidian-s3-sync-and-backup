/**
 * Build-time replacement for the upstream `setimmediate@1.0.5` (jszip's direct
 * dependency) and `immediate@3.0.6` (jszip → lie → immediate) polyfill packages.
 *
 * Both upstream polyfills target pre-IE10 browsers and bundle a
 * `document.createElement("script")` + `onreadystatechange` fast path along with
 * a Function-constructor fallback.  Both trigger Obsidian plugin-store
 * scorecard flags (dynamic script creation, dynamic code execution) and neither
 * is reachable in Obsidian's modern Chromium/Electron runtime.
 *
 * ## Why CommonJS and not TypeScript
 *
 * The `immediate` package's consumer (`lie`) does `var immediate =
 * require('immediate'); immediate(fn)`, expecting the module export to be
 * directly callable.  A TypeScript `export default` would be emitted by esbuild
 * as a namespace object (`{ default: fn, __esModule: true }`), which is not
 * callable and would crash at runtime if `lie` ever ran (currently dead code on
 * Electron because `jszip/lib/external.js` prefers native `Promise`).  Writing
 * the shim as a CommonJS module with `module.exports = fn` makes
 * `require("immediate")` resolve to the callable directly, matching the upstream
 * contract.
 *
 * ## Practical effect on Obsidian desktop
 *
 * Obsidian's Electron runtime provides a native `setImmediate` on globalThis,
 * so the global-install guards below short-circuit and the shim's setTimeout
 * code path never runs.  The scorecard win is therefore build-time: by
 * replacing the polyfill imports, the IE-era script-injection and
 * Function-constructor patterns never enter `main.js` at all.  The shim's
 * runtime behaviour matters only as a safe fallback in environments where
 * native `setImmediate` is absent.
 */

'use strict';

/**
 * Schedule `callback` to run on the next event loop tick.
 *
 * Drop-in for `setImmediate(...)`.  Forwards trailing arguments to the
 * callback the same way the native API does (via the underlying setTimeout).
 *
 * @param {(...args: unknown[]) => void} callback - Function to invoke asynchronously.
 * @param {...unknown} args - Additional arguments forwarded to `callback`.
 * @returns {ReturnType<typeof setTimeout>} Handle suitable for `clearImmediate`.
 * @throws {TypeError} When `callback` is not a function (matches Node's setImmediate semantics).
 */
function immediateShim(callback, ...args) {
	if (typeof callback !== 'function') {
		throw new TypeError('setImmediate callback must be a function');
	}
	return setTimeout(callback, 0, ...args);
}

/**
 * Cancel a callback previously scheduled with {@link immediateShim}.
 *
 * @param {ReturnType<typeof setTimeout>} handle - The handle returned by `immediateShim`.
 * @returns {void}
 */
function clearImmediateShim(handle) {
	clearTimeout(handle);
}

// Install on the global scope to match the upstream `setimmediate` side-effect
// contract (it patches `globalThis.setImmediate` / `globalThis.clearImmediate`
// on first require).  Native implementations are preferred when already
// present so this shim never replaces a faster runtime-provided one.
if (typeof globalThis.setImmediate !== 'function') {
	globalThis.setImmediate = immediateShim;
}
if (typeof globalThis.clearImmediate !== 'function') {
	globalThis.clearImmediate = clearImmediateShim;
}

// Exporting the function directly (not wrapping it in a namespace) is what
// keeps `require("immediate")` callable for any consumer that re-introduces
// the dependency in future builds.
module.exports = immediateShim;
module.exports.default = immediateShim;
module.exports.clearImmediate = clearImmediateShim;
