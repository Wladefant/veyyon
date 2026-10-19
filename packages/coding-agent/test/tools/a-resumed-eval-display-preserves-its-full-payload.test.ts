/**
 * WHY: stale version-3 sessions retain oversized raw display values. Resume must
 * migrate the domain payload to version 1 only after storing its complete value.
 * This covers atomic storage refusal and repeated resume, not OS power loss.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import type { EvalToolDetails } from "@veyyon/coding-agent/eval/types";
import { formatDisplayJson } from "@veyyon/coding-agent/tools/shell/eval-display";
import "@veyyon/coding-agent/tools/index";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { sessionFileStem } from "@veyyon/utils/session-file";
import { TempDir } from "@veyyon/utils/temp";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";

useIsolatedAgentDir();

async function writeStaleSession(
	file: string,
	cwd: string,
	payload: unknown,
	displayVersion?: number,
): Promise<string> {
	const records = [
		{ type: "session", version: 3, id: "stale-display-fixture", timestamp: "2026-01-01T00:00:00.000Z", cwd },
		{
			type: "message",
			id: "display-result",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: {
				role: "toolResult",
				toolName: "eval",
				toolCallId: "fixture-display",
				content: [{ type: "text", text: "Displayed value" }],
				details: { jsonOutputs: [payload], displayVersion },
				isError: false,
				timestamp: 1,
			},
		},
	];
	const source = `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
	await fs.writeFile(file, source);
	return source;
}

function loadedDisplay(manager: SessionManager): EvalToolDetails {
	const entry = manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "toolResult");
	if (entry?.type !== "message" || entry.message.role !== "toolResult") throw new Error("Missing eval result");
	return entry.message.details as EvalToolDetails;
}

describe("resuming stale eval display values", () => {
	it("persists bounded versioned details and recovers the complete value across repeated resume", async () => {
		using temp = TempDir.createSync("eval-display-migration-");
		const file = temp.join("stale.jsonl");
		const payload = { payload: `begin-${"😀".repeat(25_000)}-end` };
		await writeStaleSession(file, temp.path(), payload);
		const manager = await SessionManager.open(file);
		const details = loadedDisplay(manager);
		expect(details.displayVersion).toBe(1);
		expect(Buffer.byteLength(JSON.stringify(details))).toBeLessThan(10_000);
		const value = details.jsonOutputs?.[0];
		if (
			typeof value !== "object" ||
			value === null ||
			!("artifactId" in value) ||
			typeof value.artifactId !== "string"
		) {
			throw new Error("Missing migrated display artifact");
		}
		const artifact = await manager.getArtifactPath(value.artifactId);
		if (!artifact) throw new Error("Migrated display artifact does not resolve");
		expect(JSON.parse(await fs.readFile(artifact, "utf8"))).toEqual(payload);
		await manager.flush();
		expect(Buffer.byteLength(await fs.readFile(file, "utf8"))).toBeLessThan(20_000);
		const second = await SessionManager.open(file);
		expect(loadedDisplay(second)).toEqual(details);
		expect((await fs.readdir(sessionFileStem(file))).filter(name => name.endsWith(".log"))).toHaveLength(1);
		await second.flush();
	});

	it("refuses migration when durable storage fails and leaves the stale session intact", async () => {
		using temp = TempDir.createSync("eval-display-migration-failure-");
		const file = temp.join("stale.jsonl");
		const source = await writeStaleSession(file, temp.path(), { payload: "x".repeat(100_000) });
		await fs.writeFile(sessionFileStem(file), "artifact directory is blocked");
		await expect(SessionManager.open(file)).rejects.toThrow(/EEXIST|ENOTDIR/);
		expect(await fs.readFile(file, "utf8")).toBe(source);
	});

	it("refuses an unknown payload version without rewriting the session", async () => {
		using temp = TempDir.createSync("eval-display-future-version-");
		const file = temp.join("future.jsonl");
		const source = await writeStaleSession(file, temp.path(), { payload: "value" }, 99);
		await expect(SessionManager.open(file)).rejects.toThrow("Unsupported eval display version: 99");
		expect(await fs.readFile(file, "utf8")).toBe(source);
	});

	it("reports elided Unicode code points while keeping the UTF-8 prefix within its byte bound", () => {
		const formatted = formatDisplayJson({ payload: "😀".repeat(3000) });
		const marker = formatted.previewText.lastIndexOf("\n[…");
		const prefix = formatted.previewText.slice(0, marker);
		const omitted = [...formatted.fullText.slice(prefix.length)].length;
		expect(formatted.previewText.slice(marker)).toBe(`\n[…${omitted}ch elided…]`);
		expect(Buffer.byteLength(formatted.previewText)).toBeLessThanOrEqual(8000);
		expect(prefix).not.toContain("�");
	});
});
