/**
 * Obsidian HTTP Handler for AWS SDK v3
 *
 * Custom HTTP handler that uses Obsidian's requestUrl API
 * to bypass CORS restrictions. Implements the Smithy HttpHandler interface.
 */

import { requestUrl, RequestUrlParam } from 'obsidian';
import { HttpRequest, HttpResponse } from '@smithy/protocol-http';
import { HttpHandlerOptions } from '@smithy/types';

/**
 * ObsidianHttpHandler - Uses Obsidian's requestUrl for S3 requests
 *
 * This handler bypasses browser CORS restrictions by using Obsidian's
 * native HTTP request API which operates outside the browser sandbox.
 */
export class ObsidianHttpHandler {
    private requestTimeout: number;

    constructor(options?: { requestTimeout?: number }) {
        this.requestTimeout = options?.requestTimeout ?? 30000;
    }

    /**
     * Handle an HTTP request using Obsidian's requestUrl
     */
    async handle(
        request: HttpRequest,
        _options?: HttpHandlerOptions
    ): Promise<{ response: HttpResponse }> {
        // Build the full URL
        const url = this.buildUrl(request);

        // Convert headers to Record<string, string>
        // Filter out problematic headers that Obsidian handles automatically
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(request.headers)) {
            if (value !== undefined) {
                // Skip headers that can cause issues
                const lowerKey = key.toLowerCase();
                if (lowerKey === 'content-length' || lowerKey === 'host') {
                    continue;
                }
                headers[key] = value;
            }
        }

        // Build Obsidian request params - start with minimal config
        const requestParams: RequestUrlParam = {
            url,
            method: request.method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS',
            headers,
            throw: false, // Don't throw on HTTP errors
        };

        // Add body only if present and not a GET/HEAD request
        if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
            if (request.body instanceof Uint8Array) {
                // Convert Uint8Array to ArrayBuffer
                requestParams.body = request.body.buffer.slice(
                    request.body.byteOffset,
                    request.body.byteOffset + request.body.byteLength
                );
            } else if (typeof request.body === 'string') {
                requestParams.body = request.body;
            } else if (request.body instanceof ArrayBuffer) {
                requestParams.body = request.body;
            }
        }

        try {
            console.debug(`[S3 HTTP] ${request.method} ${url}`);

            const obsidianResponse = await requestUrl(requestParams);

            console.debug(`[S3 HTTP] Response: ${obsidianResponse.status}`);

            // Convert response headers
            const responseHeaders: Record<string, string> = {};
            if (obsidianResponse.headers) {
                for (const [key, value] of Object.entries(obsidianResponse.headers)) {
                    responseHeaders[key.toLowerCase()] = value;
                }
            }

            // Create HttpResponse
            const response = new HttpResponse({
                statusCode: obsidianResponse.status,
                headers: responseHeaders,
                body: new Uint8Array(obsidianResponse.arrayBuffer),
            });

            return { response };
        } catch (error) {
            // Handle network errors with more detail
            console.error('[S3 HTTP] Request error:', error);
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Request failed: ${message}`);
        }
    }

    /**
     * Build full URL from HttpRequest
     */
    private buildUrl(request: HttpRequest): string {
        // Get protocol without trailing colon if present
        let protocol = request.protocol || 'https:';
        if (!protocol.endsWith(':')) {
            protocol += ':';
        }

        const hostname = request.hostname;
        const port = request.port;
        let path = request.path || '/';
        const query = request.query;

        // Ensure path starts with /
        if (!path.startsWith('/')) {
            path = '/' + path;
        }

        let url = `${protocol}//${hostname}`;

        if (port && port !== 80 && port !== 443) {
            url += `:${port}`;
        }

        url += path;

        // Add query string from request.query
        if (query && Object.keys(query).length > 0) {
            const queryParts: string[] = [];
            for (const [key, value] of Object.entries(query)) {
                if (Array.isArray(value)) {
                    for (const v of value) {
                        if (v !== null && v !== undefined) {
                            queryParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
                        }
                    }
                } else if (value !== undefined && value !== null) {
                    queryParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
                }
            }
            if (queryParts.length > 0) {
                // Check if path already has query string
                const separator = url.includes('?') ? '&' : '?';
                url += separator + queryParts.join('&');
            }
        }

        return url;
    }

    /**
     * Required by AWS SDK - update HTTP client configuration
     */
    updateHttpClientConfig(_key: never, _value: never): void {
        // No configuration to update
    }

    /**
     * Required by AWS SDK - return HTTP handler configs
     */
    httpHandlerConfigs(): Record<string, unknown> {
        return {
            requestTimeout: this.requestTimeout,
        };
    }

    /**
     * Cleanup resources
     */
    destroy(): void {
        // Nothing to clean up
    }
}
