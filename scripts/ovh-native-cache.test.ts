import { afterEach, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = join(root, ".github/workflows/ovh-ci.yml");
const workflow = Bun.YAML.parse(readFileSync(workflowPath, "utf8")) as {
	jobs: { prepare: { steps: { id?: string; run?: string }[] } };
};
const nativeScript = workflow.jobs.prepare.steps.find(step => step.id === "native")?.run;
if (!nativeScript) throw new Error("Native build step is missing");

interface Fixture {
	dir: string;
	toolCache: string;
	workspace: string;
	runnerTemp: string;
	target: string;
	buildLog: string;
	output: string;
	env: NodeJS.ProcessEnv;
}

const fixtures: string[] = [];
afterEach(() => {
	for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): Fixture {
	const dir = mkdtempSync(join(tmpdir(), "veyyon-native-cache-"));
	fixtures.push(dir);
	const toolCache = join(dir, "tool-cache");
	const workspace = join(dir, "workspace");
	const runnerTemp = join(dir, "runner-temp");
	const bin = join(dir, "bin");
	for (const path of [toolCache, workspace, runnerTemp, bin]) mkdirSync(path);
	const target = join(toolCache, "veyyon-cargo", "runner-one");
	const buildLog = join(dir, "build.log");
	const output = join(dir, "github-output");
	const fakeBun = join(bin, "bun");
	writeFileSync(fakeBun, [
		"#!/bin/sh",
		'printf "%s\\n" "$*" >> "$BUILD_LOG"',
		'if [ "$1" = run ]; then exit "${BUILD_EXIT:-0}"; fi',
		'if [ "$1" = -e ]; then exit "${VERIFY_EXIT:-0}"; fi',
		"exit 91",
	].join("\n") + "\n");
	chmodSync(fakeBun, 0o755);
	const nativeDir = join(workspace, "natives/bridge/bindings/native");
	mkdirSync(nativeDir, { recursive: true });
	writeFileSync(join(nativeDir, "veyyon_natives.linux-x64.fixture.node"), "fixture");
	return {
		dir,
		toolCache,
		workspace,
		runnerTemp,
		target,
		buildLog,
		output,
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			RUNNER_TOOL_CACHE: toolCache,
			RUNNER_NAME: "runner-one",
			GITHUB_WORKSPACE: workspace,
			RUNNER_TEMP: runnerTemp,
			CARGO_TARGET_DIR: target,
			RELATED_TESTS: "selected.test.ts",
			NATIVE_INPUT: "false",
			GITHUB_OUTPUT: output,
			BUILD_LOG: buildLog,
		},
	};
}

function runStep(f: Fixture, env = f.env) {
	return spawnSync("bash", ["-c", nativeScript!], {
		cwd: f.workspace,
		env,
		encoding: "utf8",
		timeout: 15_000,
	});
}

function makeSentinel(f: Fixture, at = f.target): string {
	mkdirSync(at, { recursive: true });
	const sentinel = join(at, "sentinel");
	writeFileSync(sentinel, "keep");
	return sentinel;
}

const linuxIt = it.skipIf(process.platform !== "linux");

describe("OVH native cache behavior", () => {
	linuxIt("keeps an under-threshold cache and builds while preserving a sibling cache", () => {
		const f = fixture();
		const ownSentinel = makeSentinel(f);
		const siblingSentinel = makeSentinel(f, join(f.toolCache, "veyyon-cargo", "runner-two"));

		const result = runStep(f);

		expect(result.status).toBe(0);
		expect(existsSync(ownSentinel)).toBe(true);
		expect(existsSync(siblingSentinel)).toBe(true);
		expect(readFileSync(f.buildLog, "utf8")).toContain("run ci:build:native");
		expect(readFileSync(f.output, "utf8")).toContain("native_ready=true");
		expect(result.stdout).toContain("pruned=false");
	});

	linuxIt("prunes only its own over-threshold cache before rebuilding", () => {
		const f = fixture();
		const ownSentinel = makeSentinel(f);
		const sparseCache = join(f.target, "large-sparse-file");
		const expanded = spawnSync("truncate", ["-s", "4294967297", sparseCache], { encoding: "utf8" });
		expect(expanded.status).toBe(0);
		const siblingSentinel = makeSentinel(f, join(f.toolCache, "veyyon-cargo", "runner-two"));

		const result = runStep(f);

		expect(result.status).toBe(0);
		expect(existsSync(ownSentinel)).toBe(false);
		expect(existsSync(siblingSentinel)).toBe(true);
		expect(readFileSync(f.buildLog, "utf8")).toContain("run ci:build:native");
		expect(result.stdout).toContain("pruned=true");
	});

	linuxIt("rejects empty roots and invalid runner names before cache deletion", () => {
		for (const env of [
			{ RUNNER_TOOL_CACHE: "" },
			{ RUNNER_NAME: "../runner" },
		]) {
			const f = fixture();
			const sentinel = makeSentinel(f);
			const result = runStep(f, { ...f.env, ...env });

			expect(result.status).not.toBe(0);
			expect(existsSync(sentinel)).toBe(true);
			expect(existsSync(f.buildLog)).toBe(false);
		}
	});

	linuxIt("rejects a symlinked intermediate cache directory before touching its target", () => {
		const f = fixture();
		const outsideCache = join(f.dir, "outside-cache");
		const sentinel = makeSentinel(f, join(outsideCache, "runner-one"));
		symlinkSync(outsideCache, join(f.toolCache, "veyyon-cargo"), "dir");

		const result = runStep(f);

		expect(result.status).not.toBe(0);
		expect(existsSync(sentinel)).toBe(true);
		expect(existsSync(f.buildLog)).toBe(false);
	});

	linuxIt("rejects a symlinked cache leaf before touching its target", () => {
		const f = fixture();
		const outsideCache = join(f.dir, "outside-cache");
		const sentinel = makeSentinel(f, outsideCache);
		mkdirSync(dirname(f.target), { recursive: true });
		symlinkSync(outsideCache, f.target, "dir");

		const result = runStep(f);

		expect(result.status).not.toBe(0);
		expect(existsSync(sentinel)).toBe(true);
		expect(existsSync(f.buildLog)).toBe(false);
	});

	linuxIt("aborts on a held lock without deleting cache contents or starting the build", async () => {
		const f = fixture();
		const sentinel = makeSentinel(f);
		const lockPath = `${f.target}.lock`;
		const holder = spawn("flock", ["-n", lockPath, "-c", "echo locked; cat >/dev/null"], {
			stdio: ["pipe", "pipe", "inherit"],
		});
		try {
			await once(holder.stdout!, "data");
			const result = runStep(f);

			expect(result.status).not.toBe(0);
			expect(existsSync(sentinel)).toBe(true);
			expect(existsSync(f.buildLog)).toBe(false);
		} finally {
			holder.stdin!.end();
			await once(holder, "exit");
		}

	});

	linuxIt("retains the compiler failure status after final disk logging", () => {
		const f = fixture();
		makeSentinel(f);

		const result = runStep(f, { ...f.env, BUILD_EXIT: "23" });

		expect(result.status).toBe(23);
		expect(readFileSync(f.buildLog, "utf8")).toContain("run ci:build:native");
	});
});
