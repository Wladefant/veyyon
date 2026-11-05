import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { processFileArguments } from "@veyyon/coding-agent/cli/file-processor";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { ReadTool } from "@veyyon/coding-agent/tools/fs/read";
import { generateFileMentionMessages } from "@veyyon/coding-agent/utils/file-mentions";
import { errorMessage, removeWithRetries } from "@veyyon/utils";
import { toolResultText } from "./helpers/tool-result-text";
import { makeToolSession } from "./helpers/tool-session";

// WHY THIS SUITE EXISTS
// ---------------------
// `read fifo` opened the named pipe and waited for a writer that never came, so the turn held with
// no end; `read fifo:raw` did the same. A socket failed with a bare `ENXIO`, and a device read as a
// 0-byte binary file. An `@fifo` mention in a prompt held the prompt the same way, `veyyon @fifo`
// never started, and `veyyon @dir` failed with a bare `EISDIR`. Each route now stats a path before
// anything opens it: read rejects an entry that is neither a regular file nor a directory, naming
// what the entry is; a mention leaves such an entry unattached; a CLI `@` argument exits stating it.
//
// The class is "a path that is not a file gets opened". The entry kinds are enumerated from the
// runtime's `fs.Stats` predicates, so a kind a future runtime adds fails the roster case until it has
// an entry here or a recorded opt-out. Every kind is driven through every route a path takes into a
// read -- the plain path, a selector, a list entry, a symbolic link, a suffix match, and the archive,
// SQLite and PDF member probes -- and through a mention and a CLI `@` argument, and every one must
// settle within a bound, because the defect is a hang, which a value assertion alone cannot see.
//
// What it does not catch: a block device is synthesized. The sandbox runs unprivileged and exposes
// none, so the entry is a real empty file whose stat reports the block-device type bits. A route that
// opens a file without one of these stats (an internal URL handler reading its own file) is outside
// the sweep.

/** How long a read may take to settle. A rejected entry settles in milliseconds; a hang never does. */
const SETTLE_BOUND_MS = 3_000;

/** An entry kind read must reject, the phrase the rejection describes it with, and how to make one. */
interface SpecialEntry {
	described: string;
	make(at: string): Promise<void>;
}

const listening: net.Server[] = [];
/** Real paths whose stat the block-device entry rewrites. */
const blockDevices = new Set<string>();
/** Named pipes made for the current case, opened for writing to release a reader a regression left blocked. */
const pipes: string[] = [];

/** The `fs.Stats` predicates true of an entry read rejects. */
type SpecialKind = "isFIFO" | "isSocket" | "isCharacterDevice" | "isBlockDevice";

const SPECIAL_ENTRIES: Record<SpecialKind, SpecialEntry> = {
	isFIFO: {
		described: "a named pipe (FIFO)",
		async make(at) {
			execFileSync("mkfifo", [at]);
			pipes.push(at);
		},
	},
	isSocket: {
		described: "a socket",
		async make(at) {
			const server = net.createServer();
			listening.push(server);
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			server.once("error", reject);
			server.listen(at, () => resolve());
			await promise;
		},
	},
	isCharacterDevice: {
		described: "a device node",
		// `/dev/null` is a character device every unprivileged process can stat; the link puts it at a
		// name inside the working directory.
		async make(at) {
			await fs.symlink("/dev/null", at);
		},
	},
	isBlockDevice: {
		described: "a device node",
		async make(at) {
			await fs.writeFile(at, "");
			blockDevices.add(fsSync.realpathSync(at));
		},
	},
};

/**
 * Stat predicates with no entry above. `isFile` and `isDirectory` are what read opens.
 * `isSymbolicLink` is never true of a stat that follows links; the link and suffix-match routes put
 * a link in front of every kind instead.
 */
const OPTED_OUT = ["isDirectory", "isFile", "isSymbolicLink"];

/** A way a path reaches a read. */
interface Route {
	/** Where the special entry is made, relative to the working directory. */
	entry: string;
	/** The path handed to read. */
	readPath: string;
	/** The path the rejection names. */
	named: string;
	/** A link or sibling file the route needs, made after the entry. */
	prepare?(dir: string): Promise<void>;
	/** A list reports a failed entry as a note in its result instead of failing the read. */
	inList?: boolean;
}

const ROUTES: Record<string, Route> = {
	"a plain path": { entry: "entry", readPath: "entry", named: "entry" },
	"a raw selector": { entry: "entry", readPath: "entry:raw", named: "entry" },
	"a line range": { entry: "entry", readPath: "entry:1-5", named: "entry" },
	"a list entry": {
		entry: "entry",
		readPath: "plain.txt;entry",
		named: "entry",
		inList: true,
		async prepare(dir) {
			await fs.writeFile(path.join(dir, "plain.txt"), "plain\n");
		},
	},
	"a symbolic link": {
		entry: "entry",
		readPath: "link",
		named: "link",
		async prepare(dir) {
			await fs.symlink(path.join(dir, "entry"), path.join(dir, "link"));
		},
	},
	// The directory walk behind a suffix match lists no pipe or socket, but it lists a link to one.
	"a suffix match": {
		entry: "elsewhere/entry",
		readPath: "nest/entry",
		named: "deep/nest/entry",
		async prepare(dir) {
			await fs.mkdir(path.join(dir, "deep", "nest"), { recursive: true });
			await fs.symlink(path.join(dir, "elsewhere", "entry"), path.join(dir, "deep", "nest", "entry"));
		},
	},
	"a SQLite table": { entry: "data.db", readPath: "data.db:users", named: "data.db" },
	"an archive member": { entry: "pack.zip", readPath: "pack.zip:inner.txt", named: "pack.zip" },
	"a PDF image member": { entry: "doc.pdf", readPath: "doc.pdf:img-1.png", named: "doc.pdf" },
};

type Outcome =
	| { kind: "result"; text: string }
	| { kind: "error"; message: string }
	| { kind: "attached"; paths: string[] }
	| { kind: "exited"; code: number; printed: string }
	| { kind: "hung" };

/** Thrown by the `process.exit` stand-in, so a CLI exit ends the call under test instead of the run. */
class ExitCalled extends Error {
	constructor(readonly code: number) {
		super(`process.exit(${code})`);
	}
}

/** Open each pipe's write end and close it, so a reader blocked on it sees end of file. */
function releasePipes(): void {
	for (const pipe of pipes) {
		try {
			fsSync.closeSync(fsSync.openSync(pipe, fsSync.constants.O_WRONLY | fsSync.constants.O_NONBLOCK));
		} catch {
			// ENXIO: no reader is waiting on this pipe.
		}
	}
}

/**
 * Report how `pending` settled, or `hung` past {@link SETTLE_BOUND_MS}. A hung operation is released
 * before returning, so a regression fails its own case instead of wedging the file.
 */
async function settleWithin(pending: Promise<Outcome>): Promise<Outcome> {
	const deadline = Promise.withResolvers<Outcome>();
	const timer = setTimeout(() => deadline.resolve({ kind: "hung" }), SETTLE_BOUND_MS);
	let outcome: Outcome;
	try {
		outcome = await Promise.race([pending, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
	if (outcome.kind === "hung") {
		let settled = false;
		void pending.finally(() => {
			settled = true;
		});
		for (let attempt = 0; attempt < 40 && !settled; attempt++) {
			releasePipes();
			await delay(50);
		}
	}
	return outcome;
}

function readWithin(dir: string, readPath: string): Promise<Outcome> {
	const settings = Settings.isolated();
	settings.set("read.summarize.enabled", false);
	const tool = new ReadTool(
		makeToolSession({
			cwd: dir,
			getSessionFile: () => path.join(dir, "session.jsonl"),
			getArtifactsDir: () => path.join(dir, "artifacts"),
			settings,
		}),
	);
	return settleWithin(
		tool.execute("call-special", { path: readPath }).then(
			result => ({ kind: "result", text: toolResultText(result) }),
			error => ({ kind: "error", message: errorMessage(error) }),
		),
	);
}

/** The paths a prompt mentioning `mentions` attaches, as the file-mention message lists them. */
function mentionWithin(dir: string, mentions: string[]): Promise<Outcome> {
	return settleWithin(
		generateFileMentionMessages(mentions, dir, {}).then(
			messages => ({
				kind: "attached",
				paths: messages.flatMap(message => (message.role === "fileMention" ? message.files.map(f => f.path) : [])),
			}),
			error => ({ kind: "error", message: errorMessage(error) }),
		),
	);
}

/** What `veyyon @<entry>` attaches, or the exit and message it stops with. */
async function attachWithin(entry: string): Promise<Outcome> {
	const printed: string[] = [];
	const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		printed.push(args.map(String).join(" "));
	});
	const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new ExitCalled(code ?? 0);
	}) as typeof process.exit);
	try {
		return await settleWithin(
			processFileArguments([entry], { autoResizeImages: false }).then(
				result => ({ kind: "result", text: result.text }),
				error =>
					error instanceof ExitCalled
						? { kind: "exited", code: error.code, printed: stripVTControlCharacters(printed.join("\n")) }
						: { kind: "error", message: errorMessage(error) },
			),
		);
	} finally {
		errorSpy.mockRestore();
		exitSpy.mockRestore();
	}
}

let dir = "";
let statSpy: { mockRestore(): void } | undefined;

beforeEach(async () => {
	dir = fsSync.realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), "read-special-")));
	const realStat = fs.stat;
	// The block-device entry: a real stat with its file-type bits replaced, served for that one path.
	statSpy = spyOn(fs, "stat").mockImplementation((async (target: fsSync.PathLike, options?: fsSync.StatOptions) => {
		const stats = await realStat(target, options);
		if (stats instanceof fsSync.Stats && stats.isFile() && blockDevices.has(fsSync.realpathSync(String(target)))) {
			stats.mode = fsSync.constants.S_IFBLK | (stats.mode & 0o7777);
		}
		return stats;
	}) as typeof fs.stat);
});

afterEach(async () => {
	statSpy?.mockRestore();
	statSpy = undefined;
	releasePipes();
	pipes.length = 0;
	blockDevices.clear();
	for (const server of listening.splice(0)) server.close();
	await removeWithRetries(dir);
	dir = "";
});

describe.skipIf(process.platform === "win32")("a path to a pipe, socket or device is never opened", () => {
	it("has an entry or a recorded opt-out for every kind a stat reports", () => {
		const kinds = Object.getOwnPropertyNames(fsSync.Stats.prototype)
			.filter(name => /^is[A-Z]/.test(name))
			.sort();
		expect(kinds.filter(kind => !Object.hasOwn(SPECIAL_ENTRIES, kind))).toEqual(OPTED_OUT);
		expect(Object.keys(SPECIAL_ENTRIES).filter(kind => !kinds.includes(kind))).toEqual([]);
	});

	for (const [kind, special] of Object.entries(SPECIAL_ENTRIES) as Array<[SpecialKind, SpecialEntry]>) {
		for (const [routeName, route] of Object.entries(ROUTES)) {
			it(`read rejects ${special.described} (${kind}) reached through ${routeName}`, async () => {
				const at = path.join(dir, route.entry);
				await fs.mkdir(path.dirname(at), { recursive: true });
				await special.make(at);
				expect((await fs.stat(at))[kind]()).toBe(true);
				await route.prepare?.(dir);

				const outcome = await readWithin(dir, route.readPath);

				const rejection = `Path '${route.named}' is ${special.described}, not a file or directory.`;
				if (route.inList) {
					expect(outcome).toEqual({
						kind: "result",
						text: expect.stringContaining(`[Could not read entry: ${rejection}`),
					});
					expect(outcome).toEqual({ kind: "result", text: expect.stringContaining("plain") });
				} else {
					expect(outcome).toEqual({ kind: "error", message: expect.stringContaining(rejection) });
				}
			}, 10_000);
		}

		it(`a prompt does not attach ${special.described} (${kind}) it mentions, directly or through a link`, async () => {
			await special.make(path.join(dir, "entry"));
			await fs.symlink(path.join(dir, "entry"), path.join(dir, "link"));
			await fs.writeFile(path.join(dir, "plain.txt"), "plain\n");

			const outcome = await mentionWithin(dir, ["plain.txt", "entry", "link"]);

			expect(outcome).toEqual({ kind: "attached", paths: ["plain.txt"] });
		}, 10_000);

		it(`a CLI @ argument naming ${special.described} (${kind}) exits stating its kind`, async () => {
			const entry = path.join(dir, "entry");
			await special.make(entry);

			const outcome = await attachWithin(entry);

			expect(outcome).toEqual({
				kind: "exited",
				code: 1,
				printed: `Error: Cannot attach ${entry}: it is ${special.described}. @ attaches a regular file; to send a command's output, pipe it on stdin: <command> | veyyon -p "<prompt>".`,
			});
		}, 10_000);
	}

	it("a CLI @ argument naming a directory exits stating it is one", async () => {
		const outcome = await attachWithin(dir);

		expect(outcome).toEqual({
			kind: "exited",
			code: 1,
			printed: `Error: Cannot attach ${dir}: it is a directory. @ attaches a regular file; name a file inside it.`,
		});
	});

	it("a CLI @ argument naming a regular file through a link still attaches it", async () => {
		await fs.writeFile(path.join(dir, "plain.txt"), "plain body\n");
		await fs.symlink(path.join(dir, "plain.txt"), path.join(dir, "link"));

		const outcome = await attachWithin(path.join(dir, "link"));

		expect(outcome).toEqual({ kind: "result", text: expect.stringContaining("plain body") });
	});

	it("read still opens a regular file and a directory through a link and a suffix match", async () => {
		await fs.mkdir(path.join(dir, "deep", "nest", "folder"), { recursive: true });
		await fs.writeFile(path.join(dir, "deep", "nest", "file.txt"), "kept line\n");
		await fs.writeFile(path.join(dir, "deep", "nest", "folder", "inside.txt"), "inside\n");
		await fs.symlink(path.join(dir, "deep", "nest", "file.txt"), path.join(dir, "file-link"));
		await fs.symlink(path.join(dir, "deep", "nest", "folder"), path.join(dir, "folder-link"));

		for (const readPath of ["file-link", "nest/file.txt"]) {
			const outcome = await readWithin(dir, readPath);
			expect(outcome).toEqual({ kind: "result", text: expect.stringContaining("kept line") });
		}
		for (const readPath of ["folder-link", "nest/folder"]) {
			const outcome = await readWithin(dir, readPath);
			expect(outcome).toEqual({ kind: "result", text: expect.stringContaining("inside.txt") });
		}
	});
});
