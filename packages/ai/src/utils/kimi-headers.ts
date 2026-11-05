/**
 * The headers every Kimi Code request sends: the Kimi CLI's client identity and a device id persisted
 * under the agent directory. The login, the chat clients and the usage probe each send them, so they are
 * defined here rather than in any one of the three, and a chat request loads no login code.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@veyyon/utils/dirs";
import { isEnoent } from "@veyyon/utils/fs-error";
import packageJson from "../../package.json" with { type: "json" };

const DEVICE_ID_FILENAME = "kimi-device-id";

function formatDeviceModel(system: string, release: string, arch: string): string {
	return [system, release, arch].filter(Boolean).join(" ").trim();
}

function getDeviceModel(): string {
	const platform = os.platform();
	const release = os.release();
	const arch = os.arch();
	if (platform === "darwin") return formatDeviceModel("macOS", release, arch);
	if (platform === "win32") return formatDeviceModel("Windows", release, arch);
	const label = platform === "linux" ? "Linux" : platform;
	return formatDeviceModel(label, release, arch);
}

let getDeviceId = (): string => {
	const deviceIdPath = path.join(getAgentDir(), DEVICE_ID_FILENAME);
	try {
		const existing = fs.readFileSync(deviceIdPath, "utf-8");
		const trimmed = existing.trim();
		if (trimmed) {
			getDeviceId = () => trimmed;
			return trimmed;
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	const deviceId = crypto.randomUUID().replace(/-/g, "");
	// getAgentDir() only names the config root; it does not guarantee the
	// directory exists on disk. On a fresh host (a clean CI runner, a
	// first-ever launch) the parent is absent, so the write below would throw
	// ENOENT. That error used to propagate up through getKimiCommonHeaders()
	// into the usage/OAuth request try-blocks and get swallowed as a null
	// "usage unavailable", masking a filesystem failure as a network one.
	// Create the parent first so the device-id file is always writable.
	fs.mkdirSync(path.dirname(deviceIdPath), { recursive: true });
	fs.writeFileSync(deviceIdPath, `${deviceId}\n`, { mode: 0o600 });
	getDeviceId = () => deviceId;
	return deviceId;
};

function sanitizeHeaderValue(value: string, fallback = ""): string {
	const sanitized = value.replace(/[^\x20-\x7E]/g, "").trim();
	return sanitized || fallback;
}

export let getKimiCommonHeaders = () => {
	const headers = Object.freeze({
		"User-Agent": `KimiCLI/${packageJson.version}`,
		"X-Msh-Platform": "kimi_cli",
		"X-Msh-Version": packageJson.version,
		"X-Msh-Device-Name": sanitizeHeaderValue(os.hostname(), "unknown"),
		"X-Msh-Device-Model": sanitizeHeaderValue(getDeviceModel(), "unknown"),
		"X-Msh-Os-Version": sanitizeHeaderValue(os.version(), "unknown"),
		"X-Msh-Device-Id": sanitizeHeaderValue(getDeviceId(), "unknown"),
	});
	getKimiCommonHeaders = () => headers;
	return headers;
};
