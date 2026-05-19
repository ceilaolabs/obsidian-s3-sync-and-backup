/**
 * Build-time replacement for the upstream `setimmediate` npm package.
 *
 * The original polyfill exists to support pre-IE10 browsers and bundles a
 * `document.createElement("script")` + `onreadystatechange` fast path along
 * with a Function-constructor fallback.  Both trigger Obsidian plugin-store
 * scorecard flags (dynamic script creation, dynamic code execution) and
 * neither is reachable in Obsidian's modern Chromium/Electron runtime where
 * `setTimeout(fn, 0)` is functionally equivalent for the only consumer in
 * our dependency tree (jszip's chunk scheduler).
 *
 * The upstream package is a side-effect-only module that installs
 * `globalThis.setImmediate` / `globalThis.clearImmediate` on first require.
 * We replicate that contract here so any code that resolves
 * `globalThis.setImmediate` (rather than importing it directly) keeps working.
 * The native Node implementations are preferred when already present so this
 * shim never replaces a faster runtime-provided one.
 */

type ImmediateCallback = (...args: unknown[]) => void;
type ImmediateHandle = ReturnType<typeof setTimeout>;

function setImmediateShim(callback: ImmediateCallback, ...args: unknown[]): ImmediateHandle {
	return setTimeout(callback, 0, ...args);
}

function clearImmediateShim(handle: ImmediateHandle): void {
	clearTimeout(handle);
}

interface ImmediateGlobals {
	setImmediate?: typeof setImmediateShim;
	clearImmediate?: typeof clearImmediateShim;
}

// Cast via `unknown` because the lib types declare `globalThis.setImmediate`
// returning a Node `Immediate` handle, which is incompatible with our
// setTimeout-based handle type.  Functionally equivalent at runtime.
const globalScope = globalThis as unknown as ImmediateGlobals;

if (typeof globalScope.setImmediate !== 'function') {
	globalScope.setImmediate = setImmediateShim;
}

if (typeof globalScope.clearImmediate !== 'function') {
	globalScope.clearImmediate = clearImmediateShim;
}

export default setImmediateShim;
export { clearImmediateShim as clearImmediate };
