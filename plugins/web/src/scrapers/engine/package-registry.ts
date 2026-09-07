import { formatNumber, tryParseJson } from "@veyyon/utils";
import type { RenderResult, ScraperDegrade, ScrapeServices, SpecialHandler } from "../types";
import { buildResult, loadFailure, loadPage, scraperDegrade, tryParseUrl } from "../types";
import { getNested } from "../utils";

export interface PackageRegistryMatch {
	name: string;
	version?: string;
	parsedUrl: URL;
}

export interface RegistryFieldMapping {
	title?: string | ((data: any) => string | undefined);
	version?: string | ((data: any) => string | undefined);
	description?: string | ((data: any) => string | undefined);
	license?: string | ((data: any) => string | undefined);
	homepage?: string | ((data: any) => string | undefined);
	repository?: string | ((data: any) => string | undefined);
	documentation?: string | ((data: any) => string | undefined);
	downloads?: string | ((data: any) => number | string | undefined);
	install?: string | ((name: string, version?: string) => string | undefined);
	dependencies?: string | ((data: any) => string[] | Record<string, string> | undefined);
	keywords?: string | ((data: any) => string[] | string | undefined);
	author?: string | ((data: any) => string | undefined);
	fields?: Record<string, string | ((data: any) => string | number | boolean | undefined)>;
}

export interface PackageRegistryContext {
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

export interface PackageRegistryDeclaration {
	site: string;
	method?: string;
	hosts: string[];
	canonicalUrls: string[];
	pathPattern?: RegExp;
	match?: (parsedUrl: URL) => PackageRegistryMatch | null;
	apiUrl?: string | ((name: string, version?: string) => string);
	headers?: Record<string, string>;
	mapping?: RegistryFieldMapping;
	downloadsApi?: {
		url: (name: string) => string;
		path?: string;
		label?: string;
	};
	readme?: string | ((data: any) => string | undefined);
	customFetch?: (
		match: PackageRegistryMatch,
		ctx: PackageRegistryContext,
	) => Promise<RenderResult | ScraperDegrade | null>;
	customTransform?: (data: any, match: PackageRegistryMatch) => any;
	notes?: string[];
}

function resolveValue(data: any, extractor?: string | ((d: any) => any)): any {
	if (!extractor) return undefined;
	if (typeof extractor === "function") return extractor(data);
	return getNested(data, extractor);
}

export function createPackageRegistryHandler(decl: PackageRegistryDeclaration, handlerName?: string): SpecialHandler {
	const hostSet = new Set(decl.hosts.map(h => h.toLowerCase()));
	const method = decl.method ?? decl.site;

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

			let match: PackageRegistryMatch | null = null;
			if (decl.match) {
				match = decl.match(parsed);
			} else if (decl.pathPattern) {
				const m = parsed.pathname.match(decl.pathPattern);
				if (m) {
					match = {
						name: decodeURIComponent(m[1]),
						version: m[2] ? decodeURIComponent(m[2]) : undefined,
						parsedUrl: parsed,
					};
				}
			}

			if (!match || !match.name) return null;

			const fetchedAt = new Date().toISOString();
			const ctx: PackageRegistryContext = {
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
			if (decl.customFetch) {
				return await decl.customFetch(match, ctx);
			}

			if (!decl.apiUrl) return null;

			const apiUrl = typeof decl.apiUrl === "function" ? decl.apiUrl(match.name, match.version) : decl.apiUrl;
			const apiRes = await ctx.loadPage(apiUrl, {
				timeout: ctx.timeout,
				signal: ctx.signal,
				headers: { Accept: "application/json", ...decl.headers },
			});

			if (!apiRes.ok) {
				return scraperDegrade(decl.site, loadFailure(apiRes));
			}

			let data = ctx.tryParseJson<any>(apiRes.content);
			if (!data) {
				return scraperDegrade(decl.site, "unexpected response shape");
			}

			if (decl.customTransform) {
				data = decl.customTransform(data, match);
			}

			const mapping = decl.mapping || {};
			const title = resolveValue(data, mapping.title) || match.name;
			const version = resolveValue(data, mapping.version) || match.version;
			const description = resolveValue(data, mapping.description);
			const license = resolveValue(data, mapping.license);
			const homepage = resolveValue(data, mapping.homepage);
			const repository = resolveValue(data, mapping.repository);
			const documentation = resolveValue(data, mapping.documentation);
			const author = resolveValue(data, mapping.author);

			let downloads: string | number | undefined = resolveValue(data, mapping.downloads);
			let downloadsLabel = "Downloads";

			if (decl.downloadsApi && downloads === undefined) {
				const dlRes = await ctx.loadPage(decl.downloadsApi.url(match.name), {
					timeout: ctx.timeout,
					signal: ctx.signal,
					headers: { Accept: "application/json", ...decl.headers },
				});
				if (dlRes.ok) {
					const dlData = ctx.tryParseJson<any>(dlRes.content);
					if (dlData) {
						downloads = decl.downloadsApi.path ? getNested(dlData, decl.downloadsApi.path) : dlData;
						if (decl.downloadsApi.label) downloadsLabel = decl.downloadsApi.label;
					}
				}
			}

			let installCmd = "";
			if (typeof mapping.install === "function") {
				installCmd = mapping.install(match.name, version) || "";
			} else if (typeof mapping.install === "string") {
				installCmd = mapping.install.replace("{name}", match.name).replace("{version}", version || "");
			}

			const keywordsVal = resolveValue(data, mapping.keywords);
			const keywords = Array.isArray(keywordsVal)
				? keywordsVal.filter((k: any) => typeof k === "string").join(", ")
				: typeof keywordsVal === "string"
					? keywordsVal
					: undefined;

			let md = `# ${title}${version ? ` v${version}` : ""}\n\n`;
			if (description) md += `${description}\n\n`;

			if (installCmd) {
				md += `\`\`\`bash\n${installCmd}\n\`\`\`\n\n`;
			}

			const metaLines: string[] = [];
			if (license) metaLines.push(`**License:** ${license}`);
			if (homepage) metaLines.push(`**Homepage:** ${homepage}`);
			if (repository) metaLines.push(`**Repository:** ${repository}`);
			if (documentation) metaLines.push(`**Documentation:** ${documentation}`);
			if (author) metaLines.push(`**Author:** ${author}`);
			if (downloads !== undefined) {
				const dlStr = typeof downloads === "number" ? formatNumber(downloads) : String(downloads);
				metaLines.push(`**${downloadsLabel}:** ${dlStr}`);
			}
			if (keywords) metaLines.push(`**Keywords:** ${keywords}`);

			if (mapping.fields) {
				for (const [key, extractor] of Object.entries(mapping.fields)) {
					const val = resolveValue(data, extractor);
					if (val !== undefined && val !== null && val !== "") {
						metaLines.push(`**${key}:** ${typeof val === "number" ? formatNumber(val) : val}`);
					}
				}
			}

			if (metaLines.length > 0) {
				md += `${metaLines.join("\n")}\n\n`;
			}

			const depsVal = resolveValue(data, mapping.dependencies);
			if (depsVal) {
				if (Array.isArray(depsVal) && depsVal.length > 0) {
					md += `## Dependencies\n\n`;
					for (const dep of depsVal.slice(0, 20)) {
						md += `- ${typeof dep === "string" ? dep : dep.name || JSON.stringify(dep)}\n`;
					}
					md += "\n";
				} else if (typeof depsVal === "object" && Object.keys(depsVal).length > 0) {
					md += `## Dependencies\n\n`;
					for (const [dep, ver] of Object.entries(depsVal).slice(0, 20)) {
						md += `- ${dep}: ${ver}\n`;
					}
					md += "\n";
				}
			}

			const readmeVal = resolveValue(data, decl.readme);
			if (readmeVal && typeof readmeVal === "string" && readmeVal.trim().length > 0) {
				md += `---\n\n## README\n\n${readmeVal.trim()}\n`;
			}

			return buildResult(md, {
				url,
				method,
				fetchedAt,
				notes: decl.notes ?? [`Fetched via ${method} API`],
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
