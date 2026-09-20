/**
 * What a tool's declared arguments account for, as the tool itself states it.
 *
 * WHY THIS EXISTS. The refusal fence asks one question of every tool it is
 * about to run: "can this call reach a path the operator refused?" It used to
 * answer by looking for a `filesystemTargets` method and treating its presence
 * as proof that the returned list was the whole effect set. `BashTool` declares
 * that method and returns `bashCredentialTargets`, which is deliberately only
 * the credential paths under a secrets directory. So a standing refusal on
 * `/repo/protected` did not fence `bash {command: "echo x > /repo/protected"}`:
 * the refused path was simply not in bash's narrow list, `[].some(...)` was
 * false, and the write ran. That is the incident class of
 * https://github.com/Wladefant/veyyon/issues/37 — refused under one tool name,
 * performed 38 seconds later under another.
 *
 * So the answer is DECLARED, not inferred. A tool that spawns a process or
 * evaluates code says `"unbounded"`, beside the targets it publishes, and
 * `filesystemTargets` goes back to being what it always was for the fence: a
 * hint used to match a path subject, never a completeness claim.
 *
 * The floor is fail-closed and it is a floor, not an inference: a tool the
 * fence has never heard of — an MCP tool, a plugin tool, a dynamically
 * registered one — cannot be asked, so {@link isUnboundedExecutor} answers
 * `true` for it. Forgetting to declare therefore over-fences rather than
 * under-fences, and no executor can become bounded by omission.
 */

/**
 * `"declared-targets"` — every path this call can read or write is named by
 * `filesystemTargets`, or lives under something it names. A path refusal fences
 * the call only when one of those targets overlaps the refused path.
 *
 * `"unbounded"` — this call can reach any path, and nothing about its arguments
 * is safe to read as a bound: a shell line, a script body, a spawned binary, a
 * browser session, a delegated agent. A path or command refusal fences it for
 * every argument while that refusal stands.
 */
export type ToolEffectScope = "declared-targets" | "unbounded";

/** A tool that states which of the two answers above applies to it. */
export interface EffectScopedTool {
	readonly effectScope: ToolEffectScope;
}

/** Whether `tool` declares its effect scope at all, narrowing to the declaration. */
export function declaresEffectScope(tool: unknown): tool is EffectScopedTool {
	const declared = (tool as { effectScope?: unknown } | null | undefined)?.effectScope;
	return declared === "declared-targets" || declared === "unbounded";
}

/**
 * Whether the fence must treat `tool` as able to reach any path.
 *
 * An undeclared tool is not assumed harmless: the unknown answer is the
 * dangerous one, so it gets the dangerous treatment.
 */
export function isUnboundedExecutor(tool: unknown): boolean {
	return !declaresEffectScope(tool) || tool.effectScope === "unbounded";
}
