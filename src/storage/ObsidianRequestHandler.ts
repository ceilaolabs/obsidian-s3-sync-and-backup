/**
 * Obsidian Request Handler for AWS SDK
 *
 * Custom fetch handler that uses Obsidian's requestUrl API
 * to bypass CORS restrictions in the browser.
 */

import { requestUrl, RequestUrlParam, RequestUrlResponse } from 'obsidian';

/**
 * Custom fetch function that uses Obsidian's requestUrl
 * This bypasses CORS restrictions that block browser fetch
 */
export async function obsidianFetch(
    input: RequestInfo | URL,
    init?: RequestInit
): Promise<Response> {
    const url = typeof input === 'string' ? input : input.toString();

    // Build headers object
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
        throw: false, // Don't throw on HTTP errors, return them
    };

    // Handle body
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
            // For other body types, convert to string
            requestParams.body = String(init.body);
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
        throw new TypeError(`Network request failed: ${error}`);
    }
}

/**
 * Get HTTP status text for a status code
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
