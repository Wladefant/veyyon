import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Contract: a veyyon process relaunched under another profile runs on that profile's `.env` layers,
 * not on the parent's.
 *
 * WHY THIS SUITE EXISTS. `/profile <name>` and `/resume` of another profile's session relaunch veyyon
 * with the parent's environment plus `VEYYON_PROFILE`. The parent's environment held every variable
 * its own `<configRoot>/.env` and `<agentDir>/.env` had set, and an inherited variable outranks every
 * `.env` file, so the child ran on the parent profile's credentials: a key both profiles set resolved
 * to the parent's value in the child. The relaunch now passes the environment through
 * `withoutDotenvValues`.
 *
 * THE CLASS THIS CLOSES is any per-profile `.env` layer surviving into a relaunch under another
 * profile. Both per-profile layers are swept against every direction between a named profile and the
 * default one. The negative controls: a variable the real environment set, and one the parent changed
 * at run time, still reach the child.
 *
 * WHAT IT DOES NOT CATCH: a relaunch site that spawns without `withoutDotenvValues`. The one site,
 * `InteractiveMode.shutdown`, is exercised by its callers' suites through the relaunch request, not by
 * spawning.
 *
 * SUBPROCESSES, because the `.env` layers are applied once per process at module load.
 */

const UTILS_INDEX = path.join(import.meta.dir, "..", "src", "index.ts");
const KEY = "VEYYON_RELAUNCH_DOTENV_PROBE";
const LAYERS = ["agent", "configRoot"] as const;
type Layer = (typeof LAYERS)[number];
const DIRECTIONS = [
	{ parent: "work", child: "oss" },
	{ parent: "work", child: "default" },
	{ parent: "default", child: "work" },
] as const;

let root = "";

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "relaunch-dotenv-"));
});

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function layerDir(configRoot: string, profile: string, layer: Layer): string {
	const profileRoot = path.join(configRoot, "profiles", profile);
	return layer === "agent" ? path.join(profileRoot, "agent") : profileRoot;
}

interface Relaunch {
	parent: string;
	child: string;
	layer: Layer;
	/** A value for the key already in the parent's real environment. */
	real?: string;
	/** A value the parent assigns at run time before relaunching. */
	runtime?: string;
}

/** The key's value in the parent, and in the child it relaunches the way `InteractiveMode` does. */
async function relaunch(spec: Relaunch): Promise<{ parent: string; child: string }> {
	const caseRoot = fs.mkdtempSync(path.join(root, "case-"));
	const configRoot = path.join(caseRoot, "config");
	fs.mkdirSync(path.join(caseRoot, "home"));
	for (const profile of new Set([spec.parent, spec.child])) {
		const dir = layerDir(configRoot, profile, spec.layer);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, ".env"), `${KEY}=${profile}-value\n`);
	}
	const script = path.join(caseRoot, "probe.ts");
	fs.writeFileSync(
		script,
		`import { withoutDotenvValues } from ${JSON.stringify(UTILS_INDEX)};
const key = ${JSON.stringify(KEY)};
if (process.argv[2] === "child") {
	console.log(Bun.env[key] ?? "(unset)");
} else {
	const runtime = ${JSON.stringify(spec.runtime ?? null)};
	if (runtime !== null) process.env[key] = runtime;
	const child = Bun.spawnSync([process.execPath, import.meta.path, "child"], {
		env: { ...withoutDotenvValues(process.env), VEYYON_PROFILE: ${JSON.stringify(spec.child)} },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (child.exitCode !== 0) throw new Error(child.stderr.toString());
	console.log(JSON.stringify({ parent: Bun.env[key] ?? "(unset)", child: child.stdout.toString().trim() }));
}
`,
	);
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: path.join(caseRoot, "home"),
		VEYYON_CONFIG_DIR: configRoot,
		VEYYON_PROFILE: spec.parent,
	};
	if (spec.real !== undefined) env[KEY] = spec.real;
	const proc = Bun.spawn([process.execPath, "run", script], { cwd: caseRoot, env, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(code, `probe process failed:\n${err}`).toBe(0);
	return JSON.parse(out.trim()) as { parent: string; child: string };
}

describe("a process relaunched under another profile", () => {
	for (const layer of LAYERS) {
		for (const { parent, child } of DIRECTIONS) {
			it(`reads ${child}'s ${layer} .env, not ${parent}'s`, async () => {
				expect(await relaunch({ parent, child, layer })).toEqual({
					parent: `${parent}-value`,
					child: `${child}-value`,
				});
			});
		}
	}

	it("keeps a variable the real environment set", async () => {
		expect(await relaunch({ parent: "work", child: "oss", layer: "agent", real: "shell-value" })).toEqual({
			parent: "shell-value",
			child: "shell-value",
		});
	});

	it("keeps a variable the parent changed at run time", async () => {
		expect(await relaunch({ parent: "work", child: "oss", layer: "agent", runtime: "runtime-value" })).toEqual({
			parent: "runtime-value",
			child: "runtime-value",
		});
	});
});
