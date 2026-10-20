import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type PtyRunResult, Process, PtySession } from "@veyyon/natives";
import {
	atomicWriteFile,
	clamp,
	clampLow,
	errorMessage,
	exponentialBackoffDelay,
	isEnoent,
	isProcessAlive,
	logger,
	postmortem,
	ptree,
	sanitizeText,
} from "@veyyon/utils";
import { processHandle } from "@veyyon/utils/native-process";
import { truncateHead, truncateHeadBytes, truncateTail, truncateTailBytes } from "../session/streaming-output";
import { workerEnvFromParent } from "../subprocess/worker-client";
import { acquireBrokerLease, releaseBrokerLease } from "./broker-lease";
import { appendDaemonCompletion, readDaemonCompletions } from "./completions";
import {
	daemonBrokerEndpoint,
	daemonBrokerTokenPath,
	managedDaemonDir,
	managedDaemonLogPath,
	managedDaemonMetaPath,
	managedDaemonPreviousLogPath,
	managedDaemonsRoot,
} from "./paths";
import { hasLiveDaemonProjectPresence, pruneDeadDaemonRuntimeDirs } from "./presence";
import {
	DAEMON_CLEANUP_WAIT_ENV,
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_PTY_COLUMNS,
	DAEMON_PTY_ROWS,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonCompletionRecord,
	type DaemonOperation,
	type DaemonReadySpec,
	type DaemonRpcResult,
	type DaemonSignal,
	type DaemonSnapshot,
	type DaemonSpec,
	type DaemonTerminationOwner,
	DEFAULT_CLEANUP_WAIT_MS,
	parseDaemonSnapshot,
	parseDaemonSpec,
	parseDaemonWireRequest,
} from "./protocol";

const DEFAULT_IDLE_GRACE_MS = 3_000;
const MAX_REQUEST_BYTES = 1024 * 1024;
// Rotate a broker log once it reaches this size. Not a cap on total log bytes
// kept: rotation preserves the previous file, so the on-disk total is a multiple
// of this. Distinct from the bug-report bundler's much smaller read budget.
const LOG_ROTATE_BYTES = 25 * 1024 * 1024;
const LOG_READ_BYTES = 2 * 1024 * 1024;
const READINESS_BUFFER_CHARS = 64 * 1024;
const RESTART_MAX_DELAY_MS = 30_000;
/** Output carried in a retained completion record, in lines and in bytes. */
const COMPLETION_TAIL_LINES = 40;
const COMPLETION_TAIL_BYTES = 4_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const TREE_GRACE_MS = 1_000;
const TREE_BOUND_MS = 5_000;
const TREE_SAMPLE_MS = 250;
const HOLD_RECHECK_MS = 1_000;

/**
 * Attribution for a termination a broker component is about to cause: which
 * component, and the triggering condition as a human sentence. Set on the
 * record BEFORE the signal goes out, so the settle that observes the death can
 * name its cause instead of reporting an unexplained signal.
 */
interface DaemonTerminationSource {
	owner: DaemonTerminationOwner;
	reason: string;
	/** The signal sent, when the path sent one, so a PTY daemon (which reports no signalCode) still names it. */
	signal?: DaemonSignal;
	/** When the attribution was set; an operator-signal attribution expires (see #settle). */
	at: number;
}

/**
 * How long a `launch send signal=...` attribution stays valid. A handled
 * signal (a SIGHUP a daemon traps) does not kill, and attributing a natural
 * exit minutes later to it would be exactly the mislabeled death this exists
 * to prevent, so the attribution expires and the settle falls back to the
 * process's own end.
 */
const SIGNAL_ATTRIBUTION_WINDOW_MS = 10_000;

const SIGNAL_NUMBER: Record<DaemonSignal, number> = {
	SIGINT: os.constants.signals.SIGINT,
	SIGTERM: os.constants.signals.SIGTERM,
	SIGHUP: os.constants.signals.SIGHUP,
	SIGQUIT: os.constants.signals.SIGQUIT,
	SIGKILL: os.constants.signals.SIGKILL,
};

interface ManagedProcess {
	pid: number;
	exited: Promise<number>;
	/**
	 * The signal that terminated the process, if any (Bun.Subprocess.signalCode:
	 * the signal NAME, e.g. "SIGTERM", or null). Read on settle so a signal-killed
	 * process reports its signal instead of a misleading numeric exit code (a
	 * SIGTERM'd `bash -c '...; sleep 60'` otherwise surfaced as exit=1). (DOG-2)
	 */
	signalCode?: string | null;
	unref(): void;
	kill(signal?: number): void;
}

interface ManagedDaemon {
	spec: DaemonSpec;
	snapshot: DaemonSnapshot;
	dir: string;
	log?: DaemonLog;
	process?: ManagedProcess;
	input?: Bun.FileSink;
	pty?: PtySession;
	generation: number;
	stopRequested: boolean;
	logReady: boolean;
	portReady: boolean;
	readinessBuffer: string;
	outputOffset: number;
	readyPattern?: RegExp;
	restartTimer?: NodeJS.Timeout;
	consecutiveFailures: number;
	persistQueue: Promise<void>;
	/** Attribution for the death of the CURRENT generation, set before the signal goes out. */
	termination?: DaemonTerminationSource;
	/** Native handles for the current generation's process tree; absent before the first spawn. */
	tree?: ProcessTree;
	/** Settles when the output drains of this generation end. Settle waits for it only up to a bound. */
	drained?: Promise<void>;
	/** Sampler that refreshes tracked descendants while the generation runs. */
	sampler?: NodeJS.Timeout;
	/** Re-check of a held settle of a live tree. An unknown tree has no re-check: it has no handle to observe. */
	holdTimer?: NodeJS.Timeout;
	/** The settle in flight for one generation; a second observer joins it instead of settling again. */
	settling?: { generation: number; promise: Promise<void> };
	/** Generation whose completion record is already queued. A second settle of it queues none. */
	completedGeneration?: number;
}

interface DaemonLogRead {
	text: string;
	terminalText: string;
}

function quoteShellArg(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function terminalState(state: DaemonSnapshot["state"]): boolean {
	return state === "exited" || state === "failed";
}

/** Mirror per-condition readiness progress into the snapshot so clients can see which condition is unmet. */
function syncReadyPending(record: ManagedDaemon): void {
	if (record.snapshot.state !== "starting") {
		record.snapshot.readyPending = undefined;
		return;
	}
	const pending: ("log" | "port")[] = [];
	if (!record.logReady) pending.push("log");
	if (!record.portReady) pending.push("port");
	record.snapshot.readyPending = pending.length > 0 ? pending : undefined;
}

async function fileTextSlice(filePath: string, head: boolean): Promise<string> {
	try {
		const stat = await fs.stat(filePath);
		// fs.readFile, not Bun.file().text(): a Bun.file read does not ref the
		// event loop, so a broker that reaches this await with nothing else
		// pending can exit 0 mid-read instead of settling.
		if (stat.size <= LOG_READ_BYTES) return await fs.readFile(filePath, "utf8");
		const handle = await fs.open(filePath, "r");
		try {
			const offset = head ? 0 : Math.max(0, stat.size - LOG_READ_BYTES);
			const { bytesRead, buffer } = await handle.read(Buffer.allocUnsafe(LOG_READ_BYTES), 0, LOG_READ_BYTES, offset);
			return buffer.toString("utf8", 0, bytesRead);
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (isEnoent(error)) return "";
		throw error;
	}
}

class DaemonLog {
	readonly #path: string;
	readonly #previousPath: string;
	readonly #file: Bun.BunFile;
	#writer: Bun.FileSink;
	#currentBytes = 0;
	#queue: Promise<void> = Promise.resolve();
	#closed = false;

	constructor(logPath: string, previousPath: string, file: Bun.BunFile, writer: Bun.FileSink) {
		this.#path = logPath;
		this.#previousPath = previousPath;
		this.#file = file;
		this.#writer = writer;
	}

	static async open(dir: string): Promise<DaemonLog> {
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		const logPath = managedDaemonLogPath(dir);
		const previousPath = managedDaemonPreviousLogPath(dir);
		await fs.rm(previousPath, { force: true });
		try {
			await fs.rename(logPath, previousPath);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		const file = Bun.file(logPath);
		return new DaemonLog(logPath, previousPath, file, file.writer());
	}

	append(text: string): string {
		if (text.length === 0 || this.#closed) return text;
		const bytes = Buffer.byteLength(text, "utf8");
		this.#queue = this.#queue.then(async () => {
			if (this.#currentBytes > 0 && this.#currentBytes + bytes > LOG_ROTATE_BYTES) await this.#rotate();
			this.#writer.write(text);
			this.#currentBytes += bytes;
			await this.#writer.flush();
		});
		return text;
	}

	async read(head: boolean, lines: number, grep?: string): Promise<DaemonLogRead> {
		await this.#queue;
		await this.#writer.flush();
		return DaemonLog.readFiles(this.#path, this.#previousPath, head, lines, grep);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#queue;
		await this.#writer.end();
	}

	static async readFiles(
		logPath: string,
		previousPath: string,
		head: boolean,
		lines: number,
		grep?: string,
	): Promise<DaemonLogRead> {
		const [previous, current] = await Promise.all([fileTextSlice(previousPath, head), fileTextSlice(logPath, head)]);
		const combined = `${previous}${previous && current && !previous.endsWith("\n") ? "\n" : ""}${current}`;
		const terminalText = head
			? truncateHeadBytes(combined, LOG_READ_BYTES).text
			: truncateTailBytes(combined, LOG_READ_BYTES).text;
		let text = sanitizeText(terminalText);
		if (grep) {
			let pattern: RegExp;
			try {
				pattern = new RegExp(grep, "u");
			} catch (error) {
				throw new Error(`Invalid log regex: ${errorMessage(error)}`);
			}
			text = text
				.split("\n")
				.filter(line => pattern.test(line))
				.join("\n");
		}
		const options = { maxLines: lines, maxBytes: 256 * 1024 };
		return {
			text: head ? truncateHead(text, options).content : truncateTail(text, options).content,
			terminalText,
		};
	}

	async #rotate(): Promise<void> {
		await this.#writer.end();
		await fs.rm(this.#previousPath, { force: true });
		await fs.rename(this.#path, this.#previousPath);
		this.#writer = this.#file.writer();
		this.#currentBytes = 0;
	}
}

function connectPort(host: string, port: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = net.createConnection({ host, port });
	let settled = false;
	const finish = (connected: boolean): void => {
		if (settled) return;
		settled = true;
		socket.destroy();
		resolve(connected);
	};
	socket.once("connect", () => finish(true));
	socket.once("error", () => finish(false));
	socket.setTimeout(250, () => finish(false));
	return promise;
}

/**
 * Terminate the POSIX process group whose id is `pid`, the group a non-detached root leads. Resolves true only when
 * the group is proven empty. Windows has no group to signal, and a PID is never signalled alone without a handle,
 * so Windows resolves false. No persisted creation identity exists, so a reused PID is not detected here.
 */
async function reapOwnedGroup(pid: number): Promise<boolean> {
	if (process.platform === "win32") return false;
	const alive = (): boolean => {
		try {
			process.kill(-pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "EPERM";
		}
	};
	const signal = (name: NodeJS.Signals): void => {
		try {
			process.kill(-pid, name);
		} catch (error) {
			logger.debug("Owned process group signal failed", { pid, signal: name, error: errorMessage(error) });
		}
	};
	const waitGone = async (ms: number): Promise<boolean> => {
		const deadline = Date.now() + ms;
		while (alive() && Date.now() < deadline) await sleep(50);
		return !alive();
	};
	if (!alive()) return true;
	signal("SIGTERM");
	if (await waitGone(TREE_GRACE_MS)) return true;
	signal("SIGKILL");
	return waitGone(TREE_BOUND_MS);
}

type TreeState = "alive" | "dead" | "unknown";

/**
 * One generation's process tree. Each tracked process is held as a native handle (Linux pidfd, Windows
 * process HANDLE, macOS start time where available), so a tracked member keeps its identity after its
 * parent dies. A descendant spawned and reparented between two samples is never tracked. A root with no
 * handle is probed by PID alone. Escaped descendants of such a root are not observable: this is an explicit
 * gap, not an assertion that the tree is dead.
 */
class ProcessTree {
	/** Native handle of the root. Null when no handle is available. */
	readonly root: Process | null;
	/** Root PID, probed for liveness when no handle exists. */
	readonly pid: number | undefined;
	readonly #members = new Map<number, Process>();
	/** Process group captured at spawn. It is signalled but never probed, so a zombie member cannot hold a record. */
	readonly #group: number | undefined;
	/** When the tree was last walked by sampleThrottled. */
	#sampledAt = 0;

	constructor(pid: number | undefined, root: Process | null) {
		this.pid = pid;
		this.root = root;
		this.#group = root !== null && root.groupId() === root.pid ? root.pid : undefined;
	}

	/**
	 * Track the descendants of the root and of every tracked member, breadth first, in one pass. An exited
	 * parent is still enumerated: Windows keeps its children visible by creation time. Exited members are
	 * dropped after the pass, so a child of an exited Windows parent is still tracked.
	 */
	sample(): void {
		const queue: Process[] = this.root === null ? [] : [this.root];
		queue.push(...this.#members.values());
		for (let index = 0; index < queue.length; index++) {
			for (const child of queue[index].children()) {
				if (child.pid === this.root?.pid || this.#members.has(child.pid)) continue;
				this.#members.set(child.pid, child);
				queue.push(child);
			}
		}
		for (const [pid, handle] of this.#members) {
			if (handle.status() !== "running") this.#members.delete(pid);
		}
	}

	/** Walk the tree at most once per TREE_SAMPLE_MS, so an output burst does not walk it once per chunk. */
	sampleThrottled(): void {
		const now = Date.now();
		if (now - this.#sampledAt < TREE_SAMPLE_MS) return;
		this.#sampledAt = now;
		this.sample();
	}

	/** Tracked processes still running. Each is checked through its own handle, so an escaped member counts. */
	live(): Process[] {
		const running: Process[] = [];
		for (const handle of [this.root, ...this.#members.values()]) {
			if (handle !== null && handle.status() === "running") running.push(handle);
		}
		return running;
	}

	/**
	 * `dead` when every tracked handle has exited, a claim about tracked processes only. Without a root handle only
	 * the PID answers: `alive` while it probes alive, otherwise `unknown`. A root exit or a PTY exit never answers
	 * `dead` here, because neither proves the descendants gone.
	 */
	state(): TreeState {
		if (this.root === null) {
			if (this.pid === undefined) return "unknown";
			return isProcessAlive(this.pid) ? "alive" : "unknown";
		}
		return this.live().length > 0 ? "alive" : "dead";
	}

	/**
	 * Terminate every tracked process: TERM, wait `graceMs`, then KILL the survivors, then wait `boundMs`.
	 * The native `terminate` returns once its root is gone, which would report an escaped descendant as dead;
	 * this loop checks every handle instead.
	 */
	async terminate(graceMs: number, boundMs: number): Promise<TreeState> {
		this.sample();
		if (this.state() !== "alive") return this.state();
		this.#signal(os.constants.signals.SIGTERM);
		await this.#waitDead(graceMs);
		if (this.state() !== "alive") return this.state();
		this.sample();
		this.#signal(os.constants.signals.SIGKILL);
		await this.#waitDead(boundMs);
		return this.state();
	}

	#signal(signal: number): void {
		if (this.#group !== undefined) {
			try {
				process.kill(-this.#group, signal);
			} catch (error) {
				logger.debug("Daemon process group signal failed", { group: this.#group, error: errorMessage(error) });
			}
		}
		for (const handle of this.live()) handle.killTree(signal);
	}

	async #waitDead(ms: number): Promise<void> {
		const deadline = Date.now() + ms;
		while (this.state() === "alive" && Date.now() < deadline) await sleep(50);
	}
}

export class DaemonBroker {
	readonly #projectDir: string;
	readonly #runtimeDir: string;
	readonly #endpoint: string;
	readonly #token: string;
	readonly #idleGraceMs: number;
	readonly #cleanupWaitMs: number;
	readonly #cleanupTimers = new Map<string, NodeJS.Timeout>();
	readonly #records = new Map<string, ManagedDaemon>();
	/** Tail of the start, stop and restart chain per daemon name. A tail never rejects, so one failure cannot poison it. */
	readonly #lifecycle = new Map<string, Promise<void>>();
	readonly #clients = new Set<net.Socket>();
	readonly #finished = Promise.withResolvers<void>();
	readonly #sockets = new Set<net.Socket>();
	/** Serializes read-modify-write passes over the completion store. */
	#completionsQueue: Promise<void> = Promise.resolve();
	#server: net.Server | undefined;
	#idleTimer: NodeJS.Timeout | undefined;
	#shuttingDown = false;

	constructor(
		projectDir: string,
		runtimeDir: string,
		token: string,
		idleGraceMs: number,
		cleanupWaitMs = DEFAULT_CLEANUP_WAIT_MS,
	) {
		this.#projectDir = projectDir;
		this.#runtimeDir = runtimeDir;
		this.#endpoint = daemonBrokerEndpoint(runtimeDir);
		this.#token = token;
		this.#idleGraceMs = Number.isFinite(idleGraceMs) && idleGraceMs >= 0 ? idleGraceMs : DEFAULT_IDLE_GRACE_MS;
		this.#cleanupWaitMs =
			Number.isFinite(cleanupWaitMs) && cleanupWaitMs >= 0 ? cleanupWaitMs : DEFAULT_CLEANUP_WAIT_MS;
	}

	async run(): Promise<void> {
		await this.#recoverRecords();
		if (process.platform !== "win32") await fs.rm(this.#endpoint, { force: true });
		const server = net.createServer(socket => this.#accept(socket));
		this.#server = server;
		const { promise: listening, resolve, reject } = Promise.withResolvers<void>();
		server.once("listening", resolve);
		server.once("error", reject);
		server.listen(this.#endpoint);
		await listening;
		if (process.platform !== "win32") await fs.chmod(this.#endpoint, 0o600);
		this.#scheduleIdleShutdown();
		await this.#finished.promise;
	}

	async shutdown(
		termination: DaemonTerminationSource = {
			owner: "os-signal",
			reason: "the broker process itself is exiting (OS signal or process exit)",
			at: Date.now(),
		},
	): Promise<void> {
		if (this.#shuttingDown) return this.#finished.promise;
		this.#shuttingDown = true;
		clearTimeout(this.#idleTimer);
		this.#idleTimer = undefined;
		for (const timer of this.#cleanupTimers.values()) clearTimeout(timer);
		this.#cleanupTimers.clear();
		for (const record of this.#records.values()) {
			const detached = record.spec.detached && !record.stopRequested && record.snapshot.pid !== undefined;
			if (!detached && !terminalState(record.snapshot.state)) {
				await this.#stopRecord(record, 2_000, termination).catch(error =>
					logger.warn("Daemon process tree is still live at broker shutdown; it is left unsettled", {
						name: record.snapshot.name,
						error: errorMessage(error),
					}),
				);
			}
			clearTimeout(record.restartTimer);
			clearTimeout(record.holdTimer);
			this.#stopSampler(record);
			await record.log?.close();
			await record.persistQueue;
		}
		for (const timer of this.#cleanupTimers.values()) clearTimeout(timer);
		this.#cleanupTimers.clear();
		// Settles queue completion records asynchronously; the store write must
		// land before the socket closes or a shutdown loses the deaths it caused.
		await this.#completionsQueue;
		for (const socket of this.#sockets) socket.destroy();
		this.#sockets.clear();
		this.#clients.clear();
		if (this.#server) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#server.close(() => resolve());
			await promise;
		}
		if (process.platform !== "win32") await fs.rm(this.#endpoint, { force: true });
		this.#finished.resolve();
	}

	#accept(socket: net.Socket): void {
		this.#sockets.add(socket);
		let authenticated = false;
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", chunk => {
			buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
				socket.destroy(new Error("Daemon broker request exceeds size limit"));
				return;
			}
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				void this.#handleLine(socket, line, () => {
					if (authenticated) return;
					authenticated = true;
					this.#clients.add(socket);
					clearTimeout(this.#idleTimer);
					this.#idleTimer = undefined;
				});
			}
		});
		socket.on("error", () => {
			// Socket closure performs client accounting.
		});
		socket.on("close", () => {
			this.#sockets.delete(socket);
			if (!authenticated) return;
			this.#clients.delete(socket);
			this.#scheduleIdleShutdown();
		});
	}

	async #handleLine(socket: net.Socket, line: string, onAuthenticated: () => void): Promise<void> {
		let id = "unknown";
		try {
			const decoded: unknown = JSON.parse(line);
			const request = parseDaemonWireRequest(decoded);
			id = request.id;
			if (request.token !== this.#token) throw new Error("Daemon broker authentication failed");
			onAuthenticated();
			const result = await this.#dispatch(request.operation);
			socket.write(`${JSON.stringify({ id, ok: true, result })}\n`);
			if (request.operation.op === "shutdown") {
				setTimeout(
					() =>
						void this.shutdown({
							owner: "broker-shutdown",
							reason: "a veyyon client requested broker shutdown",
							at: Date.now(),
						}),
					10,
				);
			}
		} catch (error) {
			const message = errorMessage(error);
			socket.write(`${JSON.stringify({ id, ok: false, error: message })}\n`);
		}
	}

	/** Runs one lifecycle operation after the previous one for the same daemon name has settled. */
	#serialized<T>(name: string, run: () => Promise<T>): Promise<T> {
		const current = (this.#lifecycle.get(name) ?? Promise.resolve()).then(run);
		const tail = current.then(
			() => undefined,
			() => undefined,
		);
		this.#lifecycle.set(name, tail);
		void tail.then(() => {
			if (this.#lifecycle.get(name) === tail) this.#lifecycle.delete(name);
		});
		return current;
	}

	async #dispatch(operation: DaemonOperation): Promise<DaemonRpcResult> {
		switch (operation.op) {
			case "ping":
				return { op: "ping", projectDir: this.#projectDir, pid: process.pid };
			case "start":
				return this.#serialized(operation.spec.name, () => this.#start(operation.spec, operation.owner));
			case "list": {
				await Promise.all(Array.from(this.#records.values()).map(record => this.#refreshDetached(record)));
				return {
					op: "list",
					daemons: Array.from(this.#records.values())
						.sort((left, right) => left.snapshot.createdAt - right.snapshot.createdAt)
						.map(record => record.snapshot),
					completions: await this.#completionRecords(),
				};
			}
			case "logs":
				return this.#logs(operation);
			case "wait":
				return this.#wait(operation);
			case "send":
				return this.#send(operation);
			case "stop":
				return this.#serialized(operation.name, async () => {
					const record = this.#record(operation.name);
					await this.#stopRecord(record, operation.timeoutMs);
					return { op: "stop", daemon: record.snapshot };
				});
			case "restart":
				return this.#serialized(operation.name, () => this.#restart(operation.name));
			case "describe": {
				const record = this.#record(operation.name);
				await this.#refreshDetached(record);
				return { op: "describe", daemon: record.snapshot, spec: record.spec };
			}
			case "shutdown":
				return { op: "shutdown" };
		}
	}

	async #start(spec: DaemonSpec, owner?: string): Promise<DaemonRpcResult> {
		if (this.#shuttingDown) throw new Error("Daemon broker is shutting down; no daemon can start");
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(spec.name)) {
			throw new Error("Daemon name must be 1-48 letters, numbers, dots, underscores, or hyphens");
		}
		if (spec.detached && spec.pty) {
			throw new Error("A detached daemon cannot allocate a PTY");
		}
		if (
			spec.pty &&
			process.platform === "win32" &&
			[".bat", ".cmd"].includes(path.extname(spec.application).toLowerCase())
		) {
			throw new Error('Windows batch files require application "cmd.exe" with the batch path after "/c"');
		}
		const existing = this.#records.get(spec.name);
		this.#cancelCleanup(spec.name);
		if (existing) await this.#refreshDetached(existing);
		if (existing && !terminalState(existing.snapshot.state)) {
			throw new Error(`Daemon ${spec.name} is already ${existing.snapshot.state}`);
		}
		if (spec.ready?.log) {
			try {
				new RegExp(spec.ready.log, "u");
			} catch (error) {
				throw new Error(`Invalid readiness regex: ${errorMessage(error)}`);
			}
		}
		const stat = await fs.stat(spec.cwd);
		if (!stat.isDirectory()) throw new Error(`Daemon cwd is not a directory: ${spec.cwd}`);
		const dir = managedDaemonDir(this.#runtimeDir, spec.name);
		const now = Date.now();
		const record: ManagedDaemon = {
			spec,
			snapshot: {
				name: spec.name,
				id: crypto.randomUUID(),
				state: "starting",
				createdAt: now,
				startedAt: now,
				restartCount: 0,
				outputBytes: 0,
				owner,
				persist: spec.persist,
				detached: spec.detached,
				ownershipUncertain: existing?.snapshot.ownershipUncertain,
			},
			dir,
			log: await DaemonLog.open(dir),
			generation: 0,
			stopRequested: false,
			logReady: !spec.ready?.log,
			portReady: spec.ready?.port === undefined,
			readinessBuffer: "",
			outputOffset: 0,
			readyPattern: spec.ready?.log ? new RegExp(spec.ready.log, "u") : undefined,
			consecutiveFailures: 0,
			persistQueue: Promise.resolve(),
		};
		if (record.snapshot.ownershipUncertain) {
			try {
				await this.#assertOwnershipFree(spec);
			} catch (error) {
				await record.log?.close();
				throw error;
			}
		}
		syncReadyPending(record);
		this.#records.set(spec.name, record);
		await this.#launch(record);
		let readyTimedOut = false;
		if (spec.ready && !terminalState(record.snapshot.state)) {
			const ready = await this.#waitUntil(record, () => record.snapshot.state === "ready", spec.ready.timeoutMs);
			readyTimedOut = !ready && !terminalState(record.snapshot.state);
		}
		await record.persistQueue;
		return { op: "start", daemon: record.snapshot, readyTimedOut };
	}

	async #launch(record: ManagedDaemon): Promise<void> {
		// A launch never starts a process during shutdown or while a stop is pending. Initial starts and restarts
		// clear stopRequested before they get here, so only a stale launch is refused.
		if (this.#shuttingDown || record.stopRequested) return;
		record.generation++;
		const generation = record.generation;
		record.stopRequested = false;
		record.termination = undefined;
		record.tree = undefined;
		record.snapshot.state = record.spec.ready ? "starting" : "running";
		record.snapshot.startedAt = Date.now();
		record.snapshot.readyAt = undefined;
		record.snapshot.exitedAt = undefined;
		record.snapshot.exitCode = undefined;
		record.snapshot.signal = undefined;
		record.snapshot.exitReason = undefined;
		record.snapshot.terminatedBy = undefined;
		record.snapshot.pid = undefined;
		record.snapshot.readyMatch = undefined;
		record.logReady = !record.spec.ready?.log;
		record.portReady = record.spec.ready?.port === undefined;
		syncReadyPending(record);
		record.readinessBuffer = "";
		record.outputOffset = 0;
		persist(record);
		try {
			if (record.spec.detached) await this.#launchDetached(record, generation);
			else if (record.spec.pty) await this.#launchPty(record, generation);
			else this.#launchPipe(record, generation);
			if (record.snapshot.ownershipUncertain) {
				record.snapshot.ownershipUncertain = undefined;
				persist(record);
			}
			if (record.spec.ready?.port !== undefined) void this.#pollPort(record, generation, record.spec.ready);
			this.#markReady(record);
		} catch (error) {
			const message = errorMessage(error);
			record.log?.append(`Daemon launch failed: ${message}\n`);
			record.termination = {
				owner: "launch-failure",
				reason: `the broker failed to launch it: ${message}`,
				at: Date.now(),
			};
			await this.#settle(record, generation, undefined, message);
		}
	}

	async #launchPty(record: ManagedDaemon, generation: number): Promise<void> {
		const session = new PtySession();
		record.pty = session;
		const options = {
			cwd: record.spec.cwd,
			env: workerEnvFromParent({ TERM: "xterm-256color", ...record.spec.env }),
			cols: DAEMON_PTY_COLUMNS,
			rows: DAEMON_PTY_ROWS,
		};
		const onChunk = (error: Error | null, chunk: string): void => {
			if (generation !== record.generation) return;
			if (error) record.log?.append(`PTY output error: ${error.message}\n`);
			if (chunk) this.#onOutput(record, generation, chunk);
		};
		let run: Promise<PtyRunResult>;
		if (process.platform === "win32") {
			run = session.startArgv(
				{
					application: record.spec.application,
					args: record.spec.args,
					...options,
				},
				onChunk,
			);
		} else {
			const argv = [record.spec.application, ...record.spec.args];
			const command = `exec ${argv.map(quoteShellArg).join(" ")}`;
			run = session.start({ command, shell: process.env.SHELL, ...options }, onChunk);
		}
		record.tree = new ProcessTree(undefined, null);
		// The native session keeps the child's handle after the run ends. Adopting it before the exit is settled
		// proves a child that exited before the poll below saw its handle, instead of holding it as unknown.
		void run
			.then(result => {
				this.#attachPtyRoot(record, generation, session);
				return this.#onPtyExit(record, generation, result);
			})
			.catch(error => this.#settle(record, generation, undefined, errorMessage(error)));

		// The native session publishes the child's handle right after spawn. Poll it, bounded, only while this
		// generation is live and no stop or shutdown is pending. A stop that wins the race leaves the exit path to adopt it.
		const deadline = Date.now() + 5_000;
		while (!this.#attachPtyRoot(record, generation, session)) {
			if (
				Date.now() >= deadline ||
				generation !== record.generation ||
				record.stopRequested ||
				this.#shuttingDown ||
				terminalState(record.snapshot.state)
			) {
				return;
			}
			await sleep(20);
		}
		if (generation !== record.generation || terminalState(record.snapshot.state)) return;
		this.#startSampler(record, generation);
		persist(record);
	}

	/**
	 * Adopt the native root handle of this PTY child. A handle is kept after its run ends, so this succeeds whether it
	 * is read while the child runs or after it exited. Returns false while no handle is published for this generation.
	 */
	#attachPtyRoot(record: ManagedDaemon, generation: number, session: PtySession): boolean {
		if (generation !== record.generation) return false;
		if (record.tree?.root) return true;
		const root = "process" in session ? session.process : undefined;
		if (!(root instanceof Process)) return false;
		record.snapshot.pid = root.pid;
		record.tree = new ProcessTree(root.pid, root);
		return true;
	}

	#launchPipe(record: ManagedDaemon, generation: number): void {
		const process = Bun.spawn([record.spec.application, ...record.spec.args], {
			cwd: record.spec.cwd,
			env: workerEnvFromParent(record.spec.env),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			...ptree.detachedSpawnOptions(),
		});
		record.process = process;
		record.input = process.stdin;
		record.snapshot.pid = process.pid;
		record.tree = new ProcessTree(process.pid, processHandle(process.pid));
		this.#startSampler(record, generation);
		persist(record);
		// Output and exit are observed separately. A pipe that fails, or that an escaped descendant keeps
		// open, is an observation failure: it is logged and never settles a child that may still run.
		record.drained = Promise.all([
			this.#drain(record, generation, process.stdout),
			this.#drain(record, generation, process.stderr),
		]).catch(error =>
			logger.warn("Daemon output stream failed; output observation is lost, the process is not settled", {
				name: record.snapshot.name,
				error: errorMessage(error),
			}),
		);
		void process.exited
			.then(exitCode => this.#settle(record, generation, exitCode))
			.catch(error => this.#settle(record, generation, undefined, errorMessage(error)));
	}

	async #launchDetached(record: ManagedDaemon, generation: number): Promise<void> {
		const logPath = managedDaemonLogPath(record.dir);
		const output = await fs.open(logPath, "a", 0o600);
		try {
			const process = Bun.spawn([record.spec.application, ...record.spec.args], {
				cwd: record.spec.cwd,
				env: workerEnvFromParent(record.spec.env),
				stdio: ["ignore", output.fd, output.fd],
				...ptree.detachedSpawnOptions(),
			});
			record.process = process;
			record.snapshot.pid = process.pid;
			record.tree = new ProcessTree(process.pid, processHandle(process.pid));
			this.#startSampler(record, generation);
			persist(record);
			process.unref();
			void process.exited
				.then(exitCode => this.#settle(record, generation, exitCode))
				.catch(error => this.#settle(record, generation, undefined, errorMessage(error)));
		} finally {
			await output.close();
		}
	}

	async #drain(record: ManagedDaemon, generation: number, stream: ReadableStream<Uint8Array>): Promise<void> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (generation === record.generation)
					this.#onOutput(record, generation, decoder.decode(value, { stream: true }));
			}
			const tail = decoder.decode();
			if (tail && generation === record.generation) this.#onOutput(record, generation, tail);
		} finally {
			reader.releaseLock();
		}
	}

	#onOutput(record: ManagedDaemon, generation: number, raw: string): void {
		if (generation !== record.generation) return;
		const output = raw.toWellFormed();
		const text = record.log?.append(output) ?? output;
		record.snapshot.outputBytes += Buffer.byteLength(text, "utf8");
		if (record.tree?.root?.status() === "running") record.tree.sampleThrottled();
		this.#trackOutput(record, generation, sanitizeText(text));
	}

	async #readDetachedOutput(record: ManagedDaemon, generation: number): Promise<void> {
		if (!record.spec.detached || generation !== record.generation) return;
		const logPath = managedDaemonLogPath(record.dir);
		let size: number;
		try {
			size = (await fs.stat(logPath)).size;
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}
		if (size < record.outputOffset) record.outputOffset = 0;
		if (size === record.outputOffset) return;
		const handle = await fs.open(logPath, "r");
		try {
			const { bytesRead, buffer } = await handle.read(
				Buffer.allocUnsafe(size - record.outputOffset),
				0,
				size - record.outputOffset,
				record.outputOffset,
			);
			const raw = buffer.toString("utf8", 0, bytesRead);
			if (generation !== record.generation) return;
			record.outputOffset = size;
			record.snapshot.outputBytes = size;
			this.#trackOutput(record, generation, sanitizeText(raw));
		} finally {
			await handle.close();
		}
	}

	#trackOutput(record: ManagedDaemon, generation: number, text: string): void {
		if (generation !== record.generation) return;
		record.readinessBuffer = (record.readinessBuffer + text).slice(-READINESS_BUFFER_CHARS);
		if (!record.logReady && record.readyPattern) {
			const match = record.readyPattern.exec(record.readinessBuffer);
			if (match) {
				record.logReady = true;
				record.snapshot.readyMatch = match[0].slice(0, 500);
				syncReadyPending(record);
			}
		}
		this.#markReady(record);
	}

	async #refreshDetached(record: ManagedDaemon): Promise<void> {
		if (!record.spec.detached || terminalState(record.snapshot.state)) return;
		const generation = record.generation;
		await this.#readDetachedOutput(record, generation);
		if (generation !== record.generation || record.process) return;
		// Only a positive observation of the tree's death settles. An unavailable handle is not a death.
		if (record.tree?.state() !== "dead") return;
		await this.#settle(record, generation);
	}

	async #pollPort(record: ManagedDaemon, generation: number, ready: DaemonReadySpec): Promise<void> {
		const host = ready.host ?? "127.0.0.1";
		const port = ready.port;
		if (port === undefined) return;
		while (generation === record.generation && !terminalState(record.snapshot.state)) {
			if (await connectPort(host, port)) {
				record.portReady = true;
				syncReadyPending(record);
				this.#markReady(record);
				return;
			}
			await Bun.sleep(100);
		}
	}

	#markReady(record: ManagedDaemon): void {
		if (!record.spec.ready || record.snapshot.state !== "starting") return;
		if (!record.logReady || !record.portReady) return;
		record.snapshot.state = "ready";
		record.snapshot.readyAt = Date.now();
		persist(record);
	}

	async #onPtyExit(record: ManagedDaemon, generation: number, result: PtyRunResult): Promise<void> {
		return this.#settle(
			record,
			generation,
			result.exitCode,
			result.timedOut ? "timed out" : undefined,
			result.signal,
		);
	}

	async #settle(
		record: ManagedDaemon,
		generation: number,
		exitCode?: number,
		error?: string,
		ptySignal?: string,
	): Promise<void> {
		if (generation !== record.generation || terminalState(record.snapshot.state)) return;
		// Single flight: a second observer of this generation joins the settle in flight.
		const inflight = record.settling;
		if (inflight?.generation === generation) return inflight.promise;
		const promise = this.#settleOnce(record, generation, exitCode, error, ptySignal).finally(() => {
			if (record.settling?.promise === promise) record.settling = undefined;
		});
		record.settling = { generation, promise };
		return promise;
	}

	async #settleOnce(
		record: ManagedDaemon,
		generation: number,
		exitCode?: number,
		error?: string,
		ptySignal?: string,
	): Promise<void> {
		// Prove the whole tree dead before the verdict. A root that exited while a descendant lives, or whose
		// handle is unavailable, is not a settled death: the reap either proves the tree dead or holds the record.
		// A missing exit code or a rejected observer is not a death. A tree still alive is held and never
		// signalled, unless a stop asked for termination.
		if (!record.stopRequested && (exitCode === undefined || error !== undefined) && record.tree?.state() === "alive") {
			this.#hold(record, generation, "alive", exitCode, error, ptySignal);
			return;
		}
		const tree = await this.#reapTree(record, generation);
		if (generation !== record.generation || terminalState(record.snapshot.state)) return;
		if (tree !== "dead") {
			this.#hold(record, generation, tree, exitCode, error, ptySignal);
			return;
		}
		clearTimeout(record.holdTimer);
		record.holdTimer = undefined;
		await this.#readDetachedOutput(record, generation);
		if (generation !== record.generation) return;
		// Capture the terminating signal BEFORE clearing record.process below, so a signal-killed process
		// reports the signal rather than a misleading numeric exit code (DOG-2). A PTY-run daemon carries its
		// signal in `ptySignal`. An operator stop goes through #stopRecord, which attributes SIGTERM.
		// Name the killer. An operator-signal attribution expires: a trapped signal does not kill.
		let attribution = record.termination;
		if (attribution?.owner === "operator-signal" && Date.now() - attribution.at > SIGNAL_ATTRIBUTION_WINDOW_MS) {
			attribution = undefined;
		}
		record.termination = undefined;
		const signal =
			record.process?.signalCode ?? ptySignal ?? (record.stopRequested ? "SIGTERM" : attribution?.signal);
		record.process = undefined;
		record.input = undefined;
		record.pty = undefined;
		record.snapshot.pid = undefined;
		record.snapshot.exitedAt = Date.now();
		record.snapshot.exitCode = signal ? undefined : exitCode;
		record.snapshot.signal = signal ?? undefined;
		record.snapshot.readyPending = undefined;
		if (attribution) {
			record.snapshot.terminatedBy = attribution.owner;
			record.snapshot.exitReason = attribution.reason;
		} else if (signal) {
			record.snapshot.terminatedBy = "external-signal";
			record.snapshot.exitReason = `terminated by ${signal}; no veyyon component sent a signal, so the killer was external (another process, or the OOM killer)`;
		} else if (error !== undefined) {
			record.snapshot.terminatedBy = "process-exit";
			record.snapshot.exitReason = error;
		} else {
			record.snapshot.terminatedBy = "process-exit";
			record.snapshot.exitReason =
				exitCode === undefined ? "the process ended without an exit code" : `exited with code ${exitCode}`;
		}
		const failed = error !== undefined || (exitCode !== undefined && exitCode !== 0);
		const shouldRestart =
			!record.stopRequested &&
			(record.spec.restart === "always" || (record.spec.restart === "on-failure" && failed));
		if (shouldRestart && !this.#shuttingDown) {
			this.#queueCompletion(record);
			const uptime = Date.now() - record.snapshot.startedAt;
			record.consecutiveFailures = uptime >= 30_000 ? 0 : record.consecutiveFailures + 1;
			record.snapshot.restartCount++;
			record.snapshot.state = "restarting";
			const delay = exponentialBackoffDelay(record.consecutiveFailures, {
				baseMs: 1_000,
				maxMs: RESTART_MAX_DELAY_MS,
				jitter: 0,
			});
			record.log?.append(
				`\n[daemon exited${exitCode === undefined ? "" : ` with code ${exitCode}`}; restarting in ${delay}ms]\n`,
			);
			persist(record);
			clearTimeout(record.restartTimer);
			record.restartTimer = setTimeout(() => {
				record.restartTimer = undefined;
				void this.#serialized(record.snapshot.name, async () => {
					if (
						generation !== record.generation ||
						record.stopRequested ||
						this.#shuttingDown ||
						this.#records.get(record.snapshot.name) !== record ||
						record.snapshot.state !== "restarting"
					) {
						return;
					}
					await this.#launch(record);
				});
			}, delay);
			return;
		}
		// Close the log and queue the completion record BEFORE the terminal state becomes visible.
		// Bounded final drain: bytes the child already wrote reach the log. An inherited pipe cannot block settle.
		await Promise.race([record.drained, sleep(250)]);
		await record.log?.close();
		record.log = undefined;
		this.#queueCompletion(record);
		record.snapshot.state = failed && !record.stopRequested ? "failed" : "exited";
		persist(record);
		this.#scheduleCleanup(record);
		if (record.spec.persist) this.#scheduleIdleShutdown();
	}

	/** Terminate and prove the generation's tree dead. Nothing spawned means nothing to prove. */
	async #reapTree(
		record: ManagedDaemon,
		generation: number,
		graceMs = TREE_GRACE_MS,
		boundMs = TREE_BOUND_MS,
	): Promise<TreeState> {
		const tree = record.tree;
		if (!tree) return "dead";
		const state = await tree.terminate(graceMs, boundMs);
		if (generation === record.generation && state === "dead") this.#stopSampler(record);
		return state;
	}

	/** Keep the root and its handles and mark the record non-terminal. A live tree is re-checked later; an unknown one is not. */
	#hold(record: ManagedDaemon, generation: number, state: TreeState, exitCode?: number, error?: string, ptySignal?: string): void {
		record.snapshot.state = "stopping";
		record.snapshot.exitReason =
			state === "alive"
				? "the process tree is still running; restart is held until its death is proven"
				: "the process tree has no native handle, so its death cannot be observed; it stays stopping and is not restarted";
		persist(record);
		clearTimeout(record.holdTimer);
		record.holdTimer = undefined;
		// Only a live tree can change under a re-check. An unknown tree has no handle to observe, so it gets no timer.
		if (state !== "alive") return;
		record.holdTimer = setTimeout(() => {
			record.holdTimer = undefined;
			this.#settle(record, generation, exitCode, error, ptySignal).catch(recheckError =>
				logger.warn("Held daemon settle failed", { name: record.snapshot.name, error: errorMessage(recheckError) }),
			);
		}, HOLD_RECHECK_MS);
	}

	#startSampler(record: ManagedDaemon, generation: number): void {
		this.#stopSampler(record);
		const sampler = setInterval(() => {
			if (generation !== record.generation) {
				this.#stopSampler(record);
				return;
			}
			record.tree?.sample();
		}, TREE_SAMPLE_MS);
		sampler.unref();
		record.sampler = sampler;
	}

	#stopSampler(record: ManagedDaemon): void {
		clearInterval(record.sampler);
		record.sampler = undefined;
	}

	#cancelCleanup(name: string): void {
		const timer = this.#cleanupTimers.get(name);
		if (timer === undefined) return;
		clearTimeout(timer);
		this.#cleanupTimers.delete(name);
	}

	#scheduleCleanup(record: ManagedDaemon): void {
		if (this.#shuttingDown || this.#cleanupWaitMs <= 0) return;
		const name = record.snapshot.name;
		this.#cancelCleanup(name);
		const exitedAt = record.snapshot.exitedAt ?? Date.now();
		const delayMs = clamp(exitedAt + this.#cleanupWaitMs - Date.now(), 0, MAX_TIMER_DELAY_MS);
		const timer = setTimeout(() => {
			this.#cleanupTimers.delete(name);
			void this.#purgeRecord(name);
		}, delayMs);
		// A retained record is not a reason to keep the broker alive; the socket is.
		timer.unref();
		this.#cleanupTimers.set(name, timer);
	}

	async #purgeRecord(name: string): Promise<void> {
		const record = this.#records.get(name);
		if (!record || !terminalState(record.snapshot.state)) return;
		this.#cancelCleanup(name);
		// Nothing is torn down until the purge is committed. `persistQueue` yields,
		// and a start under the same name during that yield replaces the record: an
		// early `log.close()` left the new generation live in `#records` with no log
		// handle, and the later `fs.rm` wiped its directory.
		await record.persistQueue;
		if (this.#records.get(name) !== record || !terminalState(record.snapshot.state)) return;
		this.#records.delete(name);
		clearTimeout(record.restartTimer);
		await record.log?.close();
		record.log = undefined;
		await fs.rm(record.dir, { recursive: true, force: true }).catch(error => {
			logger.warn("Failed to remove purged daemon directory", { name, error: errorMessage(error) });
		});
	}

	async #logs(operation: Extract<DaemonOperation, { op: "logs" }>): Promise<DaemonRpcResult> {
		const record = this.#record(operation.name);
		await this.#refreshDetached(record);
		const cursor = operation.cursor ?? record.snapshot.outputBytes;
		let timedOut = false;
		if (operation.follow && record.snapshot.outputBytes <= cursor && !terminalState(record.snapshot.state)) {
			const changed = await this.#waitUntil(
				record,
				() => record.snapshot.outputBytes > cursor || terminalState(record.snapshot.state),
				operation.timeoutMs,
			);
			timedOut = !changed;
		}
		const lines = clampLow(Math.floor(operation.lines), 1, 1_000);
		const output = record.log
			? await record.log.read(operation.head, lines, operation.grep)
			: await DaemonLog.readFiles(
					managedDaemonLogPath(record.dir),
					managedDaemonPreviousLogPath(record.dir),
					operation.head,
					lines,
					operation.grep,
				);
		return {
			op: "logs",
			name: record.snapshot.name,
			text: output.text,
			terminalText: record.spec.pty && operation.grep === undefined ? output.terminalText : undefined,
			cursor: record.snapshot.outputBytes,
			timedOut,
			state: record.snapshot.state,
		};
	}

	async #wait(operation: Extract<DaemonOperation, { op: "wait" }>): Promise<DaemonRpcResult> {
		const record = this.#record(operation.name);
		await this.#refreshDetached(record);
		let matched: string | undefined;
		let pattern: RegExp | undefined;
		if (operation.pattern) {
			try {
				pattern = new RegExp(operation.pattern, "u");
			} catch (error) {
				throw new Error(`Invalid wait regex: ${errorMessage(error)}`);
			}
		}
		const condition = (): boolean => {
			if (pattern) {
				const match = pattern.exec(record.readinessBuffer);
				if (!match) return false;
				matched = match[0].slice(0, 500);
				return true;
			}
			if (operation.for === "exit") return terminalState(record.snapshot.state);
			return record.snapshot.state === "ready" || (record.snapshot.state === "running" && !record.spec.ready);
		};
		const reached = condition() || (await this.#waitUntil(record, condition, operation.timeoutMs));
		return { op: "wait", daemon: record.snapshot, matched, timedOut: !reached };
	}

	async #send(operation: Extract<DaemonOperation, { op: "send" }>): Promise<DaemonRpcResult> {
		const record = this.#record(operation.name);
		await this.#refreshDetached(record);
		if (terminalState(record.snapshot.state) || record.snapshot.state === "stopping") {
			throw new Error(`Daemon ${operation.name} is ${record.snapshot.state}`);
		}
		if (operation.data === undefined && operation.signal === undefined) {
			throw new Error("send requires data or signal");
		}
		if (operation.data !== undefined) {
			if (record.pty) record.pty.write(operation.data);
			else if (record.input) {
				record.input.write(operation.data);
				await record.input.flush();
			} else throw new Error(`Daemon ${operation.name} stdin is unavailable`);
		}
		if (operation.signal) {
			// Attribute before signalling: the settle that observes this death
			// reports WHO sent the signal rather than an unexplained termination.
			record.termination = {
				owner: "operator-signal",
				reason: `${operation.signal} delivered by launch send`,
				signal: operation.signal,
				at: Date.now(),
			};
			if (process.platform === "win32" && record.pty) {
				if (operation.signal === "SIGINT") record.pty.write("\u0003");
				else record.pty.kill();
			} else {
				const processRef = record.snapshot.pid === undefined ? null : processHandle(record.snapshot.pid);
				if (!processRef) throw new Error(`Daemon ${operation.name} process is unavailable`);
				processRef.killTree(SIGNAL_NUMBER[operation.signal]);
			}
		}
		return { op: "send", daemon: record.snapshot };
	}

	async #stopRecord(
		record: ManagedDaemon,
		timeoutMs: number,
		termination: DaemonTerminationSource = {
			owner: "operator-stop",
			reason: "stopped by launch stop (SIGTERM)",
			signal: "SIGTERM",
			at: Date.now(),
		},
	): Promise<void> {
		// Intent is recorded before the first await, so an exit observer that runs during the refresh sees the stop.
		record.stopRequested = true;
		record.termination = termination;
		await this.#refreshDetached(record);
		if (terminalState(record.snapshot.state)) return;
		const generation = record.generation;
		if (record.restartTimer) {
			clearTimeout(record.restartTimer);
			record.restartTimer = undefined;
			record.snapshot.terminatedBy = termination.owner;
			record.snapshot.exitReason = `${termination.reason}; the pending restart is cancelled`;
			record.snapshot.state = "exited";
			record.snapshot.exitedAt = Date.now();
			persist(record);
			await record.log?.close();
			record.log = undefined;
			// No completion is queued here: the settle that armed the restart already queued one for this generation.
			this.#scheduleCleanup(record);
			return;
		}
		record.snapshot.state = "stopping";
		persist(record);
		const tree = record.tree;
		// No native root handle: neither a PTY exit nor a root exit proves the tree dead. The kills are still sent;
		// the verdict comes from the tree alone, and a tree not proven dead is held and refused below.
		if (tree !== undefined && tree.root === null) {
			record.process?.kill();
			record.pty?.kill();
		}
		const state = await this.#reapTree(record, generation, timeoutMs, timeoutMs + 1_000);
		if (generation !== record.generation || terminalState(record.snapshot.state)) return;
		// A tree that is alive or not observable is never force-settled: the record stays unsettled and no restart may follow.
		if (state !== "dead") {
			this.#hold(record, generation, state);
			throw new Error(
				`Daemon ${record.snapshot.name} process tree is ${state === "alive" ? "still running" : "not observable"} after stop; it is left unsettled and not restarted`,
			);
		}
		await this.#settle(record, generation);
	}

	async #restart(name: string): Promise<DaemonRpcResult> {
		if (this.#shuttingDown) throw new Error("Daemon broker is shutting down; restart is refused");
		const record = this.#record(name);
		await this.#stopRecord(record, 2_000, {
			owner: "operator-restart",
			reason: "stopped by launch restart to start a new generation",
			signal: "SIGTERM",
			at: Date.now(),
		});
		// Stopping a live record settles it, and settling arms a purge timer. The
		// cancel has to follow the stop, or the new generation runs with a timer
		// armed against the corpse of the old one.
		this.#cancelCleanup(name);
		await record.log?.close();
		record.log = await DaemonLog.open(record.dir);
		if (record.snapshot.ownershipUncertain) {
			try {
				await this.#assertOwnershipFree(record.spec);
			} catch (error) {
				await record.log?.close();
				record.log = undefined;
				throw error;
			}
		}
		record.stopRequested = false;
		await this.#launch(record);
		await record.persistQueue;
		return { op: "restart", daemon: record.snapshot };
	}

	/**
	 * Gate the replacement of a record whose process tree is unaccounted for. Its configured ready port must be named
	 * and must be free by a local probe, run here immediately before the spawn. Without a port nothing proves the old
	 * tree gone, so the replacement is refused.
	 */
	async #assertOwnershipFree(spec: DaemonSpec): Promise<void> {
		const port = spec.ready?.port;
		const host = spec.ready?.host ?? "127.0.0.1";
		if (port === undefined) {
			throw new Error(
				`Daemon ${spec.name}'s previous process tree is unaccounted for and names no ready port to prove free; refusing to replace it. Stop the old process by hand first.`,
			);
		}
		if (await connectPort(host, port)) {
			throw new Error(
				`Daemon ${spec.name}'s previous process tree is unaccounted for and ${host}:${port} is in use; refusing to start a second process on it.`,
			);
		}
	}

	async #waitUntil(record: ManagedDaemon, condition: () => boolean, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + Math.max(0, timeoutMs);
		while (Date.now() < deadline) {
			await this.#refreshDetached(record);
			if (condition()) return true;
			if (this.#shuttingDown && terminalState(record.snapshot.state)) return condition();
			await sleep(50);
		}
		await this.#refreshDetached(record);
		return condition();
	}

	#record(name: string): ManagedDaemon {
		const record = this.#records.get(name);
		if (record) return record;
		const names = Array.from(this.#records.keys());
		throw new Error(`Unknown daemon ${name}${names.length ? `. Available: ${names.join(", ")}` : ""}`);
	}

	/**
	 * Retain the completion record of one terminal generation: exit code or
	 * signal, WHO ended it and WHY, timestamps, and the tail of its output.
	 * The write is serialized through `#completionsQueue` so concurrent settles
	 * cannot interleave a read-modify-write of the store.
	 */
	#queueCompletion(record: ManagedDaemon): void {
		// One completion per generation. A restart armed by a settle may have queued it, and a stop that settles
		// the same generation must not queue it again.
		if (record.completedGeneration === record.generation) return;
		record.completedGeneration = record.generation;
		const snapshot = record.snapshot;
		const completion: DaemonCompletionRecord = {
			name: snapshot.name,
			id: snapshot.id,
			owner: snapshot.owner,
			terminatedBy: snapshot.terminatedBy ?? "process-exit",
			exitReason: snapshot.exitReason,
			exitCode: snapshot.exitCode,
			signal: snapshot.signal,
			createdAt: snapshot.createdAt,
			startedAt: snapshot.startedAt,
			exitedAt: snapshot.exitedAt ?? Date.now(),
			restartCount: snapshot.restartCount,
			outputBytes: snapshot.outputBytes,
			outputTail: "",
		};
		this.#completionsQueue = this.#completionsQueue
			.then(async () => {
				const tail = await DaemonLog.readFiles(
					managedDaemonLogPath(record.dir),
					managedDaemonPreviousLogPath(record.dir),
					false,
					COMPLETION_TAIL_LINES,
				);
				completion.outputTail =
					tail.text.length > COMPLETION_TAIL_BYTES ? `…${tail.text.slice(-COMPLETION_TAIL_BYTES)}` : tail.text;
				await appendDaemonCompletion(this.#runtimeDir, completion);
			})
			.catch(error => {
				logger.warn("Failed to retain daemon completion record", {
					name: snapshot.name,
					error: errorMessage(error),
				});
			});
	}

	/**
	 * The retained completion records for the `list` result. A store that
	 * cannot be read — corrupt, or written by another schema version — is
	 * rejected rather than served: the caller gets no records and a log line,
	 * never a stale one.
	 */
	async #completionRecords(): Promise<DaemonCompletionRecord[]> {
		await this.#completionsQueue;
		try {
			return await readDaemonCompletions(this.#runtimeDir);
		} catch (error) {
			logger.warn("Rejected unreadable daemon completion records", {
				error: errorMessage(error),
			});
			return [];
		}
	}

	async #recoverRecords(): Promise<void> {
		const root = managedDaemonsRoot(this.#runtimeDir);
		const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => {
			if (isEnoent(error)) return [];
			throw error;
		});
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const dir = path.join(root, entry.name);
			try {
				const decoded: unknown = JSON.parse(await fs.readFile(managedDaemonMetaPath(dir), "utf8"));
				if (typeof decoded !== "object" || decoded === null || !("daemon" in decoded) || !("spec" in decoded)) {
					continue;
				}
				const snapshot = parseDaemonSnapshot(decoded.daemon);
				const spec = parseDaemonSpec(decoded.spec);
				const processRef = snapshot.pid === undefined ? null : processHandle(snapshot.pid);
				const wasTerminal = terminalState(snapshot.state);
				const detached =
					spec.detached &&
					!wasTerminal &&
					snapshot.state !== "stopping" &&
					(processRef ? processRef.status() === "running" : snapshot.pid !== undefined && isProcessAlive(snapshot.pid));
				let ownershipUncertain = false;
				if (!detached && !wasTerminal) {
					if (processRef) {
						try {
							await processRef.terminate({ group: true, gracefulMs: 500, timeoutMs: 2_000 });
						} catch (error) {
							logger.debug("Failed to terminate unmanaged daemon process during recovery", {
								name: snapshot.name,
								pid: snapshot.pid,
								error: errorMessage(error),
							});
						}
					} else {
						// Without a native handle, recovery cannot observe descendants. A detached daemon
						// outlives its broker by design; a missing PID also gives no safe group to reap.
						ownershipUncertain = spec.detached || snapshot.pid === undefined || !(await reapOwnedGroup(snapshot.pid));
					}
					snapshot.pid = ownershipUncertain ? snapshot.pid : undefined;
					snapshot.exitedAt = Date.now();
					if (ownershipUncertain) {
						snapshot.state = "failed";
						snapshot.terminatedBy = "broker-recovery";
						snapshot.exitReason =
							"the previous broker exited and its process tree could not be proven gone; it is not restarted, and a replacement needs its ready port free";
					} else {
						snapshot.state = "exited";
						if (spec.detached) {
							// A detached daemon outlives its broker by design, so one that is
							// already gone was not terminated by this replacement. Recording
							// `broker-recovery` here asserted both that the replacement killed
							// it and that it was non-detached, and neither is true.
							snapshot.terminatedBy = "process-exit";
							snapshot.exitReason = "exited while no broker was supervising it";
						} else {
							snapshot.terminatedBy = "broker-recovery";
							snapshot.exitReason =
								"the previous broker exited; its replacement terminated this non-detached daemon";
						}
					}
					snapshot.ownershipUncertain = ownershipUncertain || undefined;
				} else if (wasTerminal) {
					snapshot.pid = undefined;
				}
				snapshot.persist = spec.persist;
				snapshot.detached = spec.detached;
				if (this.#cleanupWaitMs > 0 && terminalState(snapshot.state) && !snapshot.ownershipUncertain) {
					const exitedAt = snapshot.exitedAt ?? Date.now();
					if (Date.now() - exitedAt >= this.#cleanupWaitMs) {
						await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
						continue;
					}
				}
				const record: ManagedDaemon = {
					spec,
					snapshot,
					tree: detached ? new ProcessTree(snapshot.pid, processRef) : undefined,
					dir,
					generation: 0,
					stopRequested: !detached || snapshot.state === "stopping",
					logReady: detached && (!spec.ready?.log || snapshot.state === "ready"),
					portReady: detached && (spec.ready?.port === undefined || snapshot.state === "ready"),
					readinessBuffer: "",
					outputOffset: detached ? snapshot.outputBytes : 0,
					readyPattern: spec.ready?.log ? new RegExp(spec.ready.log, "u") : undefined,
					consecutiveFailures: 0,
					persistQueue: Promise.resolve(),
				};
				syncReadyPending(record);
				this.#records.set(snapshot.name, record);
				if (record.tree && !terminalState(snapshot.state)) this.#startSampler(record, record.generation);
				if (detached && spec.ready?.port !== undefined && snapshot.state !== "ready") {
					void this.#pollPort(record, record.generation, spec.ready);
				}
				// A daemon the dead broker never settled never got a completion
				// record; the recovery kill above IS its terminal transition, so
				// retain it here. One already terminal on disk was recorded by the
				// broker that settled it.
				if (!detached && !wasTerminal) this.#queueCompletion(record);
				if (terminalState(snapshot.state) && !snapshot.ownershipUncertain) {
					this.#scheduleCleanup(record);
				}
				persist(record);
			} catch (error) {
				logger.warn("Failed to recover daemon record", {
					name: entry.name,
					error: errorMessage(error),
				});
			}
		}
	}

	#scheduleIdleShutdown(): void {
		if (this.#shuttingDown || this.#clients.size > 0) return;
		clearTimeout(this.#idleTimer);
		this.#idleTimer = setTimeout(() => {
			this.#idleTimer = undefined;
			void (async () => {
				if (this.#clients.size > 0 || this.#shuttingDown) return;
				// Presence protects running daemons, not an empty broker for every
				// project a long-lived Main has ever contacted.
				const liveDaemon = Array.from(this.#records.values()).some(
					record => !record.spec.detached && !terminalState(record.snapshot.state),
				);
				if (liveDaemon && (await hasLiveDaemonProjectPresence(this.#runtimeDir))) {
					this.#scheduleIdleShutdown();
					return;
				}
				if (this.#clients.size > 0 || this.#shuttingDown) return;
				const livePersistent = Array.from(this.#records.values()).some(
					record => record.spec.persist && !terminalState(record.snapshot.state),
				);
				if (!livePersistent) {
					await this.shutdown({
						owner: "idle-reaper",
						reason:
							"the last tool socket disconnected and the idle grace elapsed with no persistent daemon and no running daemon protected by live project presence",
						at: Date.now(),
					});
					return;
				}
				// A persistent sibling keeps the broker alive, not the
				// `last-client-exit` daemons beside it: those end with the last
				// client, as their lifetime states. The reaper then re-arms so the
				// broker exits once the persistent daemon is gone too.
				const reapAt = Date.now();
				for (const record of this.#records.values()) {
					if (record.spec.persist || record.spec.detached || terminalState(record.snapshot.state)) continue;
					await this.#stopRecord(record, 2_000, {
						owner: "idle-reaper",
						reason:
							"the last veyyon client disconnected and the idle grace elapsed; its lifetime is last-client-exit, so it was stopped while a persistent daemon kept the broker alive",
						signal: "SIGTERM",
						at: reapAt,
					});
				}
				this.#scheduleIdleShutdown();
			})();
		}, this.#idleGraceMs);
	}
}

function persist(record: ManagedDaemon): void {
	const metaPath = managedDaemonMetaPath(record.dir);
	record.persistQueue = record.persistQueue
		.then(() => atomicWriteFile(metaPath, JSON.stringify({ daemon: record.snapshot, spec: record.spec })))
		.catch(error => {
			logger.warn("Failed to persist daemon metadata", {
				name: record.snapshot.name,
				error: errorMessage(error),
			});
		});
}

/** Start the detached per-project daemon broker selected by the CLI worker host. */
export async function startDaemonBrokerFromEnvironment(): Promise<void> {
	const projectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const runtimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	if (!projectDir || !runtimeDir) throw new Error("Daemon broker environment is incomplete");
	delete process.env[DAEMON_PROJECT_DIR_ENV];
	delete process.env[DAEMON_RUNTIME_DIR_ENV];
	const rawGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	delete process.env[DAEMON_IDLE_GRACE_ENV];
	const parsedGrace = rawGrace === undefined ? DEFAULT_IDLE_GRACE_MS : Number.parseInt(rawGrace, 10);
	const idleGraceMs = Number.isFinite(parsedGrace) && parsedGrace >= 0 ? parsedGrace : DEFAULT_IDLE_GRACE_MS;
	const rawCleanup = process.env[DAEMON_CLEANUP_WAIT_ENV];
	delete process.env[DAEMON_CLEANUP_WAIT_ENV];
	const parsedCleanup = rawCleanup === undefined ? DEFAULT_CLEANUP_WAIT_MS : Number.parseInt(rawCleanup, 10);
	const cleanupWaitMs = Number.isFinite(parsedCleanup) && parsedCleanup >= 0 ? parsedCleanup : DEFAULT_CLEANUP_WAIT_MS;
	await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	const lease = await acquireBrokerLease(runtimeDir);
	if (!lease) return;
	process.title = "veyyon daemon broker";
	const token = (await fs.readFile(daemonBrokerTokenPath(runtimeDir), "utf8")).trim();
	if (!token) throw new Error("Daemon broker token is empty");
	const broker = new DaemonBroker(projectDir, runtimeDir, token, idleGraceMs, cleanupWaitMs);
	const cancelCleanup = postmortem.register("daemon-broker", () => broker.shutdown());
	// Reclaim sibling daemon scopes left behind by dead brokers (issue #8674).
	// Detached and non-throwing so it never delays clients connecting to us.
	void pruneDeadDaemonRuntimeDirs(runtimeDir).catch(error => {
		logger.warn("Daemon runtime prune failed", {
			error: errorMessage(error),
		});
	});
	try {
		await broker.run();
	} finally {
		cancelCleanup();
		await releaseBrokerLease(lease);
	}
}
