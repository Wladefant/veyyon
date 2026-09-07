import { tryParseJson } from "@veyyon/utils";
import type { RenderResult, ScraperDegrade, ScrapeServices, SpecialHandler } from "../types";
import { buildResult, loadFailure, loadPage, scraperDegrade, tryParseUrl } from "../types";

export interface SecurityMatch {
	id: string;
	parsedUrl: URL;
}

export interface SecurityAdvisoryMeta {
	id: string;
	title?: string | null;
	vendor?: string | null;
	product?: string | null;
	dateAdded?: string | null;
	published?: string | null;
	modified?: string | null;
	dueDate?: string | null;
	severity?: {
		score?: number | string;
		vector?: string;
		level?: string;
	} | null;
	description?: string | null;
	requiredAction?: string | null;
	affected?: Array<{
		package?: string;
		ecosystem?: string;
		ranges?: string[];
	}> | null;
	cpes?: string[] | null;
	weaknesses?: string[] | null;
	references?: Array<{ url: string; tags?: string[] }> | string[] | null;
	customMarkdown?: string | null;
}

export interface SecurityContext {
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

export interface SecurityAdvisoryDeclaration {
	site: string;
	method: string;
	hosts: string[];
	canonicalUrls: string[];
	match: (parsedUrl: URL) => SecurityMatch | null;
	fetch: (
		match: SecurityMatch,
		ctx: SecurityContext,
	) => Promise<SecurityAdvisoryMeta | RenderResult | ScraperDegrade | null>;
	notes?: string[];
}

export function createSecurityAdvisoryHandler(decl: SecurityAdvisoryDeclaration, handlerName?: string): SpecialHandler {
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
			const ctx: SecurityContext = {
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

			if (result.customMarkdown) {
				return buildResult(result.customMarkdown, {
					url,
					method: decl.method,
					fetchedAt,
					notes: decl.notes ?? [`Fetched via ${decl.method} API`],
				});
			}

			let md = `# ${result.id}\n\n`;
			if (result.title) md += `${result.title}\n\n`;
			if (result.description) md += `## Description\n\n${result.description}\n\n`;

			return buildResult(md, {
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
