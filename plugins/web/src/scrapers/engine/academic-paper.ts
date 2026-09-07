import { formatNumber, tryParseJson } from "@veyyon/utils";
import type { RenderResult, ScraperDegrade, ScrapeServices, SpecialHandler } from "../types";
import { buildResult, loadFailure, loadPage, scraperDegrade, tryParseUrl } from "../types";
import { getNested } from "../utils";

export interface AcademicMatch {
	id: string;
	isPdf?: boolean;
	server?: string;
	doi?: string;
	pmid?: string;
	rfcNumber?: string;
	parsedUrl: URL;
}

export interface AcademicFieldMapping {
	title?: string | ((data: any) => string | undefined);
	authors?: string | ((data: any) => string[] | string | undefined);
	abstract?: string | ((data: any) => string | undefined);
	doi?: string | ((data: any) => string | undefined);
	published?: string | ((data: any) => string | null | undefined);
	journal?: string | ((data: any) => string | undefined);
	citations?: string | ((data: any) => number | string | undefined);
	subjects?: string | ((data: any) => string[] | string | undefined);
	fields?: Record<string, string | ((data: any) => string | number | undefined)>;
}

export interface AcademicPaperMeta {
	title: string;
	authors?: string[];
	abstract?: string;
	doi?: string;
	published?: string;
	journal?: string;
	citations?: number | string;
	customMarkdown?: string;
}

export interface AcademicPaperContext {
	url: string;
	timeout: number;
	signal?: AbortSignal;
	services?: ScrapeServices;
	fetchedAt: string;
	notes: string[];
	loadPage: typeof loadPage;
	tryParseJson: typeof tryParseJson;
	loadFailure: typeof loadFailure;
	scraperDegrade: typeof scraperDegrade;
}

export interface AcademicPaperDeclaration {
	site: string;
	method: string | ((match: AcademicMatch) => string);
	hosts: string[];
	canonicalUrls: string[];
	match: (parsedUrl: URL) => AcademicMatch | null;
	apiUrl?: string | ((match: AcademicMatch) => string);
	headers?: Record<string, string>;
	mapping?: AcademicFieldMapping;
	customTransform?: (data: any, match: AcademicMatch) => any;
	fetch?: (
		match: AcademicMatch,
		ctx: AcademicPaperContext,
	) => Promise<AcademicPaperMeta | RenderResult | ScraperDegrade | null>;
	notes?: string[] | ((match: AcademicMatch, meta?: AcademicPaperMeta) => string[]);
}

function resolveValue(data: any, extractor?: string | ((d: any) => any)): any {
	if (!extractor) return undefined;
	if (typeof extractor === "function") return extractor(data);
	return getNested(data, extractor);
}

export function createAcademicPaperHandler(decl: AcademicPaperDeclaration, handlerName?: string): SpecialHandler {
	const hostSet = new Set(decl.hosts.map(h => h.toLowerCase()));

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
			const notes: string[] = [];
			const ctx: AcademicPaperContext = {
				url,
				timeout,
				signal,
				services,
				fetchedAt,
				notes,
				loadPage,
				tryParseJson,
				loadFailure,
				scraperDegrade,
			};

			if (decl.fetch) {
				const result = await decl.fetch(match, ctx);
				if (!result) return null;

				if ("content" in result || "scraperDegrade" in result) {
					return result;
				}

				if (result.customMarkdown) {
					const method = typeof decl.method === "function" ? decl.method(match) : decl.method;
					const noteList =
						typeof decl.notes === "function"
							? decl.notes(match, result)
							: (decl.notes ?? [`Fetched via ${method} API`]);
					return buildResult(result.customMarkdown, {
						url,
						method,
						fetchedAt,
						notes: ctx.notes.length > 0 ? ctx.notes : noteList,
					});
				}

				const method = typeof decl.method === "function" ? decl.method(match) : decl.method;
				return buildResult(result.title, {
					url,
					method,
					fetchedAt,
					notes: ctx.notes.length > 0 ? ctx.notes : [`Fetched via ${method} API`],
				});
			}

			if (!decl.apiUrl) return null;
			const apiUrl = typeof decl.apiUrl === "function" ? decl.apiUrl(match) : decl.apiUrl;
			const apiRes = await ctx.loadPage(apiUrl, {
				timeout: ctx.timeout,
				signal: ctx.signal,
				headers: { Accept: "application/json", ...decl.headers },
			});

			if (!apiRes.ok) return scraperDegrade(decl.site, loadFailure(apiRes));
			let data = ctx.tryParseJson<any>(apiRes.content);
			if (!data) return scraperDegrade(decl.site, "unexpected response shape");

			if (decl.customTransform) {
				data = decl.customTransform(data, match);
			}

			const mapping = decl.mapping || {};
			const title = resolveValue(data, mapping.title) || match.id;
			const authors = resolveValue(data, mapping.authors);
			const abstract = resolveValue(data, mapping.abstract);
			const doi = resolveValue(data, mapping.doi);
			const published = resolveValue(data, mapping.published);
			const journal = resolveValue(data, mapping.journal);
			const citations = resolveValue(data, mapping.citations);
			const subjects = resolveValue(data, mapping.subjects);

			let md = `# ${title}\n\n`;
			if (authors) {
				const authStr = Array.isArray(authors) ? authors.join(", ") : String(authors);
				md += `**Authors:** ${authStr}\n`;
			}
			if (published) md += `**Published:** ${published}\n`;
			if (journal) md += `**Journal:** ${journal}\n`;
			if (doi) md += `**DOI:** ${doi}\n`;
			if (citations !== undefined)
				md += `**Citations:** ${typeof citations === "number" ? formatNumber(citations) : citations}\n`;
			if (subjects) {
				const subjStr = Array.isArray(subjects) ? subjects.join(", ") : String(subjects);
				md += `**Subjects:** ${subjStr}\n`;
			}

			if (mapping.fields) {
				for (const [key, extractor] of Object.entries(mapping.fields)) {
					const val = resolveValue(data, extractor);
					if (val !== undefined && val !== null && val !== "") {
						md += `**${key}:** ${typeof val === "number" ? formatNumber(val) : val}\n`;
					}
				}
			}

			if (abstract) {
				md += `\n---\n\n## Abstract\n\n${abstract}\n`;
			}

			const method = typeof decl.method === "function" ? decl.method(match) : decl.method;
			const noteList =
				typeof decl.notes === "function" ? decl.notes(match) : (decl.notes ?? [`Fetched via ${method} API`]);

			return buildResult(md, {
				url,
				method,
				fetchedAt,
				notes: ctx.notes.length > 0 ? ctx.notes : noteList,
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
