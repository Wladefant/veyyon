import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DIR_OVERRIDE_ENV_KEYS, postmortem } from "@veyyon/utils";

/**
 * An update whose process ends mid-download leaves nothing beside the binary.
 *
 * THE DEFECT. A background update streams the release into
 * `<binary>.<attempt UUID>.new` next to the installed binary. Closing the
 * terminal (SIGHUP), Ctrl+C or quitting the session while that download was in
 * flight ended the process before any removal ran, and no later run reclaims a
 * `.new`: the sweep leaves them alone because one may be a live download. Each
 * interrupted update left a partial copy of the binary, tens of megabytes, in the
 * install directory until uninstall.
 *
 * THE CLASS: every way a process ends that runs exit handlers, in every phase
 * before the replacement lock takes the staged file. The reasons are taken from
 * `postmortem.Reason` at run time, so a new reason turns this red until it has a
 * trigger here or is recorded as one that never ends a process. Each case drives
 * the real `updateViaBinaryAt` and ends the process only once the staged file
 * holds bytes and the attempt sits in its phase: a release body that never
 * finishes, or a checksum sidecar that never arrives. A pass cannot come from a
 * download that never started.
 *
 * WHAT IT DOES NOT CATCH: SIGKILL, a crash of the runtime itself and power loss,
 * which run no handler; `--uninstall` reclaims those files. Nor does it cover
 * the wait for the replacement lock, or an exit during the swap, where the lock
 * owns the staged file.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const UPDATE_CLI = path.join(REPO_ROOT, "packages/coding-agent/src/cli/update-cli.ts");
const INSTALLED = "#!/bin/sh\necho veyyon/1.0.0\n";

/** How the child ends itself for each reason, and the exit status that reason produces. */
const TRIGGERS: Record<string, { code: string; status: number }> = {
	exit: { code: "process.exit(0);", status: 0 },
	sigint: { code: 'process.kill(process.pid, "SIGINT");', status: 130 },
	sigterm: { code: 'process.kill(process.pid, "SIGTERM");', status: 143 },
	sighup: { code: 'process.kill(process.pid, "SIGHUP");', status: 129 },
	uncaught_exception: { code: 'setTimeout(() => { throw new Error("study: fatal"); }, 0);', status: 1 },
	unhandled_rejection: { code: 'Promise.reject(new Error("study: rejected"));', status: 1 },
};

/** Reasons that never end a process on their own, so there is nothing to interrupt. */
const NOT_PROCESS_ENDINGS = [postmortem.Reason.PRE_EXIT, postmortem.Reason.MANUAL];

/** Where the attempt is stalled when the process ends. */
const PHASES = ["download", "checksum"] as const;

function childScript(target: string, phase: (typeof PHASES)[number], trigger: string): string {
	return `
import * as fs from "node:fs";
import * as path from "node:path";
import { updateViaBinaryAt } from ${JSON.stringify(UPDATE_CLI)};

const phase = ${JSON.stringify(phase)};
let awaitingChecksum = false;
globalThis.fetch = async url => {
	// The checksum sidecar never arrives.
	if (String(url).endsWith(".sha256")) {
		awaitingChecksum = true;
		return new Promise(() => {});
	}
	// The release starts arriving and, in the download phase, never finishes.
	const chunk = new Uint8Array(64 * 1024);
	const body = new ReadableStream({
		start(controller) {
			controller.enqueue(chunk);
			if (phase !== "download") controller.close();
		},
	});
	return new Response(body, { status: 200 });
};
// A live session keeps its event loop busy; only the trigger below may end this one.
setInterval(() => {}, 1_000);

void updateViaBinaryAt(${JSON.stringify(target)}, "2.0.0", () => {});
const dir = path.dirname(${JSON.stringify(target)});
const deadline = Date.now() + 10_000;
for (;;) {
	const staged = fs.readdirSync(dir).find(name => name.endsWith(".new"));
	const inPhase = phase === "download" || awaitingChecksum;
	if (staged && inPhase && fs.statSync(path.join(dir, staged)).size > 0) {
		console.log("STAGED " + staged);
		break;
	}
	if (Date.now() > deadline) {
		console.log("NEVER STAGED");
		process.exit(3);
	}
	await new Promise(resolve => setTimeout(resolve, 10));
}
${trigger}
`;
}

describe("an update interrupted mid-download", () => {
	const reasons = Object.values(postmortem.Reason);

	it("has a trigger for every reason that ends a process", () => {
		expect(reasons.filter(reason => !(reason in TRIGGERS))).toEqual(NOT_PROCESS_ENDINGS);
	});

	const cases = PHASES.flatMap(phase =>
		reasons.filter(reason => reason in TRIGGERS).map(reason => [phase, reason] as const),
	);
	it.each(cases)(
		"leaves only the installed binary when the %s phase ends by %s",
		async (phase, reason) => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-interrupted-update-"));
			try {
				const bin = path.join(root, "bin");
				const home = path.join(root, "home");
				await fs.mkdir(bin);
				await fs.mkdir(home);
				const target = path.join(bin, "veyyon");
				await fs.writeFile(target, INSTALLED, { mode: 0o755 });

				const env: Record<string, string | undefined> = { ...process.env, HOME: home };
				for (const key of DIR_OVERRIDE_ENV_KEYS) delete env[key];
				const run = spawnSync(process.execPath, ["-e", childScript(target, phase, TRIGGERS[reason].code)], {
					cwd: REPO_ROOT,
					encoding: "utf8",
					env,
					timeout: 20_000,
				});
				const output = `${run.stdout}${run.stderr}`;

				// Ended by the trigger, within the bound, after the attempt had staged bytes.
				expect(run.signal, output).toBeNull();
				expect(output).toMatch(/STAGED veyyon\.[0-9a-f-]{36}\.new/);
				expect(run.status, output).toBe(TRIGGERS[reason].status);

				expect(await fs.readdir(bin)).toEqual(["veyyon"]);
				expect(await fs.readFile(target, "utf8")).toBe(INSTALLED);
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		},
		30_000,
	);
});
