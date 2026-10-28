/**
 * Put back a global a test replaced: an environment variable or an object
 * property returns to the value captured before the test, and is removed when
 * there was none.
 */

export function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

/** Put `process.env` back to `snapshot`: a key added since is removed, a changed or removed key returns. */
export function restoreEnvSnapshot(snapshot: Readonly<Record<string, string | undefined>>): void {
	for (const key in process.env) {
		if (!(key in snapshot)) delete process.env[key];
	}
	for (const key in snapshot) restoreEnv(key, snapshot[key]);
}

export function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}
