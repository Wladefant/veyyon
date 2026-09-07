import type { SpecialHandler } from "../types";
import type { DeclarativeContext, DeclarativeSite } from "./declarative";
import { createDeclarativeHandler } from "./declarative";

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

export type BusinessContext = DeclarativeContext;

export type BusinessDeclaration = DeclarativeSite<BusinessMatch, BusinessMeta>;

export function createBusinessHandler(decl: BusinessDeclaration, handlerName?: string): SpecialHandler {
	return createDeclarativeHandler(decl, meta => `# ${meta.title}\n`, handlerName);
}
