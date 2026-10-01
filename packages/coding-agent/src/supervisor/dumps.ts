import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CliUsageError } from "@veyyon/utils/cli-usage-error";
import { getLogsDir } from "@veyyon/utils/dirs";

export const LOCAL_DUMPS_BASE_KEY = "HKCU\\Software\\Microsoft\\Windows\\Windows Error Reporting\\LocalDumps";
export const SUPERVISOR_TARGET_APPS = ["veyyon.exe", "bun.exe"] as const;

export const DEFAULT_DUMP_COUNT = 5;
export const MIN_DUMP_COUNT = 1;
export const MAX_DUMP_COUNT = 100;
export const DEFAULT_DUMP_FOLDER = path.join(getLogsDir(), "dumps");
export const DUMP_TYPE_MINI = 1;

export type RegRunner = (
	args: string[],
) =>
	| Promise<{ exitCode: number; stdout: string; stderr: string }>
	| { exitCode: number; stdout: string; stderr: string };

export interface EnableDumpsOptions {
	runner?: RegRunner;
	folder?: string;
	count?: number;
	platform?: string;
	mkdir?: (dir: string) => void;
}

export interface DisableDumpsOptions {
	runner?: RegRunner;
	platform?: string;
}

export interface StatusDumpsOptions {
	runner?: RegRunner;
	platform?: string;
}

export interface DumpAppStatus {
	configured: boolean;
	folder?: string;
	count?: number;
	type?: number;
}

export interface DumpsStatusResult {
	supported: boolean;
	message?: string;
	apps?: Record<string, DumpAppStatus>;
}

export function defaultRegRunner(args: string[]): { exitCode: number; stdout: string; stderr: string } {
	const result = spawnSync("reg.exe", args, {
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
		windowsHide: true,
	});
	return {
		exitCode: result.status ?? (result.error ? 1 : 0),
		stdout: result.stdout ?? "",
		stderr: result.stderr || result.error?.message || "",
	};
}

async function addRegValue(
	runner: RegRunner,
	app: string,
	key: string,
	value: string,
	type: string,
	data: string,
): Promise<void> {
	const res = await runner(["add", key, "/v", value, "/t", type, "/d", data, "/f"]);
	if (res.exitCode !== 0) {
		const detail = res.stderr.trim() || res.stdout.trim() || `exit code ${res.exitCode}`;
		const err = new Error(`Registry mutation failed [action: add, app: ${app}, value: ${value}]: ${detail}`);
		Object.assign(err, { app, value, action: "add", stderr: res.stderr, exitCode: res.exitCode });
		throw err;
	}
}

export async function enableLocalDumps(
	options?: EnableDumpsOptions,
): Promise<{ supported: boolean; message: string; apps?: Record<string, DumpAppStatus> }> {
	const platform = options?.platform ?? process.platform;
	if (platform !== "win32") {
		return { supported: false, message: "Windows LocalDumps is only supported on Windows" };
	}

	const count = options?.count ?? DEFAULT_DUMP_COUNT;
	if (typeof count !== "number" || !Number.isInteger(count) || count < MIN_DUMP_COUNT || count > MAX_DUMP_COUNT) {
		throw new CliUsageError(
			`DumpCount must be an integer between ${MIN_DUMP_COUNT} and ${MAX_DUMP_COUNT} (got: ${count})`,
		);
	}

	const folder = options?.folder ?? DEFAULT_DUMP_FOLDER;
	const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
	const userProfile = process.env.USERPROFILE || os.homedir();
	const expandedDir = folder.replace(/%LOCALAPPDATA%/gi, localAppData).replace(/%USERPROFILE%/gi, userProfile);

	if (options?.mkdir) {
		options.mkdir(expandedDir);
	} else {
		fs.mkdirSync(expandedDir, { recursive: true });
	}

	const runner = options?.runner ?? defaultRegRunner;
	const apps: Record<string, DumpAppStatus> = {};

	for (const app of SUPERVISOR_TARGET_APPS) {
		const appKey = `${LOCAL_DUMPS_BASE_KEY}\\${app}`;
		await addRegValue(runner, app, appKey, "DumpFolder", "REG_EXPAND_SZ", folder);
		await addRegValue(runner, app, appKey, "DumpCount", "REG_DWORD", String(count));
		await addRegValue(runner, app, appKey, "DumpType", "REG_DWORD", String(DUMP_TYPE_MINI));

		apps[app] = { configured: true, folder, count, type: DUMP_TYPE_MINI };
	}

	return {
		supported: true,
		message: `Enabled Windows LocalDumps for ${SUPERVISOR_TARGET_APPS.join(" and ")} (folder: ${folder}, count: ${count}, type: 1 [Mini dump])`,
		apps,
	};
}

export async function disableLocalDumps(
	options?: DisableDumpsOptions,
): Promise<{ supported: boolean; message: string }> {
	const platform = options?.platform ?? process.platform;
	if (platform !== "win32") {
		return { supported: false, message: "Windows LocalDumps is only supported on Windows" };
	}

	const runner = options?.runner ?? defaultRegRunner;
	for (const app of SUPERVISOR_TARGET_APPS) {
		const appKey = `${LOCAL_DUMPS_BASE_KEY}\\${app}`;
		const delRes = await runner(["delete", appKey, "/f"]);
		if (delRes.exitCode !== 0) {
			if (
				/(?:unable to|cannot) find the specified registry key or value|specified registry key or value was not found/i.test(
					`${delRes.stdout}\n${delRes.stderr}`,
				)
			) {
				continue;
			}
			const detail = delRes.stderr.trim() || delRes.stdout.trim() || `exit code ${delRes.exitCode}`;
			const err = new Error(`Registry mutation failed [action: delete, app: ${app}, value: key]: ${detail}`);
			Object.assign(err, { app, value: "key", action: "delete", stderr: delRes.stderr, exitCode: delRes.exitCode });
			throw err;
		}
	}

	return {
		supported: true,
		message: `Disabled Windows LocalDumps and removed application keys for ${SUPERVISOR_TARGET_APPS.join(" and ")}`,
	};
}

export async function statusLocalDumps(options?: StatusDumpsOptions): Promise<DumpsStatusResult> {
	const platform = options?.platform ?? process.platform;
	if (platform !== "win32") {
		return { supported: false, message: "Windows LocalDumps is only supported on Windows" };
	}

	const runner = options?.runner ?? defaultRegRunner;
	const apps: Record<string, DumpAppStatus> = {};

	for (const app of SUPERVISOR_TARGET_APPS) {
		const appKey = `${LOCAL_DUMPS_BASE_KEY}\\${app}`;
		const queryRes = await runner(["query", appKey]);

		if (queryRes.exitCode === 0) {
			const stdout = queryRes.stdout;
			const folder = stdout.match(/DumpFolder\s+REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/i)?.[1]?.trim();

			const countRaw = stdout.match(/DumpCount\s+REG_DWORD\s+([^\r\n]+)/i)?.[1]?.trim();
			let count: number | undefined;
			if (countRaw) {
				const parsed =
					countRaw.startsWith("0x") || countRaw.startsWith("0X")
						? Number.parseInt(countRaw, 16)
						: Number.parseInt(countRaw, 10);
				if (!Number.isNaN(parsed)) count = parsed;
			}

			const typeRaw = stdout.match(/DumpType\s+REG_DWORD\s+([^\r\n]+)/i)?.[1]?.trim();
			let type: number | undefined;
			if (typeRaw) {
				const parsed =
					typeRaw.startsWith("0x") || typeRaw.startsWith("0X")
						? Number.parseInt(typeRaw, 16)
						: Number.parseInt(typeRaw, 10);
				if (!Number.isNaN(parsed)) type = parsed;
			}

			const isConfigured =
				typeof folder === "string" &&
				folder.length > 0 &&
				typeof count === "number" &&
				Number.isInteger(count) &&
				count >= MIN_DUMP_COUNT &&
				count <= MAX_DUMP_COUNT &&
				type === DUMP_TYPE_MINI;

			apps[app] = { configured: isConfigured, folder, count, type };
		} else {
			apps[app] = { configured: false };
		}
	}

	return { supported: true, apps };
}
