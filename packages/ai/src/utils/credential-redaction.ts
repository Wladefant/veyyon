/**
 * Credential redaction for text that leaves the process.
 *
 * This is a leaf on purpose. `normalizeSystemPrompts` (`../utils`) redacts every system prompt, and
 * `../utils` is on the graph of the credential store; when this code lived in `providers/transform-messages`
 * that one import dragged the whole dialect and schema machinery in behind it. See
 * `module-reach-stays-cut.test.ts`.
 */

const SENSITIVE_TOKEN_RE =
	/(?<![a-zA-Z0-9_*-])(gh[opusr]_[a-zA-Z0-9_*]{36,}|github_pat_[a-zA-Z0-9_*]{36,}|glpat-[a-zA-Z0-9_*-]{20,}|sk-proj-[a-zA-Z0-9_*-]{36,}|sk-ant-[a-zA-Z0-9_*-]{36,}|sk-[a-zA-Z0-9_*-]{48,})(?![a-zA-Z0-9_*-])/gi;

function hasPlausibleCredentialEntropy(token: string): boolean {
	const lower = token.toLowerCase();
	const prefixLen = lower.startsWith("github_pat_")
		? 11
		: lower.startsWith("glpat-")
			? 6
			: lower.startsWith("sk-proj-")
				? 8
				: lower.startsWith("sk-ant-")
					? 7
					: lower.startsWith("gh")
						? 4
						: 3;
	const secret = token.slice(prefixLen);
	return /^\*+$/.test(secret) || [/[a-z]/, /[A-Z]/, /\d/, /[_-]/].filter(p => p.test(secret)).length >= 2;
}

export function redactSensitiveCredentials(text: string): string {
	return text.replace(SENSITIVE_TOKEN_RE, match => {
		if (!hasPlausibleCredentialEntropy(match)) return match;
		const lower = match.toLowerCase();
		const tag =
			lower.startsWith("gh") || lower.startsWith("github_pat_")
				? "github"
				: lower.startsWith("glpat-")
					? "gitlab"
					: lower.startsWith("sk-ant-")
						? "anthropic"
						: "openai";
		return `[${tag}_token_redacted]`;
	});
}

export function redactSensitiveInObject(val: unknown): { result: unknown; changed: boolean } {
	if (typeof val === "string") {
		const result = redactSensitiveCredentials(val);
		return { result, changed: result !== val };
	}
	if (Array.isArray(val)) {
		let changed = false;
		const result = val.map(i => {
			const r = redactSensitiveInObject(i);
			if (r.changed) changed = true;
			return r.result;
		});
		return { result, changed };
	}
	if (val !== null && typeof val === "object") {
		let changed = false;
		const result: Record<string, unknown> = Object.create(null);
		for (const [k, v] of Object.entries(val)) {
			const targetKey = redactSensitiveCredentials(k);
			if (targetKey !== k) changed = true;
			if (Object.hasOwn(result, targetKey)) {
				throw new Error(`Redacted property key collision: "${targetKey}" conflicts with an existing key`);
			}
			const r = redactSensitiveInObject(v);
			if (r.changed) changed = true;
			Object.defineProperty(result, targetKey, {
				value: r.result,
				writable: true,
				enumerable: true,
				configurable: true,
			});
		}
		return { result: changed ? result : val, changed };
	}
	return { result: val, changed: false };
}

export function redactJsonFunctionCallArguments(argsText: string): { result: string; changed: boolean } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(argsText);
	} catch {
		const raw = redactSensitiveCredentials(argsText);
		return { result: raw, changed: raw !== argsText };
	}
	if (parsed !== null && typeof parsed === "object") {
		const { result, changed } = redactSensitiveInObject(parsed);
		if (changed) return { result: JSON.stringify(result), changed: true };
		return { result: argsText, changed: false };
	}
	const raw = redactSensitiveCredentials(argsText);
	return { result: raw, changed: raw !== argsText };
}
