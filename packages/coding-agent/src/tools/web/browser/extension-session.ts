/**
 * Starts the relay, opens the extension's connect page in the operator's Chrome and waits for
 * the extension to dial back. No remote-debugging port is involved on either side.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { ToolError } from "../../core/tool-errors";
import {
	EXTENSION_PROTOCOL_VERSION,
	type ExtensionPolicy,
	extensionStateDir,
	loadExtensionPolicy,
	PLAYWRIGHT_EXTENSION_ID,
	readExtensionToken,
} from "./extension-policy";
import { buildConnectUrl, ExtensionRelay } from "./extension-relay";

const CONNECT_TIMEOUT_MS = 30_000;

export interface ExtensionKind {
	kind: "extension";
	/** Selects the token and relay state of one Chrome profile. */
	instanceId?: string;
	/** Chrome `--profile-directory` name, for example `Profile 1`. */
	profile?: string;
}

export interface OpenExtensionSessionOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Opens the connect URL in a browser. Defaults to starting the operator's Chrome. */
	launchConnect?: (connectUrl: string, kind: ExtensionKind) => Promise<void>;
}

function chromeCandidates(): string[] {
	if (process.platform === "win32") {
		const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA];
		return roots.flatMap(root => (root ? [path.join(root, "Google", "Chrome", "Application", "chrome.exe")] : []));
	}
	if (process.platform === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
	return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
}

function findChrome(): string {
	const fromEnv = process.env.VEYYON_CHROME_PATH;
	if (fromEnv) return fromEnv;
	const found = chromeCandidates().find(candidate => fs.existsSync(candidate));
	if (!found) throw new ToolError("Chrome was not found. Set VEYYON_CHROME_PATH to the Chrome executable.");
	return found;
}

/** Hand the connect URL to Chrome. A running Chrome opens it in a tab of the same profile. */
async function launchChrome(connectUrl: string, kind: ExtensionKind): Promise<void> {
	const args = kind.profile ? [`--profile-directory=${kind.profile}`, connectUrl] : [connectUrl];
	const child = Bun.spawn([findChrome(), ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	child.unref();
}

/** The steps the operator follows once; shown whenever the connection cannot be made. */
export const EXTENSION_SETUP_HINT =
	"Install the Playwright Extension in Chrome, copy its token from the extension status page and run `veyyon browser-extension set-token`. See docs/browser-extension-bridge.md.";

/** Connect to the extension and return the running relay. The caller owns `close()`. */
export async function openExtensionSession(
	kind: ExtensionKind,
	opts: OpenExtensionSessionOptions = {},
): Promise<ExtensionRelay> {
	const instance = kind.instanceId ?? kind.profile;
	const token = readExtensionToken(instance);
	if (token === undefined) {
		throw new ToolError(
			`No extension token is stored for ${instance ?? "the default profile"}. ${EXTENSION_SETUP_HINT}`,
		);
	}
	let policy: ExtensionPolicy;
	try {
		policy = loadExtensionPolicy();
	} catch (error) {
		throw new ToolError(
			`The extension policy could not be read: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const relay = ExtensionRelay.start({ policy, instance, scrub: [token] });
	try {
		const connectUrl = buildConnectUrl({
			extensionId: process.env.VEYYON_BROWSER_EXTENSION_ID ?? PLAYWRIGHT_EXTENSION_ID,
			protocolVersion: EXTENSION_PROTOCOL_VERSION,
			relayUrl: relay.extensionUrl,
			token,
			clientName: "veyyon",
		});
		await (opts.launchConnect ?? launchChrome)(connectUrl, kind);
		await relay.waitForExtension(opts.timeoutMs ?? CONNECT_TIMEOUT_MS, opts.signal);
		return relay;
	} catch (error) {
		await relay.close();
		if (opts.signal?.aborted) throw error;
		const reason = error instanceof Error ? error.message : String(error);
		throw new ToolError(
			`Could not connect to the Chrome extension: ${reason} Check that Chrome is running with the extension installed and that the token is current. State directory: ${extensionStateDir()}.`,
		);
	}
}
