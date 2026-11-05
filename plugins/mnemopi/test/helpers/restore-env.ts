/** Put `process.env` back to `snapshot`: a key added since is removed, a changed or removed key returns. */
export function restoreEnvSnapshot(snapshot: Readonly<Record<string, string | undefined>>): void {
	for (const key in process.env) {
		if (!(key in snapshot)) delete process.env[key];
	}
	for (const key in snapshot) {
		const value = snapshot[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}
