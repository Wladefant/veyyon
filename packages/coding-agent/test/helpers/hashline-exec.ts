import * as fs from "node:fs/promises";
import type { ExecuteHashlineSingleOptions } from "@veyyon/coding-agent/edit";
import type { WritethroughDeferredHandle } from "@veyyon/coding-agent/lsp/writethrough";
import type { ToolSession } from "@veyyon/coding-agent/tools";

/** A deferred-diagnostics handle that reports nothing, for a write no LSP pass follows. */
export function inertDeferredDiagnostics(): WritethroughDeferredHandle {
	return { onDeferredDiagnostics: () => {}, signal: new AbortController().signal, finalize: () => {} };
}

/** Options for one `executeHashlineSingle` call that writes each patched file straight to disk. */
export function hashlineExecOptions(input: string, session: ToolSession): ExecuteHashlineSingleOptions {
	return {
		session,
		input,
		writethrough: async (targetPath, content) => {
			await fs.writeFile(targetPath, content);
			return undefined;
		},
		beginDeferredDiagnosticsForPath: inertDeferredDiagnostics,
	};
}
