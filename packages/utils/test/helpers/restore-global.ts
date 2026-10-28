/**
 * Put back a global a test replaced: an environment variable or an object
 * property returns to the value captured before the test, and is removed when
 * there was none.
 */

export function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

export function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}

/**
 * Run `run` with each variable in `patch` set, or removed where its value is `undefined`, then put
 * every one back as it was, including when `run` throws.
 */
export async function withEnv<T>(patch: Record<string, string | undefined>, run: () => T | Promise<T>): Promise<T> {
	const saved = Object.keys(patch).map(key => [key, process.env[key]] as const);
	for (const [key, value] of Object.entries(patch)) restoreEnv(key, value);
	try {
		return await run();
	} finally {
		for (const [key, value] of saved) restoreEnv(key, value);
	}
}
