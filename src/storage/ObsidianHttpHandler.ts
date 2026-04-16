/**
 * Obsidian HTTP Handler for AWS SDK v3
 *
 * Custom HTTP handler that bridges the AWS SDK v3 Smithy `HttpHandler`
 * interface to Obsidian's `requestUrl` API, bypassing browser CORS
 * restrictions that would otherwise block direct S3 requests.
 *
 * **Why this is needed** — Obsidian plugins run inside an Electron
 * browser context where the standard `fetch()` API is subject to the
 * same CORS policy as any other web page.  S3-compatible endpoints
 * typically do not include the required `Access-Control-Allow-Origin`
 * headers for arbitrary origins.  Obsidian's `requestUrl` operates
 * outside the browser sandbox (via Electron's main process IPC) and is
 * therefore not restricted by CORS.
 *
 * **How it integrates** — `S3Config.buildS3ClientConfig` passes an
 * instance of this class as `requestHandler` in the `S3Client` config.
 * Every HTTP request the SDK would normally issue (sign, send, receive)
 * is routed through `handle()` instead of native `fetch`.
 *
 * **Interface contract** — Implements the Smithy `IHttpHandler` duck-type:
 * `handle()`, `updateHttpClientConfig()`, `httpHandlerConfigs()`, and
 * `destroy()`.  The AWS SDK calls these methods internally; callers of
 * `S3Provider` never interact with this class directly.
 */

import { requestUrl, RequestUrlParam } from 'obsidian';
import { HttpRequest, HttpResponse } from '@smithy/protocol-http';
import { HttpHandlerOptions } from '@smithy/types';

/**
 * AWS SDK v3 `HttpHandler` implementation that routes all S3 requests through
 * Obsidian's `requestUrl` API to sidestep browser CORS restrictions.
 *
 * Used exclusively as the `requestHandler` option in `buildS3ClientConfig`.
 * The AWS SDK calls `handle()` for every outbound HTTP request; the rest of
 * the Smithy interface (`updateHttpClientConfig`, `httpHandlerConfigs`,
 * `destroy`) are stubs required by the interface contract.
 */
export class ObsidianHttpHandler {
    private requestTimeout: number;

    /**
     * Create a new handler instance.
     *
     * @param options - Optional configuration object.
     * @param options.requestTimeout - Milliseconds before a request is
     *   considered timed out. Defaults to `30000` (30 s). This value is
     *   stored and returned by `httpHandlerConfigs()` for the SDK's
     *   awareness; Obsidian's `requestUrl` does not accept a timeout
     *   parameter and enforces its own internal timeout.
     */
    constructor(options?: { requestTimeout?: number }) {
        this.requestTimeout = options?.requestTimeout ?? 30000;
    }

    /**
     * Translate a Smithy `HttpRequest` into an Obsidian `requestUrl` call
     * and wrap the response as a Smithy `HttpResponse`.
     *
     * This is the primary method called by the AWS SDK for every S3 operation.
     * The full URL is assembled by `buildUrl`, the response body is wrapped by
     * `createResponseBody`, and HTTP-level errors (4xx/5xx) are returned as
     * valid responses rather than thrown exceptions — the SDK's own error
     * parser handles status codes.
     *
     * @param request - Smithy HTTP request produced by the AWS SDK middleware.
     * @param _options - SDK handler options (e.g. abortSignal); not used here
     *   because `requestUrl` does not support request cancellation.
     * @returns Wrapped Smithy `HttpResponse` ready for SDK deserialization.
     * @throws {Error} Only on network-level failures (DNS error, connection
     *   refused, etc.) — HTTP error status codes are NOT thrown.
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
                // Obsidian's requestUrl automatically sets Content-Length and
                // Host based on the body and URL respectively. Including them
                // explicitly causes either duplicate headers or AWS signature
                // mismatches because the signed value and the sent value differ.
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
            // `throw: false` instructs Obsidian NOT to throw on HTTP error
            // status codes (4xx/5xx). We return them as normal responses so
            // the AWS SDK's own error parser can inspect the status and body
            // and produce the correct typed error (e.g. NoSuchKey, AccessDenied).
            throw: false,
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

			const responseBody = this.createResponseBody(obsidianResponse.arrayBuffer);

			// Create HttpResponse
			const response = new HttpResponse({
				statusCode: obsidianResponse.status,
				headers: responseHeaders,
				body: responseBody,
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
     * Assemble a full URL string from the components of a Smithy `HttpRequest`.
     *
     * The SDK represents URLs in decomposed form (protocol, hostname, port,
     * path, query map) rather than as a pre-built string.  This method
     * reconstructs the URL, omitting the port when it matches the default
     * for the scheme (80 for HTTP, 443 for HTTPS), and serializes the query
     * map into a properly percent-encoded query string.  Array-valued query
     * parameters are expanded into repeated key=value pairs.
     *
     * @param request - Smithy HTTP request with decomposed URL fields.
     * @returns Fully-qualified URL string ready for `requestUrl`.
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
	 * Wrap an `ArrayBuffer` (from Obsidian's response) into the body type
	 * expected by the AWS SDK v3 browser deserializers.
	 *
	 * The SDK's `GetObject` deserializer accepts either a `Blob` or a
	 * `ReadableStream<Uint8Array>` as the response body, but the browser
	 * checksum middleware (which validates integrity) only accepts
	 * `ReadableStream`.  When `ReadableStream` is available (all modern
	 * browsers and Electron), a single-chunk stream is created.  The `Blob`
	 * fallback is kept for environments where `ReadableStream` is unavailable.
	 *
	 * @param arrayBuffer - Raw response bytes from Obsidian's `requestUrl`.
	 * @returns `ReadableStream<Uint8Array>` when available, `Blob` otherwise.
	 */
	private createResponseBody(arrayBuffer: ArrayBuffer): ReadableStream<Uint8Array> | Blob {
		if (typeof ReadableStream === 'function') {
			const chunk = new Uint8Array(arrayBuffer);
			return new ReadableStream<Uint8Array>({
				start(controller) {
					if (chunk.byteLength > 0) {
						controller.enqueue(chunk);
					}
					controller.close();
				},
			});
		}

		return new Blob([arrayBuffer]);
	}

    /**
     * No-op stub required by the Smithy `IHttpHandler` interface.
     *
     * The AWS SDK calls this method to propagate dynamic configuration updates
     * (e.g. socket keep-alive settings) to the underlying HTTP client.  Because
     * `requestUrl` is a thin wrapper over Electron IPC with no configurable
     * socket layer, there is nothing to update.
     *
     * @param _key - Configuration key (unused).
     * @param _value - Configuration value (unused).
     */
    updateHttpClientConfig(_key: never, _value: never): void {
        // No configuration to update
    }

    /**
     * Return the current handler configuration for the AWS SDK's awareness.
     *
     * The SDK uses the returned map to surface handler settings (e.g.
     * `requestTimeout`) in error messages and telemetry.  Only
     * `requestTimeout` is meaningful here; there are no socket-level
     * settings to report.
     *
     * @returns Map of handler configuration keys and their current values.
     */
    httpHandlerConfigs(): Record<string, unknown> {
        return {
            requestTimeout: this.requestTimeout,
        };
    }

    /**
     * No-op stub satisfying the Smithy `IHttpHandler` interface.
     *
     * A real HTTP client implementation (e.g. Node.js `http.Agent`) would
     * release open sockets here.  `requestUrl` manages its own lifecycle
     * through Electron IPC and does not expose any resources to release.
     */
    destroy(): void {
        // Nothing to clean up
    }
}
