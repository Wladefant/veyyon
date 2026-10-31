/**
 * A `!command` whose output the shell minimizer shortens keeps the unshortened output as a session
 * artifact and ends with the `artifact://` reference to it; a failed save keeps the shortened output
 * and drops only the reference.
 *
 * WHY. `AgentSession.executeBash` hands the executor `onMinimizedSave`, which writes the original
 * text through `SessionManager.saveArtifact`. No suite ran a minimized command through a session,
 * so a save that returned nothing passed every test while each minimized listing lost the only copy
 * of what it elided, and a save that threw would have failed the command instead of its footer.
 *
 * WHAT IT DOES NOT CATCH. Which commands the native minimizer shortens; `ls -l` is used because it
 * is shortened on every platform the suite runs on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { requireBundledModel } from "../../../agent/test/helpers";

const NAMES = Array.from({ length: 40 }, (_, i) => `file-${i}.txt`);
const FOOTER = /\n\[raw output: artifact:\/\/(\S+)\]\n$/;

describe("a minimized command keeps its raw output as an artifact", () => {
	let dir: TempDir;
	let listing: string;
	let authStorage: AuthStorage;
	let sessionManager: SessionManager;
	let session: AgentSession;

	beforeEach(async () => {
		dir = TempDir.createSync("@minimized-raw-output-");
		listing = path.join(dir.path(), "listing");
		fs.mkdirSync(listing);
		for (const [i, name] of NAMES.entries()) fs.writeFileSync(path.join(listing, name), "x".repeat(i * 10));
		authStorage = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		const model = requireBundledModel("anthropic", "claude-sonnet-4-5");
		sessionManager = SessionManager.create(dir.path(), path.join(dir.path(), "sessions"));
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session.dispose();
		authStorage.close();
		await dir.remove();
	});

	it("saves the unshortened listing and ends the output with its reference", async () => {
		const result = await session.executeBash(`ls -la ${listing}`);

		const id = FOOTER.exec(result.output)?.[1];
		if (id === undefined) throw new Error(`Expected an artifact footer in:\n${result.output}`);
		expect(NAMES.filter(name => !result.output.includes(name)).length).toBeGreaterThan(0);
		const artifactPath = await sessionManager.getArtifactPath(id);
		if (artifactPath === null) throw new Error(`Expected artifact ${id} to exist`);
		const raw = fs.readFileSync(artifactPath, "utf8");
		expect(NAMES.filter(name => !raw.includes(name))).toEqual([]);
	});

	it("keeps the shortened output and drops the reference when the save fails", async () => {
		vi.spyOn(sessionManager, "saveArtifact").mockRejectedValue(new Error("disk full"));

		const result = await session.executeBash(`ls -la ${listing}`);

		expect(result.exitCode).toBe(0);
		expect(result.output).not.toContain("artifact://");
		expect(result.output).toContain("file-0.txt");
		expect(NAMES.filter(name => !result.output.includes(name)).length).toBeGreaterThan(0);
	});
});
