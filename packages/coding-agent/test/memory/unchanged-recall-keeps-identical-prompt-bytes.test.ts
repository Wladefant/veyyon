// Recall refreshes must not change prompt bytes merely because wall-clock time passed.
// This covers both production renderers, not live backend ordering or retrieval changes.
import { expect, it, spyOn } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { loadHindsightConfig } from "@veyyon/coding-agent/memory/hindsight/config";
import { HindsightSessionState } from "@veyyon/coding-agent/memory/hindsight/state";
import { MnemopiSessionState } from "@veyyon/coding-agent/memory/mnemopi/state";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";

useIsolatedAgentDir();

it("keeps unchanged Hindsight and Mnemopi recall byte-identical across time", async () => {
	const hindsight = new HindsightSessionState({
		sessionId: "test-session",
		bankId: "test-bank",
		banksSet: new Set(),
		config: loadHindsightConfig(Settings.isolated({}), {}),
		session: {} as never,
		client: {
			registerProviderTextTransform: () => () => {},
			recall: async () => ({ results: [{ text: "Neutral remembered preference", type: "world" }] }),
		} as never,
	});
	const target = {
		bank: "test-bank",
		memory: {
			recallEnhanced: async () => [{ id: "fake-memory", content: "Neutral remembered preference", score: 1 }],
		},
	};
	const mnemopi = new MnemopiSessionState({
		sessionId: "test-session",
		config: { recallLimit: 10, debug: false, bank: "test-bank" } as never,
		session: {} as never,
		scoped: { recall: [target], retain: target } as never,
	});
	const clock = spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
	try {
		const before = [
			(await hindsight.recallForContext("preference")).context,
			await mnemopi.recallForContext("preference"),
		];
		clock.mockReturnValue(1_800_000_000_000);
		const after = [
			(await hindsight.recallForContext("preference")).context,
			await mnemopi.recallForContext("preference"),
		];
		for (let index = 0; index < before.length; index++) {
			expect(before[index]).toContain("Neutral remembered preference");
			expect(after[index]).toBe(before[index]);
			expect(after[index]).not.toContain("Current time:");
		}
	} finally {
		clock.mockRestore();
	}
});
