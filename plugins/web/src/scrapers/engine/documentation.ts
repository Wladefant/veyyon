import type { SpecialHandler } from "../types";
import type { DeclarativeContext, DeclarativeSite } from "./declarative";
import { createDeclarativeHandler } from "./declarative";

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

export type DocContext = DeclarativeContext;

export type DocDeclaration = DeclarativeSite<DocMatch, DocMeta>;

export function createDocumentationHandler(decl: DocDeclaration, handlerName?: string): SpecialHandler {
	return createDeclarativeHandler(decl, meta => `# ${meta.title}\n`, handlerName, true);
}
