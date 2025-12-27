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
