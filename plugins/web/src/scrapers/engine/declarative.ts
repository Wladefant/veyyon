import { tryParseJson } from "@veyyon/utils";
import type { RenderResult, ScraperDegrade, ScrapeServices, SpecialHandler } from "../types";
import { buildResult, loadFailure, loadPage, scraperDegrade, tryParseUrl } from "../types";

/** Request state and services a declarative site handler receives for one scrape. */
export interface DeclarativeContext {
	url: string;
	timeout: number;
	signal?: AbortSignal;
	services?: ScrapeServices;
	fetchedAt: string;
	loadPage: typeof loadPage;
	tryParseJson: typeof tryParseJson;
	loadFailure: typeof loadFailure;
	scraperDegrade: typeof scraperDegrade;
}

/** A site described by where it lives, how a URL maps to an id, and how that id is fetched. */
export interface DeclarativeSite<TMatch, TMeta> {
	site: string;
	method: string;
	hosts: string[];
	canonicalUrls: string[];
	match: (parsedUrl: URL) => TMatch | null;
	fetch: (match: TMatch, ctx: DeclarativeContext) => Promise<TMeta | RenderResult | ScraperDegrade | null>;
	notes?: string[];
}

/** Metadata every family renders from: `customMarkdown` short-circuits the family renderer. */
export interface DeclarativeMeta {
	customMarkdown?: string | null;
}

/** `*.example.com` matches any subdomain and the bare apex; every other entry matches exactly. */
function hostMatches(hosts: Set<string>, hostname: string): boolean {
	if (hosts.has(hostname)) return true;
	for (const host of hosts) {
		if (!host.startsWith("*.")) continue;
		if (hostname.endsWith(host.slice(1)) || hostname === host.slice(2)) return true;
	}
	return false;
}

/**
 * The scrape pipeline every declarative family shares: parse the URL, accept the host, map it to a
 * match, fetch, and render. A family supplies only `renderMarkdown`, which runs when the fetch
 * returns metadata rather than a finished `RenderResult` or a degrade.
 */
export function createDeclarativeHandler<TMatch, TMeta extends DeclarativeMeta>(
	decl: DeclarativeSite<TMatch, TMeta>,
	renderMarkdown: (meta: TMeta) => string,
	handlerName?: string,
	wildcardHosts = false,
): SpecialHandler {
	const hosts = new Set(decl.hosts);

	const handler: SpecialHandler = async (
		url: string,
		timeout: number,
		signal?: AbortSignal,
		services?: ScrapeServices,
	): Promise<RenderResult | ScraperDegrade | null> => {
		try {
			const parsed = tryParseUrl(url);
			if (!parsed) return null;
			const hostname = parsed.hostname.toLowerCase();
			if (!(wildcardHosts ? hostMatches(hosts, hostname) : hosts.has(hostname))) return null;

			const match = decl.match(parsed);
			if (!match) return null;

			const fetchedAt = new Date().toISOString();
			const result = await decl.fetch(match, {
				url,
				timeout,
				signal,
				services,
				fetchedAt,
				loadPage,
				tryParseJson,
				loadFailure,
				scraperDegrade,
			});
			if (!result) return null;
			if ("content" in result || "scraperDegrade" in result) return result;

			return buildResult(result.customMarkdown || renderMarkdown(result), {
				url,
				method: decl.method,
				fetchedAt,
				notes: decl.notes ?? [`Fetched via ${decl.method} API`],
			});
		} catch (error) {
			return scraperDegrade(decl.site, error);
		}
	};

	if (handlerName) {
		Object.defineProperty(handler, "name", { value: handlerName });
	}
	return handler;
}
