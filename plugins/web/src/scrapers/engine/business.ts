import { tryParseJson } from "@veyyon/utils";
import type { RenderResult, ScraperDegrade, ScrapeServices, SpecialHandler } from "../types";
import { buildResult, loadFailure, loadPage, scraperDegrade, tryParseUrl } from "../types";

export interface BusinessMatch {
	id: string;
	jurisdiction?: string;
	companyNumber?: string;
	query?: string;
	kind?: string;
	parsedUrl: URL;
}

export interface BusinessMeta {
	title: string;
	customMarkdown?: string | null;
}

export interface BusinessContext {
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

export interface BusinessDeclaration {
	site: string;
	method: string;
	hosts: string[];
	canonicalUrls: string[];
	match: (parsedUrl: URL) => BusinessMatch | null;
	fetch: (match: BusinessMatch, ctx: BusinessContext) => Promise<BusinessMeta | RenderResult | ScraperDegrade | null>;
	notes?: string[];
}

export function createBusinessHandler(decl: BusinessDeclaration, handlerName?: string): SpecialHandler {
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
			if (!hostSet.has(parsed.hostname.toLowerCase())) return null;

			const match = decl.match(parsed);
			if (!match) return null;

			const fetchedAt = new Date().toISOString();
			const ctx: BusinessContext = {
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
