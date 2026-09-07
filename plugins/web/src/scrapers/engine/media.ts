import type { SpecialHandler } from "../types";
import type { DeclarativeContext, DeclarativeSite } from "./declarative";
import { createDeclarativeHandler } from "./declarative";

export interface MediaMatch {
	id: string;
	kind?: string;
	parsedUrl: URL;
}

export interface MediaMeta {
	title: string;
	customMarkdown?: string | null;
}

export type MediaContext = DeclarativeContext;

export type MediaDeclaration = DeclarativeSite<MediaMatch, MediaMeta>;

export function createMediaHandler(decl: MediaDeclaration, handlerName?: string): SpecialHandler {
	return createDeclarativeHandler(decl, meta => `# ${meta.title}\n`, handlerName);
}
