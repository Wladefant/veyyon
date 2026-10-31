import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { executeBash } from "@veyyon/coding-agent/exec/bash-executor";
import { ProducerOutputGuard } from "@veyyon/coding-agent/secrets/producer-output";
import { OutputSink } from "@veyyon/coding-agent/session/streaming-output";

const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
	resetSettingsForTest();
});

test("executeBash protects synthetic environment inventory before artifact persistence", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "producer-output-"));
	directories.push(directory);
	await Settings.init({ inMemory: true, cwd: directory });
	const artifactPath = path.join(directory, "bash-output.txt");
	const inventory = "PATH=ghp_FAKE012345678901234567890123456789\nHOME=/safe/home\nCUSTOM=ordinary-value";
	const command = `printf '%s\\n' '${inventory.replaceAll("'", "'\\''")}'`;
	const result = await executeBash(command, {
		cwd: directory,
		timeout: 5000,
		sessionKey: "credential-inventory-regression",
		artifactPath,
		artifactId: "fake-bash-output",
		spillThreshold: 1,
	});
	const persisted = await fs.readFile(artifactPath, "utf8");
	const replay = new OutputSink({ outputGuard: new ProducerOutputGuard() });
	replay.push(persisted);
	expect(result.exitCode).toBe(0);
	expect(result.output).not.toContain("ghp_FAKE012345678901234567890123456789");
	expect(persisted).not.toContain("ghp_FAKE012345678901234567890123456789");
	expect((await replay.dump()).output).not.toContain("ghp_FAKE012345678901234567890123456789");
});
