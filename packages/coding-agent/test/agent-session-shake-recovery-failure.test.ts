import { describe, expect, it, vi } from "bun:test";
import type { ShakeRegion } from "@veyyon/agent-core/compaction";
import {
	HistoryRewrites,
	type HistoryRewritesHost,
} from "../src/session/runtime/history-rewrites";

describe("history shake recovery is archive-first", () => {
	for (const failure of ["undefined", "throw"] as const) {
		it(`preserves original records if artifact save returns ${failure}`, async () => {
			const original = "exact original output with a private line break\\nsecond line";
			const entry = {
				type: "message",
				id: "entry-one",
				message: {
					role: "toolResult",
					toolCallId: "call-one",
					toolName: "read",
					content: [{ type: "text", text: original }],
					isError: false,
					timestamp: 0,
				},
			};
			const originalEntry = JSON.stringify(entry);
			let persistedEntries = [entry];
			const saveArtifact = vi.fn(async () => {
				if (failure === "throw") throw new Error("disk full");
				return undefined;
			});
			const rewriteEntries = async (updated?: Iterable<typeof entry>) => {
				if (updated) persistedEntries = [...updated];
			};
			const replaceMessages = () => undefined;
			const host = {
				sessionStore: { saveArtifact, rewriteEntries, getBranch: () => persistedEntries },
				agent: { replaceMessages },
			} as unknown as HistoryRewritesHost;
			const region = {
				kind: "toolResult",
				entry,
				label: "read",
				tokens: 250,
				originalText: original,
			} as unknown as ShakeRegion;

			await expect(new HistoryRewrites(host).offloadAndApply([region])).rejects.toThrow(
				"recovery artifact was not saved",
			);
			expect(persistedEntries).toEqual([JSON.parse(originalEntry)]);
			expect(JSON.stringify(entry)).toBe(originalEntry);
		});
	}
});
