import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { logger } from "@veyyon/utils";

export interface ReportProviderErrorOptions {
	scriptPath?: string;
	scriptExists?: (path: string) => boolean;
	spawner?: typeof spawn;
	timeoutMs?: number;
}

/** Called only for a terminal provider message, never a tool or setup failure. */
export function isProvider429Or402(body: string): boolean {
	return /(?:^\s*|\b(?:status|statusCode|code|error|http)\b[^\w\r\n]{0,5}|\()(?:429|402)\b/im.test(body);
}

export function resolveRoutingScriptPath(override = process.env.VEYYON_MODEL_ROUTING_SCRIPT): string {
	return override ? resolve(override) : join(homedir(), ".veyyon", "workflows", "model_routing.py");
}

/** Best-effort router notification. The lane never waits for Python or logs its payload. */
export function reportProviderError(model: string, body: string, options: ReportProviderErrorOptions = {}): void {
	if (!isProvider429Or402(body)) return;
	let child: ChildProcess;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let failed = false;
	const fail = () => {
		if (failed) return;
		failed = true;
		logger.warn("Provider error reporter failed");
	};
	try {
		const script = options.scriptPath ?? resolveRoutingScriptPath();
		if (!(options.scriptExists ?? existsSync)(script)) return;
		child = (options.spawner ?? spawn)(
			process.env.PYTHON_EXECUTABLE || process.env.PYTHON || "python",
			[script, "record-error", "--model", model],
			{ stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
		);
		child.on("error", fail);
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			if (code !== 0 || signal) fail();
		});
		child.stdin?.on("error", fail);
		timer = setTimeout(() => {
			fail();
			try {
				child.kill("SIGKILL");
			} catch {
				fail();
			}
		}, options.timeoutMs ?? 10_000);
		timer.unref();
		child.unref();
		child.stdin?.end(body);
	} catch {
		fail();
	}
}
