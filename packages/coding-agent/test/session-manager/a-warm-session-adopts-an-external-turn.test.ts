import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";
import { makeAssistantMessage } from "./helpers";

const directories: string[] = [];

class PausedReadStorage extends FileSessionStorage {
	#started = Promise.withResolvers<void>();
	#release = Promise.withResolvers<void>();
	#paused = false;

	pauseNextRead(): Promise<void> {
		this.#paused = true;
		return this.#started.promise;
	}

	resumeRead(): void {
		this.#release.resolve();
	}

	override async readText(filePath: string): Promise<string> {
		if (this.#paused) {
			this.#paused = false;
			this.#started.resolve();
			await this.#release.promise;
		}
		return super.readText(filePath);
	}
}

afterEach(() => {
	for (const directory of directories.splice(0)) removeSyncWithRetries(directory);
});

async function makeWorkspace(): Promise<string> {
	const directory = path.join(os.tmpdir(), `external-turn-${Snowflake.next()}`);
	fs.mkdirSync(directory, { recursive: true });
	directories.push(directory);
	return directory;
}

async function seedWarmSession(directory: string): Promise<{ file: string; warm: SessionManager }> {
	const warm = SessionManager.create(directory, directory);
	warm.appendMessage({ role: "user", content: "Remember the first marker.", timestamp: 1 });
	warm.appendMessage(makeAssistantMessage("Stored the first marker."));
	await warm.flush();
	const file = warm.getSessionFile();
	if (!file) throw new Error("the seeded session has no transcript file");
	return { file, warm };
}

async function writeExternalTurn(file: string, directory: string, marker: string): Promise<void> {
	const external = await SessionManager.open(file, directory);
	external.appendMessage({ role: "user", content: `Store marker ${marker}.`, timestamp: 2 });
	external.appendMessage(makeAssistantMessage(`Stored ${marker}.`));
	await external.flush();
	await external.close();
}

function contextText(manager: SessionManager): string {
	return manager
		.buildSessionContext()
		.messages.map(message => {
			if (!("content" in message)) return "";
			const content = message.content;
			if (typeof content === "string") return content;
			return content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
		})
		.join("\n");
}

describe("a warm session with a sequential external writer", () => {
	it("adopts the completed external turn into its active branch and keeps both turns after cold load", async () => {
		const directory = await makeWorkspace();
		const { file, warm } = await seedWarmSession(directory);
		const marker = `EXTERNAL-${Snowflake.next()}`;

		await writeExternalTurn(file, directory, marker);

		expect(await warm.holdsForeignEntries()).toBe(true);
		const adopted = await warm.refreshExternalTurn();
		expect(adopted).toHaveLength(2);
		expect(adopted).toEqual(
			warm
				.getBranch()
				.slice(-2)
				.map(entry => entry.id),
		);
		expect(contextText(warm)).toContain(marker);
		expect(warm.getSessionFile()).toBe(file);

		warm.appendMessage({ role: "user", content: "Repeat the latest marker.", timestamp: 3 });
		warm.appendMessage(makeAssistantMessage(`The latest marker is ${marker}.`));
		await warm.flush();
		await warm.close();

		const cold = await SessionManager.open(file, directory);
		const coldContext = contextText(cold);
		expect(coldContext).toContain(marker);
		expect(coldContext).toContain("Repeat the latest marker.");
		expect(coldContext.match(new RegExp(marker, "g"))).toHaveLength(3);
		expect(cold.getSessionFile()).toBe(file);
		await cold.close();
	});

	it("does not refresh when the published file has no external entries", async () => {
		const directory = await makeWorkspace();
		const { file, warm } = await seedWarmSession(directory);

		expect(await warm.refreshExternalTurn()).toEqual([]);
		expect(warm.getSessionFile()).toBe(file);
		expect(contextText(warm)).toContain("Stored the first marker.");
		await warm.close();
	});

	// WHY: an external branch that does not extend the warm leaf must never replace the warm
	// active branch. Closes: sibling-branch adoption. Leaves open: concurrent local writes
	// racing the load (guarded by the leaf recheck, not driven here).
	it("keeps its own branch when the external writer branched away from an earlier entry", async () => {
		const directory = await makeWorkspace();
		const { file, warm } = await seedWarmSession(directory);
		const warmLeaf = warm.getLeafId();
		const firstEntry = warm.getBranch()[0];
		if (!firstEntry) throw new Error("the seeded session has no entries");

		const external = await SessionManager.open(file, directory);
		external.branch(firstEntry.id);
		external.appendMessage({ role: "user", content: "Sibling question.", timestamp: 2 });
		external.appendMessage(makeAssistantMessage("SIBLING-MARKER"));
		await external.flush();
		await external.close();

		expect(await warm.refreshExternalTurn()).toEqual([]);
		expect(warm.getLeafId()).toBe(warmLeaf);
		expect(contextText(warm)).not.toContain("SIBLING-MARKER");
		await warm.close();
	});

	// WHY: a sequential external branch with messages but no resolved run must not
	// make stale prompt context look current. Closes: admitting unfinished external
	// extensions. Leaves open: provider execution status beyond persisted entries.
	it("rejects an external run that is still waiting on a tool", async () => {
		const directory = await makeWorkspace();
		const { file, warm } = await seedWarmSession(directory);
		const leaf = warm.getLeafId();

		const external = await SessionManager.open(file, directory);
		external.appendMessage({ role: "user", content: "Run a tool.", timestamp: 2 });
		external.appendMessage({
			...makeAssistantMessage("Calling."),
			content: [{ type: "toolCall" as const, id: "call-1", name: "bash", arguments: {} }],
			stopReason: "toolUse" as const,
		});
		await external.flush();
		await external.close();

		await expect(warm.refreshExternalTurn()).rejects.toThrow(/unfinished external session extension/i);
		expect(warm.getLeafId()).toBe(leaf);
		expect(contextText(warm)).not.toContain("Run a tool.");
		await warm.close();
	});

	it("rejects an external tool call without a result", async () => {
		const directory = await makeWorkspace();
		const { file, warm } = await seedWarmSession(directory);
		const leaf = warm.getLeafId();

		const external = await SessionManager.open(file, directory);
		external.appendMessage({ role: "user", content: "Run a tool.", timestamp: 2 });
		external.appendMessage({
			...makeAssistantMessage("Calling."),
			content: [{ type: "toolCall" as const, id: "call-2", name: "bash", arguments: {} }],
		});
		await external.flush();
		await external.close();

		await expect(warm.refreshExternalTurn()).rejects.toThrow(/unfinished external session extension/i);
		expect(warm.getLeafId()).toBe(leaf);
		expect(contextText(warm)).not.toContain("Run a tool.");
		await warm.close();
	});

	// WHY: a persisted assistant message is not terminal when generation failed or was
	// cancelled. Closes: accepting nonterminal assistant boundaries on external branches.
	it("rejects an external assistant message with a failed or cancelled stop reason", async () => {
		for (const stopReason of ["error", "aborted"] as const) {
			const directory = await makeWorkspace();
			const { file, warm } = await seedWarmSession(directory);
			const leaf = warm.getLeafId();

			const external = await SessionManager.open(file, directory);
			external.appendMessage({ role: "user", content: "Continue.", timestamp: 2 });
			external.appendMessage({
				...makeAssistantMessage("The run did not finish."),
				stopReason,
			});
			await external.flush();
			await external.close();

			await expect(warm.refreshExternalTurn()).rejects.toThrow(/unfinished external session extension/i);
			expect(warm.getLeafId()).toBe(leaf);
			await warm.close();
		}
	});

	it("rejects a user-only external extension", async () => {
		const directory = await makeWorkspace();
		const { file, warm } = await seedWarmSession(directory);
		const leaf = warm.getLeafId();
		const external = await SessionManager.open(file, directory);
		external.appendMessage({ role: "user", content: "Unanswered request.", timestamp: 2 });
		await external.flush();
		await external.close();

		await expect(warm.refreshExternalTurn()).rejects.toThrow(/unfinished external session extension/i);
		expect(warm.getLeafId()).toBe(leaf);
		await warm.close();
	});

	// WHY: a valid turn on a sibling branch must not replace an explicit local
	// selection. Closes: divergent ancestry adoption. Leaves open: races after load.
	it("keeps an explicitly selected branch when external history diverges from it", async () => {
		const directory = await makeWorkspace();
		const { file, warm } = await seedWarmSession(directory);
		const branchEntry = warm.getBranch()[0];
		if (!branchEntry) throw new Error("the seeded session has no entries");
		warm.branch(branchEntry.id);
		const selectedLeaf = warm.getLeafId();

		const external = await SessionManager.open(file, directory);
		external.appendMessage({ role: "user", content: "Foreign turn.", timestamp: 2 });
		external.appendMessage(makeAssistantMessage("FOREIGN-DIVERGENT"));
		await external.flush();
		await external.close();

		expect(await warm.refreshExternalTurn()).toEqual([]);
		expect(warm.getLeafId()).toBe(selectedLeaf);
		expect(contextText(warm)).not.toContain("FOREIGN-DIVERGENT");
		await warm.close();
	});
	// WHY: an asynchronous file load can finish after the user selects another branch.
	// Closes: adopting a valid extension onto a stale local selection.
	it("keeps a branch selected while loading foreign history", async () => {
		const directory = await makeWorkspace();
		const storage = new PausedReadStorage();
		const warm = SessionManager.create(directory, directory, storage);
		warm.appendMessage({ role: "user", content: "Remember the first marker.", timestamp: 1 });
		warm.appendMessage(makeAssistantMessage("Stored the first marker."));
		await warm.flush();
		const file = warm.getSessionFile();
		if (!file) throw new Error("the seeded session has no transcript file");
		const firstEntry = warm.getBranch()[0];
		if (!firstEntry) throw new Error("the seeded session has no entries");

		await writeExternalTurn(file, directory, "RACE-MARKER");
		const loadStarted = storage.pauseNextRead();
		const refresh = warm.refreshExternalTurn();
		await loadStarted;
		warm.branch(firstEntry.id);
		const selectedLeaf = warm.getLeafId();
		storage.resumeRead();

		expect(await refresh).toEqual([]);
		expect(warm.getLeafId()).toBe(selectedLeaf);
		expect(contextText(warm)).not.toContain("RACE-MARKER");
		await warm.close();
	});
});
