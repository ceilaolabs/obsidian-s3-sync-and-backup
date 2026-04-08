/**
 * S3 Provider Module
 *
 * Provides a high-level abstraction over AWS SDK S3 client operations.
 * Handles all S3 interactions including upload, download, list, and delete.
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
import { S3SyncBackupSettings, S3ObjectInfo } from '../types';
import { buildS3ClientConfig, validateConnectionSettings } from './S3Config';

/**
 * S3Provider class - Wrapper for S3 operations
 *
 * Provides simplified interface for common S3 operations with
 * error handling and retry logic.
 */
export class S3Provider {
    private client: S3Client | null = null;
    private settings: S3SyncBackupSettings;

    constructor(settings: S3SyncBackupSettings) {
        this.settings = settings;
    }

    /**
     * Update settings and recreate client if needed
     */
    updateSettings(settings: S3SyncBackupSettings): void {
        this.settings = settings;
        this.client = null; // Force client recreation on next use
    }

    /**
     * Get or create S3 client instance
     * Lazily initializes client on first use
     */
    private getClient(): S3Client {
        if (!this.client) {
            const config = buildS3ClientConfig(this.settings);
            this.client = new S3Client(config);
        }
        return this.client;
    }

    /**
     * Test connection to S3 bucket
     *
     * Attempts to access the bucket to verify credentials and permissions.
     *
     * @returns Success message or throws error with details
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
     * List all objects under a prefix
     *
     * @param prefix - S3 key prefix to list (e.g., "vault/")
     * @param recursive - Whether to list recursively (default: true)
     * @returns Array of S3ObjectInfo
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
     * Download file content from S3
     *
     * @param key - Full S3 key (e.g., "vault/Notes/meeting.md")
     * @returns File content as Uint8Array
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

        const body = response.Body as
            | Uint8Array
            | ArrayBuffer
            | Blob
            | ReadableStream<Uint8Array>
            | { [Symbol.asyncIterator](): AsyncIteratorLike<Uint8Array> }
            | { transformToByteArray?: () => Promise<Uint8Array> }
            | string;

        if (body instanceof Uint8Array) {
            return body;
        }

        if (body instanceof ArrayBuffer) {
            return new Uint8Array(body);
        }

        if (typeof body === 'string') {
            return new TextEncoder().encode(body);
        }

        if (typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === 'function') {
            return await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
        }

        if (body instanceof Blob) {
            return new Uint8Array(await body.arrayBuffer());
        }

        const chunks: Uint8Array[] = [];

        if (typeof (body as ReadableStream<Uint8Array>).getReader === 'function') {
            const reader = (body as ReadableStream<Uint8Array>).getReader();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) chunks.push(value);
            }
        } else if (Symbol.asyncIterator in Object(body)) {
            for await (const chunk of body as { [Symbol.asyncIterator](): AsyncIteratorLike<Uint8Array> }) {
                chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
            }
        } else {
            throw new Error(`Unsupported response body type for key: ${key}`);
        }

        // Combine chunks into single Uint8Array
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
     * Download file as text along with its ETag in a single request.
     * Avoids the TOCTOU race of separate HeadObject + GetObject calls.
     *
     * @param key - Full S3 key
     * @returns Object with text content and cleaned ETag, or null if not found
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

            const body = response.Body as
                | Uint8Array
                | ArrayBuffer
                | Blob
                | ReadableStream<Uint8Array>
                | { [Symbol.asyncIterator](): AsyncIteratorLike<Uint8Array> }
                | { transformToByteArray?: () => Promise<Uint8Array> }
                | string;

            let bytes: Uint8Array;
            if (body instanceof Uint8Array) {
                bytes = body;
            } else if (body instanceof ArrayBuffer) {
                bytes = new Uint8Array(body);
            } else if (typeof body === 'string') {
                bytes = new TextEncoder().encode(body);
            } else if (typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === 'function') {
                bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
            } else if (body instanceof Blob) {
                bytes = new Uint8Array(await body.arrayBuffer());
            } else {
                const chunks: Uint8Array[] = [];
                if (typeof (body as ReadableStream<Uint8Array>).getReader === 'function') {
                    const reader = (body as ReadableStream<Uint8Array>).getReader();
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        if (value) chunks.push(value);
                    }
                } else if (Symbol.asyncIterator in Object(body)) {
                    for await (const chunk of body as { [Symbol.asyncIterator](): AsyncIteratorLike<Uint8Array> }) {
                        chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
                    }
                } else {
                    throw new Error(`Unsupported response body type for key: ${key}`);
                }
                const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
                bytes = new Uint8Array(totalLength);
                let offset = 0;
                for (const chunk of chunks) {
                    bytes.set(chunk, offset);
                    offset += chunk.length;
                }
            }

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
     * Download file as text
     *
     * @param key - Full S3 key
     * @returns File content as string
     */
    async downloadFileAsText(key: string): Promise<string> {
        const content = await this.downloadFile(key);
        return new TextDecoder().decode(content);
    }

    /**
     * Upload file to S3
     *
     * @param key - Full S3 key for destination
     * @param content - File content as Uint8Array or string
     * @param options - Optional content type and conditional headers
     * @returns The ETag of the uploaded object (for change tracking)
     */
	async uploadFile(
		key: string,
		content: Uint8Array | string,
		options?: string | { contentType?: string; ifMatch?: string; ifNoneMatch?: string }
	): Promise<string> {
        const client = this.getClient();

        const body = typeof content === 'string'
            ? new TextEncoder().encode(content)
            : content;

        const contentType = typeof options === 'string' ? options : options?.contentType;
		const ifMatch = typeof options === 'string' ? undefined : this.toConditionalEntityTag(options?.ifMatch);
		const ifNoneMatch = typeof options === 'string' ? undefined : this.toConditionalEntityTag(options?.ifNoneMatch);

        const response = await client.send(new PutObjectCommand({
            Bucket: this.settings.bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
            IfMatch: ifMatch,
            IfNoneMatch: ifNoneMatch,
        }));

		// Return cleaned ETag (remove quotes)
		return response.ETag?.replace(/"/g, '') || '';
	}

	/**
	 * Convert a normalized ETag into the quoted HTTP entity-tag form required by
	 * conditional headers such as `If-Match`.
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
     * Delete a single file from S3
     *
     * @param key - Full S3 key to delete
     */
    async deleteFile(key: string): Promise<void> {
        const client = this.getClient();

        await client.send(new DeleteObjectCommand({
            Bucket: this.settings.bucket,
            Key: key,
        }));
    }

    /**
     * Delete multiple files from S3 in a single request
     *
     * @param keys - Array of S3 keys to delete
     * @returns Number of files successfully deleted
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
     * Check if a file exists in S3
     *
     * @param key - Full S3 key
     * @returns true if file exists
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
     * Get the ETag of a file without downloading it
     *
     * Used for pre-flight validation before destructive operations.
     *
     * @param key - Full S3 key
     * @returns ETag string (without quotes) or null if file doesn't exist
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
     * Get file metadata (ETag, size, lastModified) without downloading content
     *
     * @param key - Full S3 key
     * @returns Object info or null if file doesn't exist
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
     * Delete all objects under a prefix (recursive delete)
     *
     * @param prefix - S3 key prefix to delete
     * @returns Number of files deleted
     */
    async deletePrefix(prefix: string): Promise<number> {
        const objects = await this.listObjects(prefix, true);
        const keys = objects.map(obj => obj.key);
        return await this.deleteFiles(keys);
    }

    /**
     * Get the bucket name from settings
     */
    getBucket(): string {
        return this.settings.bucket;
    }

    /**
     * Dispose of the S3 client
     * Call this when the plugin is unloaded
     */
    destroy(): void {
        if (this.client) {
            this.client.destroy();
            this.client = null;
        }
    }
}

interface AsyncIteratorLike<T> {
    next(): Promise<IteratorResult<T>>;
}
