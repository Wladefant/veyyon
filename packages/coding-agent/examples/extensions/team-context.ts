import { createHash } from "node:crypto";

export type ContextScope = { team: string; repository: string };
export type ContextAccess = {
	scope: ContextScope;
	actor: string;
	binding: string;
	allowedPrivacy: Array<"repository" | "team">;
};
export type ContextDraft = {
	version: 1;
	id: string;
	kind: "note" | "meeting-minutes" | "conversation";
	scope: ContextScope;
	source: { uri: string; revision: string; client: string; session?: string; leaf?: string };
	revision: string;
	body: string;
	privacy: "private" | "repository" | "team";
	author: string;
};
export type ApprovedContextRecord = ContextDraft & {
	contentDigest: string;
	approval: { state: "approved"; actor: string; at: string; digest: string };
};
export type ContextReference = { text: string; title?: string; source?: string; timestamp?: string };
export type ContextReceipt = {
	status: "stored" | "duplicate" | "queued";
	id: string;
	revision: string;
	contentDigest: string;
	message: string;
	provider: Record<string, string>;
};
export type TeamContextProvider = {
	name: string;
	resolve(cwd: string, signal?: AbortSignal): Promise<ContextAccess>;
	list(cwd: string, access: ContextAccess, signal?: AbortSignal): Promise<ApprovedContextRecord[]>;
	read(cwd: string, access: ContextAccess, id: string, signal?: AbortSignal): Promise<ApprovedContextRecord | undefined>;
	search(cwd: string, access: ContextAccess, query: string, signal?: AbortSignal): Promise<ApprovedContextRecord[]>;
	publish(cwd: string, access: ContextAccess, record: ApprovedContextRecord, signal?: AbortSignal): Promise<ContextReceipt>;
	recentReferences(cwd: string, access: ContextAccess, signal?: AbortSignal): Promise<ContextReference[]>;
	searchReferences(cwd: string, access: ContextAccess, query: string, signal?: AbortSignal): Promise<ContextReference[]>;
	publishHandoff(cwd: string, access: ContextAccess, record: ApprovedContextRecord, signal?: AbortSignal): Promise<ContextReceipt>;
};

const PRIVACY: Record<string, true> = { private: true, repository: true, team: true };
const ID = /^[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown) => JSON.stringify(value);
function required(value: unknown, name: string): asserts value is string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${name}`);
}

function freezeDraft(draft: ContextDraft): ContextDraft {
	Object.freeze(draft.scope);
	Object.freeze(draft.source);
	return Object.freeze(draft);
}

function freezeRecord(record: ApprovedContextRecord): ApprovedContextRecord {
	freezeDraft(record);
	Object.freeze(record.approval);
	return Object.freeze(record);
}

function bodyDigest(body: string): string {
	return `sha256:${hash(body)}`;
}

export function createDraft(input: Omit<ContextDraft, "version" | "id">): ContextDraft {
	const { scope, source } = input;
	required(scope?.team, "team");
	required(scope?.repository, "repository");
	required(source?.uri, "source URI");
	required(source?.revision, "source revision");
	required(source?.client, "client");
	if (source.session !== undefined) required(source.session, "session");
	if (source.leaf !== undefined) required(source.leaf, "leaf");
	required(input.revision, "revision");
	required(input.body, "body");
	required(input.author, "author");
	if (!Object.hasOwn(PRIVACY, input.privacy) || !["note", "meeting-minutes", "conversation"].includes(input.kind))
		throw new Error("Invalid context kind or privacy");
	const normalized = {
		kind: input.kind,
		scope: { team: scope.team, repository: scope.repository },
		source: {
			uri: source.uri,
			revision: source.revision,
			client: source.client,
			...(source.session === undefined ? {} : { session: source.session }),
			...(source.leaf === undefined ? {} : { leaf: source.leaf }),
		},
		revision: input.revision,
		body: input.body,
		privacy: input.privacy,
		author: input.author,
	};
	const id = hash(canonical({ uri: normalized.source.uri, scope: normalized.scope }));
	return freezeDraft({ version: 1, ...normalized, id });
}

function draftOf(record: ContextDraft): ContextDraft {
	return {
		version: 1,
		id: record.id,
		kind: record.kind,
		scope: { team: record.scope.team, repository: record.scope.repository },
		source: {
			uri: record.source.uri,
			revision: record.source.revision,
			client: record.source.client,
			...(record.source.session === undefined ? {} : { session: record.source.session }),
			...(record.source.leaf === undefined ? {} : { leaf: record.source.leaf }),
		},
		revision: record.revision,
		body: record.body,
		privacy: record.privacy,
		author: record.author,
	};
}


function validateDraft(value: unknown): ContextDraft {
	if (!value || typeof value !== "object") throw new Error("Invalid context record");
	const d = value as ContextDraft;
	if (d.version !== 1 || !ID.test(d.id) || !["note", "meeting-minutes", "conversation"].includes(d.kind))
		throw new Error("Invalid context record");
	required(d.scope?.team, "team");
	required(d.scope?.repository, "repository");
	required(d.source?.uri, "source URI");
	required(d.source?.revision, "source revision");
	required(d.source?.client, "client");
	if (d.source.session !== undefined) required(d.source.session, "session");
	if (d.source.leaf !== undefined) required(d.source.leaf, "leaf");
	required(d.revision, "revision");
	required(d.body, "body");
	required(d.author, "author");
	if (!Object.hasOwn(PRIVACY, d.privacy)) throw new Error("Invalid context privacy");
	const draft = draftOf(d);
	if (hash(canonical({ uri: draft.source.uri, scope: draft.scope })) !== draft.id)
		throw new Error("Invalid context identity");
	return draft;
}

export function assertSameAccess(expected: ContextAccess, current: ContextAccess): void {
	const expectedKey = canonical({
		scope: { team: expected.scope.team, repository: expected.scope.repository },
		actor: expected.actor,
		binding: expected.binding,
		allowedPrivacy: [...expected.allowedPrivacy].sort(),
	});
	const currentKey = canonical({
		scope: { team: current.scope.team, repository: current.scope.repository },
		actor: current.actor,
		binding: current.binding,
		allowedPrivacy: [...current.allowedPrivacy].sort(),
	});
	if (expectedKey !== currentKey) throw new Error("Context authorization changed");
}

export function approveRecord(
	draft: ContextDraft,
	access: ContextAccess,
	confirmed: boolean,
	at = new Date().toISOString(),
): ApprovedContextRecord {
	if (!confirmed) throw new Error("Context approval was not confirmed");
	const clean = validateDraft(draft);
	if (clean.scope.team !== access.scope.team || clean.scope.repository !== access.scope.repository || clean.author !== access.actor)
		throw new Error("Context actor or scope mismatch");
	if (clean.privacy === "private" || !access.allowedPrivacy.includes(clean.privacy))
		throw new Error("Context privacy is not allowed");
	const contentDigest = bodyDigest(clean.body);
	if (!Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at)
		throw new Error("Invalid approval timestamp");
	const approval = { state: "approved" as const, actor: access.actor, at, digest: "" };
	approval.digest = hash(canonical({ draft: clean, contentDigest, actor: approval.actor, at: approval.at }));
	return freezeRecord({ ...clean, contentDigest, approval });
}

export function validateRecord(value: unknown, access: ContextAccess): ApprovedContextRecord {
	if (!value || typeof value !== "object") throw new Error("Invalid approved context record");
	const r = value as ApprovedContextRecord;
	const draft = validateDraft(r);
	if (draft.scope.team !== access.scope.team || draft.scope.repository !== access.scope.repository)
		throw new Error("Context scope mismatch");
	if (draft.privacy === "private" || !access.allowedPrivacy.includes(draft.privacy))
		throw new Error("Context privacy is not allowed");
	if (r.contentDigest !== bodyDigest(draft.body))
		throw new Error("Context body digest mismatch");
	if (!r.approval || r.approval.state !== "approved" || r.approval.actor !== draft.author ||
		typeof r.approval.at !== "string" || !Number.isFinite(Date.parse(r.approval.at)) ||
		new Date(r.approval.at).toISOString() !== r.approval.at || !HASH.test(r.approval.digest))
		throw new Error("Context approval is invalid");
	const expected = hash(canonical({ draft, contentDigest: r.contentDigest, actor: r.approval.actor, at: r.approval.at }));
	if (r.approval.digest !== expected) throw new Error("Context approval digest mismatch");
	return freezeRecord({ ...draft, contentDigest: r.contentDigest, approval: { ...r.approval } });
}

export function assertPublishable(record: ApprovedContextRecord, access: ContextAccess): void {
	const validated = validateRecord(record, access);
	if (validated.author !== access.actor || validated.approval.actor !== access.actor)
		throw new Error("Only the author may publish an approved context record");
}
