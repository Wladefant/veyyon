// WHY: Shell environment inventories can expose credential values while staying syntactically benign.
// This guards inventory-shaped output only; executeBash persistence is covered by the credential-records test.
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ProducerOutputGuard } from "@veyyon/coding-agent/secrets/producer-output";
import { OutputSink } from "@veyyon/coding-agent/session/streaming-output";

const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

for (const inventory of [
	"PATH=ghp_FAKE012345678901234567890123456789\nHOME=/safe/home\nCUSTOM=ordinary-value",
	'{\n  "PATH": "ghp_FAKE012345678901234567890123456789",\n  "HOME": "/safe/home",\n  "CUSTOM": "ordinary-value"\n}',
	'{"PATH":"ghp_FAKE012345678901234567890123456789","HOME":"/safe/home","CUSTOM":"ordinary-value"}',
	"{'PATH': 'ghp_FAKE012345678901234567890123456789', 'HOME': '/safe/home', 'CUSTOM': 'ordinary-value'}",
	"Name Value\nPATH ghp_FAKE012345678901234567890123456789\nHOME /safe/home\nCUSTOM ordinary-value",
]) {
	test(`shell inventory stays out of live output and raw artifacts: ${inventory.slice(0, 24)}`, async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "producer-output-"));
		directories.push(directory);
		const artifactPath = path.join(directory, "output.txt");
		const live: string[] = [];
		const sink = new OutputSink({
			outputGuard: new ProducerOutputGuard(),
			artifactPath,
			artifactId: "fake-output",
			spillThreshold: 1,
			onChunk: chunk => live.push(chunk),
		});
		for (const character of inventory + "\n") sink.push(character);
		const result = await sink.dumpWithArtifactStatus();
		const persisted = await fs.readFile(artifactPath, "utf8");
		const replay = new OutputSink({ outputGuard: new ProducerOutputGuard() });
		replay.push(persisted);
		expect(live.join("")).not.toContain("ghp_FAKE012345678901234567890123456789");
		expect(persisted).not.toContain("ghp_FAKE012345678901234567890123456789");
		expect(result.output).not.toContain("ghp_FAKE012345678901234567890123456789");
		expect((await replay.dump()).output).not.toContain("ghp_FAKE012345678901234567890123456789");
	});
}
