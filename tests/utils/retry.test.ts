/**
 * Unit tests for Retry utility
 */

import { 
    withRetry, 
    sleep, 
    isNetworkError, 
    isRateLimitError,
    createS3RetryOptions 
} from '../../src/utils/retry';

describe('Retry Utility', () => {
    describe('withRetry', () => {
        it('should succeed on first attempt', async () => {
            const fn = jest.fn().mockResolvedValue('success');
            const result = await withRetry(fn);
            
            expect(result).toBe('success');
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('should retry on failure and succeed', async () => {
            const fn = jest.fn()
                .mockRejectedValueOnce(new Error('fail'))
                .mockResolvedValue('success');
            
            const result = await withRetry(fn, { maxAttempts: 3, initialDelayMs: 10 });
            
            expect(result).toBe('success');
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it('should throw after max attempts', async () => {
            const fn = jest.fn().mockRejectedValue(new Error('always fails'));
            
            await expect(withRetry(fn, { maxAttempts: 3, initialDelayMs: 10 }))
                .rejects.toThrow('always fails');
            expect(fn).toHaveBeenCalledTimes(3);
        });

        it('should not retry non-retryable errors', async () => {
            const fn = jest.fn().mockRejectedValue(new Error('non-retryable'));
            
            await expect(withRetry(fn, { 
                maxAttempts: 3, 
                isRetryable: () => false 
            })).rejects.toThrow('non-retryable');
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('should apply exponential backoff with jitter', async () => {
            const fn = jest.fn()
                .mockRejectedValueOnce(new Error('fail1'))
                .mockRejectedValueOnce(new Error('fail2'))
                .mockResolvedValue('success');
            
            const delays: number[] = [];
            const onRetry = (_attempt: number, _error: Error, delayMs: number) => {
                delays.push(delayMs);
            };

            await withRetry(fn, { 
                maxAttempts: 3, 
                initialDelayMs: 100,
                backoffMultiplier: 2,
                onRetry 
            });
            
            // First delay should be ~100ms (with up to 30% jitter)
            expect(delays[0]).toBeGreaterThanOrEqual(100);
            expect(delays[0]).toBeLessThanOrEqual(130); // 100 + 30% jitter
            
            // Second delay should be ~200ms (with up to 30% jitter)
            expect(delays[1]).toBeGreaterThanOrEqual(200);
            expect(delays[1]).toBeLessThanOrEqual(260); // 200 + 30% jitter
        });

        it('should respect maxDelayMs', async () => {
            const fn = jest.fn()
                .mockRejectedValueOnce(new Error('fail'))
                .mockResolvedValue('success');
            
            const delays: number[] = [];
            await withRetry(fn, {
                maxAttempts: 3,
                initialDelayMs: 10000,
                maxDelayMs: 500,
                onRetry: (_a, _e, d) => delays.push(d)
            });

            // Even though initial delay is 10000ms, should be capped at maxDelayMs
            expect(delays[0]).toBeLessThanOrEqual(500);
        });

        it('should call onRetry callback on each retry', async () => {
            const fn = jest.fn()
                .mockRejectedValueOnce(new Error('fail1'))
                .mockRejectedValueOnce(new Error('fail2'))
                .mockResolvedValue('success');
            
            const onRetry = jest.fn();
            
            await withRetry(fn, { 
                maxAttempts: 3, 
                initialDelayMs: 10,
                onRetry 
            });
            
            expect(onRetry).toHaveBeenCalledTimes(2);
            expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error), expect.any(Number));
            expect(onRetry).toHaveBeenCalledWith(2, expect.any(Error), expect.any(Number));
        });

        it('should handle non-Error rejections', async () => {
            const fn = jest.fn().mockRejectedValue('string error');
            
            await expect(withRetry(fn, { maxAttempts: 2, initialDelayMs: 10 }))
                .rejects.toThrow('string error');
        });

        it('should use default options when none provided', async () => {
            const fn = jest.fn()
                .mockRejectedValueOnce(new Error('fail'))
                .mockResolvedValue('success');
            
            const result = await withRetry(fn, { initialDelayMs: 10 });
            
            expect(result).toBe('success');
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it('should handle custom isRetryable function', async () => {
            const fn = jest.fn()
                .mockRejectedValueOnce(new Error('network timeout'))
                .mockRejectedValueOnce(new Error('bad request'))
                .mockResolvedValue('success');
            
            const isRetryable = (error: Error) => error.message.includes('network');
            
            await expect(withRetry(fn, { maxAttempts: 3, initialDelayMs: 10, isRetryable }))
                .rejects.toThrow('bad request');
            
            // Should retry once for network error, then fail on bad request
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it('should handle zero attempts gracefully', async () => {
            const fn = jest.fn().mockRejectedValue(new Error('fail'));
            
            await expect(withRetry(fn, { maxAttempts: 0, initialDelayMs: 10 }))
                .rejects.toThrow();
        });
    });

    describe('sleep', () => {
        it('should delay execution', async () => {
            const start = Date.now();
            await sleep(50);
            const elapsed = Date.now() - start;
            
            expect(elapsed).toBeGreaterThanOrEqual(45); // Allow small variance
            expect(elapsed).toBeLessThan(100); // Shouldn't be too long
        });

        it('should work with zero delay', async () => {
            const start = Date.now();
            await sleep(0);
            const elapsed = Date.now() - start;
            
            expect(elapsed).toBeLessThan(10);
        });

        it('should return a Promise', () => {
            const result = sleep(1);
            expect(result).toBeInstanceOf(Promise);
        });
    });

    describe('isNetworkError', () => {
        it('should detect network keyword', () => {
            expect(isNetworkError(new Error('network error'))).toBe(true);
            expect(isNetworkError(new Error('Network timeout'))).toBe(true);
            expect(isNetworkError(new Error('NETWORK ISSUE'))).toBe(true);
        });

        it('should detect timeout keyword', () => {
            expect(isNetworkError(new Error('timeout'))).toBe(true);
            expect(isNetworkError(new Error('Request timeout'))).toBe(true);
            expect(isNetworkError(new Error('TIMEOUT ERROR'))).toBe(true);
        });

        it('should detect ECONNRESET', () => {
            expect(isNetworkError(new Error('ECONNRESET'))).toBe(true);
            expect(isNetworkError(new Error('Error: ECONNRESET connection reset'))).toBe(true);
        });

        it('should detect ENOTFOUND', () => {
            expect(isNetworkError(new Error('ENOTFOUND'))).toBe(true);
            expect(isNetworkError(new Error('getaddrinfo ENOTFOUND'))).toBe(true);
        });

        it('should detect connection refused', () => {
            expect(isNetworkError(new Error('connection refused'))).toBe(true);
            expect(isNetworkError(new Error('Connection refused by server'))).toBe(true);
        });

        it('should detect socket hang up', () => {
            expect(isNetworkError(new Error('socket hang up'))).toBe(true);
            expect(isNetworkError(new Error('Socket hang up error'))).toBe(true);
        });

        it('should not detect non-network errors', () => {
            expect(isNetworkError(new Error('File not found'))).toBe(false);
            expect(isNetworkError(new Error('Invalid input'))).toBe(false);
            expect(isNetworkError(new Error('Permission denied'))).toBe(false);
            expect(isNetworkError(new Error('Database error'))).toBe(false);
        });

        it('should be case-insensitive', () => {
            expect(isNetworkError(new Error('NETWORK ERROR'))).toBe(true);
            expect(isNetworkError(new Error('Network Error'))).toBe(true);
            expect(isNetworkError(new Error('network error'))).toBe(true);
        });
    });

    describe('isRateLimitError', () => {
        it('should detect 429 status code', () => {
            const error = new Error('Too many requests') as Error & { 
                $metadata?: { httpStatusCode?: number } 
            };
            error.$metadata = { httpStatusCode: 429 };
            
            expect(isRateLimitError(error)).toBe(true);
        });

        it('should not detect other 4xx errors', () => {
            const error = new Error('Bad request') as Error & { 
                $metadata?: { httpStatusCode?: number } 
            };
            error.$metadata = { httpStatusCode: 400 };
            
            expect(isRateLimitError(error)).toBe(false);
        });

        it('should not detect 5xx errors', () => {
            const error = new Error('Server error') as Error & { 
                $metadata?: { httpStatusCode?: number } 
            };
            error.$metadata = { httpStatusCode: 500 };
            
            expect(isRateLimitError(error)).toBe(false);
        });

        it('should handle errors without metadata', () => {
            const error = new Error('Error') as Error & { 
                $metadata?: { httpStatusCode?: number } 
            };
            expect(isRateLimitError(error)).toBe(false);
        });

        it('should handle errors with empty metadata', () => {
            const error = new Error('Error') as Error & { 
                $metadata?: { httpStatusCode?: number } 
            };
            error.$metadata = {};
            
            expect(isRateLimitError(error)).toBe(false);
        });

        it('should handle regular errors', () => {
            const error = new Error('Regular error');
            expect(isRateLimitError(error as Error & { $metadata?: { httpStatusCode?: number } })).toBe(false);
        });
    });

    describe('createS3RetryOptions', () => {
        it('should create retry options with correct defaults', () => {
            const options = createS3RetryOptions(false);
            
            expect(options.maxAttempts).toBe(3);
            expect(options.initialDelayMs).toBe(1000);
            expect(options.maxDelayMs).toBe(10000);
            expect(options.isRetryable).toBeDefined();
            expect(options.onRetry).toBeDefined();
        });

        it('should only retry network errors', () => {
            const options = createS3RetryOptions(false);
            
            const networkError = new Error('network timeout');
            expect(options.isRetryable!(networkError)).toBe(true);
            
            const otherError = new Error('validation error');
            expect(options.isRetryable!(otherError)).toBe(false);
        });

        it('should only retry rate limit errors', () => {
            const options = createS3RetryOptions(false);
            
            const rateLimitError = new Error('rate limit') as Error & { 
                $metadata?: { httpStatusCode?: number } 
            };
            rateLimitError.$metadata = { httpStatusCode: 429 };
            expect(options.isRetryable!(rateLimitError)).toBe(true);
        });

        it('should retry both network and rate limit errors', () => {
            const options = createS3RetryOptions(false);
            
            expect(options.isRetryable!(new Error('network error'))).toBe(true);
            
            const rateLimitError = new Error('too many') as Error & { 
                $metadata?: { httpStatusCode?: number } 
            };
            rateLimitError.$metadata = { httpStatusCode: 429 };
            expect(options.isRetryable!(rateLimitError)).toBe(true);
            
            expect(options.isRetryable!(new Error('other error'))).toBe(false);
        });

        it('should not log when debugLogging is false', () => {
            const consoleSpy = jest.spyOn(console, 'debug').mockImplementation();
            const options = createS3RetryOptions(false);
            
            options.onRetry!(1, new Error('test'), 1000);
            
            expect(consoleSpy).not.toHaveBeenCalled();
            consoleSpy.mockRestore();
        });

        it('should log when debugLogging is true', () => {
            const consoleSpy = jest.spyOn(console, 'debug').mockImplementation();
            const options = createS3RetryOptions(true);
            
            const error = new Error('test error');
            options.onRetry!(1, error, 1000);
            
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('[S3 Retry]'),
            );
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('test error'),
            );
            consoleSpy.mockRestore();
        });
    });

    describe('integration', () => {
        it('should work with realistic S3 retry scenario', async () => {
            let attemptCount = 0;
            const fn = async () => {
                attemptCount++;
                if (attemptCount < 3) {
                    const error = new Error('network timeout') as Error & {
                        $metadata?: { httpStatusCode?: number }
                    };
                    throw error;
                }
                return 'success';
            };

            const options = createS3RetryOptions(false);
            const result = await withRetry(fn, { 
                ...options, 
                initialDelayMs: 10 
            });

            expect(result).toBe('success');
            expect(attemptCount).toBe(3);
        });

        it('should fail fast for non-retryable errors', async () => {
            let attemptCount = 0;
            const fn = async () => {
                attemptCount++;
                throw new Error('Invalid access key');
            };

            const options = createS3RetryOptions(false);
            
            await expect(withRetry(fn, { 
                ...options, 
                initialDelayMs: 10 
            })).rejects.toThrow('Invalid access key');
            
            // Should only attempt once since it's not retryable
            expect(attemptCount).toBe(1);
        });
    });
});

