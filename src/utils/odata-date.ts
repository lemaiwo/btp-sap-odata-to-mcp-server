/**
 * Utility to convert SAP OData legacy date strings to ISO 8601 format.
 *
 * SAP OData v2 returns dates as: /Date(1704067200000)/
 * or with timezone offset:       /Date(1704067200000+0200)/
 *
 * These are opaque to LLMs and cannot be reasoned about without conversion.
 * This module converts them to standard ISO 8601 strings transparently.
 *
 * Can be disabled via DISABLE_DATE_CONVERSION=true environment variable.
 */

const SAP_DATE_REGEX = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;

/**
 * Convert a single SAP OData date string to ISO 8601.
 * Non-matching strings are returned unchanged.
 *
 * Examples:
 *   /Date(1704067200000)/        → 2024-01-01T00:00:00.000Z
 *   /Date(1704067200000+0200)/   → 2024-01-01T02:00:00.000+02:00
 *   /Date(1704067200000-0500)/   → 2023-12-31T19:00:00.000-05:00
 */
export function convertSapDate(value: string): string {
    const match = SAP_DATE_REGEX.exec(value);
    if (!match) return value;

    const timestamp = parseInt(match[1], 10);
    const offset = match[2]; // e.g. "+0200" or "-0500" or undefined

    const date = new Date(timestamp);

    if (!offset) {
        return date.toISOString();
    }

    // Parse offset hours and minutes
    const sign = offset[0] === '+' ? 1 : -1;
    const offsetHours = parseInt(offset.slice(1, 3), 10);
    const offsetMinutes = parseInt(offset.slice(3, 5), 10);
    const totalOffsetMinutes = sign * (offsetHours * 60 + offsetMinutes);

    // Shift the date by the offset to get the local time, then format
    const localMs = timestamp + totalOffsetMinutes * 60 * 1000;
    const localDate = new Date(localMs);

    const pad = (n: number, width = 2) => String(n).padStart(width, '0');

    const isoBase =
        `${localDate.getUTCFullYear()}-${pad(localDate.getUTCMonth() + 1)}-${pad(localDate.getUTCDate())}` +
        `T${pad(localDate.getUTCHours())}:${pad(localDate.getUTCMinutes())}:${pad(localDate.getUTCSeconds())}` +
        `.${pad(localDate.getUTCMilliseconds(), 3)}`;

    const offsetStr =
        `${sign > 0 ? '+' : '-'}${pad(offsetHours)}:${pad(offsetMinutes)}`;

    return `${isoBase}${offsetStr}`;
}

/**
 * Recursively walk a JSON value (object, array, or primitive) and convert
 * all SAP date strings to ISO 8601. All other values are returned unchanged.
 */
export function convertSapDatesInResponse(data: unknown): unknown {
    if (data === null || data === undefined) return data;

    if (typeof data === 'string') {
        return convertSapDate(data);
    }

    if (Array.isArray(data)) {
        return data.map(convertSapDatesInResponse);
    }

    if (typeof data === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
            result[key] = convertSapDatesInResponse(value);
        }
        return result;
    }

    return data;
}

/**
 * Returns true if date conversion is enabled (default: true).
 * Set DISABLE_DATE_CONVERSION=true to bypass.
 */
export function isDateConversionEnabled(): boolean {
    return process.env.DISABLE_DATE_CONVERSION !== 'true';
}
