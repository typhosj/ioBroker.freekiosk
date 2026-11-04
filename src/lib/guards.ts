/**
 * True for a plain, non-null, non-array object.
 *
 * @param value Any value from the native settings or a payload
 */
export function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
