/**
 * Unit tests for the in-repo setImmediate shim used at build time to replace
 * the upstream `setimmediate` and `immediate` polyfill packages.
 *
 * Two behaviours under test:
 *  - The CommonJS export shape: `module.exports` must be the callable shim
 *    itself, with `default` and `clearImmediate` as properties.  This is what
 *    keeps `lie`'s `var immediate = require('immediate'); immediate(fn)`
 *    contract intact if jszip's fallback Promise path ever activates.
 *  - The global side-effect contract: the shim installs
 *    `globalThis.setImmediate` / `globalThis.clearImmediate` if and only if a
 *    native implementation is absent.
 */

type ShimCallback = (...args: unknown[]) => void;
type ShimHandle = ReturnType<typeof setTimeout>;
type ImmediateShim = ((callback: ShimCallback, ...args: unknown[]) => ShimHandle) & {
	default: ImmediateShim;
	clearImmediate: (handle: ShimHandle) => void;
};

function loadShim(): ImmediateShim {
	let shim!: ImmediateShim;
	jest.isolateModules(() => {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		shim = require('../../src/shims/setimmediate.cjs') as ImmediateShim;
	});
	return shim;
}

describe('setimmediate shim — CommonJS callable export', () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it('exports a directly callable function (module.exports = fn)', () => {
		const shim = loadShim();
		expect(typeof shim).toBe('function');
	});

	it('also exposes itself as `.default` for ESM-style imports', () => {
		const shim = loadShim();
		expect(shim.default).toBe(shim);
	});

	it('schedules the callback asynchronously via setTimeout', () => {
		const shim = loadShim();
		const callback = jest.fn();

		shim(callback);

		expect(callback).not.toHaveBeenCalled();
		jest.advanceTimersByTime(0);
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it('forwards trailing arguments to the callback', () => {
		const shim = loadShim();
		const callback = jest.fn();

		shim(callback, 1, 'two', true);
		jest.advanceTimersByTime(0);

		expect(callback).toHaveBeenCalledWith(1, 'two', true);
	});

	it('throws a TypeError when callback is not a function (matches Node semantics)', () => {
		const shim = loadShim();
		// @ts-expect-error: intentional invalid argument
		expect(() => shim('not a function')).toThrow(TypeError);
	});

	it('clearImmediate cancels a pending callback', () => {
		const shim = loadShim();
		const callback = jest.fn();

		const handle = shim(callback);
		shim.clearImmediate(handle);
		jest.advanceTimersByTime(0);

		expect(callback).not.toHaveBeenCalled();
	});
});

describe('setimmediate shim — global side effects', () => {
	type GlobalsWithImmediate = {
		setImmediate?: unknown;
		clearImmediate?: unknown;
	};
	const globalScope = globalThis as GlobalsWithImmediate;

	let originalSetImmediate: unknown;
	let originalClearImmediate: unknown;

	beforeEach(() => {
		originalSetImmediate = globalScope.setImmediate;
		originalClearImmediate = globalScope.clearImmediate;
	});

	afterEach(() => {
		globalScope.setImmediate = originalSetImmediate;
		globalScope.clearImmediate = originalClearImmediate;
	});

	it('installs setImmediate on globalThis when absent', () => {
		delete globalScope.setImmediate;
		delete globalScope.clearImmediate;

		loadShim();

		expect(typeof globalScope.setImmediate).toBe('function');
		expect(typeof globalScope.clearImmediate).toBe('function');
	});

	it('does not replace a pre-existing native setImmediate', () => {
		const native = jest.fn();
		globalScope.setImmediate = native;

		loadShim();

		expect(globalScope.setImmediate).toBe(native);
	});

	it('does not replace a pre-existing native clearImmediate', () => {
		const native = jest.fn();
		globalScope.clearImmediate = native;

		loadShim();

		expect(globalScope.clearImmediate).toBe(native);
	});
});
