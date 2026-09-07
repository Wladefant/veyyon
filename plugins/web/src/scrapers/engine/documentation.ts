import { tryParseJson } from "@veyyon/utils";
import type { RenderResult, ScraperDegrade, ScrapeServices, SpecialHandler } from "../types";
import { buildResult, loadFailure, loadPage, scraperDegrade, tryParseUrl } from "../types";

export interface DocMatch {
	id: string;
	lang?: string;
	topic?: string;
	platform?: string;
	parsedUrl: URL;
}

export interface DocMeta {
	title: string;
	customMarkdown?: string | null;
}

export interface DocContext {
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

export interface DocDeclaration {
	site: string;
	method: string;
	hosts: string[];
	canonicalUrls: string[];
	match: (parsedUrl: URL) => DocMatch | null;
	fetch: (match: DocMatch, ctx: DocContext) => Promise<DocMeta | RenderResult | ScraperDegrade | null>;
	notes?: string[];
}

export function createDocumentationHandler(decl: DocDeclaration, handlerName?: string): SpecialHandler {
	const hostSet = new Set(decl.hosts);

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
			const matchesHost =
				hostSet.has(hostname) ||
				Array.from(hostSet).some(h => {
					if (h.startsWith("*.")) {
						return hostname.endsWith(h.slice(1)) || hostname === h.slice(2);
					}
					return false;
				});
			if (!matchesHost) return null;

			const match = decl.match(parsed);
			if (!match) return null;

			const fetchedAt = new Date().toISOString();
			const ctx: DocContext = {
				url,
				timeout,
				signal,
				services,
				fetchedAt,
				loadPage,
				tryParseJson,
				loadFailure,
				scraperDegrade,
			};
			const result = await decl.fetch(match, ctx);
			if (!result) return null;

			if ("content" in result || "scraperDegrade" in result) {
				return result;
			}

			return buildResult(result.customMarkdown || `# ${result.title}\n`, {
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
