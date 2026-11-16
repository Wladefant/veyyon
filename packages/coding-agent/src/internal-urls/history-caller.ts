import { AgentRegistry, type AgentRef } from "../registry/agent-registry";
import type { ToolSession } from "../tools";

declare const historyCallerCapabilityBrand: unique symbol;

/** Opaque, process-local authority minted only at the trusted read-tool seam. */
export type HistoryCallerCapability = {
  readonly [historyCallerCapabilityBrand]: true;
};

export interface ResolvedHistoryCaller {
  readonly registry: AgentRegistry;
  readonly actor: AgentRef;
  readonly agentId: string;
  readonly sessionId: string;
  readonly scope: string;
}

interface CapabilityBinding {
  readonly session: ToolSession;
  readonly caller: ResolvedHistoryCaller;
}

const capabilities = new WeakMap<object, CapabilityBinding>();

/**
 * Read a live caller binding from the real ToolSession and the exact global
 * registry. Unknown, advisor, parked, unscoped, or mismatched sessions fail
 * closed; URL fields never participate in this decision.
 */
function currentCaller(session: ToolSession): ResolvedHistoryCaller | undefined {
  try {
    const ownerSession = session.getOwningAgentSession?.();
    if (!ownerSession || ownerSession.isDisposed) return undefined;

    const registry = session.agentRegistry;
    if (!registry || registry !== AgentRegistry.global()) return undefined;

    const agentId = session.getAgentId?.();
    const sessionId = session.getSessionId?.();
    if (
      typeof agentId !== "string" ||
      agentId.length === 0 ||
      typeof sessionId !== "string" ||
      sessionId.length === 0
    ) {
      return undefined;
    }

    const actor = registry.get(agentId);
    if (
      !actor ||
      actor.kind === "advisor" ||
      (actor.status !== "running" && actor.status !== "idle") ||
      !actor.session ||
      actor.session !== ownerSession ||
      actor.session.isDisposed
    ) {
      return undefined;
    }

    const scope = actor.scope;
    if (typeof scope !== "string" || scope.trim().length === 0) return undefined;
    if (actor.session.sessionManager.getSessionId() !== sessionId) return undefined;
    if (ownerSession.isDisposed || session.getOwningAgentSession?.() !== ownerSession) return undefined;

    return { registry, actor, agentId, sessionId, scope };
  } catch {
    // A partially disposed or throwing session is not an authorization source.
    return undefined;
  }
}

/** Mint a one-read capability from the actual host-owned ToolSession. */
export function createHistoryCallerCapability(session: ToolSession): HistoryCallerCapability | undefined {
  const caller = currentCaller(session);
  if (!caller) return undefined;

  const capability = Object.freeze(Object.create(null)) as HistoryCallerCapability;
  capabilities.set(capability, { session, caller });
  return capability;
}

/**
 * Resolve and revalidate a capability. The caller's registry, actor object,
 * session ID and attributed scope must still be exactly the binding that was
 * minted at the read-tool boundary.
 */
export function resolveHistoryCallerCapability(candidate: unknown): ResolvedHistoryCaller | undefined {
  if (!candidate || typeof candidate !== "object") return undefined;
  const binding = capabilities.get(candidate);
  if (!binding) return undefined;

  const current = currentCaller(binding.session);
  if (
    !current ||
    current.registry !== binding.caller.registry ||
    current.actor !== binding.caller.actor ||
    current.agentId !== binding.caller.agentId ||
    current.sessionId !== binding.caller.sessionId ||
    current.scope !== binding.caller.scope
  ) {
    return undefined;
  }

  return current;
}
