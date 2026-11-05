/**
 * Clone a JSON value while applying the producer's text guard to every string.
 *
 * Sanitize before JSON.stringify so control characters cannot hide registered
 * values behind JSON escaping. Object keys are text too, so a collision after
 * sanitization fails closed rather than changing the value's meaning.
 */
export function sanitizeJsonValue(
	value: unknown,
	sanitize: (text: string) => string,
	ancestors = new WeakSet<object>(),
): unknown {
	if (typeof value === "string") return sanitize(value);
	if (value === null || typeof value !== "object") return value;
	if (ancestors.has(value)) throw new Error("JSON value contains a cycle.");

	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map(item => sanitizeJsonValue(item, sanitize, ancestors));
		}

		const sanitized: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(value)) {
			const sanitizedKey = sanitize(key);
			if (Object.hasOwn(sanitized, sanitizedKey)) {
				throw new Error("Sanitized JSON keys collide.");
			}
			Object.defineProperty(sanitized, sanitizedKey, {
				value: sanitizeJsonValue(nested, sanitize, ancestors),
				enumerable: true,
				configurable: true,
				writable: true,
			});
		}
		return sanitized;
	} finally {
		ancestors.delete(value);
	}
}
