import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";
import { makeAssistantMessage } from "./helpers";

const directories: string[] = [];

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
		expect(await warm.refreshExternalTurn()).toBe(true);
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

		expect(await warm.refreshExternalTurn()).toBe(false);
		expect(warm.getSessionFile()).toBe(file);
		expect(contextText(warm)).toContain("Stored the first marker.");
		await warm.close();
	});
});
