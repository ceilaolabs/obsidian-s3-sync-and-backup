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
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(request.headers)) {
            if (value !== undefined) {
                headers[key] = value;
            }
        }

        // Build request body
        let body: ArrayBuffer | string | undefined;
        if (request.body) {
            if (request.body instanceof Uint8Array) {
                body = request.body.buffer.slice(
                    request.body.byteOffset,
                    request.body.byteOffset + request.body.byteLength
                );
            } else if (typeof request.body === 'string') {
                body = request.body;
            } else if (request.body instanceof ArrayBuffer) {
                body = request.body;
            }
        }

        // Build Obsidian request params
        const requestParams: RequestUrlParam = {
            url,
            method: request.method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS',
            headers,
            body,
            throw: false, // Don't throw on HTTP errors
        };

        try {
            const obsidianResponse = await requestUrl(requestParams);

            // Convert response headers
            const responseHeaders: Record<string, string> = {};
            for (const [key, value] of Object.entries(obsidianResponse.headers)) {
                responseHeaders[key.toLowerCase()] = value;
            }

            // Create HttpResponse
            const response = new HttpResponse({
                statusCode: obsidianResponse.status,
                headers: responseHeaders,
                body: new Uint8Array(obsidianResponse.arrayBuffer),
            });

            return { response };
        } catch (error) {
            // Handle network errors
            const message = error instanceof Error ? error.message : 'Network request failed';
            throw new Error(`Request failed: ${message}`);
        }
    }

    /**
     * Build full URL from HttpRequest
     */
    private buildUrl(request: HttpRequest): string {
        const protocol = request.protocol || 'https:';
        const hostname = request.hostname;
        const port = request.port;
        const path = request.path || '/';
        const query = request.query;

        let url = `${protocol}//${hostname}`;

        if (port && port !== 80 && port !== 443) {
            url += `:${port}`;
        }

        url += path;

        // Add query string
        if (query && Object.keys(query).length > 0) {
            const queryParams = new URLSearchParams();
            for (const [key, value] of Object.entries(query)) {
                if (Array.isArray(value)) {
                    for (const v of value) {
                        if (v !== null) {
                            queryParams.append(key, v);
                        }
                    }
                } else if (value !== undefined && value !== null) {
                    queryParams.append(key, value);
                }
            }
            const queryString = queryParams.toString();
            if (queryString) {
                url += `?${queryString}`;
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
