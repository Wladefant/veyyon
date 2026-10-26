/**
 * `/move <path>` (`CommandController.handleMoveCommand`) moves the session into an existing directory directly, and
 * into a missing one only after the "Create directory?" prompt is confirmed and only when its parent exists.
 *
 * Contracts, each checked on the filesystem and on the session:
 *  - an existing directory is moved into without a prompt;
 *  - a missing directory under an existing parent prompts; confirmed, it is created and moved into; declined, nothing
 *    is created, moved or shown;
 *  - a missing directory under a missing parent is refused with an error and no prompt;
 *  - a path that exists as a file prompts, and creating it fails with an error and no move;
 *  - a failed move shows its error and leaves the cwd alone;
 *  - the path is resolved against the session cwd with outer quotes stripped; an empty one prints usage;
 *  - nothing moves while a response streams.
 *
 * Gap: what `moveToCwd` relocates (session file, artifacts) and re-scopes is owned by the session suites.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	CommandController,
	type CommandControllerContext,
} from "@veyyon/coding-agent/modes/terminal/controllers/command-controller";
import { useTruecolorTheme } from "../../../helpers/theme-assertions";

useTruecolorTheme("dark");

let root = "";

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-move-target-"));
	await fs.mkdir(path.join(root, "home"));
	await fs.mkdir(path.join(root, "existing"));
	await fs.writeFile(path.join(root, "a-file"), "");
});

afterAll(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

interface MoveRun {
	prompts: [string, string][];
	errors: string[];
	warnings: string[];
	movedTo: string[];
	presented: number;
}

async function runMove(
	input: string,
	options: { confirm?: boolean; streaming?: boolean; moveError?: Error } = {},
): Promise<MoveRun> {
	const run: MoveRun = { prompts: [], errors: [], warnings: [], movedTo: [], presented: 0 };
	const ctx = {
		session: {
			isStreaming: options.streaming ?? false,
			moveToCwd: async (target: string) => {
				if (options.moveError) throw options.moveError;
				run.movedTo.push(target);
				return target;
			},
		},
		sessionManager: {
			getCwd: () => path.join(root, "home"),
		},
		showHookConfirm: async (title: string, message: string) => {
			run.prompts.push([title, message]);
			return options.confirm ?? false;
		},
		showError: (message: string) => run.errors.push(message),
		showWarning: (message: string) => run.warnings.push(message),
		updateEditorBorderColor: () => {},
		reloadTodos: async () => {},
		ui: { requestRender: () => {} },
		present: () => {
			run.presented++;
		},
	} as unknown as CommandControllerContext;
	await new CommandController(ctx).handleMoveCommand(input);
	return run;
}

async function isDirectory(target: string): Promise<boolean> {
	try {
		return (await fs.stat(target)).isDirectory();
	} catch {
		return false;
	}
}

function prompt(name: string): [string, string] {
	return ["Create directory?", `"${name}" does not exist. Create it?`];
}

describe("a move into a missing directory creates it only when confirmed", () => {
	it("an existing directory is moved into without a prompt", async () => {
		const target = path.join(root, "existing");
		const run = await runMove(target, { confirm: false });
		expect(run).toEqual({
			prompts: [],
			errors: [],
			warnings: [],
			movedTo: [target],
			presented: 1,
		});
	});

	it("a missing directory under an existing parent is created and moved into once confirmed", async () => {
		const target = path.join(root, "created");
		const run = await runMove(target, { confirm: true });
		expect(await isDirectory(target)).toBe(true);
		expect(run).toEqual({
			prompts: [prompt("created")],
			errors: [],
			warnings: [],
			movedTo: [target],
			presented: 1,
		});
	});

	it("a declined prompt creates, moves and shows nothing", async () => {
		const target = path.join(root, "declined");
		const run = await runMove(target, { confirm: false });
		expect(await isDirectory(target)).toBe(false);
		expect(run).toEqual({
			prompts: [prompt("declined")],
			errors: [],
			warnings: [],
			movedTo: [],
			presented: 0,
		});
	});

	it("a missing directory under a missing parent is refused without a prompt", async () => {
		const target = path.join(root, "absent-parent", "child");
		const run = await runMove(target, { confirm: true });
		expect(await isDirectory(path.join(root, "absent-parent"))).toBe(false);
		expect(run).toEqual({
			prompts: [],
			errors: ['Cannot create "child": parent directory does not exist'],
			warnings: [],
			movedTo: [],
			presented: 0,
		});
	});

	it("a path that exists as a file prompts, then fails to create and does not move", async () => {
		const target = path.join(root, "a-file");
		const run = await runMove(target, { confirm: true });
		expect(run.prompts).toEqual([prompt("a-file")]);
		expect(run.errors).toHaveLength(1);
		expect(run.errors[0]).toStartWith("Failed to create directory: ");
		expect(run.movedTo).toEqual([]);
	});

	it("a failed move shows its error and leaves the cwd alone", async () => {
		const target = path.join(root, "existing");
		const run = await runMove(target, { moveError: new Error("session file is locked") });
		expect(run).toEqual({
			prompts: [],
			errors: ["Move failed: session file is locked"],
			warnings: [],
			movedTo: [],
			presented: 0,
		});
	});
});

describe("a move target is read the way it was typed", () => {
	it("a relative path resolves against the session cwd", async () => {
		const run = await runMove("../existing");
		expect(run.movedTo).toEqual([path.join(root, "existing")]);
	});

	it("outer double quotes are stripped", async () => {
		const run = await runMove(`"${path.join(root, "existing")}"`);
		expect(run.movedTo).toEqual([path.join(root, "existing")]);
	});

	it("a quoted empty path prints usage", async () => {
		const run = await runMove('""');
		expect(run).toEqual({
			prompts: [],
			errors: ["Usage: /move <path>"],
			warnings: [],
			movedTo: [],
			presented: 0,
		});
	});

	it("nothing moves while a response streams", async () => {
		const run = await runMove(path.join(root, "existing"), { streaming: true });
		expect(run).toEqual({
			prompts: [],
			errors: [],
			warnings: ["Wait for the current response to finish or abort it before moving."],
			movedTo: [],
			presented: 0,
		});
	});
});
