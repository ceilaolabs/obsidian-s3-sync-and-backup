/**
 * Setup fake-indexeddb for E2E tests.
 *
 * SyncJournal uses the `idb` library which expects IndexedDB to be available.
 * In Node.js test environment, we polyfill it with fake-indexeddb.
 */

import 'fake-indexeddb/auto';
