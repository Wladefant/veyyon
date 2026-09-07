import { tryParseJson } from "@veyyon/utils";
import type { RenderResult, ScraperDegrade, ScrapeServices, SpecialHandler } from "../types";
import { buildResult, loadFailure, loadPage, scraperDegrade, tryParseUrl } from "../types";

export interface DiscussionMatch {
	id: string;
	subpath?: string;
	site?: string;
	kind?: string;
	parsedUrl: URL;
}

export interface DiscussionMeta {
	title: string;
	author?: string | null;
	date?: string | null;
	score?: number | null;
	commentsCount?: number | null;
	body?: string | null;
	url?: string | null;
	tags?: string[] | null;
	category?: string | null;
	community?: string | null;
	subreddit?: string | null;
	customMarkdown?: string | null;
}

export interface DiscussionContext {
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

export interface DiscussionDeclaration {
	site: string;
	method: string;
	hosts: string[];
	canonicalUrls: string[];
	match: (parsedUrl: URL) => DiscussionMatch | null;
	fetch: (
		match: DiscussionMatch,
		ctx: DiscussionContext,
	) => Promise<DiscussionMeta | RenderResult | ScraperDegrade | null>;
	notes?: string[];
}

export function createDiscussionHandler(decl: DiscussionDeclaration, handlerName?: string): SpecialHandler {
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

			// Handle wildcard hosts like *.stackexchange.com or *.discourse.group
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
			const ctx: DiscussionContext = {
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

			let md = `# ${result.title}\n\n`;
			if (result.author) md += `**Author:** ${result.author}\n`;
			if (result.date) md += `**Date:** ${result.date}\n`;
			if (result.score !== undefined && result.score !== null) md += `**Score:** ${result.score}\n`;
			md += "\n";
			if (result.body) md += `${result.body}\n`;

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
