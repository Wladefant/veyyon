import type { SpecialHandler } from "../types";
import type { DeclarativeContext, DeclarativeSite } from "./declarative";
import { createDeclarativeHandler } from "./declarative";

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

export type DiscussionContext = DeclarativeContext;

export type DiscussionDeclaration = DeclarativeSite<DiscussionMatch, DiscussionMeta>;

function renderDiscussion(meta: DiscussionMeta): string {
	let md = `# ${meta.title}\n\n`;
	if (meta.author) md += `**Author:** ${meta.author}\n`;
	if (meta.date) md += `**Date:** ${meta.date}\n`;
	if (meta.score !== undefined && meta.score !== null) md += `**Score:** ${meta.score}\n`;
	md += "\n";
	if (meta.body) md += `${meta.body}\n`;
	return md;
}

export function createDiscussionHandler(decl: DiscussionDeclaration, handlerName?: string): SpecialHandler {
	return createDeclarativeHandler(decl, renderDiscussion, handlerName, true);
}
