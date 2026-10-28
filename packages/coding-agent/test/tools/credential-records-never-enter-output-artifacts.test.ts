// WHY: Credential inventories with benign labels could leak through live output and raw artifacts.
// These tests sweep shell, JSON, Python, and PowerShell shapes; they do not cover encoded or arbitrary exfiltration.
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { executeBash } from "@veyyon/coding-agent/exec/bash-executor";
import { OutputSink } from "@veyyon/coding-agent/session/streaming-output";
import { BLOCKED_OUTPUT_RECORD, ProducerOutputGuard } from "@veyyon/coding-agent/secrets/producer-output";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";


const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
	resetSettingsForTest();
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
	const secrets = new SecretObfuscator([{ type: "plain", content: "fake-known-value", origin: "environment" }]);
	const redacted = secrets.obfuscate("fake-known-value");
	const guard = new ProducerOutputGuard(text => secrets.obfuscate(text));
	const sink = new OutputSink({ outputGuard: guard, onChunk: chunk => live.push(chunk) });
	for (const character of "result fake-known-value") sink.push(character);
	expect(live).toEqual([]);
	expect((await sink.dump()).output).toBe(`result ${redacted}`);
	expect(live.join("")).toBe(`result ${redacted}`);
	sink.replace("replacement fake-known-value");
	expect((await sink.dump()).output).toBe(`replacement ${redacted}`);
});

test("unterminated oversized records never leak their suffix and memory stays bounded", () => {
	const guard = new ProducerOutputGuard();
	expect(guard.push("x".repeat(65537))).toBe("");
	expect(guard.push("fake-credential-123\nmore-secret-data\n")).toBe(BLOCKED_OUTPUT_RECORD + "\n");
	expect(guard.finish()).toBe("");
});

test("bounded benign assignments and lookups retain exact output", async () => {
	const sink = new OutputSink({ outputGuard: new ProducerOutputGuard() });
	for (const character of "MODE=test\nFEATURE_FLAG=enabled\n/bin:/usr/bin\nan access token\nready") sink.push(character);
	expect((await sink.dump()).output).toBe("MODE=test\nFEATURE_FLAG=enabled\n/bin:/usr/bin\nan access token\nready");
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

test("aggregate filtering keeps large benign multiline minimizer artifacts", async () => {
	const output = "ordinary build progress\n".repeat(5000);
	const guard = new ProducerOutputGuard();
	expect(guard.sanitize(output)).toBe(output);
	const sink = new OutputSink({ outputGuard: guard, spillThreshold: output.length * 2 });
	sink.replace(output);
	expect((await sink.dump()).output).toBe(output);
});

test("ANSI between a credential key and delimiter cannot hide a record", async () => {
	const live: string[] = [];
	const sink = new OutputSink({
		outputGuard: new ProducerOutputGuard(),
		onChunk: chunk => live.push(chunk),
	});
	for (const character of "\x1b[32mAPI_KEY\x1b[0m=fake-credential-123\n") sink.push(character);
	expect((await sink.dump()).output).toBe(BLOCKED_OUTPUT_RECORD + "\n");
	expect(live.join("")).toBe(BLOCKED_OUTPUT_RECORD + "\n");
});

test("ANSI within a known value cannot bypass its secret owner", () => {
	const secrets = new SecretObfuscator([{ type: "plain", content: "fake-known-value", origin: "environment" }]);
	const redacted = secrets.obfuscate("fake-known-value");
	const guard = new ProducerOutputGuard(text => secrets.obfuscate(text));
	expect(guard.sanitize("fake-\x1b[32mknown\x1b[0m-value")).toBe(redacted);
	expect(guard.sanitize("\x1b[32mordinary output\x1b[0m")).toBe("\x1b[32mordinary output\x1b[0m");
});

test("credential labels split by a dump cannot be reassembled in output", () => {
	const guard = new ProducerOutputGuard();
	const output = [
		guard.push("API_KE"),
		guard.finish(),
		guard.push("Y=fake-credential-123\n"),
		guard.finish(),
	].join("");
	expect(output).not.toContain("API_KEY=fake-credential-123");
	expect(output).not.toContain("fake-credential-123");
});

for (const record of [
	"--token=fake-credential-123",
	"?access_token=fake-credential-123",
	"config.api_key: fake-credential-123",
]) {
	test(`recognizes credential label form: ${record.split(/[=:]/)[0]}`, () => {
		const guard = new ProducerOutputGuard();
		expect(guard.push(`${record}\n`)).toBe(BLOCKED_OUTPUT_RECORD + "\n");
		expect(guard.finish()).toBe("");
	});
}

test("dump between credential label chunks keeps the credential out of artifacts", async () => {
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
	sink.push("API_KE");
	expect((await sink.dump()).output).toBe("");
	sink.push("Y=fake-credential-123\n");
	const result = await sink.dumpWithArtifactStatus();
	const persisted = await fs.readFile(artifactPath, "utf8");
	expect(live.join("")).not.toContain("fake-credential-123");
	expect(persisted).not.toContain("fake-credential-123");
	expect(result.output).not.toContain("fake-credential-123");
});

for (const record of [
	"PATH=ghp_FAKE012345678901234567890123456789\nHOME=/safe/home\nCUSTOM=ordinary-value",
	'{\n  "PATH": "ghp_FAKE012345678901234567890123456789",\n  "HOME": "/safe/home",\n  "CUSTOM": "ordinary-value"\n}',
	'{"PATH":"ghp_FAKE012345678901234567890123456789","HOME":"/safe/home","CUSTOM":"ordinary-value"}',
	"{'PATH': 'ghp_FAKE012345678901234567890123456789', 'HOME': '/safe/home', 'CUSTOM': 'ordinary-value'}",
	"Name Value\nPATH ghp_FAKE012345678901234567890123456789\nHOME /safe/home\nCUSTOM ordinary-value",
]) {
	test(`environment inventory stays out of live output and raw artifacts: ${record.slice(0, 24)}`, async () => {
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
		for (const character of record + "\n") sink.push(character);
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
