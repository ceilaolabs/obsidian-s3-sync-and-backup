/**
 * S3 Provider Module
 *
 * High-level abstraction over the AWS SDK v3 S3 client. This is the single
 * point of contact between the rest of the plugin and S3-compatible storage.
 *
 * Key design choices:
 * - **Lazy client initialization**: The `S3Client` instance is created on the
 *   first operation rather than at construction time, so settings changes
 *   (via `updateSettings`) are picked up without extra housekeeping — just
 *   nullify `this.client` and the next call rebuilds it.
 * - **Obsidian HTTP handler**: Every request is routed through
 *   `ObsidianHttpHandler`, which uses Obsidian's `requestUrl` API.  This
 *   sidesteps browser CORS restrictions that would otherwise block direct
 *   `fetch()` calls to S3 endpoints.
 * - **ETag normalization**: S3 returns ETags wrapped in double-quotes (e.g.
 *   `"abc123"`).  All public methods strip those quotes before returning so
 *   callers always deal with bare hex strings.
 * - **Conditional uploads**: `uploadFile` supports `If-Match` / `If-None-Match`
 *   headers for optimistic concurrency control.  The helper
 *   `toConditionalEntityTag` re-adds the required quotes before forwarding to
 *   the SDK.
 * - **NoSuchKey → null**: Methods that "read" a resource return `null` on 404
 *   (`NoSuchKey` / `NotFound`) rather than throwing, so callers can use simple
 *   null-checks instead of try/catch for the expected-missing case.
 */

import {
    S3Client,
    ListObjectsV2Command,
    GetObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand,
    HeadBucketCommand,
    HeadObjectCommand,
    DeleteObjectsCommand,
    ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';
import { PayloadFormat, S3DownloadResult, S3HeadResult, S3ObjectInfo, S3SyncBackupSettings } from '../types';
import { buildS3ClientConfig, validateConnectionSettings } from './S3Config';

/**
 * S3Provider class
 *
 * High-level wrapper around the AWS SDK v3 `S3Client` that presents a clean,
 * plugin-specific API for every S3 operation the plugin needs.
 *
 * **Lazy client initialization** — `this.client` starts as `null`. The first
 * call to any operation invokes `getClient()`, which builds the `S3Client`
 * from current settings. Calling `updateSettings()` nullifies `this.client`
 * so the next operation transparently rebuilds it with the new config.
 *
 * **ETag handling** — S3 always returns ETags wrapped in double-quotes
 * (e.g. `"d41d8cd98f00b204e9800998ecf8427e"`). All public methods strip
 * those quotes before returning, so callers work with bare hex strings.
 * `toConditionalEntityTag` re-adds quotes when forwarding to conditional
 * headers (`If-Match`, `If-None-Match`).
 *
 * **Conditional upload support** — `uploadFile` accepts optional `ifMatch` /
 * `ifNoneMatch` values enabling optimistic concurrency: the upload succeeds
 * only if the remote object matches (or does not match) the given ETag.
 *
 * **NoSuchKey → null** — Read-style methods (`headObject`, `downloadFileWithMetadata`,
 * `getFileEtag`, `getFileMetadata`, `downloadFileAsTextWithEtag`) return
 * `null` when the key does not exist, rather than throwing. Callers use a
 * simple null-check for the expected-absent case and re-throw for real errors.
 */
export class S3Provider {
    private client: S3Client | null = null;
    private settings: S3SyncBackupSettings;

    /**
     * Create a new S3Provider instance.
     *
     * The underlying `S3Client` is not created here; it is built lazily on
     * the first operation so that construction never throws even if settings
     * are incomplete at the time the plugin loads.
     *
     * @param settings - Full plugin settings. Only the connection-related
     *   fields are used here; sync/backup fields are ignored.
     */
    constructor(settings: S3SyncBackupSettings) {
        this.settings = settings;
    }

    /**
     * Replace the current settings and invalidate the cached S3 client.
     *
     * The next S3 operation after this call will rebuild the client using the
     * new settings, so this is safe to call at any time — even mid-session.
     *
     * @param settings - New plugin settings to apply.
     */
    updateSettings(settings: S3SyncBackupSettings): void {
        this.settings = settings;
        this.client = null; // Force client recreation on next use
    }

    /**
     * Return the cached `S3Client`, building it from current settings on first
     * call or whenever `this.client` has been nullified by `updateSettings`.
     *
     * @returns A ready-to-use `S3Client` configured for the active provider.
     */
    private getClient(): S3Client {
        if (!this.client) {
            const config = buildS3ClientConfig(this.settings);
            this.client = new S3Client(config);
        }
        return this.client;
    }

    /**
     * Test connectivity and permission to the configured S3 bucket.
     *
     * Validates settings locally first, then fires a `HeadBucket` request —
     * the lightest-weight operation that confirms both authentication and
     * bucket existence without reading any data.
     *
     * @returns A human-readable success message (e.g. `"Connected successfully to my-bucket"`).
     * @throws {Error} With a user-friendly message for common failures:
     *   - Configuration validation errors (missing bucket, credentials, etc.)
     *   - 404 → bucket not found
     *   - 403 → access denied / wrong permissions
     *   - InvalidAccessKeyId / SignatureDoesNotMatch → bad credentials
     *   - DNS failure → endpoint unreachable
     *   - Any other AWS SDK error is re-thrown with its original message.
     */
    async testConnection(): Promise<string> {
        // Validate settings first
        const errors = validateConnectionSettings(this.settings);
        if (errors.length > 0) {
            throw new Error(`Configuration errors: ${errors.join(', ')}`);
        }

        try {
            const client = this.getClient();

            // HeadBucket checks if bucket exists and we have access
            await client.send(new HeadBucketCommand({
                Bucket: this.settings.bucket,
            }));

            return `Connected successfully to ${this.settings.bucket}`;
        } catch (error) {
            // Provide user-friendly error messages
            const err = error as Error & { name?: string; $metadata?: { httpStatusCode?: number } };

            if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
                throw new Error(`Bucket "${this.settings.bucket}" not found`);
            }

            if (err.name === 'AccessDenied' || err.$metadata?.httpStatusCode === 403) {
                throw new Error('Access denied. Check your credentials and bucket permissions.');
            }

            if (err.name === 'InvalidAccessKeyId') {
                throw new Error('Invalid Access Key ID');
            }

            if (err.name === 'SignatureDoesNotMatch') {
                throw new Error('Invalid Secret Access Key');
            }

            if (err.message?.includes('ENOTFOUND') || err.message?.includes('getaddrinfo')) {
                throw new Error('Could not reach endpoint. Check your endpoint URL and network connection.');
            }

            // Re-throw with original message for unknown errors
            throw new Error(`Connection failed: ${err.message || 'Unknown error'}`);
        }
    }

    /**
     * List all objects under a key prefix, paginating automatically.
     *
     * Uses `ListObjectsV2` with continuation tokens to handle buckets with
     * more than 1000 objects. The returned array is always fully materialized.
     *
     * @param prefix - S3 key prefix to scope the listing (e.g. `"vault/"`).
     *   Pass an empty string to list the entire bucket.
     * @param recursive - When `true` (default) no delimiter is set, so all
     *   keys at every depth are returned. When `false`, a `/` delimiter is
     *   added so only the immediate "directory" level is returned.
     * @returns Array of {@link S3ObjectInfo} objects. Empty if the prefix
     *   does not exist or contains no keys.
     * @throws {Error} On S3 or network failure.
     */
    async listObjects(prefix: string, recursive = true): Promise<S3ObjectInfo[]> {
        const client = this.getClient();
        const objects: S3ObjectInfo[] = [];

        let continuationToken: string | undefined;

        do {
            const response: ListObjectsV2CommandOutput = await client.send(new ListObjectsV2Command({
                Bucket: this.settings.bucket,
                Prefix: prefix,
                Delimiter: recursive ? undefined : '/',
                ContinuationToken: continuationToken,
            }));

            if (response.Contents) {
                for (const item of response.Contents) {
                    if (item.Key) {
                        objects.push({
                            key: item.Key,
                            size: item.Size || 0,
                            lastModified: item.LastModified || new Date(),
                            etag: item.ETag,
                        });
                    }
                }
            }

            continuationToken = response.NextContinuationToken;
        } while (continuationToken);

        return objects;
    }

    /**
     * Download a file's raw bytes from S3.
     *
     * Delegates body conversion to `bodyToUint8Array`, which handles all
     * response-body forms the AWS SDK can return in the Obsidian runtime.
     *
     * @param key - Full S3 key (e.g. `"vault/Notes/meeting.md"`).
     * @returns File content as a `Uint8Array`.
     * @throws {Error} If the object is missing, the body is empty, or an S3/
     *   network error occurs. Use `downloadFileWithMetadata` for a null-on-404
     *   variant.
     */
    async downloadFile(key: string): Promise<Uint8Array> {
        const client = this.getClient();

        const response = await client.send(new GetObjectCommand({
            Bucket: this.settings.bucket,
            Key: key,
        }));

        if (!response.Body) {
            throw new Error(`Empty response for key: ${key}`);
        }

        return await this.bodyToUint8Array(response.Body, key);
    }

    /**
     * Download file content and all plugin-managed S3 metadata in one request.
     *
     * Preferred over a separate `headObject` + `downloadFile` pair because it
     * eliminates the TOCTOU window between the two calls.
     *
     * @param key - Full S3 key.
     * @returns Combined content + metadata, or `null` if the key does not exist.
     * @throws {Error} On S3/network errors other than 404.
     */
    async downloadFileWithMetadata(key: string): Promise<S3DownloadResult | null> {
        try {
            const client = this.getClient();
            const response = await client.send(new GetObjectCommand({
                Bucket: this.settings.bucket,
                Key: key,
            }));

            if (!response.Body) {
                throw new Error(`Empty response for key: ${key}`);
            }

            const content = await this.bodyToUint8Array(response.Body, key);
            const metadata = this.toS3HeadResult(response);

            return {
                content,
                ...metadata,
            };
        } catch (error) {
            const err = error as Error & { name?: string };
            if (err.name === 'NoSuchKey' || err.name === 'NotFound') {
                return null;
            }
            throw error;
        }
    }

    /**
     * Normalize an AWS SDK response body into a `Uint8Array` regardless of
     * the runtime-specific type the SDK chose.
     *
     * The AWS SDK v3 types `Body` as a union of many possible forms.  In a
     * Node.js environment the body is typically a `Readable` stream; in a
     * browser environment it's a `ReadableStream<Uint8Array>` or `Blob`; in
     * the Obsidian/Electron environment (where the custom HTTP handler
     * intercepts the request and wraps the response) the body arrives as a
     * `ReadableStream<Uint8Array>` produced by `createResponseBody`. The
     * AWS SDK also provides `transformToByteArray()` as a utility method on
     * its blob helper in v3.  All forms are handled here so the rest of the
     * class has a single, consistent interface.
     *
     * @param body - Raw response body as returned by the AWS SDK.
     * @param key - S3 key, used only in the error message for unsupported types.
     * @returns File bytes as a `Uint8Array`.
     * @throws {Error} If the body type is not recognised.
     */
    private async bodyToUint8Array(
        body: unknown,
        key: string
    ): Promise<Uint8Array> {
        const responseBody = body as
            | Uint8Array
            | ArrayBuffer
            | Blob
            | ReadableStream<Uint8Array>
            | { [Symbol.asyncIterator](): AsyncIteratorLike<Uint8Array> }
            | { transformToByteArray?: () => Promise<Uint8Array> }
            | string;
        type ByteArrayTransformable = { transformToByteArray: () => Promise<Uint8Array> };

        if (responseBody instanceof Uint8Array) {
            return responseBody;
        }

        if (responseBody instanceof ArrayBuffer) {
            return new Uint8Array(responseBody);
        }

        if (typeof responseBody === 'string') {
            return new TextEncoder().encode(responseBody);
        }

        if (typeof responseBody === 'object' && responseBody !== null && 'transformToByteArray' in responseBody) {
            const transformableBody = responseBody as ByteArrayTransformable;
            if (typeof transformableBody.transformToByteArray === 'function') {
                return await transformableBody.transformToByteArray();
            }
        }

        if (responseBody instanceof Blob) {
            return new Uint8Array(await responseBody.arrayBuffer());
        }

        const chunks: Uint8Array[] = [];

        if (typeof responseBody === 'object' && responseBody !== null && 'getReader' in responseBody && typeof responseBody.getReader === 'function') {
            const reader = responseBody.getReader();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) chunks.push(value);
            }
        } else if (typeof responseBody === 'object' && responseBody !== null && Symbol.asyncIterator in responseBody) {
            for await (const chunk of responseBody as { [Symbol.asyncIterator](): AsyncIteratorLike<Uint8Array> }) {
                chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
            }
        } else {
            throw new Error(`Unsupported response body type for key: ${key}`);
        }

        const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }

        return result;
    }

    /**
     * Retrieve plugin-managed metadata for an S3 object without downloading
     * its content (uses `HeadObject`).
     *
     * @param key - Full S3 key.
     * @returns Parsed {@link S3HeadResult}, or `null` if the key does not exist.
     * @throws {Error} On S3/network errors other than 404.
     */
    async headObject(key: string): Promise<S3HeadResult | null> {
        try {
            const client = this.getClient();
            const response = await client.send(new HeadObjectCommand({
                Bucket: this.settings.bucket,
                Key: key,
            }));

            return this.toS3HeadResult(response);
        } catch (error) {
            const err = error as Error & { name?: string };
            if (err.name === 'NoSuchKey' || err.name === 'NotFound') {
                return null;
            }
            throw error;
        }
    }

    /**
     * Map a raw AWS SDK `HeadObject` or `GetObject` response into the
     * plugin-specific {@link S3HeadResult} shape.
     *
     * ETag quotes are stripped here (S3 always wraps the value in `"…"`).
     * Custom metadata keys (`obsidian-sync-version`, `obsidian-fingerprint`,
     * `obsidian-mtime`, `obsidian-device-id`) are extracted from the
     * `Metadata` map and parsed where numeric.
     *
     * @param response - Subset of the AWS SDK response containing the fields
     *   this method needs.
     * @returns Normalized {@link S3HeadResult}.
     */
    private toS3HeadResult(response: {
        ETag?: string;
        ContentLength?: number;
        LastModified?: Date;
        Metadata?: Record<string, string>;
    }): S3HeadResult {
        const metadata = response.Metadata ?? {};

        return {
            etag: response.ETag?.replace(/"/g, '') || '',
            size: response.ContentLength || 0,
            lastModified: response.LastModified?.getTime() || 0,
            syncVersion: this.parseMetadataNumber(metadata['obsidian-sync-version']),
            fingerprint: metadata['obsidian-fingerprint'],
            clientMtime: this.parseMetadataNumber(metadata['obsidian-mtime']),
            deviceId: metadata['obsidian-device-id'],
            payloadFormat: this.parsePayloadFormat(metadata['obsidian-payload-format']),
        };
    }

    /**
     * Safely parse a string from S3 object metadata as a base-10 integer.
     *
     * S3 metadata values are always strings; this helper converts them to
     * numbers where the metadata field is expected to hold a numeric value
     * (e.g. `obsidian-mtime`, `obsidian-sync-version`).
     *
     * @param value - Raw metadata string, or `undefined` if the key was absent.
     * @returns Parsed integer, or `undefined` if the input is falsy or `NaN`.
     */
    private parseMetadataNumber(value?: string): number | undefined {
        if (!value) {
            return undefined;
        }

        const parsed = parseInt(value, 10);
        return Number.isNaN(parsed) ? undefined : parsed;
    }

    /**
     * Parse an S3 metadata value as a {@link PayloadFormat}, returning
     * `undefined` for absent or unrecognised values.
     */
    private parsePayloadFormat(value?: string): PayloadFormat | undefined {
        if (value === 'plaintext-v1' || value === 'xsalsa20poly1305-v1') {
            return value;
        }
        return undefined;
    }

    /**
     * Download file as text along with its ETag in a single request.
     * Avoids the TOCTOU race of separate HeadObject + GetObject calls.
     *
     * @param key - Full S3 key.
     * @returns Object with text content and cleaned ETag (quotes stripped), or
     *   `null` if the key does not exist.
     * @throws {Error} On S3/network errors other than 404.
     */
    async downloadFileAsTextWithEtag(key: string): Promise<{ text: string; etag: string | null } | null> {
        try {
            const client = this.getClient();
            const response = await client.send(new GetObjectCommand({
                Bucket: this.settings.bucket,
                Key: key,
            }));

            if (!response.Body) {
                throw new Error(`Empty response for key: ${key}`);
            }

            const bytes = await this.bodyToUint8Array(response.Body, key);

            return {
                text: new TextDecoder().decode(bytes),
                etag: response.ETag?.replace(/"/g, '') ?? null,
            };
        } catch (error) {
            const err = error as Error & { name?: string };
            if (err.name === 'NoSuchKey' || err.name === 'NotFound') {
                return null;
            }
            throw error;
        }
    }

    /**
     * Download a file from S3 and decode its bytes as UTF-8 text.
     *
     * Convenience wrapper around {@link downloadFile} for text-only callers
     * (e.g. JSON config files, markdown notes).
     *
     * @param key - Full S3 key.
     * @returns File content decoded as a UTF-8 string.
     * @throws {Error} If the key does not exist or an S3/network error occurs.
     */
    async downloadFileAsText(key: string): Promise<string> {
        const content = await this.downloadFile(key);
        return new TextDecoder().decode(content);
    }

    /**
     * Upload content to an S3 key, optionally with conditional headers.
     *
     * **Content type** — Passed as `Content-Type` on the `PutObject` request.
     * Some S3 providers use it for `Content-Disposition` and browser previews.
     *
     * **Conditional upload** — `ifMatch` / `ifNoneMatch` map directly to the
     * HTTP `If-Match` / `If-None-Match` headers.  Pass `"*"` to `ifNoneMatch`
     * to create-only (reject if key already exists), or pass the current ETag
     * to `ifMatch` to update-only (reject if object was changed since read).
     * ETag values must be bare hex strings; this method re-adds the required
     * surrounding quotes before forwarding to the SDK.
     *
     * @param key - Full S3 key for the destination object.
     * @param content - File bytes or UTF-8 string to upload.
     * @param options - Optional content type string, or an options object with
     *   `contentType`, `ifMatch`, `ifNoneMatch`, and/or `metadata` fields.
     * @returns The ETag of the newly created/updated object (quotes stripped).
     * @throws {Error} On S3/network error, or if a conditional header is not
     *   satisfied (HTTP 412 Precondition Failed).
     */
	async uploadFile(
		key: string,
		content: Uint8Array | string,
		options?: string | { contentType?: string; ifMatch?: string; ifNoneMatch?: string; metadata?: Record<string, string> }
	): Promise<string> {
        const client = this.getClient();

        const body = typeof content === 'string'
            ? new TextEncoder().encode(content)
            : content;

        const contentType = typeof options === 'string' ? options : options?.contentType;
		const ifMatch = typeof options === 'string' ? undefined : this.toConditionalEntityTag(options?.ifMatch);
		const ifNoneMatch = typeof options === 'string' ? undefined : this.toConditionalEntityTag(options?.ifNoneMatch);
		const metadata = typeof options === 'string' ? undefined : options?.metadata;

        const response = await client.send(new PutObjectCommand({
            Bucket: this.settings.bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
            IfMatch: ifMatch,
            IfNoneMatch: ifNoneMatch,
            Metadata: metadata,
        }));

		// Return cleaned ETag (remove quotes)
		return response.ETag?.replace(/"/g, '') || '';
	}

	/**
	 * Convert a normalized (quote-free) ETag into the HTTP entity-tag form
	 * required by conditional request headers (`If-Match`, `If-None-Match`).
	 *
	 * The S3 API mandates that entity-tag values in these headers are enclosed
	 * in double-quotes or use the `W/"..."` weak-tag form.  Because this class
	 * strips quotes from all returned ETags, they must be re-quoted here before
	 * being forwarded to the AWS SDK.
	 *
	 * Passthrough cases (no wrapping applied):
	 * - `undefined` / empty — returns `undefined` so the header is omitted.
	 * - `"*"` — wildcard token; must not be quoted.
	 * - Already quoted (`"…"` or `W/"…"`) — returned as-is to avoid double-quoting.
	 *
	 * @param etag - Bare ETag hex string, wildcard `"*"`, pre-quoted string, or `undefined`.
	 * @returns Properly quoted entity-tag string, or `undefined` if input is falsy.
	 */
	private toConditionalEntityTag(etag?: string): string | undefined {
		if (!etag) {
			return undefined;
		}

		if (etag === '*' || etag.startsWith('"') || etag.startsWith('W/"')) {
			return etag;
		}

		return `"${etag}"`;
	}

    /**
     * Delete a single object from S3.
     *
     * S3's `DeleteObject` is idempotent — deleting a key that does not exist
     * returns 204 and does not throw an error.
     *
     * @param key - Full S3 key of the object to delete.
     * @throws {Error} On S3/network failure (not on missing key).
     */
    async deleteFile(key: string): Promise<void> {
        const client = this.getClient();

        await client.send(new DeleteObjectCommand({
            Bucket: this.settings.bucket,
            Key: key,
        }));
    }

    /**
     * Delete multiple S3 objects in batched `DeleteObjects` requests.
     *
     * The S3 `DeleteObjects` API accepts at most 1000 keys per call, so large
     * arrays are split into 1000-key chunks and each chunk is sent as a
     * separate request.  Using `Quiet: true` suppresses the per-key success
     * entries in the response, reducing payload size.
     *
     * @param keys - Array of full S3 keys to delete. Passing an empty array
     *   is a no-op and returns `0` immediately.
     * @returns Total number of successfully deleted objects (input count minus
     *   any keys that had per-key errors reported by S3).
     * @throws {Error} On S3/network failure at the request level.
     */
    async deleteFiles(keys: string[]): Promise<number> {
        if (keys.length === 0) return 0;

        const client = this.getClient();

        // S3 DeleteObjects has a limit of 1000 objects per request
        const BATCH_SIZE = 1000;
        let deleted = 0;

        for (let i = 0; i < keys.length; i += BATCH_SIZE) {
            const batch = keys.slice(i, i + BATCH_SIZE);

            const response = await client.send(new DeleteObjectsCommand({
                Bucket: this.settings.bucket,
                Delete: {
                    Objects: batch.map(key => ({ Key: key })),
                    Quiet: true,
                },
            }));

            // Count successful deletions
            deleted += batch.length - (response.Errors?.length || 0);
        }

        return deleted;
    }

    /**
     * Check whether an S3 object exists without downloading its content.
     *
     * Uses `HeadObject` under the hood — cheaper than `GetObject` for
     * existence checks because no body bytes are transferred.
     *
     * @param key - Full S3 key to probe.
     * @returns `true` if the object exists and is accessible, `false` on 404.
     * @throws {Error} On S3/network errors other than 404.
     */
    async fileExists(key: string): Promise<boolean> {
        try {
            const client = this.getClient();
            await client.send(new HeadObjectCommand({
                Bucket: this.settings.bucket,
                Key: key,
            }));
            return true;
        } catch (error) {
            const err = error as Error & { name?: string };
            if (err.name === 'NoSuchKey' || err.name === 'NotFound' || err.name === 'NotFound') {
                return false;
            }
            throw error;
        }
    }

    /**
     * Fetch only the ETag of an S3 object, suitable for pre-flight checks
     * before conditional writes or deletes.
     *
     * The returned ETag has its surrounding double-quotes stripped (e.g.
     * `"abc123"` → `"abc123"`).
     *
     * @param key - Full S3 key.
     * @returns Bare ETag hex string, or `null` if the key does not exist.
     * @throws {Error} On S3/network errors other than 404.
     */
    async getFileEtag(key: string): Promise<string | null> {
        try {
            const client = this.getClient();
            const response = await client.send(new HeadObjectCommand({
                Bucket: this.settings.bucket,
                Key: key,
            }));
            // Return cleaned ETag (remove quotes)
            return response.ETag?.replace(/"/g, '') || null;
        } catch (error) {
            const err = error as Error & { name?: string };
            if (err.name === 'NoSuchKey' || err.name === 'NotFound') {
                return null;
            }
            throw error;
        }
    }

    /**
     * Fetch basic object metadata (key, size, lastModified, ETag) without
     * downloading the object body.
     *
     * Unlike {@link headObject}, this returns the lightweight {@link S3ObjectInfo}
     * shape (no plugin-specific metadata fields) and is suitable for listings
     * and size checks.
     *
     * @param key - Full S3 key.
     * @returns Object info with ETag (quotes stripped), or `null` if not found.
     * @throws {Error} On S3/network errors other than 404.
     */
    async getFileMetadata(key: string): Promise<S3ObjectInfo | null> {
        try {
            const client = this.getClient();
            const response = await client.send(new HeadObjectCommand({
                Bucket: this.settings.bucket,
                Key: key,
            }));
            return {
                key,
                size: response.ContentLength || 0,
                lastModified: response.LastModified || new Date(),
                etag: response.ETag?.replace(/"/g, ''),
            };
        } catch (error) {
            const err = error as Error & { name?: string };
            if (err.name === 'NoSuchKey' || err.name === 'NotFound') {
                return null;
            }
            throw error;
        }
    }

    /**
     * Delete every S3 object whose key begins with `prefix`.
     *
     * Combines {@link listObjects} (recursive) with {@link deleteFiles}, so it
     * inherits both the pagination of listings and the 1000-key batching of
     * deletes.  Suitable for wiping an entire sync prefix or removing a backup
     * snapshot directory.
     *
     * @param prefix - S3 key prefix to wipe (e.g. `"backups/backup-2024-01-01T12-00-00/"`).
     * @returns Total number of objects deleted.
     * @throws {Error} On S3/network failure.
     */
    async deletePrefix(prefix: string): Promise<number> {
        const objects = await this.listObjects(prefix, true);
        const keys = objects.map(obj => obj.key);
        return await this.deleteFiles(keys);
    }

    /**
     * Return the S3 bucket name from the active plugin settings.
     *
     * Callers (e.g. `SyncPathCodec`, `BackupScheduler`) use this to build
     * fully-qualified S3 URIs for logging without needing a direct reference
     * to the settings object.
     *
     * @returns Bucket name string as configured in plugin settings.
     */
    getBucket(): string {
        return this.settings.bucket;
    }

    /**
     * Destroy the underlying `S3Client` and release its resources.
     *
     * Should be called from the plugin's `onunload()` lifecycle hook to avoid
     * resource leaks (open HTTP connections, timers, etc.).  Safe to call
     * multiple times — subsequent calls are a no-op.
     */
    destroy(): void {
        if (this.client) {
            this.client.destroy();
            this.client = null;
        }
    }
}

/**
 * Minimal async-iterator contract used to type the async-iterable form of the
 * AWS SDK response body.
 *
 * The SDK's `Body` type includes `{ [Symbol.asyncIterator](): AsyncIterator<T> }`,
 * but the full `AsyncIterator<T>` interface also requires `return()` and
 * `throw()` methods that are never called here.  This slimmed-down interface
 * lets `bodyToUint8Array` iterate over chunks without a full implementation.
 *
 * @template T - The type of each yielded chunk (typically `Uint8Array`).
 */
interface AsyncIteratorLike<T> {
    next(): Promise<IteratorResult<T>>;
}
