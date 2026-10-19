/**
 * Request headers whose values are config references (`!command`, environment names, literals),
 * resolved through {@link resolveConfigValueSync}. A live header object re-resolves on every read,
 * so a rotated key or a changed command output reaches the next request without a reload.
 */
import { resolveConfigValueSync } from "./resolve-config-value-sync";

/** One layer of configured headers; later layers win. `undefined` is an absent layer. */
export type HeaderSource = Record<string, string> | undefined;

export interface HeaderResolutionOptions {
	/** Add `Authorization: Bearer <apiKeyConfig>` once the key resolves. */
	authHeader?: boolean;
	apiKeyConfig?: string;
}

function materializeConfigHeaderSources(
	sources: readonly HeaderSource[],
	options?: HeaderResolutionOptions,
): Record<string, string> | undefined {
	const resolved: Record<string, string> = {};
	for (const source of sources) {
		if (!source) continue;
		for (const [key, value] of Object.entries(source)) {
			const next = resolveConfigValueSync(value, `header "${key}"`);
			if (next) resolved[key] = next;
		}
	}
	if (options?.authHeader && options.apiKeyConfig) {
		const resolvedKey = resolveConfigValueSync(options.apiKeyConfig, "provider API key");
		if (resolvedKey) resolved.Authorization = `Bearer ${resolvedKey}`;
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/**
 * A header object over `sources` that resolves its values on every read. Writes land in a local
 * layer above every source. `undefined` when there is no source and no auth header to add.
 */
export function createLiveConfigHeaders(
	sources: readonly HeaderSource[],
	options?: HeaderResolutionOptions,
): Record<string, string> | undefined {
	const liveSources = sources.filter((source): source is Record<string, string> => source !== undefined);
	if (liveSources.length === 0 && (!options?.authHeader || !options.apiKeyConfig)) return undefined;

	const localHeaders: Record<string, string> = {};
	const allSources = liveSources.concat([localHeaders]);
	const current = () => materializeConfigHeaderSources(allSources, options) ?? {};
	return new Proxy(localHeaders, {
		get(target, property, receiver) {
			if (typeof property !== "string") return Reflect.get(target, property, receiver);
			return current()[property];
		},
		set(target, property, value) {
			if (typeof property !== "string" || typeof value !== "string") return false;
			target[property] = value;
			return true;
		},
		deleteProperty(target, property) {
			if (typeof property !== "string") return false;
			delete target[property];
			return true;
		},
		has(_target, property) {
			if (typeof property !== "string") return false;
			return Object.hasOwn(current(), property);
		},
		ownKeys() {
			return Reflect.ownKeys(current());
		},
		getOwnPropertyDescriptor(_target, property) {
			if (typeof property !== "string") return undefined;
			const headers = current();
			if (!Object.hasOwn(headers, property)) return undefined;
			return {
				configurable: true,
				enumerable: true,
				value: headers[property],
				writable: true,
			};
		},
	});
}

/** `headers` resolved once, as a plain object; `undefined` when nothing resolves. */
export function resolveConfigHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	return materializeConfigHeaderSources([headers]);
}
