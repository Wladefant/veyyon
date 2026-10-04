/**
 * Keeps a usage credential out of everything a usage backend can say about a failure.
 *
 * A backend is handed the live key. Anything it throws, logs or returns can carry that key back: an
 * upstream that echoes the Authorization header into its error body, a `String(error)` in a warning, a
 * report whose metadata copied the request. Those strings reach the log, the credential-check result
 * shown to the user, a stored disable reason, and the `usage_cache:` row the store writes as plaintext.
 *
 * Two layers, both applied where the text is built rather than where it is displayed:
 *  - the exact secrets of the credential in hand, which catches a key of any shape (a self-hosted or
 *    extension backend's key has no vendor prefix), and
 *  - the shape-based families in `redactProviderSecrets`, which catch a credential the backend echoed
 *    that is not the one in hand (a refreshed token, a header from a redirect).
 */

import { types } from "node:util";
import { redactProviderSecrets } from "../error/error-body";
import type { UsageCredential, UsageLimit, UsageLogger, UsageReport } from "../usage";

/**
 * A credential is removed whatever its length: a short key can only be a test key or a misconfiguration,
 * and a leaked one is still a leaked one. The cost is a mangled word in an error message, which is cheap.
 */
const MIN_EXACT_SECRET_LENGTH = 1;

/** Every secret a usage credential holds, longest first so a key that contains another is removed whole. */
export function usageCredentialSecrets(credential: UsageCredential): string[] {
	const found = new Set<string>();
	for (const value of [credential.apiKey, credential.accessToken, credential.refreshToken]) {
		if (typeof value === "string" && value.length >= MIN_EXACT_SECRET_LENGTH) found.add(value);
	}
	return [...found].sort((a, b) => b.length - a.length);
}

interface SecretForm {
	/** What to look for in text. */
	pattern: string;
	/** Whether `pattern` is percent-encoded, which a server may spell with lowercase hex. */
	percentEncoded: boolean;
	/** The length of the credential this is a form of, which is what the replacement states. */
	secretLength: number;
}

const formsBySecrets = new WeakMap<readonly string[], SecretForm[]>();

/**
 * The spellings of each secret an echo can carry: as is, URL-encoded (component, whole-URL and form
 * encoding) and as the inside of a JSON string. Longest first.
 */
function secretForms(secrets: readonly string[]): SecretForm[] {
	const cached = formsBySecrets.get(secrets);
	if (cached) return cached;
	const forms = new Map<string, SecretForm>();
	const add = (pattern: string, percentEncoded: boolean, secret: string): void => {
		if (pattern.length > 0 && !forms.has(pattern)) {
			forms.set(pattern, { pattern, percentEncoded, secretLength: secret.length });
		}
	};
	for (const secret of secrets) {
		add(secret, false, secret);
		const component = encodeURIComponent(secret);
		add(component, component !== secret, secret);
		add(component.replace(/%20/g, "+"), true, secret);
		const whole = encodeURI(secret);
		add(whole, whole !== secret, secret);
		add(JSON.stringify(secret).slice(1, -1), false, secret);
		for (const spelling of wholeBase64Spellings(secret)) add(spelling, false, secret);
	}
	const result = [...forms.values()].sort((a, b) => b.pattern.length - a.pattern.length);
	formsBySecrets.set(secrets, result);
	return result;
}

/**
 * The whole-secret base64 spellings (standard and URL-safe, padded and unpadded) removed whatever the
 * secret's length, because a short accepted key is exactly as leaked when it is logged as `c2hvcnQ=`.
 * The unpadded spelling of a very short secret is a common word fragment, so it is removed only from
 * {@link MIN_UNPADDED_BASE64_FORM} characters up; the padded spelling ends in `=` and is always removed.
 */
const MIN_UNPADDED_BASE64_FORM = 6;

function wholeBase64Spellings(secret: string): string[] {
	const padded = Buffer.from(secret, "utf8").toString("base64");
	const urlSafe = padded.replace(/\+/g, "-").replace(/\//g, "_");
	const spellings: string[] = [];
	for (const form of [padded, urlSafe]) {
		if (form.endsWith("=")) spellings.push(form);
		const unpadded = form.replace(/=+$/, "");
		if (unpadded.length >= MIN_UNPADDED_BASE64_FORM) spellings.push(unpadded);
	}
	return spellings;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The shortest run of a secret that is still redacted when an echo cut the credential short. A run
 * shorter than this is too common in ordinary words and numbers to name a credential; a secret shorter
 * than this is redacted only whole.
 */
const MIN_PARTIAL_RUN = 12;

const partialFormsBySecrets = new WeakMap<readonly string[], string[]>();

/**
 * The base64 spellings of each secret an echo can carry (an Authorization header of the wrong scheme, a
 * debug dump of the encoded value): standard and URL-safe, unpadded, at each of the three alignments a
 * secret can sit in a longer encoded string. Only the characters fully determined by the secret's own
 * bytes are kept, so the spelling matches wherever the secret was embedded.
 */
function base64Spellings(secret: string): string[] {
	const bytes = Buffer.from(secret, "utf8");
	const spellings: string[] = [];
	for (let lead = 0; lead < 3; lead++) {
		const encoded = Buffer.concat([Buffer.alloc(lead, 0x78), bytes])
			.toString("base64")
			.replace(/=+$/, "");
		const from = lead === 0 ? 0 : lead + 1;
		const to = Math.floor(((lead + bytes.length) * 8) / 6);
		const middle = encoded.slice(from, to);
		if (middle.length === 0) continue;
		spellings.push(middle, middle.replace(/\+/g, "-").replace(/\//g, "_"));
	}
	return spellings;
}

/** Every plain spelling whose runs are redacted even when only part of it appears in the text. */
function partialForms(secrets: readonly string[]): string[] {
	const cached = partialFormsBySecrets.get(secrets);
	if (cached) return cached;
	const forms = new Set<string>();
	for (const secret of secrets) {
		if (secret.length >= MIN_PARTIAL_RUN) forms.add(secret);
		for (const spelling of base64Spellings(secret)) {
			if (spelling.length >= MIN_PARTIAL_RUN) forms.add(spelling);
		}
	}
	const result = [...forms];
	partialFormsBySecrets.set(secrets, result);
	return result;
}

/** Replace every run of `form` at least {@link MIN_PARTIAL_RUN} long, however much of `form` it covers. */
function redactRunsOf(text: string, form: string): string {
	if (text.length < MIN_PARTIAL_RUN) return text;
	const ranges: Array<[number, number]> = [];
	for (let start = 0; start + MIN_PARTIAL_RUN <= form.length; start++) {
		const probe = form.slice(start, start + MIN_PARTIAL_RUN);
		for (let at = text.indexOf(probe); at !== -1; at = text.indexOf(probe, at + 1)) {
			let from = at;
			let formFrom = start;
			while (from > 0 && formFrom > 0 && text[from - 1] === form[formFrom - 1]) {
				from--;
				formFrom--;
			}
			let to = at + MIN_PARTIAL_RUN;
			let formTo = start + MIN_PARTIAL_RUN;
			while (to < text.length && formTo < form.length && text[to] === form[formTo]) {
				to++;
				formTo++;
			}
			ranges.push([from, to]);
		}
	}
	if (ranges.length === 0) return text;
	ranges.sort((a, b) => a[0] - b[0]);
	let out = "";
	let cursor = 0;
	for (const [from, to] of ranges) {
		if (to <= cursor) continue;
		out += `${text.slice(cursor, Math.max(from, cursor))}<redacted credential>`;
		cursor = to;
	}
	return out + text.slice(cursor);
}

/**
 * Remove the given secrets in every spelling, any run of one that an echo cut short, then every
 * credential-shaped run, from `text`.
 */
export function redactUsageText(text: string, secrets: readonly string[]): string {
	let result = text;
	for (const form of secretForms(secrets)) {
		const replacement = `<redacted ${form.secretLength} chars>`;
		result = form.percentEncoded
			? result.replace(new RegExp(escapeRegExp(form.pattern), "gi"), replacement)
			: result.split(form.pattern).join(replacement);
	}
	for (const form of partialForms(secrets)) result = redactRunsOf(result, form);
	return redactProviderSecrets(result);
}

/** What stands in for anything the snapshot could not read without running the value's own code. */
const UNREADABLE = "[unreadable]";

const dateToISOString = Date.prototype.toISOString;
const dateGetTime = Date.prototype.getTime;

/** The own data value of `key`: an accessor is never invoked, so no code of the value's runs. */
function ownDataValue(object: object, key: PropertyKey): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

/**
 * A plain snapshot of `value` with every string inside it redacted, property names included. It runs
 * none of the value's own code: only own enumerable data properties are read, so an accessor, a
 * `toJSON`, a `toString` or a `toISOString` on the input is never called and a function is dropped.
 * Binary data becomes a placeholder, a Date is read through the intrinsic methods and an Error keeps
 * its own name and message. Anything that still throws (a Proxy trap) becomes a fixed placeholder, never
 * the error's message. Objects and arrays are rebuilt and a cycle is cut rather than followed, so a
 * hostile report cannot hang the fetch. Only the nodes on the current path count as a cycle: a node
 * reachable twice without looping is copied once and reused.
 */
export function redactUsageValue<T>(value: T, secrets: readonly string[]): T {
	return redactNode(value, secrets, new Set(), new Map(), undefined) as T;
}

/**
 * The public shape of a usage report: for each object kind, the property names the schema defines, and
 * the kind each property's value has. Those names are fixed by this codebase, never by the backend, so
 * they are kept as written: a one-character credential such as `e` would otherwise rename `provider`
 * and `scope` and make a valid report unreadable. Anything else (an unknown property, every property of
 * the free-form `metadata` and `raw`) is untrusted payload and is redacted by name and by value.
 */
type ShapeKind =
	| "report"
	| "limit"
	| "scope"
	| "window"
	| "amount"
	| "display"
	| "resetCredits"
	| "credit"
	| "result"
	| "completion"
	| "historyEntry";

/**
 * What a property's value is: `leaf` is redacted by value, `keep` is a primitive this code built itself
 * (a store row id, a provider id from the store, a digest) and is copied as written, `skip` is a value
 * this module already sanitized and must not be redacted a second time, and anything else names the
 * nested kind or list of kinds.
 */
type Spec = ShapeKind | `list:${ShapeKind}` | "leaf" | "keep" | "skip";

const SHAPES: Record<ShapeKind, Record<string, Spec>> = {
	report: {
		provider: "leaf",
		fetchedAt: "leaf",
		limits: "list:limit",
		resetCredits: "resetCredits",
		notes: "leaf",
		metadata: "leaf",
		raw: "leaf",
	},
	limit: {
		id: "leaf",
		label: "leaf",
		scope: "scope",
		window: "window",
		amount: "amount",
		status: "leaf",
		notes: "leaf",
		display: "display",
	},
	scope: {
		provider: "leaf",
		accountId: "leaf",
		projectId: "leaf",
		orgId: "leaf",
		modelId: "leaf",
		tier: "leaf",
		windowId: "leaf",
		shared: "leaf",
	},
	window: { id: "leaf", label: "leaf", durationMs: "leaf", resetsAt: "leaf" },
	amount: {
		used: "leaf",
		limit: "leaf",
		remaining: "leaf",
		usedFraction: "leaf",
		remainingFraction: "leaf",
		unit: "leaf",
	},
	display: { remaining: "leaf", inapplicable: "leaf" },
	resetCredits: { availableCount: "leaf", credits: "list:credit" },
	credit: { id: "leaf", title: "leaf", grantedAt: "leaf", expiresAt: "leaf", status: "leaf", clears: "leaf" },
	// A credential check result: only its own fields have fixed names. `report` was sanitized by
	// `redactUsageReport` and is not redacted again (a second pass would rewrite a unit such as "percent"
	// when the key is a letter in it). `completion` comes from a caller's callback, so it is a kind of its own.
	result: {
		id: "keep",
		provider: "keep",
		type: "leaf",
		email: "leaf",
		accountId: "leaf",
		orgId: "leaf",
		orgName: "leaf",
		remoteRefresh: "leaf",
		ok: "leaf",
		reason: "leaf",
		report: "skip",
		completion: "completion",
	},
	completion: { ok: "leaf", reason: "leaf", modelId: "leaf" },
	historyEntry: {
		recordedAt: "keep",
		provider: "keep",
		accountKey: "keep",
		email: "leaf",
		accountId: "leaf",
		limitId: "leaf",
		label: "leaf",
		windowLabel: "leaf",
		usedFraction: "leaf",
		status: "leaf",
		resetsAt: "leaf",
	},
};

/** The fixed vocabulary of the two enum-valued report properties; a value outside it is untrusted text. */
const ENUM_VALUES: Partial<Record<ShapeKind, Record<string, ReadonlySet<string>>>> = {
	limit: { status: new Set(["ok", "warning", "exhausted", "unknown"]) },
	amount: { unit: new Set(["percent", "tokens", "requests", "usd", "minutes", "bytes", "unknown"]) },
	result: { type: new Set(["oauth", "api_key"]) },
	historyEntry: { status: new Set(["ok", "warning", "exhausted", "unknown"]) },
};

type Ctx = { kind: ShapeKind } | { list: ShapeKind } | undefined;

/**
 * Redact a value this code built (a credential check result, the history entries of one fetch) by its
 * schema: its own property names are never rewritten, only its string values are, and an unknown
 * property (for instance an extra field a completion callback returned) is redacted by name and value.
 * `list` names the kind of each element when the root is an array.
 */
export function redactUsageShape<T>(value: T, secrets: readonly string[], shape: ShapeKind | `list:${ShapeKind}`): T {
	const ctx: Ctx = shape.startsWith("list:") ? { list: shape.slice(5) as ShapeKind } : { kind: shape as ShapeKind };
	return redactNode(value, secrets, new Set(), new Map(), ctx) as T;
}

function redactNode(
	value: unknown,
	secrets: readonly string[],
	ancestors: Set<object>,
	done: Map<object, unknown>,
	ctx: Ctx,
): unknown {
	if (typeof value === "string") return redactUsageText(value, secrets);
	if (typeof value === "bigint") return redactUsageText(`${value}`, secrets);
	if (typeof value === "symbol") return undefined;
	if (typeof value === "function") return isOrInheritsFromProxy(value) ? UNREADABLE : undefined;
	if (value === null || typeof value !== "object") return value;
	// A Proxy runs its traps on every reflective read, so it is never reflected on.
	if (isOrInheritsFromProxy(value)) return UNREADABLE;
	if (ancestors.has(value)) return undefined;
	// A node reached under a schema kind is not shared with the same node reached as free-form payload.
	if (ctx === undefined && done.has(value)) return done.get(value);
	ancestors.add(value);
	try {
		const copy = snapshotObject(value, secrets, ancestors, done, ctx);
		if (ctx === undefined) done.set(value, copy);
		return copy;
	} catch {
		return UNREADABLE;
	} finally {
		ancestors.delete(value);
	}
}

function snapshotObject(
	value: object,
	secrets: readonly string[],
	ancestors: Set<object>,
	done: Map<object, unknown>,
	ctx: Ctx,
): unknown {
	if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
		return "[binary data]";
	}
	if (value instanceof Date) {
		const time = dateGetTime.call(value);
		return Number.isNaN(time) ? null : redactUsageText(dateToISOString.call(value), secrets);
	}
	if (value instanceof Error) {
		const name = ownDataValue(value, "name");
		const message = ownDataValue(value, "message");
		const label = typeof name === "string" ? name : "Error";
		return redactUsageText(typeof message === "string" ? `${label}: ${message}` : label, secrets);
	}
	if (Array.isArray(value)) {
		const length = ownDataValue(value, "length");
		const items: unknown[] = [];
		for (let index = 0; typeof length === "number" && index < length; index++) {
			const itemCtx: Ctx = ctx !== undefined && "list" in ctx ? { kind: ctx.list } : undefined;
			items.push(redactNode(ownDataValue(value, index), secrets, ancestors, done, itemCtx));
		}
		return items;
	}
	const entries: Array<[string, unknown]> = [];
	for (const key of Object.keys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || !("value" in descriptor)) continue;
		const kind = ctx !== undefined && "kind" in ctx ? ctx.kind : undefined;
		// Own-property lookups only: a data key named `toString` or `constructor` is untrusted payload.
		const child = kind !== undefined && Object.hasOwn(SHAPES[kind], key) ? SHAPES[kind][key] : undefined;
		if (kind === undefined || child === undefined) {
			entries.push([
				redactUsageText(key, secrets),
				redactNode(descriptor.value, secrets, ancestors, done, undefined),
			]);
			continue;
		}
		if (child === "skip") {
			entries.push([key, descriptor.value]);
			continue;
		}
		if (child === "keep" && isPrimitiveData(descriptor.value)) {
			entries.push([key, descriptor.value]);
			continue;
		}
		const enumValues = ENUM_VALUES[kind];
		const allowed = enumValues !== undefined && Object.hasOwn(enumValues, key) ? enumValues[key] : undefined;
		if (allowed !== undefined && typeof descriptor.value === "string" && allowed.has(descriptor.value)) {
			entries.push([key, descriptor.value]);
			continue;
		}
		const childCtx: Ctx =
			child === "leaf" || child === "keep"
				? undefined
				: child.startsWith("list:")
					? { list: child.slice(5) as ShapeKind }
					: { kind: child as ShapeKind };
		entries.push([key, redactNode(descriptor.value, secrets, ancestors, done, childCtx)]);
	}
	return Object.fromEntries(entries);
}

/**
 * The redacted snapshot of a usage report, or undefined when what came back is not a report: not a plain
 * object, or missing `provider`, `fetchedAt` or a `limits` array once snapshotted (an unreadable root
 * becomes a placeholder string, a getter is not read). A limit without an `amount` and a `scope` object is
 * dropped, so a reader may take `limit.scope` and `limit.amount` unguarded.
 */
export function redactUsageReport(report: UsageReport, secrets: readonly string[]): UsageReport | undefined {
	const snapshot = redactNode(report, secrets, new Set(), new Map(), { kind: "report" });
	if (!isRecord(snapshot)) return undefined;
	if (typeof snapshot.provider !== "string" || typeof snapshot.fetchedAt !== "number") return undefined;
	if (!Array.isArray(snapshot.limits)) return undefined;
	return {
		...(snapshot as unknown as UsageReport),
		limits: snapshot.limits.filter(
			(limit): limit is UsageLimit => isRecord(limit) && isRecord(limit.amount) && isRecord(limit.scope),
		),
	};
}

function isPrimitiveData(value: unknown): value is string | number | boolean | null {
	return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Redacted text for a caught value, taken from the same no-user-code snapshot as a report: an Error
 * keeps its own message (its name when it has none), an accessor or a Proxy is never run, and a throw while reading
 * gives a fixed placeholder. Use it instead of `String(error)` wherever the error came from a backend.
 */
export function redactUsageError(error: unknown, secrets: readonly string[]): string {
	try {
		switch (typeof error) {
			case "string":
				return redactUsageText(error, secrets);
			case "bigint":
				return redactUsageText(`${error}`, secrets);
			case "symbol":
				return "[symbol]";
			case "undefined":
			case "number":
			case "boolean":
				return String(error);
			default:
		}
		if (error === null || error === undefined) return String(error);
		// Before any typeof branch: a callable Proxy is a function, and every reflective read of a Proxy
		// (or of a value whose prototype is one) runs its traps.
		if (isOrInheritsFromProxy(error)) return UNREADABLE;
		if (typeof error === "function") return "[function]";
		if (error instanceof Error) {
			const message = ownDataValue(error, "message");
			if (typeof message === "string") return redactUsageText(message, secrets);
		}
		const snapshot = redactUsageValue(error, secrets);
		return typeof snapshot === "string" ? snapshot : (JSON.stringify(snapshot) ?? String(snapshot));
	} catch {
		return UNREADABLE;
	}
}

/** A logger that redacts the message and every string in the metadata before the wrapped logger sees it. */
export function redactingUsageLogger(
	logger: UsageLogger | undefined,
	secrets: readonly string[],
): UsageLogger | undefined {
	if (!logger) return undefined;
	return {
		debug: (message, meta) => logger.debug(redactUsageText(message, secrets), redactUsageValue(meta, secrets)),
		warn: (message, meta) => logger.warn(redactUsageText(message, secrets), redactUsageValue(meta, secrets)),
	};
}

/**
 * Whether the value or anything on its prototype chain is a Proxy. `instanceof` and an inherited property
 * read ask a Proxy prototype's traps, so a value with one is never reflected on.
 */
function isOrInheritsFromProxy(value: object): boolean {
	let node: object | null = value;
	for (let depth = 0; node !== null && depth < 32; depth++) {
		if (types.isProxy(node)) return true;
		node = Object.getPrototypeOf(node);
	}
	return node !== null;
}

/**
 * The numeric `status` of a thrown HTTP error, read without running user code: a Proxy anywhere on the
 * prototype chain is never asked anything, and `status` is taken only from a data property, so a getter
 * (which may throw the credential) is not called. Anything unreadable is undefined, which callers treat
 * as a generic failure.
 */
export function usageErrorStatus(error: unknown): number | undefined {
	let node: unknown = error;
	for (let depth = 0; depth < 32 && typeof node === "object" && node !== null; depth++) {
		if (types.isProxy(node)) return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(node, "status");
		if (descriptor !== undefined) {
			return "value" in descriptor && typeof descriptor.value === "number" ? descriptor.value : undefined;
		}
		node = Object.getPrototypeOf(node);
	}
	return undefined;
}
