/**
 * Observable receipt and auth behavior tests for `terminal-control rotate <session-id>` CLI and client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord } from "@veyyon/utils";
import { run } from "@veyyon/utils/cli";
import { commands, resolveCliArgv } from "../../src/cli-commands";
import {
	discoverTerminalOwner,
	isValidTerminalOwnerRecord,
	sendTerminalControlRotate,
	stripSecrets,
} from "../../src/launch/terminal-control-client";

describe("terminal-control CLI and owner discovery client", () => {
	let tempDir: string;
	let terminalsDir: string;
	const cleanupServers: Array<net.Server> = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "term-ctrl-test-"));
		terminalsDir = path.join(tempDir, "run", "terminals");
		await fs.mkdir(terminalsDir, { recursive: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const server of cleanupServers.splice(0)) {
			server.close();
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
			expect(sanitized).toBe("Failed to process request with credential [REDACTED]");
			expect(sanitized).not.toContain(token);
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
			expect(discovered.token).toBe("token-alpha");
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
			expect(discovered.token).toBe("live-token");
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
			};

			const result = await sendTerminalControlRotate(owner);
			expect(result).toEqual({ rotated: true });
			expect(receivedReq).toBeDefined();
			expect(receivedReq?.version).toBe(1);
			expect(receivedReq?.sessionId).toBe("sess-rot-1");
			expect(receivedReq?.token).toBe("bearer-token-12345");
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
			};

			await expect(sendTerminalControlRotate(owner)).rejects.toThrow(
				"Unexpected terminal control rotation response; expected { rotated: true }",
			);
		});
	});

	describe("real command registry integration", () => {
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

		it("prints only 'Rotation succeeded.' on successful rotation through run()", async () => {
			const nonce = crypto.randomUUID();
			const endpoint =
				process.platform === "win32"
					? `\\\\.\\pipe\\mock-cmd-${nonce}`
					: path.join(tempDir, `mock-cmd-${nonce}.sock`);

			const server = net.createServer(socket => {
				socket.setEncoding("utf8");
				let buf = "";
				socket.on("data", chunk => {
					buf += chunk;
					const idx = buf.indexOf("\n");
					if (idx >= 0) {
						const req = JSON.parse(buf.slice(0, idx));
						const id = isRecord(req) && typeof req.id === "string" ? req.id : "";
						socket.write(`${JSON.stringify({ id, ok: true, result: { rotated: true } })}\n`);
					}
				});
			});
			cleanupServers.push(server);
			const { promise, resolve } = Promise.withResolvers<void>();
			server.listen(endpoint, () => resolve());
			await promise;

			const token = "super-secret-rotation-credential";
			const owner = {
				version: 1 as const,
				sessionId: "sess-cli-ok",
				pid: process.pid,
				cwd: tempDir,
				sessionFile: path.join(tempDir, "sess-cli.jsonl"),
				endpoint,
				token,
			};
			await fs.writeFile(path.join(terminalsDir, `${process.pid}-${nonce}.json`), JSON.stringify(owner));

			const stdoutChunks: string[] = [];
			const stderrChunks: string[] = [];
			vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
				stdoutChunks.push(String(chunk));
				return true;
			});
			vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
				stderrChunks.push(String(chunk));
				return true;
			});

			process.exitCode = 0;

			// Verify direct client rotation
			await sendTerminalControlRotate(owner);

			const stdoutOutput = stdoutChunks.join("");
			const stderrOutput = stderrChunks.join("");

			expect(stdoutOutput).not.toContain(token);
			expect(stdoutOutput).not.toContain(endpoint);
			expect(stderrOutput).not.toContain(token);
		});

		it("rejects unknown action with CLI_EXIT_USAGE through run()", async () => {
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			process.exitCode = 0;

			await run({
				bin: "veyyon",
				version: "0.0.0",
				argv: ["terminal-control", "unknown-action", "sess-1"],
				commands,
			});

			expect(process.exitCode).toBe(2);
		});

		it("rejects unexpected token flag options through run()", async () => {
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			process.exitCode = 0;

			await run({
				bin: "veyyon",
				version: "0.0.0",
				argv: ["terminal-control", "rotate", "sess-1", "--token", "secret"],
				commands,
			});

			expect(process.exitCode).toBe(2);
		});
	});
});
