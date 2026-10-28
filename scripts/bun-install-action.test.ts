import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface CompositeActionStep {
	name?: string;
	run?: string;
}

interface CompositeAction {
	runs: { steps: CompositeActionStep[] };
}

interface InstallStepResult {
	exitCode: number;
	pathOutput: string;
	attempts: number;
	stderr: string;
}
interface DetectStepResult {
	setup: boolean;
	installDir: string;
	pathOutput: string;
}

const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * The version the step installs comes from `packageManager`, so the expectation
 * does too. A literal here would be one more copy of the pin to bump, which is
 * the drift `scripts/the-bun-pin-has-one-owner.test.ts` exists to stop.
 */
function pinnedBunVersion(): string {
	const manifest = JSON.parse(fs.readFileSync("package.json", "utf8")) as { packageManager?: string };
	const match = /^bun@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager ?? "");
	if (!match) throw new Error(`package.json packageManager is not a bun pin: ${manifest.packageManager}`);
	return match[1];
}

async function runDetectStep(installedVersion: string, packageManager = `bun@${pinnedBunVersion()}`): Promise<DetectStepResult> {
	const action = Bun.YAML.parse(await Bun.file(".github/actions/bun-install/action.yml").text()) as CompositeAction;
	const step = action.runs.steps.find(candidate => candidate.name === "Detect bun");
	if (!step?.run) throw new Error("bun-install action has no bun detection step");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bun-detect-action-"));
	tempRoots.push(root);
	await Bun.write(path.join(root, "package.json"), JSON.stringify({ packageManager }));
	const outputPath = path.join(root, "github-output");
	const envPath = path.join(root, "github-env");
	const pathPath = path.join(root, "github-path");
	const runnerTemp = path.join(root, "runner-temp");
	fs.mkdirSync(runnerTemp, { recursive: true });
	const bunPath = path.join(root, "bun");
	await Bun.write(bunPath, '#!/bin/sh\nprintf "%s\\n" "$FAKE_BUN_VERSION"\n');
	fs.chmodSync(bunPath, 0o755);
	const proc = Bun.spawn(["bash", "-c", step.run], {
		cwd: root,
		env: {
			...process.env,
			PATH: `${root}:${process.env.PATH ?? ""}`,
			RUNNER_TEMP: runnerTemp,
			GITHUB_OUTPUT: outputPath,
			GITHUB_ENV: envPath,
			GITHUB_PATH: pathPath,
			FAKE_BUN_VERSION: installedVersion,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	if (exitCode !== 0) throw new Error(`bun detection failed: ${stderr}`);
	const [output, env, pathOutput] = await Promise.all([
		Bun.file(outputPath).text(),
		Bun.file(envPath).text().catch(() => ""),
		Bun.file(pathPath).text().catch(() => ""),
	]);
	const match = /^BUN_INSTALL=(.+)$/m.exec(env);
	return {
		setup: /setup_bun=true/.test(output),
		installDir: match?.[1] ?? "",
		pathOutput: pathOutput.trim(),
	};
}

async function runInstallStep(runnerOs: "Linux" | "Windows", failuresBeforeSuccess = 0): Promise<InstallStepResult> {
	const action = Bun.YAML.parse(await Bun.file(".github/actions/bun-install/action.yml").text()) as CompositeAction;
	const step = action.runs.steps.find(candidate => candidate.name === "Install bun when absent or mismatched");
	if (!step?.run) throw new Error("bun-install action has no executable install step");

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bun-install-action-"));
	tempRoots.push(root);
	const outputPath = path.join(root, "github-path");
	const countPath = path.join(root, "curl-count");
	const curlPath = path.join(root, "curl");
	await Bun.write(
		curlPath,
		`#!/bin/sh
count=0
if [ -f "$FAKE_CURL_COUNT" ]; then
  count="$(cat "$FAKE_CURL_COUNT")"
fi
count=$((count + 1))
printf '%s\\n' "$count" > "$FAKE_CURL_COUNT"
if [ "$count" -le "$FAKE_CURL_FAILURES" ]; then
  printf '#!/bin/sh\\nexit 1\\n'
else
  printf '#!/bin/sh\\nexit 0\\n'
fi
`,
	);
	fs.chmodSync(curlPath, 0o755);

	const sleepPath = path.join(root, "sleep");
	await Bun.write(sleepPath, "#!/bin/sh\nexit 0\n");
	fs.chmodSync(sleepPath, 0o755);

	const cygpathPath = path.join(root, "cygpath");
	await Bun.write(
		cygpathPath,
		'#!/bin/sh\n[ "$*" = "-w /home/test-agent/.bun/bin" ] || exit 9\nprintf \'C:\\\\Users\\\\runner\\\\.bun\\\\bin\\n\'\n',
	);
	fs.chmodSync(cygpathPath, 0o755);

	const proc = Bun.spawn(["bash", "-c", step.run], {
		env: {
			...process.env,
			PATH: `${root}:${process.env.PATH ?? ""}`,
			HOME: "/home/test-agent",
			BUN_INSTALL: "/home/test-agent/.bun",
			RUNNER_TEMP: path.join(root, "runner-temp"),
			RUNNER_OS: runnerOs,
			GITHUB_PATH: outputPath,
			FAKE_CURL_COUNT: countPath,
			FAKE_CURL_FAILURES: String(failuresBeforeSuccess),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	const [pathOutput, attemptsText] = await Promise.all([
		Bun.file(outputPath)
			.text()
			.catch(() => ""),
		Bun.file(countPath).text(),
	]);
	return {
		exitCode,
		pathOutput: pathOutput.trim(),
		attempts: Number(attemptsText.trim()),
		stderr,
	};
}

describe("bun-install composite action PATH serialization", () => {
	it("installs when the runner bun does not match the root packageManager pin", async () => {
		const result = await runDetectStep("1.4.0");
		const expectedDirName = `bun-bun-v${pinnedBunVersion()}`;
		expect(result.setup).toBe(true);
		expect(path.basename(result.installDir)).toBe(expectedDirName);
		expect(result.pathOutput).toBe(`${result.installDir}/bin`);
		expect(result.installDir).not.toBe(path.join(os.homedir(), ".bun"));
	});

	it("keeps a matching runner bun and isolates distinct pinned installs", async () => {
		const pin = pinnedBunVersion();
		const matching = await runDetectStep(pin);
		const first = await runDetectStep("1.4.0");
		const second = await runDetectStep("1.4.0");
		expect(matching.setup).toBe(false);
		expect(matching.installDir).toBe("");
		expect(first.setup).toBe(true);
		expect(second.setup).toBe(true);
		expect(first.installDir).not.toBe(second.installDir);
		expect(first.installDir).toContain(`bun-bun-v${pin}`);
		expect(second.installDir).toContain(`bun-bun-v${pin}`);
	});

	it("uses distinct job-local binaries for different branch pins", async () => {
		const base = await runDetectStep("1.3.0", "bun@1.4.0");
		const head = await runDetectStep("1.3.0");
		expect(base.setup).toBe(true);
		expect(head.setup).toBe(true);
		expect(base.installDir).not.toBe(head.installDir);
		expect(path.basename(base.installDir)).toBe("bun-bun-v1.4.0");
		expect(path.basename(head.installDir)).toBe(`bun-bun-v${pinnedBunVersion()}`);
	});
	/** A native Windows Bun child must receive a Win32 path, not Git Bash's MSYS spelling. */
	it("writes a native Windows Bun directory to GITHUB_PATH", async () => {
		const result = await runInstallStep("Windows");
		expect(result.exitCode).toBe(0);
		expect(result.attempts).toBe(1);
		expect(result.pathOutput).toBe("C:\\Users\\runner\\.bun\\bin");
	});

	/** Unix runners keep the direct HOME-relative Bun directory and never need path translation. */
	it("keeps the POSIX Bun directory on Linux", async () => {
		const result = await runInstallStep("Linux");
		expect(result.exitCode).toBe(0);
		expect(result.attempts).toBe(1);
		expect(result.pathOutput).toBe("/home/test-agent/.bun/bin");
	});

	/** A transient GitHub asset failure must not discard an otherwise healthy Windows CI job. */
	it("retries the complete Bun installer after transient download failures", async () => {
		const result = await runInstallStep("Windows", 2);
		expect(result.exitCode).toBe(0);
		expect(result.attempts).toBe(3);
		expect(result.pathOutput).toBe("C:\\Users\\runner\\.bun\\bin");
		expect(result.stderr).toContain("install failed on attempt 2; retrying");
	});

	/** A persistent outage stays bounded and leaves no unusable directory on the job PATH. */
	it("fails after three attempts when every Bun download fails", async () => {
		const result = await runInstallStep("Windows", 3);
		expect(result.exitCode).toBe(1);
		expect(result.attempts).toBe(3);
		expect(result.pathOutput).toBe("");
		expect(result.stderr).toContain(`failed to install bun-v${pinnedBunVersion()} after 3 attempts`);
	});
});
