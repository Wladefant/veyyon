/**
 * WHY: ordinary tool fixtures cannot prove the real EvalTool JS backend keeps
 * a registered value out of its live callback, display details, and raw output
 * artifact. This drives those producer sinks end to end with a true JS result.
 * It does not exercise Python/Ruby/Julia evaluators or provider-side masking.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { disposeAllVmContexts } from "@veyyon/coding-agent/eval/js/context-manager";
import type { EvalToolDetails } from "@veyyon/coding-agent/eval/types";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { wrapToolWithMetaNotice } from "@veyyon/coding-agent/tools/core/output-meta";
import { EvalTool } from "@veyyon/coding-agent/tools/shell/eval";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { makeToolSession } from "../helpers/tool-session";
import "@veyyon/coding-agent/tools/index";

const CANARY = "synthetic-eval-\n\nregistered-value-6c84f1";
const obfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: CANARY, name: "EVAL_CANARY" }]);
let directory: string | undefined;

afterEach(() => {
	if (directory) fs.rmSync(directory, { recursive: true, force: true });
	directory = undefined;
	disposeAllVmContexts();
});

function makeSession(artifactPath: string): ToolSession {
	const settings = Settings.isolated();
	settings.set("tools.artifactSpillThreshold", 128);
	const owner = {
		redact: (text: string) => obfuscator.obfuscate(text),
		pendingPrefixLength: (text: string) => obfuscator.pendingRedactionPrefixLength(text),
	};
	return makeToolSession({
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings,
		captureProducerSecretOwner: () => owner,
		allocateOutputArtifact: async (toolType: string) => ({ id: `synthetic-${toolType}`, path: artifactPath }),
	});
}

describe("real EvalTool output stays redacted under its registered producer owner", () => {
	it("guards streamed output, display values, retained details, and artifact bytes without changing JS computation", async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "eval-producer-owner-"));
		const artifactPath = path.join(directory, "eval-output.txt");
		const session = makeSession(artifactPath);
		const progress: AgentToolResult[] = [];
		const tool = wrapToolWithMetaNotice(new EvalTool(session), session);
		const code = [
			'const value = "synthetic-eval-\\n\\n" + "registered-value-6c84f1";',
			'print("split=" + value.slice(0, 16));',
			"print(value.slice(16));",
			'print("harmless-padding\\n".repeat(12000));',
			'display(value === "synthetic-eval-\\n\\n" + "registered-value-6c84f1");',
			"display({ value });",
			'return value === "synthetic-eval-\\n\\n" + "registered-value-6c84f1";',
		].join("\n");

		const result = await tool.execute(
			"synthetic-eval-call",
			{ language: "js", code, reset: true },
			undefined,
			update => progress.push(update),
		);
		const artifact = fs.existsSync(artifactPath) ? fs.readFileSync(artifactPath, "utf8") : "";
		const details = result.details as EvalToolDetails & { meta?: unknown };
		const originalOutput = details.cells?.[0]?.output ?? "";
		const retained = [
			JSON.stringify(progress),
			JSON.stringify(result.content),
			JSON.stringify(result.details),
			artifact,
		];

		expect(progress.length).toBeGreaterThan(0);
		for (const sink of retained) expect(sink).not.toContain(CANARY);
		expect(JSON.stringify(result.content)).not.toContain(CANARY);
		expect(originalOutput).not.toContain(CANARY);
		expect(details.jsonOutputs).toEqual([{ value: obfuscator.obfuscate(CANARY) }]);
		expect(JSON.stringify(result.content)).toContain("true");
		expect(artifact).not.toContain(CANARY);
	});
	it("withholds log and phase inventories from live status, result details, and session entries", async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "eval-status-inventory-"));
		const session = makeSession(path.join(directory, "eval-output.txt"));
		const progress: AgentToolResult[] = [];
		const tool = wrapToolWithMetaNotice(new EvalTool(session), session);
		const inventoryParts = ["ALPHA=fake-a", "BETA=fake-b", "GAMMA=fake-c"];
		const encodedParts = inventoryParts.map(part => [...part].map(char => char.charCodeAt(0)).join(","));
		const code = [
			`const values = [${encodedParts.map(part => `String.fromCharCode(${part})`).join(", ")}];`,
			`log("safe status"); phase("safe phase");`,
			`log(values.join("\\n")); phase(values.join("\\n"));`,
			`log(values[0]); phase(values[1]); log(values[2]);`,
		].join("\n");
		const result = await tool.execute(
			"synthetic-eval-status-call",
			{
				language: "js",
				code,
				reset: true,
			},
			undefined,
			update => progress.push(update),
		);
		const retained = [JSON.stringify(progress), JSON.stringify(result.content), JSON.stringify(result.details)];
		for (const sink of retained) {
			for (const sentinel of inventoryParts) expect(sink).not.toContain(sentinel);
		}
		expect(result.details?.statusEvents).toEqual([
			{ op: "log", message: "safe status" },
			{ op: "phase", title: "safe phase" },
			{ op: "log", message: "[credential output withheld]" },
			{ op: "phase", title: "[credential output withheld]" },
			{ op: "log", message: "[credential output withheld]" },
			{ op: "phase", title: "[credential output withheld]" },
			{ op: "log", message: "[credential output withheld]" },
		]);

		const manager = SessionManager.create(directory, path.join(directory, "sessions"));
		await manager.ensureOnDisk();
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "synthetic-eval-status-call",
			toolName: "eval",
			content: result.content,
			details: result.details,
			isError: result.isError ?? false,
			timestamp: Date.now(),
		});
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const persisted = fs.readFileSync(sessionFile!, "utf8");
		for (const sentinel of inventoryParts) expect(persisted).not.toContain(sentinel);
		const reopened = await SessionManager.open(sessionFile!);
		const reopenedText = JSON.stringify(reopened.getBranch());
		for (const sentinel of inventoryParts) expect(reopenedText).not.toContain(sentinel);
	});
});
