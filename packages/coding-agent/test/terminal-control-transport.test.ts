import { afterEach, describe, expect, it, vi } from "bun:test";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import {
	createPosixSocketServer,
	createTerminalControlTransport,
	createWindowsPipeTransport,
	type TerminalControlServer,
	type TerminalSocket,
} from "../src/launch/terminal-control-transport";

interface FakeChildProcess extends EventEmitter {
	stdin: PassThrough;
	stdout: PassThrough;
	stderr: PassThrough;
	killed: boolean;
	killCalls: number;
	kill(): boolean;
}

interface FakeSpawnCall {
	command: string;
	args: string[];
	options: {
		env?: NodeJS.ProcessEnv;
		stdio?: unknown;
		windowsHide?: boolean;
	};
}

function createFakeChild(): FakeChildProcess {
	const child = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		killed: false,
		killCalls: 0,
		kill(): boolean {
			child.killed = true;
			child.killCalls += 1;
			child.emit("exit", 0, "SIGTERM");
			return true;
		},
	});
	return child;
}

const cleanupActions: Array<() => void | Promise<void>> = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanupActions.splice(0).reverse()) {
		try {
			await cleanup();
		} catch {}
	}
});

describe("terminal-control-transport", () => {
	it("establishes Windows pipe transport, frames multiplexed data, and handles client lifecycle", async () => {
		const fakeChild = createFakeChild();
		const spawnCalls: FakeSpawnCall[] = [];
		const mockSpawn = ((command: string, args: string[], options: FakeSpawnCall["options"]) => {
			spawnCalls.push({ command, args, options });
			return fakeChild;
		}) as unknown as typeof spawn;

		const connectedSockets: TerminalSocket[] = [];
		const serverPromise = createWindowsPipeTransport(
			"\\\\.\\pipe\\veyyon-terminal-test-uuid",
			socket => {
				connectedSockets.push(socket);
			},
			{
				spawnProcess: mockSpawn,
				systemRoot: "C:\\Windows",
				readinessTimeoutMs: 5000,
			},
		);

		expect(spawnCalls.length).toBe(1);
		expect(spawnCalls[0].command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
		expect(spawnCalls[0].options.windowsHide).toBe(true);
		expect(spawnCalls[0].options.env?.VEYYON_PIPE_NAME).toBe("veyyon-terminal-test-uuid");
		expect(spawnCalls[0].options.env?.SystemRoot).toBe("C:\\Windows");

		fakeChild.stdout.write("READY veyyon-terminal-test-uuid\n");
		const server = await serverPromise;
		cleanupActions.push(() => server.close());

		expect(server.endpoint).toBe("\\\\.\\pipe\\veyyon-terminal-test-uuid");

		fakeChild.stdout.write("C 1\n");
		expect(connectedSockets.length).toBe(1);
		const socket1 = connectedSockets[0];
		expect(socket1.destroyed).toBe(false);
		expect(socket1.writableLength).toBe(0);

		socket1.setEncoding("utf8");
		const receivedData: string[] = [];
		socket1.on("data", chunk => {
			receivedData.push(chunk as string);
		});

		const rawPayload = Buffer.from("hello terminal client 1\n").toString("base64");
		fakeChild.stdout.write(`D 1 ${rawPayload}\n`);
		expect(receivedData).toEqual(["hello terminal client 1\n"]);

		const stdinChunks: string[] = [];
		fakeChild.stdin.on("data", chunk => {
			stdinChunks.push(chunk.toString("utf8"));
		});

		const written = socket1.write("server response to client 1\n");
		expect(written).toBe(true);

		const expectedBase64 = Buffer.from("server response to client 1\n").toString("base64");
		expect(stdinChunks).toEqual([`D 1 ${expectedBase64}\n`]);

		let socket1Closed = false;
		socket1.on("close", () => {
			socket1Closed = true;
		});

		fakeChild.stdout.write("X 1\n");
		expect(socket1Closed).toBe(true);
		expect(socket1.destroyed).toBe(true);

		server.close();
		expect(stdinChunks).toContain("Q\n");
	});

	it("reassembles multi-byte UTF-8 split sequences across chunk boundaries using StringDecoder", async () => {
		const fakeChild = createFakeChild();
		const mockSpawn = (() => fakeChild) as unknown as typeof spawn;

		const connectedSockets: TerminalSocket[] = [];
		const serverPromise = createWindowsPipeTransport(
			"\\\\.\\pipe\\veyyon-utf8-split",
			socket => {
				connectedSockets.push(socket);
			},
			{
				spawnProcess: mockSpawn,
				systemRoot: "C:\\Windows",
				readinessTimeoutMs: 5000,
			},
		);

		fakeChild.stdout.write("READY veyyon-utf8-split\n");
		const server = await serverPromise;
		cleanupActions.push(() => server.close());

		fakeChild.stdout.write("C 1\n");
		const socket = connectedSockets[0];
		socket.setEncoding("utf8");

		const received: string[] = [];
		socket.on("data", chunk => received.push(chunk as string));

		const fullBytes = Buffer.from("🚀");
		const part1 = fullBytes.subarray(0, 2);
		const part2 = fullBytes.subarray(2);

		fakeChild.stdout.write(`D 1 ${part1.toString("base64")}\n`);
		fakeChild.stdout.write(`D 1 ${part2.toString("base64")}\n`);

		expect(received.join("")).toBe("🚀");

		server.close();
	});

	it("handles multiple concurrent clients independently without crosstalk", async () => {
		const fakeChild = createFakeChild();
		const mockSpawn = (() => fakeChild) as unknown as typeof spawn;

		const connectedSockets: TerminalSocket[] = [];
		const serverPromise = createWindowsPipeTransport(
			"\\\\.\\pipe\\veyyon-multi-client",
			socket => {
				connectedSockets.push(socket);
			},
			{
				spawnProcess: mockSpawn,
				systemRoot: "C:\\Windows",
				readinessTimeoutMs: 5000,
			},
		);

		fakeChild.stdout.write("READY veyyon-multi-client\n");
		const server = await serverPromise;
		cleanupActions.push(() => server.close());

		fakeChild.stdout.write("C 1\n");
		fakeChild.stdout.write("C 2\n");
		expect(connectedSockets.length).toBe(2);

		const [client1, client2] = connectedSockets;
		client1.setEncoding("utf8");
		client2.setEncoding("utf8");

		const client1Messages: string[] = [];
		const client2Messages: string[] = [];
		client1.on("data", chunk => client1Messages.push(chunk as string));
		client2.on("data", chunk => client2Messages.push(chunk as string));

		const msg1 = Buffer.from("message for 1").toString("base64");
		const msg2 = Buffer.from("message for 2").toString("base64");
		fakeChild.stdout.write(`D 1 ${msg1}\n`);
		fakeChild.stdout.write(`D 2 ${msg2}\n`);

		expect(client1Messages).toEqual(["message for 1"]);
		expect(client2Messages).toEqual(["message for 2"]);

		const stdinLines: string[] = [];
		fakeChild.stdin.on("data", chunk => {
			stdinLines.push(chunk.toString("utf8"));
		});

		client1.destroy();
		expect(client1.destroyed).toBe(true);
		expect(client2.destroyed).toBe(false);
		expect(stdinLines).toContain("X 1\n");

		server.close();
		expect(client2.destroyed).toBe(true);
		expect(stdinLines).toContain("Q\n");
	});

	it("rejects readiness if the Windows broker exits prematurely with error diagnostics", async () => {
		const fakeChild = createFakeChild();
		const mockSpawn = (() => fakeChild) as unknown as typeof spawn;

		const serverPromise = createWindowsPipeTransport(
			"\\\\.\\pipe\\veyyon-crash-test",
			() => {},
			{
				spawnProcess: mockSpawn,
				systemRoot: "C:\\Windows",
				readinessTimeoutMs: 5000,
			},
		);

		fakeChild.stderr.write("Access denied creating named pipe security descriptor\n");
		fakeChild.emit("exit", 1, null);

		await expect(serverPromise).rejects.toThrow("Windows named pipe broker exited prematurely with code 1");
	});

	it("rejects readiness if broker readiness timeout elapses", async () => {
		const fakeChild = createFakeChild();
		const mockSpawn = (() => fakeChild) as unknown as typeof spawn;

		const serverPromise = createWindowsPipeTransport(
			"\\\\.\\pipe\\veyyon-timeout-test",
			() => {},
			{
				spawnProcess: mockSpawn,
				systemRoot: "C:\\Windows",
				readinessTimeoutMs: 50,
			},
		);

		await expect(serverPromise).rejects.toThrow("timed out waiting for readiness");
		expect(fakeChild.killCalls).toBeGreaterThan(0);
	});

	it("rejects if trusted Windows SystemRoot is unavailable or not drive-qualified", async () => {
		await expect(
			createWindowsPipeTransport("\\\\.\\pipe\\test", () => {}, { systemRoot: "relative/path" }),
		).rejects.toThrow("trusted drive-qualified Windows system root is unavailable");

		await expect(
			createWindowsPipeTransport("\\\\.\\pipe\\test", () => {}, { systemRoot: "\\\\server\\share" }),
		).rejects.toThrow("trusted drive-qualified Windows system root is unavailable");
	});

	it("never exposes credential tokens in broker arguments or environment", async () => {
		const fakeChild = createFakeChild();
		const spawnCalls: FakeSpawnCall[] = [];
		const mockSpawn = ((command: string, args: string[], options: FakeSpawnCall["options"]) => {
			spawnCalls.push({ command, args, options });
			return fakeChild;
		}) as unknown as typeof spawn;

		const serverPromise = createTerminalControlTransport(
			"\\\\.\\pipe\\veyyon-isolated-token",
			() => {},
			{
				spawnProcess: mockSpawn,
				systemRoot: "C:\\Windows",
				readinessTimeoutMs: 1000,
				forceWindows: true,
			},
		);

		fakeChild.stdout.write("READY veyyon-isolated-token\n");
		const server = await serverPromise;
		cleanupActions.push(() => server.close());

		expect(spawnCalls.length).toBe(1);
		const env = spawnCalls[0].options.env;
		expect(Object.keys(env ?? {})).toEqual(["SystemRoot", "VEYYON_PIPE_NAME"]);
		expect(env?.VEYYON_PIPE_NAME).toBe("veyyon-isolated-token");
		expect(spawnCalls[0].args.join(" ")).not.toContain("token");
	});

	it("notifies onClose listener on unexpected broker termination and invokes immediately if already dead", async () => {
		const fakeChild = createFakeChild();
		const mockSpawn = (() => fakeChild) as unknown as typeof spawn;

		const serverPromise = createWindowsPipeTransport(
			"\\\\.\\pipe\\veyyon-onclose-test",
			() => {},
			{
				spawnProcess: mockSpawn,
				systemRoot: "C:\\Windows",
				readinessTimeoutMs: 5000,
			},
		);

		fakeChild.stdout.write("READY veyyon-onclose-test\n");
		const server = await serverPromise;
		cleanupActions.push(() => server.close());

		let closeCalled = false;
		server.onClose?.(() => {
			closeCalled = true;
		});

		fakeChild.emit("exit", 1, null);
		expect(closeCalled).toBe(true);

		let lateCloseCalled = false;
		server.onClose?.(() => {
			lateCloseCalled = true;
		});
		expect(lateCloseCalled).toBe(true);
	});

	if (process.platform !== "win32") {
		it("runs native POSIX socket server with client round-trip on Unix hosts", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-transport-test-"));
			cleanupActions.push(() => fs.rm(tempDir, { recursive: true, force: true }));
			const socketPath = path.join(tempDir, "control.sock");

			let serverSocket: TerminalSocket | undefined;
			const server = await createPosixSocketServer(socketPath, socket => {
				serverSocket = socket;
			});
			cleanupActions.push(() => server.close());

			const client = net.connect(socketPath);
			cleanupActions.push(() => client.destroy());

			const clientConnected = Promise.withResolvers<void>();
			client.once("connect", () => clientConnected.resolve());
			await clientConnected.promise;

			expect(serverSocket).toBeDefined();
			serverSocket?.setEncoding("utf8");

			const received = Promise.withResolvers<string>();
			serverSocket?.on("data", chunk => {
				received.resolve(chunk as string);
			});

			client.write("posix payload\n");
			expect(await received.promise).toBe("posix payload\n");

			server.close();
		});

		// WHY: issue 580. The socket is the control channel, so it must be owner-only. This checks a real
		// socket's mode and owner, not the source text, because chmod or the owner check can regress unnoticed.
		it("creates the POSIX control socket with mode 0600 owned by the current uid", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-transport-test-"));
			cleanupActions.push(() => fs.rm(tempDir, { recursive: true, force: true }));
			const socketPath = path.join(tempDir, "control.sock");

			const server = await createPosixSocketServer(socketPath, () => {});
			cleanupActions.push(() => server.close());

			const stat = await fs.lstat(socketPath);
			expect(stat.isSocket()).toBe(true);
			expect(stat.mode & 0o777).toBe(0o600);
			const processUid = process.getuid?.();
			expect(processUid).toBeDefined();
			expect(stat.uid).toBe(processUid);
		});
	}

	if (process.platform === "win32") {
		it("runs the real Windows pipe broker with owner-and-SYSTEM ACL and verifies same-user delivery", async () => {
			const pipeName = `veyyon-test-pipe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			const endpoint = `\\\\.\\pipe\\${pipeName}`;

			const connection = Promise.withResolvers<TerminalSocket>();
			const clientFailure = Promise.withResolvers<never>();
			void clientFailure.promise.catch(() => undefined);
			const server = await createWindowsPipeTransport(endpoint, socket => {
				connection.resolve(socket);
			});
			cleanupActions.push(() => server.close());

			const client = net.connect(endpoint);
			cleanupActions.push(() => client.destroy());
			client.once("error", error => {
				clientFailure.reject(new Error("Windows named-pipe client failed", { cause: error }));
			});

			// Real OS and process events cannot use fake timers, so bound each wait with a platform timer.
			const withClientBound = async <T>(promise: Promise<T>, label: string): Promise<T> => {
				const timeout = Promise.withResolvers<never>();
				const timer = setTimeout(() => timeout.reject(new Error(`${label} timed out after 5000ms`)), 5000);
				try {
					return await Promise.race([promise, clientFailure.promise, timeout.promise]);
				} finally {
					clearTimeout(timer);
				}
			};

			const clientConnected = Promise.withResolvers<void>();
			client.once("connect", () => clientConnected.resolve());
			await withClientBound(clientConnected.promise, "Windows named-pipe client connection");
			const serverSocket = await withClientBound(connection.promise, "Windows transport connection callback");
			serverSocket.setEncoding("utf8");

			const received = Promise.withResolvers<string>();
			serverSocket.on("data", chunk => {
				received.resolve(chunk as string);
			});

			client.write("pipe roundtrip test\n");
			expect(await withClientBound(received.promise, "Windows named-pipe payload delivery")).toBe(
				"pipe roundtrip test\n",
			);

			const psCommand = `
$client = [System.IO.Pipes.NamedPipeClientStream]::new('.', '${pipeName}', [System.IO.Pipes.PipeDirection]::InOut)
$client.Connect(2000)
$sec = $client.GetAccessControl()
$owner = $sec.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
$isProtected = $sec.AreAccessRulesProtected
$rules = @($sec.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
    [PSCustomObject]@{
        Identity = $_.IdentityReference.Value
        Rights = $_.PipeAccessRights.ToString()
        Type = $_.AccessControlType.ToString()
    }
})
$client.Dispose()
[PSCustomObject]@{
    Owner = $owner
    IsProtected = $isProtected
    Rules = $rules
} | ConvertTo-Json -Compress
`.trim();

			const powershell = path.win32.join(
				process.env.SystemRoot ?? "C:\\Windows",
				"System32",
				"WindowsPowerShell",
				"v1.0",
				"powershell.exe",
			);
			type ProcessResult = { stdout: string; stderr: string; exitCode: number };
			const runBoundedProcess = (
				command: string,
				args: string[],
				label: string,
			): Promise<ProcessResult> => {
				const result = Promise.withResolvers<ProcessResult>();
				const proc = spawn(command, args, { windowsHide: true });
				let stdout = "";
				let stderr = "";
				let settled = false;
				const timer = setTimeout(() => {
					if (settled) return;
					settled = true;
					try {
						proc.kill();
					} catch {}
					result.reject(new Error(`${label} timed out after 5000ms`));
				}, 5000);
				void clientFailure.promise.catch(() => {
					if (!settled) {
						try {
							proc.kill();
						} catch {}
					}
				});
				const fail = (error: Error): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					result.reject(new Error(`${label} failed: ${error.message}`, { cause: error }));
				};
				proc.stdout.on("data", data => (stdout += data.toString()));
				proc.stderr.on("data", data => (stderr += data.toString()));
				proc.once("error", fail);
				proc.once("close", code => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					result.resolve({ stdout, stderr, exitCode: code ?? -1 });
				});
				return result.promise;
			};
			const cp = await withClientBound(
				runBoundedProcess(
					powershell,
					["-NoProfile", "-NonInteractive", "-Command", psCommand],
					"Pipe ACL query",
				),
				"Pipe ACL query",
			);
			const whoami = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe");
			const identity = await withClientBound(
				runBoundedProcess(whoami, ["/user", "/fo", "csv", "/nh"], "Current-user SID query"),
				"Current-user SID query",
			);

			expect(cp.exitCode, cp.stderr).toBe(0);
			const aclResult = JSON.parse(cp.stdout.trim());
			expect(aclResult.IsProtected).toBe(true);
			expect(identity.exitCode, identity.stderr).toBe(0);
			const identityMatch = identity.stdout.match(/"[^"]+","(S-1-[^"]+)"/);
			expect(identityMatch, identity.stdout).not.toBeNull();
			const currentUserSid = identityMatch?.[1];
			expect(aclResult.Owner).toBe(currentUserSid);
			// The broker grants only the owner and LocalSystem; exact count and values reject extra or missing principals.
			expect(aclResult.Rules).toHaveLength(2);
			expect(aclResult.Rules).toContainEqual({
				Identity: currentUserSid,
				Rights: "FullControl",
				Type: "Allow",
			});
			expect(aclResult.Rules).toContainEqual({
				Identity: "S-1-5-18",
				Rights: "FullControl",
				Type: "Allow",
			});

			server.close();
		});
	}
});
