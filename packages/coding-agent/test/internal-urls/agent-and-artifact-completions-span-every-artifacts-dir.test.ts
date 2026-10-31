/**
 * Contract: `agent://` and `artifact://` completions list the ids found across
 * EVERY registered artifacts dir, each id once, in the scheme's own order
 * (names alphabetically, artifact ids numerically). A candidate dir that does
 * not exist, or that is a file, contributes nothing instead of failing the
 * completion, matching `history://`.
 *
 * Gap: the order of dirs is not observable here, since both schemes sort.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentProtocolHandler } from "@veyyon/coding-agent/internal-urls/agent-protocol";
import { ArtifactProtocolHandler } from "@veyyon/coding-agent/internal-urls/artifact-protocol";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@veyyon/coding-agent/internal-urls/registry-helpers";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { removeWithRetries } from "@veyyon/utils";

let root = "";

async function artifactsDir(name: string, files: string[]): Promise<string> {
	const dir = path.join(root, name);
	await fs.mkdir(dir, { recursive: true });
	for (const file of files) await fs.writeFile(path.join(dir, file), "x");
	return dir;
}

describe("agent:// and artifact:// completions", () => {
	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		resetRegisteredArtifactDirsForTests();
		root = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-completions-"));
		registerArtifactsDir(await artifactsDir("first", ["3.bash.log", "10.read.txt", "Reviewer.md", "notes.txt"]));
		registerArtifactsDir(await artifactsDir("second", ["2.grep.log", "3.eval.log", "Reviewer.md", "Worker.md"]));
		registerArtifactsDir(path.join(root, "missing"));
		const fileCandidate = path.join(root, "a-file");
		await fs.writeFile(fileCandidate, "not a directory");
		registerArtifactsDir(fileCandidate);
	});

	afterEach(async () => {
		AgentRegistry.resetGlobalForTests();
		resetRegisteredArtifactDirsForTests();
		await removeWithRetries(root);
	});

	it("lists every agent output id once, alphabetically", async () => {
		const completions = await new AgentProtocolHandler().complete();
		expect(completions.map(c => c.value)).toEqual(["Reviewer", "Worker"]);
	});

	it("lists every artifact id once, in numeric order", async () => {
		const completions = await new ArtifactProtocolHandler().complete();
		expect(completions.map(c => c.value)).toEqual(["2", "3", "10"]);
	});
});
