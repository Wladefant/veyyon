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
	options: {
		cycles?: "reject" | "mark";
		transformValue?: (value: unknown, key?: string) => unknown;
	} = {},
): unknown {
	const ancestors = new WeakSet<object>();
	const clone = (original: unknown, key?: string): unknown => {
		const current = options.transformValue ? options.transformValue(original, key) : original;
		if (typeof current === "string") return sanitize(current);
		if (current === null || typeof current !== "object") return current;
		if (ancestors.has(current)) {
			if (options.cycles === "mark") return "[Circular]";
			throw new Error("JSON value contains a cycle.");
		}

		ancestors.add(current);
		try {
			if (Array.isArray(current)) return current.map(item => clone(item));

			const sanitized: Record<string, unknown> = {};
			for (const [key, nested] of Object.entries(current)) {
				const sanitizedKey = sanitize(key);
				if (Object.hasOwn(sanitized, sanitizedKey)) {
					throw new Error("Sanitized JSON keys collide.");
				}
				Object.defineProperty(sanitized, sanitizedKey, {
					value: clone(nested, key),
					enumerable: true,
					configurable: true,
					writable: true,
				});
			}
			return sanitized;
		} finally {
			ancestors.delete(current);
		}
	};
	return clone(value);
}
