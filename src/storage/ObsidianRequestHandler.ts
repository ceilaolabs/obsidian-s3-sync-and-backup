/**
 * Obsidian Request Handler for AWS SDK
 *
 * Alternative CORS bypass adapter that implements the standard `fetch()`
 * function signature instead of the Smithy `HttpHandler` interface used by
 * {@link ObsidianHttpHandler}.
 *
 * **Relationship to ObsidianHttpHandler** — Both modules solve the same
 * problem (CORS restrictions in the Obsidian/Electron runtime) but at
 * different integration points:
 * - `ObsidianHttpHandler` hooks into the AWS SDK v3 Smithy middleware stack
 *   as a first-class `requestHandler`, giving it access to the fully signed
 *   `HttpRequest` object.
 * - `ObsidianRequestHandler` exposes `obsidianFetch`, a drop-in replacement
 *   for the browser's global `fetch()`.  It is kept for compatibility with
 *   code paths or third-party libraries that accept a `fetch` override rather
 *   than a Smithy handler.
 *
 * **Why `requestUrl`** — Obsidian's `requestUrl` API routes requests through
 * Electron's main process, which is not subject to browser CORS policy.  This
 * lets the plugin reach S3-compatible endpoints that do not send the
 * `Access-Control-Allow-Origin` header.
 */

import { requestUrl, RequestUrlParam, RequestUrlResponse } from 'obsidian';

/**
 * Drop-in replacement for the browser's `fetch()` that routes requests
 * through Obsidian's `requestUrl` to bypass CORS restrictions.
 *
 * Accepts all three input forms that the `fetch` spec allows:
 * - `string` — URL passed directly.
 * - `URL` — `.href` is extracted.
 * - `Request` — `.url` is extracted (headers/body in `init` take precedence).
 *
 * **Header conversion** — `RequestInit.headers` can be a `Headers` object,
 * an array of `[key, value]` pairs, or a plain `Record<string, string>`.
 * All three forms are normalised into a flat `Record<string, string>` because
 * that is what `RequestUrlParam.headers` requires.
 *
 * **Body conversion** — Bodies are forwarded as-is when they are already
 * `ArrayBuffer` or `string`.  A `Uint8Array` is sliced into a detached
 * `ArrayBuffer` to avoid sharing the backing buffer.  Any other serializable
 * type falls back to `JSON.stringify`.
 *
 * **Error handling** — HTTP error status codes (4xx/5xx) are returned as
 * normal `Response` objects (`throw: false`), not thrown exceptions.  Only
 * network-level failures (DNS errors, connection refused) throw a
 * `TypeError` matching the `fetch` spec.
 *
 * @param input - Request URL as a `string`, `URL`, or `Request` object.
 * @param init - Standard `RequestInit` options (method, headers, body, etc.).
 * @returns Standard `Response` object, compatible with the AWS SDK's
 *   fetch-based deserializers.
 * @throws {TypeError} On network-level failures (not on HTTP error statuses).
 */
export async function obsidianFetch(
    input: RequestInfo | URL,
    init?: RequestInit
): Promise<Response> {
    let url: string;
    if (typeof input === 'string') {
        url = input;
    } else if (input instanceof URL) {
        url = input.href;
    } else {
        url = input.url;
    }

    // Normalise all three supported header formats into a flat Record.
    // Headers object: iterable key/value pairs.
    // Array: [[key, value], ...] tuples.
    // Plain object: Record<string, string> copied via Object.assign.
    const headers: Record<string, string> = {};
    if (init?.headers) {
        if (init.headers instanceof Headers) {
            init.headers.forEach((value, key) => {
                headers[key] = value;
            });
        } else if (Array.isArray(init.headers)) {
            for (const [key, value] of init.headers) {
                headers[key] = value;
            }
        } else {
            Object.assign(headers, init.headers);
        }
    }

    // Build request params
    const requestParams: RequestUrlParam = {
        url,
        method: (init?.method || 'GET') as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS',
        headers,
        // `throw: false` mirrors the behaviour of the native `fetch()` spec:
        // HTTP error statuses (4xx/5xx) resolve the promise with a Response
        // rather than rejecting it.  The AWS SDK checks `response.ok` / the
        // status code itself to produce typed errors (e.g. NoSuchKey).
        throw: false,
    };

    // Normalise body to the subset of types that requestUrl accepts.
    // ArrayBuffer and string: forwarded as-is.
    // Uint8Array: sliced into a detached ArrayBuffer (avoids shared-buffer
    //   issues if the caller reuses the original buffer after this call).
    // Other types (FormData, URLSearchParams, etc.): JSON-serialised as a
    //   best-effort fallback; the AWS SDK never sends non-JSON structured data.
    if (init?.body) {
        if (init.body instanceof ArrayBuffer) {
            requestParams.body = init.body;
        } else if (init.body instanceof Uint8Array) {
            requestParams.body = init.body.buffer.slice(
                init.body.byteOffset,
                init.body.byteOffset + init.body.byteLength
            );
        } else if (typeof init.body === 'string') {
            requestParams.body = init.body;
        } else {
            // For other body types, convert to string using JSON
            requestParams.body = JSON.stringify(init.body);
        }
    }

    try {
        const response: RequestUrlResponse = await requestUrl(requestParams);

        // Convert Obsidian response to standard Response
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
            responseHeaders.set(key, value);
        }

        // Create a Response object compatible with AWS SDK
        return new Response(response.arrayBuffer, {
            status: response.status,
            statusText: getStatusText(response.status),
            headers: responseHeaders,
        });
    } catch (error) {
        // Network error
        throw new TypeError(`Network request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Map an HTTP status code to its standard reason phrase.
 *
 * Obsidian's `requestUrl` does not return a `statusText` field, but the
 * standard `Response` constructor requires one.  This helper provides a
 * minimal lookup table covering the status codes most commonly returned by
 * S3-compatible APIs.  Unknown codes return an empty string, which is a
 * valid (if unhelpful) `statusText` per the `fetch` spec.
 *
 * @param status - HTTP status code (e.g. `200`, `403`, `404`).
 * @returns Canonical reason phrase string, or `""` for unrecognised codes.
 */
function getStatusText(status: number): string {
    const statusTexts: Record<number, string> = {
        200: 'OK',
        201: 'Created',
        204: 'No Content',
        301: 'Moved Permanently',
        302: 'Found',
        304: 'Not Modified',
        400: 'Bad Request',
        401: 'Unauthorized',
        403: 'Forbidden',
        404: 'Not Found',
        405: 'Method Not Allowed',
        409: 'Conflict',
        500: 'Internal Server Error',
        502: 'Bad Gateway',
        503: 'Service Unavailable',
    };
    return statusTexts[status] || '';
}
