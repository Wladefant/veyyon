/**
 * Handlers for the `share` builtin slash commands.
 *
 * Split out of `builtin-registry.ts`, which is now the composition root: it imports the eight
 * domain maps and assembles them. The domain a command belongs to is decided in one place,
 * `categories.ts`, and `test/slash-commands/a-builtin-lives-in-the-domain-it-is-categorised-under.test.ts`
 * fails when this file and that map disagree, so the two cannot drift.
 */
import { APP_NAME } from "@veyyon/utils";
import type { CollabHost } from "../collab/host";
import { shareSession } from "../export/share";
import { urlHyperlinkAlways } from "../modes/terminal/draw/hyperlink";
import type { InteractiveModeContext } from "../modes/terminal/types";
import { extractLastCodeBlock, extractLastCommand } from "../modes/terminal/utils/copy-targets";
import { theme } from "../theme/theme";
import { copyToClipboard } from "../utils/clipboard";
import type { BuiltinSlashCommandHandlers } from "./handler-types";
import { CollabQrCodeComponent } from "./helpers/collab-qrcode";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./helpers/parse";

/** Scheme-less display form of a browser deep link: accent + underline, OSC-8 linked to the full URL. */
export function collabWebLinkClickable(webLink: string): string {
	const display = theme.fg("accent", `\x1b[4m${webLink.replace(/^https?:\/\//, "")}\x1b[24m`);
	return urlHyperlinkAlways(webLink, display);
}

/** Join hint printed by /collab: compact terminal link + clickable browser deep link. */
export function collabLinkHint(host: CollabHost, heading: string, view = false): string {
	const bullet = theme.fg("accent", theme.format.bullet);
	const link = view ? host.viewLink : host.link;
	const webLink = view ? host.webViewLink : host.webLink;
	return [
		theme.fg("success", heading),
		` ${bullet} ${theme.fg("muted", view ? "Watch from another terminal:" : "Join from another terminal:")} ${APP_NAME} join "${link}"`,
		` ${bullet} ${theme.fg("muted", "or any web browser:")} ${collabWebLinkClickable(webLink)}`,
		theme.fg(
			"dim",
			view
				? "Anyone with this link can watch the session but cannot prompt the agent."
				: "Anyone with the link can read the session and prompt the agent. Read-only link: /collab view",
		),
	].join("\n");
}

export function showCollabQrCode(ctx: Pick<InteractiveModeContext, "present" | "showError">, webLink: string): void {
	try {
		ctx.present([new CollabQrCodeComponent(webLink)]);
	} catch (err) {
		ctx.showError(`Failed to render collab QR code: ${errorMessage(err)}`);
	}
}

export function showCollabLink(
	ctx: Pick<InteractiveModeContext, "present" | "showError" | "showStatus">,
	host: CollabHost,
	heading: string,
	view = false,
): void {
	ctx.showStatus(collabLinkHint(host, heading, view), { dim: false });
	showCollabQrCode(ctx, view ? host.webViewLink : host.webLink);
}

/** What the share builtins DO, keyed by the name each is declared under. */
export const SHARE_HANDLERS = {
	export: {
		handle: async (command, runtime) => {
			const arg = command.args.trim();
			// Match the interactive `/export` behavior: clipboard aliases are not a
			// valid export target. Without this, the literal value (`copy`,
			// `--copy`, `clipboard`) is passed to `exportToHtml` and becomes the
			// output filename.
			if (arg === "--copy" || arg === "clipboard" || arg === "copy") {
				return usage("Use /dump to copy the session to clipboard.", runtime);
			}
			try {
				const filePath = await runtime.session.exportToHtml(arg || undefined);
				await runtime.output(`Session exported to: ${filePath}`);
				return commandConsumed();
			} catch (err) {
				return usage(`Failed to export session: ${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleExportCommand(command.text);
			runtime.ctx.editor.setText("");
		},
	},
	dump: {
		handle: async (_command, runtime) => {
			const text = runtime.session.formatSessionAsText();
			if (!text) {
				await runtime.output("No messages to dump yet.");
				return commandConsumed();
			}
			let sidecarPath: string | undefined;
			let sidecarError: string | undefined;
			try {
				sidecarPath = await runtime.session.dumpLlmRequestToTmpDir();
			} catch (error) {
				// The sidecar is the machine-readable half of what `/dump` promises.
				// Dropping it silently handed back a transcript that looks complete,
				// so the operator went looking for a file that was never written.
				sidecarError = errorMessage(error);
			}
			const lines = [text];
			if (sidecarPath)
				lines.push(
					"",
					`LLM request JSON: ${sidecarPath}`,
					"This file persists on disk and may contain raw context/secrets — treat accordingly.",
				);
			else if (sidecarError) lines.push("", `LLM request JSON could not be written: ${sidecarError}`);
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleDumpCommand();
			runtime.ctx.editor.setText("");
		},
	},
	share: {
		handle: async (_command, runtime) => {
			try {
				const result = await shareSession(runtime.sessionManager, {
					serverUrl: runtime.settings.get("share.serverUrl"),
					store: runtime.settings.get("share.store"),
					state: runtime.session.state,
					obfuscator: runtime.settings.get("share.redactSecrets") ? runtime.session.providerRedactor : undefined,
				});
				const lines = [`Share URL: ${result.url}`];
				if (result.gistUrl) lines.push(`Gist: ${result.gistUrl}`);
				if (result.truncated) lines.push("Note: large content was trimmed to fit the share size limit.");
				await runtime.output(lines.join("\n"));
				return commandConsumed();
			} catch (err) {
				return usage(`Failed to share session: ${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleShareCommand();
			runtime.ctx.editor.setText("");
		},
	},
	collab: {
		getTuiAutocompleteDescription: runtime => {
			if (runtime.ctx.collabHost) {
				return `Share this session live · hosting (${Math.max(0, runtime.ctx.collabHost.participants.length - 1)} guests)`;
			}
			if (runtime.ctx.collabGuest?.readOnly) return "Share this session live · read-only guest";
			if (runtime.ctx.collabGuest) return "Share this session live · guest";
			return "Share this session live via a relay";
		},
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			const args = command.args.trim();
			const { verb, rest } = parseSubcommand(args);
			if (verb === "stop") {
				if (!ctx.collabHost) {
					ctx.showStatus("Not hosting a collab session");
					return;
				}
				await ctx.collabHost.stop("host stopped");
				ctx.showStatus("Collab stopped");
				return;
			}
			if (verb === "status") {
				if (ctx.collabHost) {
					const names = ctx.collabHost.participants.map(p =>
						p.role === "host" ? `${p.name} (host)` : p.readOnly ? `${p.name} (view-only)` : p.name,
					);
					ctx.showStatus(`Collab: ${names.join(", ")} — ${collabWebLinkClickable(ctx.collabHost.webLink)}`);
				} else if (ctx.collabGuest) {
					ctx.showStatus(
						ctx.collabGuest.readOnly
							? "In a collab session as a read-only guest (/leave to exit)"
							: "In a collab session as a guest (/leave to exit)",
					);
				} else {
					ctx.showStatus("Not in a collab session");
				}
				return;
			}
			if (ctx.collabGuest) {
				ctx.showError("Already in a collab session as a guest (/leave first)");
				return;
			}
			const knownStartVerb = verb === "start" || verb === "view";
			const view = verb === "view";
			if (ctx.collabHost) {
				showCollabLink(
					ctx,
					ctx.collabHost,
					view ? "Read-only collab session active" : "Collab session active",
					view,
				);
				return;
			}
			const explicitUrl = knownStartVerb ? rest : args;
			const relayInput = explicitUrl || ctx.settings.get("collab.relayUrl") || "";
			if (!relayInput) {
				ctx.showError(
					"No relay configured. Set collab.relayUrl in /settings or pass one: /collab relay.example.com",
				);
				return;
			}
			// Scheme-less relay args default to wss (ws:// must be spelled out for localhost).
			const relayUrl = relayInput.includes("://") ? relayInput : `wss://${relayInput}`;
			const webUrl = ctx.settings.get("collab.webUrl") || "";
			// The host client (relay socket, room crypto, wire codecs) loads here
			// rather than at startup: a session that never hosts never evaluates it.
			const { CollabHost } = await import("../collab/host");
			const host = new CollabHost(ctx);
			try {
				await host.start(relayUrl, webUrl);
			} catch (err) {
				ctx.showError(`Failed to start collab session: ${errorMessage(err)}`);
				return;
			}
			ctx.collabHost = host;
			showCollabLink(ctx, host, "Collab session started!", view);
		},
	},
	join: {
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			const link = command.args.trim();
			if (!link) {
				ctx.showError("Usage: /join <link>");
				return;
			}
			if (ctx.collabHost) {
				ctx.showError("Stop hosting first (/collab stop)");
				return;
			}
			if (ctx.collabGuest) {
				ctx.showError("Already in a collab session (/leave first)");
				return;
			}
			try {
				const { CollabGuestLink } = await import("../collab/guest");
				await new CollabGuestLink(ctx).join(link);
			} catch (err) {
				ctx.showError(`Failed to join collab session: ${errorMessage(err)}`);
			}
		},
	},
	leave: {
		getTuiAutocompleteDescription: runtime => {
			if (runtime.ctx.collabHost) return "Leave the collab session · hosting";
			if (runtime.ctx.collabGuest) return "Leave the collab session · guest";
			return "Leave the collab session · not in collab";
		},
		handleTui: async (_command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			if (ctx.collabGuest) {
				await ctx.collabGuest.leave("left");
				return;
			}
			if (ctx.collabHost) {
				await ctx.collabHost.stop("host stopped");
				ctx.showStatus("Collab stopped");
				return;
			}
			ctx.showStatus("Not in a collab session");
		},
	},
	copy: {
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (!arg) {
				runtime.ctx.showCopySelector();
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "code") {
				const block = extractLastCodeBlock(runtime.ctx.session.messages);
				if (!block) {
					runtime.ctx.showStatus("No code block to copy.");
					runtime.ctx.editor.setText("");
					return;
				}
				await copyToClipboard(block.code);
				runtime.ctx.showStatus("Copied code block to clipboard");
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "cmd" || arg === "command") {
				const lastCommand = extractLastCommand(runtime.ctx.session.messages);
				if (!lastCommand) {
					runtime.ctx.showStatus("No command to copy.");
					runtime.ctx.editor.setText("");
					return;
				}
				await copyToClipboard(lastCommand.code);
				runtime.ctx.showStatus(`Copied ${lastCommand.kind === "bash" ? "bash command" : "eval code"} to clipboard`);
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /copy [code|cmd]");
			runtime.ctx.editor.setText("");
		},
	},
} satisfies Partial<BuiltinSlashCommandHandlers>;
