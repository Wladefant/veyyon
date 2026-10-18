import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { $which, APP_NAME, BUILD_TAG, VERSION } from "@veyyon/utils";

const execFileAsync = promisify(execFile);
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const BUILD_SHA_PATTERN = /\bbuild SHA\s+([0-9a-f]{40})\b/i;
const VERSION_PATTERN = /(?:^|\/|\s)(\d+\.\d+\.\d+)(?=\s|$|\()/;
const INSTALLED_VERSION_TIMEOUT_MS = 3_000;

export interface BuildIdentity {
	version: string;
	buildSha: string | null;
	buildTag: string | null;
}

/** Identity compiled into this running process; unlike --version, it never rereads a replaced executable. */
export function getLoadedBuildIdentity(): BuildIdentity {
	const buildSha = process.env.VEYYON_BUILD_SHA;
	return {
		version: VERSION,
		buildSha: buildSha && FULL_SHA_PATTERN.test(buildSha) ? buildSha.toLowerCase() : null,
		buildTag: BUILD_TAG ?? null,
	};
}

/** Parse the stable build fields printed by a compiled executable's --version output. */
export function parseBuildIdentity(output: string): BuildIdentity | null {
	const version = output.match(VERSION_PATTERN)?.[1];
	if (!version) return null;
	const buildSha = output.match(BUILD_SHA_PATTERN)?.[1]?.toLowerCase() ?? null;
	const rawTag = output.match(/\(([^;)]+)(?:;|\))/)?.[1]?.trim();
	const buildTag = rawTag?.startsWith("tag ")
		? rawTag.slice("tag ".length)
		: rawTag && !rawTag.startsWith("build SHA ")
			? rawTag
			: null;
	return { version, buildSha, buildTag };
}

export function formatBuildIdentity(identity: BuildIdentity): string {
	const buildTag = identity.buildTag ? `tag ${identity.buildTag}` : undefined;
	const buildSha = identity.buildSha ? `build SHA ${identity.buildSha}` : "build SHA unavailable";
	return `${APP_NAME}/${identity.version} (${[buildTag, buildSha].filter(Boolean).join("; ")})`;
}

/** Read the executable currently on disk, if one can be identified and queried safely. */
export async function readInstalledBuildIdentity(): Promise<BuildIdentity | null> {
	const executable = process.env.VEYYON_COMPILED === "true" ? process.execPath : $which(APP_NAME);
	if (!executable) return null;
	try {
		const { stdout } = await execFileAsync(executable, ["--version"], {
			encoding: "utf8",
			timeout: INSTALLED_VERSION_TIMEOUT_MS,
			maxBuffer: 4096,
			windowsHide: true,
		});
		return parseBuildIdentity(stdout);
	} catch {
		return null;
	}
}
