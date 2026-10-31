/**
 * Utilities for launching an external text editor ($VISUAL / $EDITOR).
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $env, privateTempDir, Snowflake } from "@veyyon/utils";

/**
 * Returns the user's preferred editor command, or a platform default.
 *
 * Resolution order:
 *   1. `$VISUAL`
 *   2. `$EDITOR`
 *   3. `notepad` on Windows (always present in `%SystemRoot%\System32`)
 *
 * POSIX returns `undefined` when neither variable is set so the caller can
 * surface a warning that nudges the user to configure one.
 */
export function getEditorCommand(): string | undefined {
	const configured = $env.VISUAL?.trim() || $env.EDITOR?.trim();
	if (configured) return configured;
	if (process.platform === "win32") return "notepad";
	return undefined;
}

/**
 * Editors that fork and return before the file has been edited. Launched
 * without their wait flag the child exits at once, the temp file is read back
 * unchanged, and the whole round trip appears to have done nothing.
 */
export const EDITOR_WAIT_FLAGS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
	["code", ["--wait"]],
	["code-insiders", ["--wait"]],
	["codium", ["--wait"]],
	["vscodium", ["--wait"]],
	["cursor", ["--wait"]],
	["windsurf", ["--wait"]],
	["positron", ["--wait"]],
	["zed", ["--wait"]],
	["subl", ["--wait"]],
	["sublime_text", ["--wait"]],
	["atom", ["--wait"]],
	["gedit", ["--wait"]],
	["kate", ["--block"]],
	["mate", ["--wait"]],
	["gvim", ["--nofork"]],
	["mvim", ["--nofork"]],
	["notepad++", ["-multiInst", "-nosession"]],
]);

/** The binary a command line starts with, without directory or `.exe`. */
function editorBinaryName(command: string): string {
	const base = command.replace(/\\/g, "/").split("/").pop() ?? command;
	return base.replace(/\.exe$/i, "").toLowerCase();
}

/**
 * Split `editorCmd` into a command and its arguments, adding the wait flag a
 * GUI editor needs when the command line does not already carry one.
 */
export function resolveEditorInvocation(editorCmd: string): { command: string; args: string[] } {
	const [command = editorCmd, ...args] = editorCmd.trim().split(/\s+/);
	const waitFlags = EDITOR_WAIT_FLAGS.get(editorBinaryName(command));
	if (!waitFlags) return { command, args };
	const alreadyWaits = args.includes("-w") || waitFlags.some(flag => args.includes(flag));
	return { command, args: alreadyWaits ? args : args.concat(waitFlags) };
}

export interface OpenInEditorOptions {
	/** File extension for the temp file (default: ".md"). */
	extension?: string;
	/** Custom stdio configuration (default: all "inherit"). */
	stdio?: [number | "inherit", number | "inherit", number | "inherit"];
	/** Keep the file's trailing newline instead of trimming it from the returned text. */
	trimTrailingNewline?: boolean;
}

/**
 * Opens `content` in the user's external editor and returns the edited text.
 * Returns `null` if the editor exits with a non-zero code.
 *
 * Runs with the screen untouched; `editInTerminal` hands a running TUI's terminal to the editor.
 */
export async function openInEditor(
	editorCmd: string,
	content: string,
	options?: OpenInEditorOptions,
): Promise<string | null> {
	const ext = options?.extension ?? ".md";
	const tmpFile = path.join(privateTempDir(), `veyyon-editor-${Snowflake.next()}${ext}`);

	try {
		await Bun.write(tmpFile, content);

		const { command: editor, args: editorArgs } = resolveEditorInvocation(editorCmd);
		const stdio = options?.stdio ?? ["inherit", "inherit", "inherit"];

		const child = spawn(editor, editorArgs.concat([tmpFile]), { stdio, shell: process.platform === "win32" });
		const { promise, reject, resolve } = Promise.withResolvers<number>();
		child.once("exit", (code, signal) => resolve(code ?? (signal ? -1 : 0)));
		child.once("error", error => reject(error));
		const exitCode = await promise;

		if (exitCode === 0) {
			const text = await Bun.file(tmpFile).text();
			if (options?.trimTrailingNewline === false) {
				return text;
			}
			return text.replace(/\n$/, "");
		}
		return null;
	} finally {
		try {
			await fs.rm(tmpFile, { force: true });
		} catch {
			// Ignore cleanup errors
		}
	}
}

/** Shown when neither `$VISUAL` nor `$EDITOR` names an editor on a platform without a default. */
export const NO_EDITOR_CONFIGURED = "No editor configured. Set $VISUAL or $EDITOR environment variable.";

/** The part of a terminal UI an editor handoff drives: release the screen, then take it back. */
export interface EditorHandoffScreen {
	stop(): void;
	start(): void;
}

/**
 * Opens the controlling terminal for the editor child, or returns `null` when there is none:
 * Windows, piped stdin, a CI runner, a detached process. `null` hands the editor the inherited
 * stdio, which is the same terminal whenever one exists.
 */
async function openControllingTerminal(): Promise<fs.FileHandle | null> {
	if (process.platform === "win32") return null;
	try {
		return await fs.open("/dev/tty", "r+");
	} catch {
		return null;
	}
}

/**
 * Hands the terminal to the external editor for one edit of `content`, then takes it back.
 *
 * The editor runs on the controlling terminal when one opens, so it reads keys from a descriptor of
 * its own rather than the stdin the stopped screen was reading. The terminal handle is closed and
 * the screen restarted whether the editor saves, exits non-zero, or fails to start. Returns the
 * edited text, or `null` when the editor exits non-zero; rejects when the editor cannot start.
 */
export async function editInTerminal(
	screen: EditorHandoffScreen,
	editorCmd: string,
	content: string,
	options?: Omit<OpenInEditorOptions, "stdio">,
): Promise<string | null> {
	const tty = await openControllingTerminal();
	screen.stop();
	try {
		const stdio: OpenInEditorOptions["stdio"] = tty ? [tty.fd, tty.fd, tty.fd] : undefined;
		return await openInEditor(editorCmd, content, { ...options, stdio });
	} finally {
		// The edit's outcome is already settled; a close that fails here must not replace it, and the
		// descriptor is released with the process regardless.
		await tty?.close().catch(() => {});
		screen.start();
	}
}
