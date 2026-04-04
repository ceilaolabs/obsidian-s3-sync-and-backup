/**
 * Unit tests for ObsidianHttpHandler.
 *
 * Verifies that response bodies are returned in a browser-compatible format
 * for AWS SDK stream deserialization and checksum validation.
 */

import { requestUrl } from 'obsidian';
import { HttpRequest } from '@smithy/protocol-http';
import { ObsidianHttpHandler } from '../../src/storage/ObsidianHttpHandler';

jest.mock('obsidian', () => ({
	requestUrl: jest.fn(),
}));

describe('ObsidianHttpHandler', () => {
	it('returns ReadableStream bodies for successful responses when available', async () => {
		const payload = new TextEncoder().encode('hello world');
		(requestUrl as jest.Mock).mockResolvedValue({
			status: 200,
			headers: {
				'content-type': 'text/plain',
			},
			arrayBuffer: payload.buffer,
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

			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				if (value) {
					chunks.push(value);
				}
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
