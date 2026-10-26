// WHY: raw backing artifacts and streamed previews previously preceded consumer redaction.
// These tests cover recognizable records and known values, not encoded data or image content.
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { OutputSink } from "@veyyon/coding-agent/session/streaming-output";
import { BLOCKED_OUTPUT_RECORD, ProducerOutputGuard } from "@veyyon/coding-agent/secrets/producer-output";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

for (const record of [
	"API_KEY=fake-credential-123",
	"SERVICE_ACCESS_TOKEN=fake-credential-123",
	"export DB_PASSWORD='fake-credential-123'",
	"API_KEY    fake-credential-123",
	'{"API_KEY":"fake-credential-123","PATH":"/safe"}',
	"{'CLIENT_SECRET': 'fake-credential-123'}",
	'  "credentials": {\n    "value": "fake-credential-123"\n  }',
]) {
	test(`credential record stays out of live output and raw artifacts: ${record.split(/[=:]/)[0]}`, async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "producer-output-"));
		directories.push(directory);
		const artifactPath = path.join(directory, "output.txt");
		const live: string[] = [];
		const sink = new OutputSink({
			outputGuard: new ProducerOutputGuard(), artifactPath, artifactId: "fake-output",
			spillThreshold: 1, onChunk: chunk => live.push(chunk),
		});
		// Every boundary, including within both the key and value, is hostile to chunk-local filtering.
		for (const character of record + "\n") sink.push(character);
		const result = await sink.dumpWithArtifactStatus();
		const persisted = await fs.readFile(artifactPath, "utf8");
		expect(live.join("")).toBe(BLOCKED_OUTPUT_RECORD + "\n");
		expect(persisted).not.toContain("fake-credential-123");
		expect(persisted).toContain(BLOCKED_OUTPUT_RECORD);
		expect(result.output).not.toContain("fake-credential-123");
	});
}

test("known values redact at EOF and on minimizer replacement without enumerating environment", async () => {
	const live: string[] = [];
	const guard = new ProducerOutputGuard(text => text.replaceAll("fake-known-value", "<redacted>"));
	const sink = new OutputSink({ outputGuard: guard, onChunk: chunk => live.push(chunk) });
	for (const character of "result fake-known-value") sink.push(character);
	expect(live).toEqual([]);
	expect((await sink.dump()).output).toBe("result <redacted>");
	expect(live.join("")).toBe("result <redacted>");
	sink.replace("replacement fake-known-value");
	expect((await sink.dump()).output).toBe("replacement <redacted>");
});

test("unterminated oversized records never leak their suffix and memory stays bounded", () => {
	const guard = new ProducerOutputGuard();
	expect(guard.push("x".repeat(65537))).toBe("");
	expect(guard.push("fake-credential-123\nmore-secret-data\n")).toBe(BLOCKED_OUTPUT_RECORD + "\n");
	expect(guard.finish()).toBe("");
});

test("bounded benign assignments and lookups retain exact output", async () => {
	const sink = new OutputSink({ outputGuard: new ProducerOutputGuard() });
	for (const character of "MODE=test\n/bin:/usr/bin\nready") sink.push(character);
	expect((await sink.dump()).output).toBe("MODE=test\n/bin:/usr/bin\nready");
});

test("redactor failure withholds the record instead of falling back to raw output", () => {
	const guard = new ProducerOutputGuard(() => { throw new Error("synthetic failure"); });
	expect(guard.push("fake-credential-123\n")).toBe(BLOCKED_OUTPUT_RECORD + "\n");
	expect(guard.finish()).toBe("");
});

test("a final snapshot cannot reopen a withheld producer stream", () => {
	const guard = new ProducerOutputGuard();
	expect(guard.push("API_KEY=fake-credential-123\n")).toBe(BLOCKED_OUTPUT_RECORD + "\n");
	expect(guard.finish()).toBe("");
	expect(guard.push("unlabelled credential suffix\n")).toBe("");
	expect(guard.finish()).toBe("");
	guard.reset();
	expect(guard.push("safe new producer\n")).toBe("safe new producer\n");
});
