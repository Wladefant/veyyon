import * as fs from "node:fs";
import { ensureChromiumExecutable } from "@veyyon/coding-agent/tools/web/browser/launch";

/**
 * Whether the Chromium puppeteer resolves can execute on this host. CI runners without Chrome's
 * system libraries (libnspr4 & co.) hold the downloaded binary but cannot exec it, so a real-browser
 * suite probes with `--version` and skips instead of failing.
 *
 * Windows is probed by existence only: `chrome.exe --version` there does not print a version, it opens
 * a browser window and never returns, so the probe would hang every real-browser suite at import. The
 * missing-system-library failure it guards against is a Linux one.
 */
export async function chromiumCanLaunch(): Promise<boolean> {
	try {
		const executable = await ensureChromiumExecutable();
		if (!executable) return false;
		if (process.platform === "win32") return fs.existsSync(executable);
		return Bun.spawnSync([executable, "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
	} catch {
		return false;
	}
}
