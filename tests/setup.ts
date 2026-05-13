/**
 * Jest setup file
 * Provides global polyfills needed for tests
 */

import { TextEncoder, TextDecoder } from 'util';
import crypto from 'crypto';

// Polyfill TextEncoder/TextDecoder for Node.js environment
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder as typeof global.TextDecoder;

// Polyfill crypto for Node.js tests
// This is needed for tweetnacl which uses crypto.getRandomValues
Object.defineProperty(global, 'crypto', {
    value: {
        getRandomValues: (arr: Uint8Array) => crypto.randomFillSync(arr),
    },
});

// Polyfill `window` so `window.setTimeout` etc. resolve in the Node test
// environment. Obsidian's lint rules require `window.setTimeout` in source
// code (popout-window compatibility); production code runs in the renderer
// where `window` is real, but Jest's `node` environment has no `window`
// unless a test sets one up itself. Aliasing it to `globalThis` is enough
// for the timer/event-loop APIs the source code reaches for.
if (typeof (global as { window?: unknown }).window === 'undefined') {
    (global as { window: typeof globalThis }).window = globalThis;
}

// Polyfill `activeDocument`. Obsidian exposes this global to make code work
// across the main window and popout windows; in the renderer it points at
// whichever document currently has focus. In tests we proxy it to the
// current `document` so existing per-test `document` mocks (see
// BackupDownloader.test.ts) automatically satisfy `activeDocument` reads.
Object.defineProperty(global, 'activeDocument', {
    configurable: true,
    get: () => (global as { document?: Document }).document,
});
