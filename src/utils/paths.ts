/**
 * Path Utility Module
 *
 * Provides path manipulation utilities for file operations.
 */

/**
 * Normalize path separators to forward slashes
 */
export function normalizePath(path: string): string {
    return path.replace(/\\/g, '/');
}

/**
 * Get directory part of a path
 */
export function getDirectory(path: string): string {
    const normalized = normalizePath(path);
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash >= 0 ? normalized.substring(0, lastSlash) : '';
}

/**
 * Get filename from a path
 */
export function getFilename(path: string): string {
    const normalized = normalizePath(path);
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash >= 0 ? normalized.substring(lastSlash + 1) : normalized;
}

/**
 * Get file extension (without dot)
 */
export function getExtension(path: string): string {
    const filename = getFilename(path);
    const lastDot = filename.lastIndexOf('.');
    return lastDot >= 0 ? filename.substring(lastDot + 1) : '';
}

/**
 * Join path segments
 */
export function joinPath(...segments: string[]): string {
    return segments
        .map((s) => normalizePath(s))
        .filter((s) => s.length > 0)
        .join('/')
        .replace(/\/+/g, '/');
}

/**
 * Check if path matches a glob pattern
 * Supports * (any characters except /) and ** (any characters including /)
 */
export function matchGlob(path: string, pattern: string): boolean {
    const normalized = normalizePath(path);

    // Convert glob to regex
    const regexPattern = pattern
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '<<<GLOBSTAR>>>')
        .replace(/\*/g, '[^/]*')
        .replace(/<<<GLOBSTAR>>>/g, '.*');

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(normalized);
}

/**
 * Check if path matches any of the glob patterns
 */
export function matchesAnyGlob(path: string, patterns: string[]): boolean {
    return patterns.some((pattern) => matchGlob(path, pattern));
}

/**
 * Add prefix to path
 */
export function addPrefix(path: string, prefix: string): string {
    if (!prefix) return path;
    const normalizedPrefix = normalizePath(prefix).replace(/\/$/, '');
    const normalizedPath = normalizePath(path).replace(/^\//, '');
    return `${normalizedPrefix}/${normalizedPath}`;
}

/**
 * Remove prefix from path
 */
export function removePrefix(path: string, prefix: string): string | null {
    const normalizedPath = normalizePath(path);
    const normalizedPrefix = normalizePath(prefix).replace(/\/$/, '') + '/';

    if (normalizedPath.startsWith(normalizedPrefix)) {
        return normalizedPath.substring(normalizedPrefix.length);
    }

    return null;
}

/**
 * Check if path is a conflict file (starts with LOCAL_ or REMOTE_)
 */
export function isConflictFile(path: string): boolean {
    const filename = getFilename(path);
    return filename.startsWith('LOCAL_') || filename.startsWith('REMOTE_');
}

/**
 * Get original path from conflict file path
 */
export function getOriginalFromConflict(conflictPath: string): string | null {
    const dir = getDirectory(conflictPath);
    const filename = getFilename(conflictPath);

    let originalFilename: string;
    if (filename.startsWith('LOCAL_')) {
        originalFilename = filename.substring(6);
    } else if (filename.startsWith('REMOTE_')) {
        originalFilename = filename.substring(7);
    } else {
        return null;
    }

    return dir ? `${dir}/${originalFilename}` : originalFilename;
}
