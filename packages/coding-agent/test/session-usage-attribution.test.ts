import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@veyyon/catalog/models";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

const temporaryDirectories: TempDir[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => directory.remove()));
});

describe("session usage attribution JSONL", () => {
	it("persists and reloads old and attributed usage without changing either record", async () => {
		const directory = TempDir.createSync("@vey-usage-attribution-");
		temporaryDirectories.push(directory);
		const cwd = directory.path();
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled session test model");
		const oldUsage = {
			input: 11,
			output: 4,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const attributedUsage = {
			...oldUsage,
			credentialId: "credential-session-29",
			transport: "websocket",
			model: "actual-response-model",
		};
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "legacy usage" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: oldUsage,
			stopReason: "stop",
			timestamp: 1,
		});
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "attributed usage" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: attributedUsage,
			stopReason: "stop",
			timestamp: 2,
		});
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file path");
		const persisted = fs.readFileSync(sessionFile, "utf8");
		const entries = persisted
			.trimEnd()
			.split("\n")
			.map(line => JSON.parse(line) as Record<string, unknown>);
		const assistantRecords = entries
			.filter(entry => entry.type === "message")
			.map(entry => entry.message as { role: string; usage: unknown });
		expect(assistantRecords.map(record => record.usage)).toEqual([oldUsage, attributedUsage]);

		const reloaded = await SessionManager.open(sessionFile, sessionDir, undefined, {
			initialCwd: cwd,
			suppressBreadcrumb: true,
		});
		try {
			const replayed = reloaded
				.getBranch()
				.flatMap(entry => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []))
				.map(message => message.usage);
			expect(replayed).toEqual([oldUsage, attributedUsage]);
		} finally {
			await reloaded.close();
			await manager.close();
		}
	});
});
