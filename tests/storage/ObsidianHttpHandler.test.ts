/**
 * Unit tests for ObsidianHttpHandler.
 *
 * Verifies URL construction, header filtering, body handling, error wrapping,
 * and response body format for AWS SDK stream deserialization.
 */

import { requestUrl } from 'obsidian';
import { HttpRequest } from '@smithy/protocol-http';
import { ObsidianHttpHandler } from '../../src/storage/ObsidianHttpHandler';

jest.mock('obsidian', () => ({
	requestUrl: jest.fn(),
}));

const mockedRequestUrl = jest.mocked(requestUrl);

function mockSuccessResponse(body = 'ok'): void {
	const payload = new TextEncoder().encode(body);
	mockedRequestUrl.mockResolvedValue({
		status: 200,
		headers: { 'content-type': 'text/plain' },
		arrayBuffer: payload.buffer.slice(
			payload.byteOffset,
			payload.byteOffset + payload.byteLength,
		),
		json: JSON.parse,
		text: body,
	});
}

describe('ObsidianHttpHandler', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	/** Verifies the core response body format contract with the AWS SDK. */
	describe('response body format', () => {
		it('returns ReadableStream bodies for successful responses when available', async () => {
			const payload = new TextEncoder().encode('hello world');
			mockedRequestUrl.mockResolvedValue({
				status: 200,
				headers: { 'content-type': 'text/plain' },
				arrayBuffer: payload.buffer,
				json: JSON.parse,
				text: 'hello world',
			});

			const handler = new ObsidianHttpHandler();
			const { response } = await handler.handle(new HttpRequest({
				protocol: 'https:',
				hostname: 'example.com',
				method: 'GET',
				path: '/test.txt',
				headers: {},
			}));

			expect(response.statusCode).toBe(200);
			if (typeof ReadableStream === 'function') {
				expect(response.body).toBeInstanceOf(ReadableStream);
				const reader = (response.body as ReadableStream<Uint8Array>).getReader();
				const chunks: Uint8Array[] = [];

				// eslint-disable-next-line no-constant-condition
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					if (value) chunks.push(value);
				}

				const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
				const collected = new Uint8Array(totalLength);
				let offset = 0;
				for (const chunk of chunks) {
					collected.set(chunk, offset);
					offset += chunk.length;
				}

				expect(new TextDecoder().decode(collected)).toBe('hello world');
				return;
			}

			expect(response.body).toBeInstanceOf(Blob);
			expect(await (response.body as Blob).text()).toBe('hello world');
		});
	});

	/** Verifies URL construction from decomposed HttpRequest fields. */
	describe('URL building', () => {
		it('assembles a full URL with query parameters', async () => {
			mockSuccessResponse();
			const handler = new ObsidianHttpHandler();

			await handler.handle(new HttpRequest({
				protocol: 'https:',
				hostname: 'bucket.s3.amazonaws.com',
				method: 'GET',
				path: '/key.txt',
				query: { 'list-type': '2', prefix: 'vault/' },
				headers: {},
			}));

			const calledUrl = mockedRequestUrl.mock.calls[0]?.[0]?.url as string;
			expect(calledUrl).toContain('https://bucket.s3.amazonaws.com/key.txt');
			expect(calledUrl).toContain('list-type=2');
			expect(calledUrl).toContain('prefix=vault%2F');
		});

		it('omits default ports (80 for HTTP, 443 for HTTPS)', async () => {
			mockSuccessResponse();
			const handler = new ObsidianHttpHandler();

			await handler.handle(new HttpRequest({
				protocol: 'https:',
				hostname: 'example.com',
				port: 443,
				method: 'GET',
				path: '/',
				headers: {},
			}));

			const calledUrl = mockedRequestUrl.mock.calls[0]?.[0]?.url as string;
			expect(calledUrl).toBe('https://example.com/');
			expect(calledUrl).not.toContain(':443');
		});

		it('includes non-default ports in the URL', async () => {
			mockSuccessResponse();
			const handler = new ObsidianHttpHandler();

			await handler.handle(new HttpRequest({
				protocol: 'http:',
				hostname: 'localhost',
				port: 9000,
				method: 'GET',
				path: '/test',
				headers: {},
			}));

			const calledUrl = mockedRequestUrl.mock.calls[0]?.[0]?.url as string;
			expect(calledUrl).toBe('http://localhost:9000/test');
		});
	});

	/** Verifies that problematic headers are filtered before sending. */
	describe('header filtering', () => {
		it('filters out content-length and host headers', async () => {
			mockSuccessResponse();
			const handler = new ObsidianHttpHandler();

			await handler.handle(new HttpRequest({
				protocol: 'https:',
				hostname: 'example.com',
				method: 'PUT',
				path: '/file.txt',
				headers: {
					'Content-Length': '42',
					'Host': 'example.com',
					'x-amz-content-sha256': 'abc123',
				},
			}));

			const sentHeaders = mockedRequestUrl.mock.calls[0]?.[0]?.headers as Record<string, string>;
			expect(sentHeaders['Content-Length']).toBeUndefined();
			expect(sentHeaders['Host']).toBeUndefined();
			expect(sentHeaders['x-amz-content-sha256']).toBe('abc123');
		});
	});

	/** Verifies request body handling for different HTTP methods and content types. */
	describe('request body handling', () => {
		it('skips body for GET requests even when body is present', async () => {
			mockSuccessResponse();
			const handler = new ObsidianHttpHandler();

			await handler.handle(new HttpRequest({
				protocol: 'https:',
				hostname: 'example.com',
				method: 'GET',
				path: '/test',
				headers: {},
				body: 'should-be-ignored',
			}));

			const params = mockedRequestUrl.mock.calls[0]?.[0];
			expect(params?.body).toBeUndefined();
		});

		it('converts Uint8Array body to ArrayBuffer for PUT requests', async () => {
			mockSuccessResponse();
			const handler = new ObsidianHttpHandler();
			const bodyBytes = new Uint8Array([1, 2, 3]);

			await handler.handle(new HttpRequest({
				protocol: 'https:',
				hostname: 'example.com',
				method: 'PUT',
				path: '/upload',
				headers: {},
				body: bodyBytes,
			}));

			const params = mockedRequestUrl.mock.calls[0]?.[0];
			expect(params?.body).toBeInstanceOf(ArrayBuffer);
			const sent = new Uint8Array(params?.body as ArrayBuffer);
			expect(sent).toEqual(bodyBytes);
		});

		it('passes string body directly for POST requests', async () => {
			mockSuccessResponse();
			const handler = new ObsidianHttpHandler();

			await handler.handle(new HttpRequest({
				protocol: 'https:',
				hostname: 'example.com',
				method: 'POST',
				path: '/api',
				headers: {},
				body: '<xml>data</xml>',
			}));

			const params = mockedRequestUrl.mock.calls[0]?.[0];
			expect(params?.body).toBe('<xml>data</xml>');
		});
	});

	/** Verifies error wrapping for network-level failures. */
	describe('error handling', () => {
		it('wraps network errors with a descriptive message', async () => {
			mockedRequestUrl.mockRejectedValue(new Error('net::ERR_CONNECTION_REFUSED'));
			const handler = new ObsidianHttpHandler();
			const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

			await expect(handler.handle(new HttpRequest({
				protocol: 'https:',
				hostname: 'example.com',
				method: 'GET',
				path: '/',
				headers: {},
			}))).rejects.toThrow('Request failed: net::ERR_CONNECTION_REFUSED');

			consoleSpy.mockRestore();
		});

		it('wraps non-Error thrown values', async () => {
			mockedRequestUrl.mockRejectedValue('string error');
			const handler = new ObsidianHttpHandler();
			const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

			await expect(handler.handle(new HttpRequest({
				protocol: 'https:',
				hostname: 'example.com',
				method: 'GET',
				path: '/',
				headers: {},
			}))).rejects.toThrow('Request failed: string error');

			consoleSpy.mockRestore();
		});
	});

	/** Verifies the Smithy interface stubs behave correctly. */
	describe('Smithy interface', () => {
		it('returns requestTimeout in httpHandlerConfigs', () => {
			const handler = new ObsidianHttpHandler({ requestTimeout: 5000 });
			expect(handler.httpHandlerConfigs()).toEqual({ requestTimeout: 5000 });
		});

		it('uses default requestTimeout of 30000', () => {
			const handler = new ObsidianHttpHandler();
			expect(handler.httpHandlerConfigs()).toEqual({ requestTimeout: 30000 });
		});
	});
});
