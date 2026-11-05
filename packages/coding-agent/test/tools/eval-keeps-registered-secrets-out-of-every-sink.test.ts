/**
 * WHY: ordinary tool fixtures cannot prove the real EvalTool JS backend keeps
 * a registered value out of its live callback, display details, raw output
 * artifact, and persisted session. This drives those producer sinks end to end
 * with a true JS result. It does not cover other evaluators or provider masking.
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
	it("keeps escaped JSON secrets out of live output, details, artifacts, and persisted sessions", async () => {
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
			"display({ value, padding: 'x'.repeat(12000) });",
			'return value === "synthetic-eval-\\n\\n" + "registered-value-6c84f1";',
		].join("\n");

		const result = await tool.execute(
			"synthetic-eval-call",
			{ language: "js", code, reset: true },
			undefined,
			update => progress.push(update),
		);
		const manager = SessionManager.create(directory, path.join(directory, "sessions"));
		await manager.ensureOnDisk();
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "synthetic-eval-call",
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
		const reopened = await SessionManager.open(sessionFile!);
		const reopenedText = JSON.stringify(reopened.getBranch());
		const artifact = fs.existsSync(artifactPath) ? fs.readFileSync(artifactPath, "utf8") : "";
		const details = result.details as EvalToolDetails & { meta?: unknown };

		const retained = [
			JSON.stringify(progress),
			JSON.stringify(result.content),
			JSON.stringify(result.details),
			artifact,
			persisted,
			reopenedText,
		];
		for (const sink of retained) {
			let candidate = CANARY;
			for (let depth = 0; depth < 5; depth++) {
				expect(sink).not.toContain(candidate);
				candidate = JSON.stringify(candidate).slice(1, -1);
			}
		}

		expect(progress.length).toBeGreaterThan(0);
		expect(JSON.stringify(details.jsonOutputs)).toContain(obfuscator.obfuscate(CANARY));
		expect(artifact).toContain("display[1]:");
		expect(JSON.stringify(result.content)).toContain("true");
	});

	it("withholds unquoted environment-map inventories from every eval sink", async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "eval-inventory-"));
		const artifactPath = path.join(directory, "eval-output.txt");
		const session = makeSession(artifactPath);
		const progress: AgentToolResult[] = [];
		const tool = wrapToolWithMetaNotice(new EvalTool(session), session);
		const code = [
			"console.log({ ALPHA: 'fake-a', BETA: 'fake-b', GAMMA: 'fake-c' })",
			"console.log({",
			"  DELTA: 'fake-d',",
			"  EPSILON: 'fake-e',",
			"  ZETA: 'fake-f'",
			"})",
		].join("\n");
		const result = await tool.execute(
			"synthetic-eval-inventory",
			{ language: "js", code, reset: true },
			undefined,
			update => progress.push(update),
		);
		const artifact = fs.existsSync(artifactPath) ? fs.readFileSync(artifactPath, "utf8") : "";
		const details = result.details as EvalToolDetails;
		const sinks = [
			...progress.map(update => (update.details as EvalToolDetails | undefined)?.cells?.[0]?.output ?? ""),
			result.content.map(part => (part.type === "text" ? part.text : "")).join("\n"),
			details.cells?.[0]?.output ?? "",
			artifact,
		];

		for (const sink of sinks) {
			for (const value of ["fake-a", "fake-b", "fake-c", "fake-d", "fake-e", "fake-f"]) {
				expect(sink).not.toContain(value);
			}
		}
		expect(result.content.map(part => (part.type === "text" ? part.text : "")).join("\n")).toContain(
			"[credential output withheld]",
		);
	});

	it("keeps ordinary one- and two-key objects and lowercase objects visible", async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "eval-ordinary-object-"));
		const session = makeSession(path.join(directory, "unused.txt"));
		const tool = wrapToolWithMetaNotice(new EvalTool(session), session);
		const code = [
			"console.log({ alpha: 'ordinary-a', beta: 'ordinary-b' })",
			"console.log({ alpha: 'ordinary-a', beta: 'ordinary-b', gamma: 'ordinary-c' })",
			"console.log({ ALPHA: 'ordinary-a', BETA: 'ordinary-b' })",
		].join("\n");
		const result = await tool.execute("synthetic-ordinary-objects", { language: "js", code, reset: true });
		const output = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		expect(output).toContain("{ alpha: 'ordinary-a', beta: 'ordinary-b' }");
		expect(output).toContain("{ alpha: 'ordinary-a', beta: 'ordinary-b', gamma: 'ordinary-c' }");
		expect(output).toContain("{ ALPHA: 'ordinary-a', BETA: 'ordinary-b' }");
	});
	it("withholds a labeled multiline inventory and creates its artifact", async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "eval-labeled-inventory-"));
		const artifactPath = path.join(directory, "inventory.txt");
		const session = makeSession(artifactPath);
		const progress: AgentToolResult[] = [];
		const tool = wrapToolWithMetaNotice(new EvalTool(session), session);
		const code = [
			"console.log('harmless-padding-before-inventory-'.repeat(30))",
			'console.log("Here\'s env", {',
			"  ALPHA: 'fake-a'.repeat(8),",
			"  BETA: 'fake-b'.repeat(8),",
			"  GAMMA: 'fake-c'.repeat(8)",
			"})",
		].join("\n");
		const result = await tool.execute(
			"synthetic-labeled-inventory",
			{ language: "js", code, reset: true },
			undefined,
			update => progress.push(update),
		);
		const details = result.details as EvalToolDetails;
		const content = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		const callbackOutputs = progress.map(
			update => (update.details as EvalToolDetails | undefined)?.cells?.[0]?.output ?? "",
		);
		const artifact = fs.readFileSync(artifactPath, "utf8");
		const sinks = [JSON.stringify(progress), JSON.stringify(details), content, artifact];
		expect(callbackOutputs.length).toBeGreaterThan(0);
		expect(fs.existsSync(artifactPath), "artifact file should exist").toBe(true);
		for (const canary of ["fake-a".repeat(8), "fake-b".repeat(8), "fake-c".repeat(8)]) {
			for (const callbackOutput of callbackOutputs) {
				expect(callbackOutput, `live callback must withhold ${canary}`).not.toContain(canary);
			}
			expect(JSON.stringify(details), `details must withhold ${canary}`).not.toContain(canary);
			expect(content, `final text must withhold ${canary}`).not.toContain(canary);
			expect(artifact, `artifact bytes must withhold ${canary}`).not.toContain(canary);
			expect(sinks.join("\n"), `all sinks must withhold ${canary}`).not.toContain(canary);
		}
		expect(content).toContain("[credential output withheld]");
	});

	it("withholds quoted Path, SystemRoot, and ComSpec alongside two uppercase keys", async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "eval-quoted-windows-env-"));
		for (const [key, value] of [
			["Path", "path-value"],
			["SystemRoot", "system-root-value"],
			["ComSpec", "command-value"],
		]) {
			const session = makeSession(path.join(directory, "unused.txt"));
			const tool = wrapToolWithMetaNotice(new EvalTool(session), session);
			const code = `console.log({ ALPHA: 'fake-a', BETA: 'fake-b', "${key}": "${value}" })`;
			const result = await tool.execute(`synthetic-quoted-windows-env-${key}`, {
				language: "js",
				code,
				reset: true,
			});
			const output = (result.details as EvalToolDetails).cells?.[0]?.output ?? "";
			expect(output).not.toContain("fake-a");
			expect(output).not.toContain("fake-b");
			expect(output).not.toContain(value);
		}
	});

	it("withholds an inspected backtick value with braces and both quotes", async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "eval-inspected-quotes-"));
		const session = makeSession(path.join(directory, "unused.txt"));
		const tool = wrapToolWithMetaNotice(new EvalTool(session), session);
		const code = [
			"console.log({",
			"  ALPHA: `fake}'\"a`,",
			"  BETA: 'fake-b'.repeat(8),",
			"  GAMMA: 'fake-c'.repeat(8)",
			"})",
		].join("\n");
		const result = await tool.execute("synthetic-inspected-quotes", { language: "js", code, reset: true });
		const output = (result.details as EvalToolDetails).cells?.[0]?.output ?? "";
		expect(output).not.toContain("fake}");
		expect(output).not.toContain("fake-b");
		expect(output).not.toContain("fake-c");
	});

	it("withholds Path, SystemRoot, and ComSpec alongside two uppercase keys", async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "eval-windows-env-"));
		for (const [key, value] of [
			["Path", "path-value"],
			["SystemRoot", "system-root-value"],
			["ComSpec", "command-value"],
		]) {
			const session = makeSession(path.join(directory, "unused.txt"));
			const tool = wrapToolWithMetaNotice(new EvalTool(session), session);
			const code = `console.log({ ALPHA: 'fake-a', BETA: 'fake-b', ${key}: '${value}' })`;
			const result = await tool.execute(`synthetic-windows-env-${key}`, { language: "js", code, reset: true });
			const output = (result.details as EvalToolDetails).cells?.[0]?.output ?? "";
			expect(output).not.toContain("fake-a");
			expect(output).not.toContain("fake-b");
			expect(output).not.toContain(value);
		}
	});

	it("keeps ordinary lowercase properties with uppercase values visible in console and display", async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "eval-ordinary-uppercase-"));
		const session = makeSession(path.join(directory, "unused.txt"));
		const tool = wrapToolWithMetaNotice(new EvalTool(session), session);
		const code = [
			"console.log({ message: 'Expected HTTP: 200, GOT: 404, RETRY: 1, STATUS: pending' })",
			"console.log('completed')",
			"display({ message: 'Expected HTTP: 200, GOT: 404, RETRY: 1, STATUS: pending' })",
		].join("\n");
		const result = await tool.execute("synthetic-ordinary-uppercase", { language: "js", code, reset: true });
		const details = result.details as EvalToolDetails;
		const output = details.cells?.[0]?.output ?? "";
		const content = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		expect(output).toContain("Expected HTTP: 200, GOT: 404, RETRY: 1, STATUS: pending");
		expect(output).toContain("completed");
		expect(details.jsonOutputs).toContainEqual({
			message: "Expected HTTP: 200, GOT: 404, RETRY: 1, STATUS: pending",
		});
		expect(content).toContain("completed");
	});
	it("withholds warning inventories after bracketed console labels", async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "eval-bracketed-inventory-"));
		for (const label of ["[worker] Here's env", "[worker's env]"]) {
			const artifactPath = path.join(directory, `${label.length}.txt`);
			const session = makeSession(artifactPath);
			const tool = wrapToolWithMetaNotice(new EvalTool(session), session);
			const progress: AgentToolResult[] = [];
			const code = [
				'console.log("padding-".repeat(400))',
				`console.warn(${JSON.stringify(label)}, {`,
				'  ALPHA: "fake-a".repeat(8),',
				'  BETA: "fake-b".repeat(8),',
				'  GAMMA: "fake-c".repeat(8)',
				"})",
			].join("\n");
			const result = await tool.execute(
				`synthetic-bracketed-${label.length}`,
				{ language: "js", code, reset: true },
				undefined,
				update => progress.push(update),
			);
			const details = result.details as EvalToolDetails;
			const content = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
			const artifact = fs.existsSync(artifactPath) ? fs.readFileSync(artifactPath, "utf8") : "";
			for (const sink of [JSON.stringify(progress), JSON.stringify(details), content, artifact]) {
				for (const canary of ["fake-a".repeat(8), "fake-b".repeat(8), "fake-c".repeat(8)]) {
					expect(sink).not.toContain(canary);
				}
			}
			expect(fs.existsSync(artifactPath)).toBe(true);
		}
	});

	const inventories = [
		{
			name: "raw env label",
			expression: `console.log('env "', { ALPHA: 'short-a', BETA: 'short-b', GAMMA: 'short-c' })`,
			canaries: ["short-a", "short-b", "short-c"],
		},
		{
			name: "long inspected map",
			expression: `console.log({ ALPHA: '${"long-a".repeat(8)}', BETA: '${"long-b".repeat(8)}', GAMMA: '${"long-c".repeat(8)}' })`,
			canaries: ["long-a", "long-b", "long-c"].map(value => value.repeat(8)),
		},
		{
			name: "serialized three-key map",
			expression: `console.log(JSON.stringify({ ALPHA: 'json-a', BETA: 'json-b', GAMMA: 'json-c' }))`,
			canaries: ["json-a", "json-b", "json-c"],
		},
		{
			name: "console.log array of one-key objects",
			expression: `console.log('env', [{ ALPHA: 'array-log-a' }, { BETA: 'array-log-b' }, { GAMMA: 'array-log-c' }])`,
			canaries: ["array-log-a", "array-log-b", "array-log-c"],
		},
		{
			name: "console.warn array of one-key objects",
			expression: `console.warn([{ ALPHA: 'array-warn-a' }, { BETA: 'array-warn-b' }, { GAMMA: 'array-warn-c' }])`,
			canaries: ["array-warn-a", "array-warn-b", "array-warn-c"],
		},
	] as const;

	for (const [index, inventory] of inventories.entries()) {
		it(`withholds ${inventory.name} independently from every eval sink`, async () => {
			directory = fs.mkdtempSync(path.join(os.tmpdir(), "eval-inspected-inventory-"));
			const artifactPath = path.join(directory, `inventory-${index}.txt`);
			const session = makeSession(artifactPath);
			const progress: AgentToolResult[] = [];
			const tool = wrapToolWithMetaNotice(new EvalTool(session), session);
			const code = [`console.log("spill-padding-".repeat(400))`, inventory.expression].join("\n");
			const result = await tool.execute(
				`synthetic-eval-inventory-${index}`,
				{ language: "js", code, reset: true },
				undefined,
				update => progress.push(update),
			);
			const details = result.details as EvalToolDetails;
			const content = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
			const artifact = fs.readFileSync(artifactPath, "utf8");
			const sinks = [
				...progress.map(update => (update.details as EvalToolDetails | undefined)?.cells?.[0]?.output ?? ""),
				details.cells?.[0]?.output ?? "",
				JSON.stringify(details.jsonOutputs) ?? "",
				content,
				artifact,
			];

			expect(fs.existsSync(artifactPath), inventory.name).toBe(true);
			expect(content, inventory.name).toContain("[credential output withheld]");
			for (const sink of sinks) {
				for (const canary of inventory.canaries) expect(sink, inventory.name).not.toContain(canary);
			}
		});
	}

	it("keeps an ordinary array diagnostic visible before completed output", async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "eval-array-diagnostic-"));
		const session = makeSession(path.join(directory, "unused.txt"));
		const tool = wrapToolWithMetaNotice(new EvalTool(session), session);
		const code = [
			'console.log(["Expected response { HTTP: 200, RETRY: 1, STATUS: pending }"])',
			'console.log("completed")',
		].join("\n");
		const result = await tool.execute("synthetic-array-diagnostic", { language: "js", code, reset: true });
		const output = (result.details as EvalToolDetails).cells?.[0]?.output ?? "";
		expect(output).toContain("Expected response { HTTP: 200, RETRY: 1, STATUS: pending }");
		expect(output).toContain("completed");
	});

	it("preserves a serialized scalar diagnostic and later completed output", async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "eval-serialized-diagnostic-"));
		const session = makeSession(path.join(directory, "unused.txt"));
		const tool = wrapToolWithMetaNotice(new EvalTool(session), session);
		const code = [
			'console.log(JSON.stringify("Expected response { HTTP: 200, RETRY: 1, STATUS: pending }"))',
			'console.log("completed")',
		].join("\n");
		const result = await tool.execute("synthetic-serialized-diagnostic", { language: "js", code, reset: true });
		const output = (result.details as EvalToolDetails).cells?.[0]?.output ?? "";
		expect(output).toContain('"Expected response { HTTP: 200, RETRY: 1, STATUS: pending }"');
		expect(output).toContain("completed");
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
