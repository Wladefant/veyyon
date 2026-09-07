import type { SpecialHandler } from "../types";
import type { DeclarativeContext, DeclarativeSite } from "./declarative";
import { createDeclarativeHandler } from "./declarative";

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

export type SecurityContext = DeclarativeContext;

export type SecurityAdvisoryDeclaration = DeclarativeSite<SecurityMatch, SecurityAdvisoryMeta>;

function renderAdvisory(meta: SecurityAdvisoryMeta): string {
	let md = `# ${meta.id}\n\n`;
	if (meta.title) md += `${meta.title}\n\n`;
	if (meta.description) md += `## Description\n\n${meta.description}\n\n`;
	return md;
}

export function createSecurityAdvisoryHandler(decl: SecurityAdvisoryDeclaration, handlerName?: string): SpecialHandler {
	return createDeclarativeHandler(decl, renderAdvisory, handlerName);
}
