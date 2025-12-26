/**
 * Retry Utility Module
 *
 * Provides retry logic with exponential backoff for transient failures.
 */

/**
 * Retry options
 */
export interface RetryOptions {
    /** Maximum number of attempts (default: 3) */
    maxAttempts?: number;
    /** Initial delay in milliseconds (default: 1000) */
    initialDelayMs?: number;
    /** Maximum delay in milliseconds (default: 30000) */
    maxDelayMs?: number;
    /** Multiplier for exponential backoff (default: 2) */
    backoffMultiplier?: number;
    /** Function to determine if error is retryable (default: all errors) */
    isRetryable?: (error: Error) => boolean;
    /** Callback for each retry attempt */
    onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

/**
 * Default retry options
 */
const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'onRetry'>> & { onRetry?: RetryOptions['onRetry'] } = {
    maxAttempts: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    isRetryable: () => true,
};

/**
 * Execute a function with retry logic and exponential backoff
 *
 * @param fn - Async function to execute
 * @param options - Retry options
 * @returns Result of the function
 * @throws Last error if all attempts fail
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    options: RetryOptions = {}
): Promise<T> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    let lastError: Error | null = null;
    let delayMs = opts.initialDelayMs;

    for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));

            // Check if error is retryable
            if (!opts.isRetryable(lastError)) {
                throw lastError;
            }

            // Check if we have more attempts
            if (attempt >= opts.maxAttempts) {
                break;
            }

            // Calculate delay with jitter
            const jitter = Math.random() * 0.3 * delayMs; // Up to 30% jitter
            const actualDelay = Math.min(delayMs + jitter, opts.maxDelayMs);

            // Call retry callback
            opts.onRetry?.(attempt, lastError, actualDelay);

            // Wait before next attempt
            await sleep(actualDelay);

            // Increase delay for next attempt
            delayMs = Math.min(delayMs * opts.backoffMultiplier, opts.maxDelayMs);
        }
    }

    throw lastError || new Error('Retry failed with unknown error');
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if an error is a network error (potentially transient)
 */
export function isNetworkError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
        message.includes('network') ||
        message.includes('timeout') ||
        message.includes('econnreset') ||
        message.includes('enotfound') ||
        message.includes('connection refused') ||
        message.includes('socket hang up')
    );
}

/**
 * Check if an error is a rate limit error
 */
export function isRateLimitError(error: Error & { $metadata?: { httpStatusCode?: number } }): boolean {
    return error.$metadata?.httpStatusCode === 429;
}

/**
 * Create retry options for S3 operations
 */
export function createS3RetryOptions(debugLogging: boolean): RetryOptions {
    return {
        maxAttempts: 3,
        initialDelayMs: 1000,
        maxDelayMs: 10000,
        isRetryable: (error) => isNetworkError(error) || isRateLimitError(error as Error & { $metadata?: { httpStatusCode?: number } }),
        onRetry: (attempt, error, delayMs) => {
            if (debugLogging) {
                console.debug(`[S3 Retry] Attempt ${attempt} failed: ${error.message}, retrying in ${delayMs}ms`);
            }
        },
    };
}
