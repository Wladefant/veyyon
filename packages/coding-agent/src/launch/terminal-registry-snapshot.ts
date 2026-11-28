import { type AgentRef, AgentRegistry, type AgentStatus } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";

export const REGISTRY_SNAPSHOT_CAPABILITY = "registry-snapshot-v1";
const MAX_ROWS = 128;
const MAX_REFS_VISITED = 4096;
// Bound JSON size even when every code unit needs a six-byte JSON escape.
export const MAX_REGISTRY_SNAPSHOT_TEXT = 160;

interface RegistrySnapshotAgent {
	id: string;
	rootId: string;
	parentId: string | null;
	displayName: string;
	kind: "root" | "subagent" | "advisor";
	status: AgentStatus;
	live: boolean;
	model: string | null;
	lastActivity: number | null;
	waitingOnPeer: boolean;
	blockedOnApproval: boolean;
}

export interface RegistrySnapshotObservation {
	/** Unix time in milliseconds. All rows describe the same in-memory observation. */
	observedAt: number;
	/** Partial if any limit was hit or a parent could not be verified within the scope. */
	coverage: "complete" | "partial";
	truncated: boolean;
	agents: RegistrySnapshotAgent[];
}

/** Capture one turn of the owning runtime. Do not read transcripts or use permissive UI scoping. */
export function observeTerminalRegistry(
	sessionId: string,
	session: AgentSession,
): RegistrySnapshotObservation | undefined {
	const registry = AgentRegistry.global();
	const root = session.registryAgentId ? registry.get(session.registryAgentId) : undefined;
	if (
		root?.kind !== "main" ||
		root.scope !== sessionId ||
		root.session !== session ||
		session.isDisposed ||
		root.id.length > MAX_REGISTRY_SNAPSHOT_TEXT ||
		sessionId.length > MAX_REGISTRY_SNAPSHOT_TEXT
	)
		return;

	const observedAt = Date.now();
	let truncated = false;
	let incompleteLineage = false;
	const agents = new Map<string, RegistrySnapshotAgent>();
	const inactive: AgentRef[] = [];

	const append = (row: RegistrySnapshotAgent, model: { provider: string; id: string } | undefined) => {
		if (agents.size === MAX_ROWS) {
			truncated = true;
			return;
		}
		if (row.displayName.length > MAX_REGISTRY_SNAPSHOT_TEXT) {
			row.displayName = row.displayName.slice(0, MAX_REGISTRY_SNAPSHOT_TEXT);
			truncated = true;
		}
		if (model) {
			if (model.provider.length + 1 + model.id.length > MAX_REGISTRY_SNAPSHOT_TEXT) truncated = true;
			else row.model = `${model.provider}/${model.id}`;
		}
		agents.set(row.id, row);
	};

	const appendRef = (ref: AgentRef) => {
		if (ref.id.length > MAX_REGISTRY_SNAPSHOT_TEXT) {
			truncated = true;
			return;
		}
		const liveSession =
			ref.status !== "parked" && ref.status !== "aborted" && !ref.session?.isDisposed ? ref.session : null;
		let parentId: string | null = null;
		if (ref !== root) {
			const parent = ref.parentId ? registry.get(ref.parentId) : undefined;
			if (parent?.scope === sessionId && (parent.kind !== "main" || parent === root)) {
				if (parent.id.length <= MAX_REGISTRY_SNAPSHOT_TEXT) parentId = parent.id;
				else truncated = true;
			} else incompleteLineage = true;
		}
		append(
			{
				id: ref.id,
				rootId: root.id,
				parentId,
				displayName: ref.displayName,
				kind: ref === root ? "root" : ref.kind === "advisor" ? "advisor" : "subagent",
				status: ref === root ? (session.isStreaming ? "running" : "idle") : ref.status,
				live: liveSession !== null,
				model: null,
				lastActivity: Number.isFinite(ref.lastActivity) ? ref.lastActivity : null,
				waitingOnPeer: ref.waitingOnPeer === true,
				blockedOnApproval: ref.pendingApproval !== undefined,
			},
			liveSession?.model,
		);
		if (!liveSession) return;
		for (const advisor of liveSession.liveAdvisorStates()) {
			if (agents.size === MAX_ROWS || advisor.slug.length > MAX_REGISTRY_SNAPSHOT_TEXT) {
				truncated = true;
				break;
			}
			const id = advisor.slug ? `${ref.id}/advisor:${advisor.slug}` : `${ref.id}/advisor`;
			const existing = registry.get(id);
			if (id.length > MAX_REGISTRY_SNAPSHOT_TEXT || (existing && existing.kind !== "advisor") || agents.has(id)) {
				truncated = true;
				break;
			}
			append(
				{
					id,
					rootId: root.id,
					parentId: ref.id,
					displayName: advisor.name,
					kind: "advisor",
					status: advisor.isStreaming ? "running" : "idle",
					live: true,
					model: null,
					lastActivity: advisor.lastActivity,
					waitingOnPeer: false,
					blockedOnApproval: false,
				},
				advisor.model,
			);
		}
	};

	appendRef(root);
	let visited = 0;
	for (const ref of registry.values()) {
		if (++visited > MAX_REFS_VISITED) {
			truncated = true;
			break;
		}
		if (ref.scope !== sessionId || ref.kind === "main") continue;
		if (!ref.session || ref.session.isDisposed || ref.status === "parked" || ref.status === "aborted") {
			if (inactive.length < MAX_ROWS) inactive.push(ref);
			else truncated = true;
		} else if (agents.size < MAX_ROWS) appendRef(ref);
		else truncated = true;
	}
	// A live advisor and its retained transcript have the same stable ID. Prefer the live row.
	for (const ref of inactive) {
		if (!agents.has(ref.id)) appendRef(ref);
	}
	return {
		observedAt,
		coverage: truncated || incompleteLineage ? "partial" : "complete",
		truncated,
		agents: [...agents.values()],
	};
}
