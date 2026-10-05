/**
 * Operator commands for the `app.extension` browser backend: store the extension token, check the
 * bridge, and disconnect every controlled tab.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Args, Command, Flags } from "@veyyon/utils/cli";
import {
	extensionStateDir,
	hasExtensionToken,
	instanceFileName,
	policyFilePath,
	removeExtensionToken,
	writeExtensionToken,
} from "../tools/web/browser/extension-policy";

const ACTIONS = ["set-token", "clear-token", "status", "disconnect"] as const;
type Action = (typeof ACTIONS)[number];

interface RelayState {
	port: number;
	control: string;
}

/** The running relay of this profile, read from its private state file. Undefined when none runs. */
function readRelayState(instance: string | undefined): RelayState | undefined {
	const file = path.join(extensionStateDir(), `${instanceFileName(instance)}.relay.json`);
	if (!fs.existsSync(file)) return undefined;
	const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
	if (parsed === null || typeof parsed !== "object") return undefined;
	if (!("port" in parsed) || typeof parsed.port !== "number") return undefined;
	if (!("control" in parsed) || typeof parsed.control !== "string") return undefined;
	return { port: parsed.port, control: parsed.control };
}

async function readTokenFromStdin(): Promise<string> {
	const text = await Bun.stdin.text();
	return text.split(/\r?\n/)[0]?.trim() ?? "";
}

async function control(state: RelayState, verb: "status" | "disconnect"): Promise<unknown> {
	const response = await fetch(`http://127.0.0.1:${state.port}/control/${state.control}/${verb}`, {
		method: verb === "status" ? "GET" : "POST",
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error(`The relay answered HTTP ${response.status}.`);
	return await response.json();
}

export default class BrowserExtension extends Command {
	static description = "Set up and control the Chrome extension bridge used by the browser tool (app.extension)";

	static args = {
		action: Args.string({
			description: `One of: ${ACTIONS.join(", ")}`,
			required: true,
		}),
	};

	static flags = {
		instance: Flags.string({
			description: "Chrome profile name the token belongs to (default: the default profile)",
		}),
	};

	static examples = [
		"# Store the token copied from the extension status page (reads one line from stdin)\n  veyyon browser-extension set-token",
		"# Check the token, the allowlist and any running relay\n  veyyon browser-extension status",
		"# Detach every controlled tab and drop the extension\n  veyyon browser-extension disconnect",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(BrowserExtension);
		const action = ACTIONS.find(candidate => candidate === args.action);
		if (action === undefined) {
			throw new Error(`Unknown action "${args.action}". Use one of: ${ACTIONS.join(", ")}.`);
		}
		await this.#dispatch(action, flags.instance);
	}

	async #dispatch(action: Action, instance: string | undefined): Promise<void> {
		switch (action) {
			case "set-token": {
				process.stderr.write("Paste the token from the extension status page, then press Enter.\n");
				const token = await readTokenFromStdin();
				if (token.length < 8) throw new Error("No token was read. Nothing was stored.");
				writeExtensionToken(instance, token);
				process.stdout.write("Token stored. It is never printed.\n");
				return;
			}
			case "clear-token":
				process.stdout.write(removeExtensionToken(instance) ? "Token removed.\n" : "No token was stored.\n");
				return;
			case "status": {
				process.stdout.write(`Token stored: ${hasExtensionToken(instance) ? "yes" : "no"}\n`);
				process.stdout.write(`Allowlist file: ${policyFilePath()}\n`);
				const state = readRelayState(instance);
				if (!state) {
					process.stdout.write("Relay: not running\n");
					return;
				}
				try {
					process.stdout.write(`Relay: ${JSON.stringify(await control(state, "status"))}\n`);
				} catch (error) {
					process.stdout.write(
						`Relay: not reachable (${error instanceof Error ? error.message : String(error)})\n`,
					);
				}
				return;
			}
			case "disconnect": {
				const state = readRelayState(instance);
				if (!state) {
					process.stdout.write("No relay is running. Nothing is attached.\n");
					return;
				}
				process.stdout.write(`Disconnected: ${JSON.stringify(await control(state, "disconnect"))}\n`);
				return;
			}
		}
	}
}
