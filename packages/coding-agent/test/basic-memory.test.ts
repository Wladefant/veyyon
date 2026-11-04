import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "../src/config/settings";
import { resolveMemoryBackend } from "../src/memory/resolve";
import { createMemoryRuntimeContext } from "../src/memory/runtime";
import { readBasicMemory, retainBasicMemory, searchBasicMemory } from "../src/memory/basic-memory";
import { MemoryRecallTool } from "../src/tools/agent/memory-recall";
import { MemoryRetainTool } from "../src/tools/agent/memory-retain";
 
const command = process.env.BASIC_MEMORY_TEST_COMMAND;
const directories: string[] = [];
const integration = it.skipIf(!command);

async function isolatedSettings() {
	const directory = await mkdtemp(join(tmpdir(), "veyyon-basic-memory-"));
	directories.push(directory);
	const vault = join(directory, "vault");
	await mkdir(vault, { recursive: true });
	await writeFile(join(directory, "config.json"), JSON.stringify({
		mode: "local",
		projects: { main: { path: vault } },
	}), "utf8");
	return {
		directory,
		vault,
		settings: Settings.isolated({
			"memory.backend": "basic-memory",
			"memory.basicMemory.command": command ?? "bm",
			"memory.basicMemory.project": "main",
			"memory.basicMemory.configDir": directory,
			"memory.basicMemory.timeoutMs": 60_000,
		}),
	};
}

function settingsFor(directory: string, overrides: Record<string, unknown> = {}) {
	return Settings.isolated({
		"memory.backend": "basic-memory",
		"memory.basicMemory.command": command ?? "bm",
		"memory.basicMemory.project": "main",
		"memory.basicMemory.configDir": directory,
		"memory.basicMemory.timeoutMs": 60_000,
		...overrides,
	} as never);
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Basic Memory backend integration", () => {
	integration("stores and reads multiline Unicode content, context, and source metadata without loss", async () => {
		const { settings, directory, vault } = await isolatedSettings();
		const content = "Preference: keep the original wording.\n日本語と café — \u{1F30D}";
		const context = "Context line one.\nContext line two: preserve exactly.";
		const saved = await retainBasicMemory(settings, directory, [{ content, context, source: "test" }]);

		expect(saved).toMatchObject({ backend: "basic-memory", stored: 1 });
		expect(saved.ids).toHaveLength(1);
		const note = await readFile(join(vault, "hindsight-memory", `${saved.ids![0]}.md`), "utf8");
		const encoded = note.match(/hindsight_source_base64:([A-Za-z0-9+/=]+)/)?.[1];
		expect(encoded).toBeDefined();
		expect(JSON.parse(Buffer.from(encoded!, "base64").toString("utf8"))).toMatchObject({ text: content, context, source: "test" });
		expect(note).toContain(`- ${content.split("\n")[0]}`);
		expect(note).toContain(`  ${content.split("\n")[1]}`);
		await expect(readBasicMemory(settings, directory, saved.ids![0]!)).resolves.toBe(`${content}\n\nContext: ${context}`);
		const recalled = await searchBasicMemory(settings, directory, "café 日本語", { limit: 5 });
		expect(recalled.backend).toBe("basic-memory");
		expect(recalled.items.some((item) => item.content === `${content}\n\nContext: ${context}`)).toBe(true);
	});

	integration("uses lexical recall and returns an empty result for no match", async () => {
		const { settings, directory } = await isolatedSettings();
		await retainBasicMemory(settings, directory, [
			{ content: "Orchid protocol: rotate the amber key every spring.", context: "Lexical recall fixture" },
		]);
		const result = await searchBasicMemory(settings, directory, "orchid amber", { limit: 5 });
		expect(result.items.some((item) => item.content.toLowerCase().includes("orchid"))).toBe(true);
		const empty = await searchBasicMemory(settings, directory, "unrelated xenolith", { limit: 5 });
		expect(empty).toMatchObject({ backend: "basic-memory", count: 0, items: [] });
	});

	integration("reads a missing note as a not-found failure", async () => {
		const { settings, directory } = await isolatedSettings();
		await expect(readBasicMemory(settings, directory, "definitely-not-a-real-note")).rejects.toThrow(/not found|no note|does not exist/i);
	});

	integration("runs through the resolved backend runtime and tool runtime", async () => {
		const { settings, directory } = await isolatedSettings();
		expect((await resolveMemoryBackend(settings)).id).toBe("basic-memory");
		const session = { settings } as never;
		const runtime = createMemoryRuntimeContext({ agentDir: directory, cwd: directory, session });
		const saved = await runtime.save({ content: "Runtime integration orchid fact.", context: "Saved via runtime" });
		expect(saved).toMatchObject({ backend: "basic-memory", stored: 1 });
		const recalled = await runtime.search("orchid");
		expect(recalled.backend).toBe("basic-memory");
		expect(recalled.items.some((item) => item.content.includes("Runtime integration orchid fact."))).toBe(true);
		const retain = MemoryRetainTool.createIf({ settings } as never);
		const recall = MemoryRecallTool.createIf({ settings } as never);
		expect(retain).not.toBeNull();
		expect(recall).not.toBeNull();
	});
});

describe("Basic Memory backend validation", () => {
	it("rejects an empty command, project, and out-of-range timeout before connecting", async () => {
		const directory = await mkdtemp(join(tmpdir(), "veyyon-basic-memory-invalid-"));
		directories.push(directory);
		for (const overrides of [
			{ "memory.basicMemory.command": "   " },
			{ "memory.basicMemory.project": "   " },
			{ "memory.basicMemory.timeoutMs": 999 },
			{ "memory.basicMemory.timeoutMs": 300_001 },
		]) {
			await expect(searchBasicMemory(settingsFor(directory, overrides), directory, "query")).rejects.toThrow(/command and project|timeoutMs/i);
		}
	});

	it("rejects a missing configured executable", async () => {
		const directory = await mkdtemp(join(tmpdir(), "veyyon-basic-memory-missing-"));
		directories.push(directory);
		const settings = settingsFor(directory, { "memory.basicMemory.command": join(directory, "missing-bm.exe") });
		await expect(searchBasicMemory(settings, directory, "missing command")).rejects.toThrow(/basic memory|bm|spawn|command/i);
	});

	it("does not start the executable when retain was already aborted", async () => {
		const directory = await mkdtemp(join(tmpdir(), "veyyon-basic-memory-aborted-"));
		directories.push(directory);
		const controller = new AbortController();
		controller.abort(new Error("cancel before retain"));
		const settings = settingsFor(directory, { "memory.basicMemory.command": join(directory, "must-not-run.exe") });
		await expect(retainBasicMemory(settings, directory, [{ content: "never stored" }], controller.signal)).rejects.toThrow("cancel before retain");
	});
});

