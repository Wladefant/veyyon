/**
 * Observable receipt, auth behavior, and registered CLI smoke contract tests
 * for `terminal-control rotate <session-id>`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord } from "@veyyon/utils";
import { commands, resolveCliArgv } from "../../src/cli-commands";
import {
	discoverTerminalOwner,
	isValidTerminalOwnerRecord,
	sendTerminalControlRotate,
	stripSecrets,
} from "../../src/launch/terminal-control-client";
import {
	serveTerminalControl,
	type TerminalControlTarget,
	type TerminalOwner,
} from "../../src/launch/terminal-control";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const cliEntry = path.join(repoRoot, "src", "cli.ts");

interface SpawnResult {
	code: number;
	stdout: string;
	stderr: string;
}

async function runCli(args: string[], extraEnv?: Record<string, string>): Promise<SpawnResult> {
	const { home, env, cleanup } = hermeticSpawnEnv(extraEnv);
	try {
		const spawnEnv: Record<string, string | undefined> = {
			...env,
			...(process.platform === "win32" ? { USERPROFILE: home } : {}),
			...extraEnv,
		};
		const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
			env: spawnEnv,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, stdout, stderr };
	} finally {
		cleanup();
	}
}

async function readOwnerRecord(root: string): Promise<TerminalOwner> {
	const directory = path.join(root, "run", "terminals");
	const files = (await fs.readdir(directory)).filter(name => name.endsWith(".json"));
	if (files.length === 0) {
		throw new Error("No terminal owner discovery record found");
	}
	const content = await fs.readFile(path.join(directory, files[0]!), "utf8");
	const parsed = JSON.parse(content);
	if (!isValidTerminalOwnerRecord(parsed)) {
		throw new Error("Invalid terminal owner record read from directory");
	}
	return parsed;
}

async function pingEndpoint(
	owner: { endpoint: string; token: string; sessionId: string },
	bound = 5_000,
): Promise<{ ok: boolean; result?: unknown; error?: unknown }> {
	const { promise, resolve } = Promise.withResolvers<{ ok: boolean; result?: unknown; error?: unknown }>();
	const socket = net.createConnection(owner.endpoint);

	socket.setTimeout(bound, () => {
		socket.destroy();
		resolve({ ok: false, error: "timeout" });
	});

	let buffer = "";
	socket.setEncoding("utf8");

	socket.on("connect", () => {
		const frame = JSON.stringify({
			version: 1,
			id: `ping-${crypto.randomUUID()}`,
			token: owner.token,
			sessionId: owner.sessionId,
			op: "ping",
		});
		socket.write(`${frame}\n`);
	});

	socket.on("data", chunk => {
		buffer += chunk;
		const idx = buffer.indexOf("\n");
		if (idx >= 0) {
			socket.destroy();
			try {
				const res = JSON.parse(buffer.slice(0, idx));
				if (isRecord(res)) {
					resolve({ ok: res.ok === true, result: res.result, error: res.error });
					return;
				}
			} catch {
				// fallthrough
			}
			resolve({ ok: false, error: "invalid frame" });
		}
	});

	socket.on("error", () => {
		socket.destroy();
		resolve({ ok: false, error: "socket error" });
	});

	socket.on("close", () => {
		resolve({ ok: false, error: "closed" });
	});

	return promise;
}

describe("terminal-control CLI and owner discovery client", () => {
	let tempDir: string;
	let terminalsDir: string;
	const cleanupServers: Array<net.Server | (() => void | Promise<void>)> = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "term-ctrl-test-"));
		terminalsDir = path.join(tempDir, "run", "terminals");
		await fs.mkdir(terminalsDir, { recursive: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const close of cleanupServers.splice(0)) {
			try {
				if (typeof close === "function") {
					await close();
				} else {
					close.close();
				}
			} catch {
				// ignore cleanup error
			}
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	describe("record validation and secret sanitization", () => {
		it("validates well-formed discovery records", () => {
			const valid = {
				version: 1,
				sessionId: "sess-abc-123",
				pid: process.pid,
				cwd: "/workspace",
				sessionFile: "/workspace/session.jsonl",
				endpoint: "\\\\.\\pipe\\term-123",
				token: "abcdef1234567890abcdef1234567890",
			};
			expect(isValidTerminalOwnerRecord(valid)).toBe(true);
		});

		it("rejects malformed discovery records with missing or invalid fields", () => {
			expect(isValidTerminalOwnerRecord(null)).toBe(false);
			expect(isValidTerminalOwnerRecord({})).toBe(false);
			expect(
				isValidTerminalOwnerRecord({
					version: 2,
					sessionId: "sess-1",
					pid: 123,
					cwd: "/a",
					sessionFile: "/a",
					endpoint: "/sock",
					token: "tok",
				}),
			).toBe(false);
			expect(
				isValidTerminalOwnerRecord({
					version: 1,
					sessionId: "invalid/session/id",
					pid: 123,
					cwd: "/a",
					sessionFile: "/a",
					endpoint: "/sock",
					token: "tok",
				}),
			).toBe(false);
			expect(
				isValidTerminalOwnerRecord({
					version: 1,
					sessionId: "sess-1",
					pid: -1,
					cwd: "/a",
					sessionFile: "/a",
					endpoint: "/sock",
					token: "tok",
				}),
			).toBe(false);
			expect(
				isValidTerminalOwnerRecord({
					version: 1,
					sessionId: "sess-1",
					pid: 123,
					cwd: "",
					sessionFile: "/a",
					endpoint: "/sock",
					token: "tok",
				}),
			).toBe(false);
			expect(
				isValidTerminalOwnerRecord({
					version: 1,
					sessionId: "sess-1",
					pid: 123,
					cwd: "/a",
					sessionFile: "/a",
					endpoint: "",
					token: "tok",
				}),
			).toBe(false);
			expect(
				isValidTerminalOwnerRecord({
					version: 1,
					sessionId: "sess-1",
					pid: 123,
					cwd: "/a",
					sessionFile: "/a",
					endpoint: "/sock",
					token: "",
				}),
			).toBe(false);
		});

		it("redacts secret tokens from text without reflecting raw token", () => {
			const token = "super-secret-auth-token-9999";
			const raw = `Failed to process request with credential ${token}`;
			const sanitized = stripSecrets(raw, [token]);
			expect(sanitized === "Failed to process request with credential [REDACTED]").toBe(true);
			expect(sanitized.includes(token)).toBe(false);
		});
	});

	describe("owner discovery", () => {
		it("discovers single live owner matching session ID", async () => {
			const recordPath = path.join(terminalsDir, `${process.pid}-nonce1.json`);
			const owner = {
				version: 1 as const,
				sessionId: "sess-target-1",
				pid: process.pid,
				cwd: tempDir,
				sessionFile: path.join(tempDir, "s.jsonl"),
				endpoint: process.platform === "win32" ? "\\\\.\\pipe\\test-p1" : path.join(tempDir, "p1.sock"),
				token: "token-alpha",
			};
			await fs.writeFile(recordPath, JSON.stringify(owner));

			const discovered = await discoverTerminalOwner("sess-target-1", tempDir);
			expect(discovered.sessionId).toBe("sess-target-1");
			expect(discovered.token === "token-alpha").toBe(true);
		});

		it("rejects absent owners", async () => {
			await expect(discoverTerminalOwner("missing-session", tempDir)).rejects.toThrow(
				'No active terminal owner found for session "missing-session".',
			);
		});

		it("rejects ambiguous owners when multiple live records share session ID", async () => {
			const rec1 = path.join(terminalsDir, `${process.pid}-n1.json`);
			const rec2 = path.join(terminalsDir, `${process.pid}-n2.json`);
			const owner1 = {
				version: 1 as const,
				sessionId: "duplicate-session",
				pid: process.pid,
				cwd: tempDir,
				sessionFile: path.join(tempDir, "s1.jsonl"),
				endpoint: process.platform === "win32" ? "\\\\.\\pipe\\test-p1" : path.join(tempDir, "p1.sock"),
				token: "token-1",
			};
			const owner2 = {
				version: 1 as const,
				sessionId: "duplicate-session",
				pid: process.pid,
				cwd: tempDir,
				sessionFile: path.join(tempDir, "s2.jsonl"),
				endpoint: process.platform === "win32" ? "\\\\.\\pipe\\test-p2" : path.join(tempDir, "p2.sock"),
				token: "token-2",
			};
			await fs.writeFile(rec1, JSON.stringify(owner1));
			await fs.writeFile(rec2, JSON.stringify(owner2));

			await expect(discoverTerminalOwner("duplicate-session", tempDir)).rejects.toThrow(
				'Multiple active terminal owners found for session "duplicate-session". Ambiguous owner.',
			);
		});

		it("ignores stale records from dead processes and corrupt files", async () => {
			const corruptPath = path.join(terminalsDir, "corrupt.json");
			await fs.writeFile(corruptPath, "{ invalid json");

			const deadPidPath = path.join(terminalsDir, "999999-dead.json");
			await fs.writeFile(
				deadPidPath,
				JSON.stringify({
					version: 1,
					sessionId: "target-live",
					pid: 99999999,
					cwd: tempDir,
					sessionFile: path.join(tempDir, "dead.jsonl"),
					endpoint: "/sock",
					token: "tok",
				}),
			);

			const livePath = path.join(terminalsDir, `${process.pid}-live.json`);
			await fs.writeFile(
				livePath,
				JSON.stringify({
					version: 1,
					sessionId: "target-live",
					pid: process.pid,
					cwd: tempDir,
					sessionFile: path.join(tempDir, "live.jsonl"),
					endpoint: "/live.sock",
					token: "live-token",
				}),
			);

			const discovered = await discoverTerminalOwner("target-live", tempDir);
			expect(discovered.token === "live-token").toBe(true);
		});
	});

	describe("authenticated rotation request protocol", () => {
		async function createMockServer(handler: (req: Record<string, unknown>, socket: net.Socket) => void) {
			const { promise, resolve } = Promise.withResolvers<string>();
			const nonce = crypto.randomUUID();
			const endpoint =
				process.platform === "win32"
					? `\\\\.\\pipe\\mock-term-${nonce}`
					: path.join(tempDir, `mock-${nonce}.sock`);

			const server = net.createServer(socket => {
				socket.setEncoding("utf8");
				let buffer = "";
				socket.on("data", chunk => {
					buffer += chunk;
					const idx = buffer.indexOf("\n");
					if (idx >= 0) {
						const line = buffer.slice(0, idx);
						const parsed = JSON.parse(line);
						if (isRecord(parsed)) {
							handler(parsed, socket);
						}
					}
				});
			});

			cleanupServers.push(server);
			server.listen(endpoint, () => resolve(endpoint));
			return { endpoint: await promise, server };
		}

		it("sends authenticated rotate frame and receives { rotated: true } receipt", async () => {
			let receivedReq: Record<string, unknown> | undefined;
			const { endpoint } = await createMockServer((req, socket) => {
				receivedReq = req;
				const id = typeof req.id === "string" ? req.id : "";
				socket.write(`${JSON.stringify({ id, ok: true, result: { rotated: true } })}\n`);
			});

			const owner = {
				version: 1 as const,
				sessionId: "sess-rot-1",
				pid: process.pid,
				cwd: tempDir,
				sessionFile: path.join(tempDir, "s.jsonl"),
				endpoint,
				token: "bearer-token-12345",
				loadedVersion: "1.5.8",
				loadedBuildSha: null,
				capabilities: ["deliver-ack", "session-notices", "rotate"],
			};

			const result = await sendTerminalControlRotate(owner);
			expect(result).toEqual({ rotated: true });
			expect(receivedReq).toBeDefined();
			expect(receivedReq?.version).toBe(1);
			expect(receivedReq?.sessionId).toBe("sess-rot-1");
			expect(receivedReq?.token === "bearer-token-12345").toBe(true);
			expect(receivedReq?.op).toBe("rotate");
		});

		it("returns fixed rotation failed error on peer rejection without reflecting arbitrary payload", async () => {
			const { endpoint } = await createMockServer((req, socket) => {
				const id = typeof req.id === "string" ? req.id : "";
				socket.write(
					`${JSON.stringify({
						id,
						ok: false,
						error: "arbitrary-server-error-string",
					})}\n`,
				);
			});

			const owner = {
				version: 1 as const,
				sessionId: "sess-fail-1",
				pid: process.pid,
				cwd: tempDir,
				sessionFile: path.join(tempDir, "s.jsonl"),
				endpoint,
				token: "secret-bearer-credential",
				loadedVersion: "1.5.8",
				loadedBuildSha: null,
				capabilities: ["deliver-ack", "session-notices", "rotate"],
			};

			await expect(sendTerminalControlRotate(owner)).rejects.toThrow("Terminal control rotation failed");
		});

		it("rejects when server response does not contain rotated: true", async () => {
			const { endpoint } = await createMockServer((req, socket) => {
				const id = typeof req.id === "string" ? req.id : "";
				socket.write(`${JSON.stringify({ id, ok: true, result: { rotated: false } })}\n`);
			});

			const owner = {
				version: 1 as const,
				sessionId: "sess-bad-res",
				pid: process.pid,
				cwd: tempDir,
				sessionFile: path.join(tempDir, "s.jsonl"),
				endpoint,
				token: "tok",
				loadedVersion: "1.5.8",
				loadedBuildSha: null,
				capabilities: ["deliver-ack", "session-notices", "rotate"],
			};

			await expect(sendTerminalControlRotate(owner)).rejects.toThrow(
				"Unexpected terminal control rotation response; expected { rotated: true }",
			);
		});
	});

	describe("registered CLI smoke contract against real server and parser", () => {
		it("routes terminal-control through resolveCliArgv as a first-class subcommand", () => {
			const resolved = resolveCliArgv(["terminal-control", "rotate", "sess-1"]);
			expect(resolved).toEqual({
				argv: ["terminal-control", "rotate", "sess-1"],
			});
		});

		it("is registered in top-level commands table", () => {
			const entry = commands.find(e => e.name === "terminal-control");
			expect(entry).toBeDefined();
			expect(entry?.summary?.description).toContain("Rotate");
		});

		it("rotates credentials through runCli, emitting only redacted receipt, changing token, and enabling new ping", async () => {
			const hermeticHome = await fs.mkdtemp(path.join(os.tmpdir(), "tcs-"));
			const profileRoot = path.join(hermeticHome, ".veyyon", "profiles", "default");
			await fs.mkdir(path.join(profileRoot, "run", "terminals"), { recursive: true });

			const sessionId = "smoke-live-session";
			const target: TerminalControlTarget = {
				identity: () => ({
					sessionId,
					cwd: profileRoot,
					sessionFile: path.join(profileRoot, `${sessionId}.jsonl`),
				}),
				deliver: async () => "delivered",
				abort: async () => false,
				history: () => [{ entryId: "e1", text: "initial" }],
				subscribe: () => () => {},
			};

			const closeServer = await serveTerminalControl(target, profileRoot);
			cleanupServers.push(closeServer);

			const initialOwner = await readOwnerRecord(profileRoot);
			const initialToken = initialOwner.token;

			const initialPing = await pingEndpoint(initialOwner);
			expect(initialPing.ok).toBe(true);

			const spawnEnv: Record<string, string> = {
				HOME: hermeticHome,
				USERPROFILE: hermeticHome,
				NO_COLOR: "1",
			};

			const result = await runCli(["terminal-control", "rotate", sessionId], spawnEnv);

			expect(result.code).toBe(0);
			expect(result.stdout.trim() === "Rotation succeeded.").toBe(true);
			expect(result.stdout.includes(initialToken)).toBe(false);
			expect(result.stderr === "").toBe(true);

			const updatedOwner = await readOwnerRecord(profileRoot);
			expect(updatedOwner.token !== initialToken).toBe(true);
			expect(typeof updatedOwner.token).toBe("string");
			expect(updatedOwner.token.length).toBeGreaterThan(0);
			expect(result.stdout.includes(updatedOwner.token)).toBe(false);

			const newPing = await pingEndpoint(updatedOwner);
			expect(newPing.ok).toBe(true);

			const oldTokenPing = await pingEndpoint({ ...updatedOwner, token: initialToken });
			expect(oldTokenPing.ok).toBe(false);

			await fs.rm(hermeticHome, { recursive: true, force: true });
		}, 60_000);

		it("rejects absent session with failure exit code and clean error through runCli", async () => {
			const hermeticHome = await fs.mkdtemp(path.join(os.tmpdir(), "term-smoke-absent-"));
			const spawnEnv: Record<string, string> = {
				HOME: hermeticHome,
				USERPROFILE: hermeticHome,
				NO_COLOR: "1",
			};

			const result = await runCli(["terminal-control", "rotate", "non-existent-session"], spawnEnv);

			expect(result.code).toBe(1);
			expect(result.stderr).toContain('No active terminal owner found for session "non-existent-session"');
			expect(result.stdout.trim() === "").toBe(true);

			await fs.rm(hermeticHome, { recursive: true, force: true });
		}, 60_000);

		it("rejects unknown action with usage error through runCli", async () => {
			const result = await runCli(["terminal-control", "unknown-action", "sess-1"]);
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("Error:");
		}, 60_000);

		it("rejects unexpected token flag options through runCli", async () => {
			const result = await runCli(["terminal-control", "rotate", "sess-1", "--token", "secret"]);
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("Error:");
		}, 60_000);
	});
});
