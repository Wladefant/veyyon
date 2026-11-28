import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const dayMs = 24 * 60 * 60 * 1000;
const mib = 1024 * 1024;

async function withProfile(run: (profile: string) => Promise<void>): Promise<void> {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-http-dump-retention-"));
	try {
		await run(home);
	} finally {
		await fs.rm(home, { recursive: true, force: true });
	}
}

function dumpDir(home: string): string {
	return path.join(home, ".veyyon", "profiles", "default", "logs", "http-400-requests");
}

async function rejectRequest(home: string, bodyLength = 8): Promise<string> {
	// The production writer is intentionally disabled under bun test. Start a
	// normal Bun process and prove its resolved destination before exercising it.
	const result = Bun.spawn({
		cmd: [
			process.execPath,
			"--no-env-file",
			"-e",
			`
import { appendRawHttpRequestDumpFor400 } from "./src/utils/http-inspector.ts";
import { getLogsDir } from "@veyyon/utils/dirs";
import * as path from "node:path";
if (path.relative(process.env.EXPECTED_LOGS_DIR, getLogsDir()) !== "") {
	throw new Error("Refusing to write outside the isolated test profile");
}
console.log(JSON.stringify(await appendRawHttpRequestDumpFor400("bad payload", { status: 400 }, {
	provider: "fixture", api: "fixture", model: "fixture", body: "x".repeat(Number(process.env.BODY_LENGTH)),
})));
`,
		],
		cwd: path.join(import.meta.dir, ".."),
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			VEYYON_PROFILE: "default",
			VEYYON_CONFIG_DIR: ".veyyon",
			VEYYON_CODING_AGENT_DIR: "",
			XDG_DATA_HOME: "",
			XDG_CACHE_HOME: "",
			XDG_STATE_HOME: "",
			BUN_ENV: "production",
			NODE_ENV: "production",
			EXPECTED_LOGS_DIR: path.dirname(dumpDir(home)),
			BODY_LENGTH: String(bodyLength),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		result.exited,
		new Response(result.stdout).text(),
		new Response(result.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`Writer fixture exited ${exitCode}: ${stderr}`);
	return JSON.parse(stdout) as string;
}

async function seedDump(dir: string, daysOld: number, size?: number): Promise<string> {
	const date = new Date(Date.now() - daysOld * dayMs);
	const file = path.join(dir, `${date.getTime()}-${crypto.randomUUID()}.json`);
	await fs.writeFile(file, "fixture");
	if (size !== undefined) await fs.truncate(file, size);
	await fs.utimes(file, date, date);
	return file;
}

const savedPath = (message: string): string | undefined => message.split("\nraw-http-request=")[1];

test("expires managed dumps after seven days without touching legacy or recent evidence", async () => {
	await withProfile(async home => {
		const dir = dumpDir(home);
		const managed = path.join(dir, "retained-v1");
		await fs.mkdir(managed, { recursive: true });
		const legacy = await seedDump(dir, 8);
		const expired = await seedDump(managed, 8);
		const recent = await seedDump(managed, 6);

		const file = savedPath(await rejectRequest(home));
		expect(path.dirname(file ?? "")).toBe(managed);
		expect(await fs.readFile(file!, "utf8")).toContain('"body": "xxxxxxxx"');
		expect(await Bun.file(expired).exists()).toBe(false);
		expect(await fs.readFile(legacy, "utf8")).toBe("fixture");
		expect(await fs.readFile(recent, "utf8")).toBe("fixture");
	});
});

test("concurrent writers stay below the byte cap without evicting recent dumps", async () => {
	await withProfile(async home => {
		const managed = path.join(dumpDir(home), "retained-v1");
		await fs.mkdir(managed, { recursive: true });
		const recent = await seedDump(managed, 1, 63 * mib);
		const messages = await Promise.all([rejectRequest(home, (3 * mib) / 4), rejectRequest(home, (3 * mib) / 4)]);
		const recorded = messages.map(savedPath).filter(file => file !== undefined);
		expect(recorded).toHaveLength(1);
		expect(messages.filter(message => message.includes("raw-http-request-save-failed="))).toHaveLength(1);
		expect((await fs.stat(recent)).size).toBe(63 * mib);
		expect((await fs.stat(recent)).size + (await fs.stat(recorded[0])).size).toBeLessThanOrEqual(64 * mib);
	});
});

test("a full count cap preserves recent evidence and returns a diagnostic", async () => {
	await withProfile(async home => {
		const managed = path.join(dumpDir(home), "retained-v1");
		await fs.mkdir(managed, { recursive: true });
		for (let index = 0; index < 256; index++) await seedDump(managed, 1);
		expect(await rejectRequest(home)).toContain("raw-http-request-save-failed=");
		expect(await fs.readdir(managed)).toHaveLength(256);
	});
});
