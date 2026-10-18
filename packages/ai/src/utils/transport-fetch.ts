import * as fs from "node:fs";
import { coworkFetch } from "../providers/cowork-fetch";
import { withInferenceUserAgent } from "../providers/inference-headers";
import type { Api, FetchImpl, Model } from "../types";
import { getProxyForProvider, shouldBypassProxy } from "./proxy";
import { isRequestDebugEnabled, wrapFetchForRequestDebug } from "./request-debug";

/**
 * Return `init` with `proxy: proxyUrl` set when the request should tunnel.
 * A caller-supplied `init.proxy` always wins (the innermost, most specific
 * decision); Unix sockets, local/metadata hosts, NO_PROXY matches, and
 * unparseable URLs pass through unchanged.
 */
export function withProxyInit(
	input: string | URL | Request,
	init: RequestInit | undefined,
	proxyUrl: string,
): RequestInit | undefined {
	if (init && (("unix" in init && init.unix) || ("proxy" in init && init.proxy))) return init;
	const urlStr = input instanceof Request ? input.url : input.toString();
	let urlObj: URL;
	try {
		urlObj = new URL(urlStr);
	} catch {
		return init;
	}

	if (shouldBypassProxy(urlObj)) {
		return init;
	}

	const proxied: RequestInit & { proxy: string } = { ...init, proxy: proxyUrl };
	return proxied;
}

let extraCaCacheKey: string | undefined;
let extraCaCacheValue: string | undefined;

/**
 * Returns the PEM bytes referenced by `NODE_EXTRA_CA_CERTS`, or `undefined`
 * when the env var is unset or empty.
 */
export function resolveExtraCa(): string | undefined {
	const raw = Bun.env.NODE_EXTRA_CA_CERTS?.trim();
	if (!raw) return undefined;

	let key: string;
	if (raw.includes("-----BEGIN")) {
		key = raw;
	} else {
		try {
			key = `${raw}@${fs.statSync(raw).mtimeMs}`;
		} catch {
			return undefined;
		}
	}

	if (key === extraCaCacheKey) return extraCaCacheValue;
	extraCaCacheKey = key;

	if (raw.includes("-----BEGIN")) {
		extraCaCacheValue = raw;
		return raw;
	}

	try {
		extraCaCacheValue = fs.readFileSync(raw, "utf8");
		return extraCaCacheValue;
	} catch {
		extraCaCacheValue = undefined;
		return undefined;
	}
}

/**
 * Merge `extraCa` into `init.tls.ca`. When the caller has not supplied a CA
 * list, the PEM is wrapped in an array. When `init.tls` is present (such as
 * Anthropic Foundry's mTLS options, which already seed
 * `tls.rootCertificates`), only the extra CA is appended.
 */
export function withExtraCaInit(init: RequestInit | undefined, extraCa: string): RequestInit {
	const existingTls = (init as (RequestInit & { tls?: { ca?: string | string[]; rootCertificates?: string[] } }) | undefined)?.tls;
	const existingCa = existingTls?.ca;
	let mergedCa: string[];
	if (existingCa === undefined) {
		mergedCa = existingTls?.rootCertificates ? existingTls.rootCertificates.concat([extraCa]) : [extraCa];
	} else if (Array.isArray(existingCa)) {
		mergedCa = existingCa.concat([extraCa]);
	} else {
		mergedCa = [existingCa, extraCa];
	}
	return { ...init, tls: { ...existingTls, ca: mergedCa } } as RequestInit;
}

/** Stamped on a fetch already built by {@link transportFetch}. */
const TRANSPORT_FETCH = Symbol("veyyon.transportFetch");

type TransportFetch = FetchImpl & { [TRANSPORT_FETCH]?: true };

/**
 * The one fetch every inference request goes through. Per call it applies, in
 * order: the inference User-Agent default, `NODE_EXTRA_CA_CERTS`, the
 * per-provider proxy, and `PI_REQ_DEBUG` request/response recording — then
 * calls `fetchImpl` (or the model's default fetch) exactly once. Providers
 * never layer transport concerns themselves.
 *
 * Idempotent: the built fetch is stamped and returned as-is on later passes.
 * `streamSimple` re-enters `stream`, and `streamSimpleRequest` re-enters itself
 * on auth retries, so without the stamp each entry point would add another
 * layer (three PI_REQ_DEBUG dumps for one request).
 */
export function transportFetch(model: Model<Api>, fetchImpl: FetchImpl | undefined): FetchImpl {
	const given = fetchImpl as TransportFetch | undefined;
	if (given?.[TRANSPORT_FETCH]) return given;
	const base =
		given ?? (model.provider === "anthropic" && model.api === "anthropic-messages" ? coworkFetch : globalThis.fetch);
	const proxyUrl = getProxyForProvider(model.provider);

	const fetch: TransportFetch = async (input, init) => {
		if ((init?.method ?? (input instanceof Request ? input.method : "GET")) === "POST") {
			recordDispatchOrigin(model, input);
		}
		init = withInferenceUserAgent(input, init);
		const extraCa = resolveExtraCa();
		if (extraCa) init = withExtraCaInit(init, extraCa);
		if (proxyUrl) init = withProxyInit(input, init, proxyUrl);
		if (!isRequestDebugEnabled()) return base(input, init);
		return wrapFetchForRequestDebug(base)(input, init);
	};
	if (base.preconnect) fetch.preconnect = base.preconnect;
	fetch[TRANSPORT_FETCH] = true;
	return fetch;
}

const dispatchOrigins = new Map<string, string>();
const DISPATCH_ORIGIN_CACHE_MAX = 1024;

function dispatchKey(model: Model<Api>): string {
	return `${model.provider}\u0000${model.baseUrl}`;
}

function recordDispatchOrigin(model: Model<Api>, input: string | URL | Request): void {
	let origin: string;
	try {
		origin = new URL(input instanceof Request ? input.url : input).origin;
	} catch {
		return;
	}
	const key = dispatchKey(model);
	if (dispatchOrigins.get(key) === origin) return;
	if (dispatchOrigins.size >= DISPATCH_ORIGIN_CACHE_MAX) dispatchOrigins.clear();
	dispatchOrigins.set(key, origin);
}

/**
 * Origin of the last inference request {@link model} actually sent, after
 * every dispatch-time rewrite (credential endpoints, env overrides, regional
 * hosts); `undefined` before its first request.
 */
export function lastDispatchOrigin(model: Model<Api>): string | undefined {
	return dispatchOrigins.get(dispatchKey(model));
}

/** Test hook: forgets every recorded dispatch origin. */
export function resetDispatchOriginsForTesting(): void {
	dispatchOrigins.clear();
}

/** Options-bag form of {@link transportFetch}; returns `options` untouched when its fetch is already built. */
export function withTransportFetch<T extends { fetch?: FetchImpl }>(model: Model<Api>, options: T): T {
	const fetch = transportFetch(model, options.fetch);
	return fetch === options.fetch ? options : { ...options, fetch };
}
