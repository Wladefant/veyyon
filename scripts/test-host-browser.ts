#!/usr/bin/env bun
/**
 * Run the three real-browser suites on a developer host, under the gate's `VEYYON_TEST_HOST_BROWSER=1` mode.
 *
 * The test sandbox guest has no Chromium, so these suites skip there (issue #223). The gate admits
 * them on a host only when every condition in `hostBrowserBreaches` holds; this script builds exactly
 * that environment so nobody has to assemble it by hand:
 *
 * - a throwaway home named `veyyon-host-browser-home-*` (`HOME`, `USERPROFILE`, `LOCALAPPDATA`,
 *   `APPDATA`, XDG dirs), removed afterwards, so no suite writes into the real home;
 * - `PUPPETEER_EXECUTABLE_PATH` set to an absolute browser binary: `--chrome <path>`, the variable
 *   already in the environment, or the newest Chrome in the puppeteer cache;
 * - system Chrome hidden from discovery (`ProgramFiles*` pointed at a missing directory), because
 *   `ensureChromiumExecutable` prefers an installed system Chrome over the variable;
 * - only the suites in `HOST_BROWSER_SUITES` are named. Read the summary: 18 cases across 3 files, 0 skip.
 *
 * Usage: `bun scripts/test-host-browser.ts [--chrome <absolute path>]`
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

// Spelled out rather than imported: importing `sandbox-gate.ts` runs the gate at module load and
// refuses this launcher itself. The gate remains the authority; a name that drifts from it is
// refused there with the reason, so a stale copy here fails loudly and cannot widen anything.
const HOST_BROWSER_ENV = "VEYYON_TEST_HOST_BROWSER";
const HOST_BROWSER_HOME_PREFIX = "veyyon-host-browser-home-";
const HOST_BROWSER_SUITES = [
	"a-browser-context-keeps-its-own-session-and-a-state-file-restores-it.test.ts",
	"browser-tab-evaluate.test.ts",
	"tab-fill-replaces-a-value-with-one-real-edit.test.ts",
];
const suiteDir = path.join(repoRoot, "packages", "coding-agent", "test", "tools");

/** The newest Chrome in the puppeteer cache under the real home, or undefined. */
export function findCachedChrome(home: string): string | undefined {
	const root = path.join(home, ".cache", "puppeteer", "chrome");
	let builds: string[];
	try {
		builds = fs.readdirSync(root).sort();
	} catch {
		return undefined;
	}
	const relative =
		process.platform === "win32"
			? ["chrome-win64", "chrome.exe"]
			: process.platform === "darwin"
				? ["chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"]
				: ["chrome-linux64", "chrome"];
	for (const build of builds.reverse()) {
		const candidate = path.join(root, build, ...relative);
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

async function main(): Promise<number> {
	const chromeFlag = process.argv.indexOf("--chrome");
	const executable =
		(chromeFlag >= 0 ? process.argv[chromeFlag + 1] : undefined) ??
		process.env.PUPPETEER_EXECUTABLE_PATH ??
		findCachedChrome(os.homedir());
	if (!executable || !path.isAbsolute(executable) || !fs.existsSync(executable)) {
		console.error("No Chrome found. Pass --chrome <absolute path> or set PUPPETEER_EXECUTABLE_PATH.");
		return 2;
	}
	const home = fs.mkdtempSync(path.join(os.tmpdir(), HOST_BROWSER_HOME_PREFIX));
	const missing = path.join(home, "no-system-chrome");
	const env: Record<string, string | undefined> = {
		...process.env,
		[HOST_BROWSER_ENV]: "1",
		PUPPETEER_EXECUTABLE_PATH: executable,
		HOME: home,
		USERPROFILE: home,
		LOCALAPPDATA: path.join(home, "AppData", "Local"),
		APPDATA: path.join(home, "AppData", "Roaming"),
		XDG_CONFIG_HOME: path.join(home, ".config"),
		XDG_CACHE_HOME: path.join(home, ".cache"),
		XDG_DATA_HOME: path.join(home, ".local", "share"),
		XDG_STATE_HOME: path.join(home, ".local", "state"),
		ProgramFiles: missing,
		"ProgramFiles(x86)": missing,
		ProgramW6432: missing,
	};
	delete env.VEYYON_CONFIG_DIR;
	const suites = HOST_BROWSER_SUITES.map(name => path.join(suiteDir, name));
	console.error(`host-browser run: executable=${executable} home=${home}`);
	try {
		const proc = Bun.spawn(["bun", "test", ...suites], {
			cwd: path.join(repoRoot, "packages", "coding-agent"),
			env,
			stdout: "inherit",
			stderr: "inherit",
		});
		return await proc.exited;
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
}

if (import.meta.main) process.exit(await main());
