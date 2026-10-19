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

interface ParsedBrokerPipeSecurity {
	constructorSecurityAssignment: string;
	pipeCreationSecurityArg: string;
	owner: string;
	ownerSource: string;
	isProtected: boolean;
	preserveInheritance: boolean;
	rules: Array<{
		identityVar: string;
		sidType: string;
		rights: string;
		type: string;
	}>;
	sddl: string;
}

function parseBrokerPipeSecurity(brokerScript: string): ParsedBrokerPipeSecurity {
	const ctorMatch = brokerScript.match(
		/public\s+VeyyonTerminalPipeBroker\s*\([^)]*\)\s*\{([\s\S]*?)\}/,
	);
	if (!ctorMatch) {
		throw new Error("VeyyonTerminalPipeBroker constructor not found in broker script");
	}
	const ctorBody = ctorMatch[1];
	const ctorSecAssign = ctorBody.match(/_pipeSecurity\s*=\s*([^;]+?);/);
	const constructorSecurityAssignment = ctorSecAssign ? ctorSecAssign[1].trim() : "";

	const instanceMatch = brokerScript.match(/new\s+NamedPipeServerStream\s*\(([\s\S]*?)\);/);
	if (!instanceMatch) {
		throw new Error("NamedPipeServerStream instantiation not found in broker script");
	}
	const instanceArgs = instanceMatch[1]
		.split(",")
		.map(arg => arg.trim());
	const pipeCreationSecurityArg = instanceArgs[7] ?? "";

	const createSecurityMatch = brokerScript.match(
		/private\s+static\s+PipeSecurity\s+CreateSecurity\s*\(\)\s*\{([\s\S]*?)\n\s*return\s+security;\s*\}/,
	);
	if (!createSecurityMatch) {
		throw new Error("CreateSecurity method body not found in broker script");
	}
	const secBody = createSecurityMatch[1];

	const identMatch = secBody.match(/var\s+identity\s*=\s*([^;]+?);/);
	const ownerSource = identMatch ? identMatch[1].trim() : "";

	const sidVarMap: Record<string, string> = {};
	const sidDefRegex = /var\s+(\w+)\s*=\s*new\s+SecurityIdentifier\s*\(\s*([^,\s]+)\s*,\s*[^)]+\s*\);/g;
	let sidMatch: RegExpExecArray | null;
	while ((sidMatch = sidDefRegex.exec(secBody)) !== null) {
		sidVarMap[sidMatch[1]] = sidMatch[2];
	}
	const ownerMatch = secBody.match(/security\.SetOwner\s*\(\s*([^)]+?)\s*\);/);
	const owner = ownerMatch ? ownerMatch[1].trim() : "";

	const protMatch = secBody.match(/security\.SetAccessRuleProtection\s*\(\s*([^,\s]+)\s*,\s*([^)\s]+)\s*\);/);
	const isProtected = protMatch ? protMatch[1] === "true" : false;
	const preserveInheritance = protMatch ? protMatch[2] === "true" : true;

	const ruleRegex = /security\.AddAccessRule\s*\(\s*new\s+PipeAccessRule\s*\(([\s\S]*?)\)\s*\);/g;
	const rules: Array<{ identityVar: string; sidType: string; rights: string; type: string }> = [];
	let match: RegExpExecArray | null;
	while ((match = ruleRegex.exec(secBody)) !== null) {
		const ruleArgs = match[1].split(",").map(a => a.trim());
		const identityVar = ruleArgs[0] ?? "";
		let sidType = "unknown";
		if (identityVar === "identity") {
			sidType = ownerSource;
		} else if (identityVar in sidVarMap) {
			sidType = sidVarMap[identityVar];
		}
		rules.push({
			identityVar,
			sidType,
			rights: ruleArgs[1] ?? "",
			type: ruleArgs[2] ?? "",
		});
	}

	const sddlProtection = isProtected && !preserveInheritance ? "P" : "";
	const sddlAces = rules
		.map(r => {
			const typeCode = r.type === "AccessControlType.Allow" ? "A" : "D";
			const rightsCode = r.rights === "PipeAccessRights.FullControl" ? "GA" : "UNKNOWN";
			let sidCode = "UNKNOWN";
			if (r.identityVar === "identity" && r.sidType.includes("WindowsIdentity.GetCurrent().User")) {
				sidCode = "identity";
			} else if (r.sidType.includes("LocalSystemSid")) {
				sidCode = "SY";
			} else if (r.sidType.includes("WorldSid")) {
				sidCode = "WD";
			} else if (r.sidType.includes("AnonymousSid")) {
				sidCode = "AN";
			} else if (r.sidType.includes("AuthenticatedUserSid")) {
				sidCode = "AU";
			}
			return `(${typeCode};;${rightsCode};;;${sidCode})`;
		})
		.join("");
	const sddl = `D:${sddlProtection}${sddlAces}`;

	return {
		constructorSecurityAssignment,
		pipeCreationSecurityArg,
		owner,
		ownerSource,
		isProtected,
		preserveInheritance,
		rules,
		sddl,
	};
}

function validateBrokerPipeSecurity(parsed: ParsedBrokerPipeSecurity): void {
	if (parsed.constructorSecurityAssignment !== "CreateSecurity()") {
		throw new Error(
			`Broker constructor must assign _pipeSecurity = CreateSecurity(), got: ${parsed.constructorSecurityAssignment}`,
		);
	}
	if (parsed.pipeCreationSecurityArg !== "_pipeSecurity") {
		throw new Error(`NamedPipeServerStream must receive _pipeSecurity, got: ${parsed.pipeCreationSecurityArg}`);
	}
	if (parsed.owner !== "identity" || !parsed.ownerSource.includes("WindowsIdentity.GetCurrent().User")) {
		throw new Error(`PipeSecurity owner must resolve to WindowsIdentity.GetCurrent().User, got: ${parsed.ownerSource}`);
	}
	if (!parsed.isProtected || parsed.preserveInheritance) {
		throw new Error(
			`PipeSecurity must enforce protected DACL without inheritance, got isProtected=${parsed.isProtected}, preserveInheritance=${parsed.preserveInheritance}`,
		);
	}
	if (parsed.rules.length !== 2) {
		throw new Error(`Expected exactly 2 access rules (owner and SYSTEM), got ${parsed.rules.length}`);
	}
	const [ownerRule, systemRule] = parsed.rules;
	if (
		ownerRule.identityVar !== "identity" ||
		!ownerRule.sidType.includes("WindowsIdentity.GetCurrent().User") ||
		ownerRule.rights !== "PipeAccessRights.FullControl" ||
		ownerRule.type !== "AccessControlType.Allow"
	) {
		throw new Error(`Invalid owner rule: ${JSON.stringify(ownerRule)}`);
	}
	if (
		systemRule.identityVar !== "systemSid" ||
		!systemRule.sidType.includes("WellKnownSidType.LocalSystemSid") ||
		systemRule.rights !== "PipeAccessRights.FullControl" ||
		systemRule.type !== "AccessControlType.Allow"
	) {
		throw new Error(`Invalid system rule (must be LocalSystemSid): ${JSON.stringify(systemRule)}`);
	}
	if (parsed.sddl !== "D:P(A;;GA;;;identity)(A;;GA;;;SY)") {
		throw new Error(`SDDL does not match expected DACL: ${parsed.sddl}`);
	}
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

	it("verifies real Windows broker creates pipe with protected owner-only and SYSTEM FullControl ACL", async () => {
		const fakeChild = createFakeChild();
		const spawnCalls: FakeSpawnCall[] = [];
		const mockSpawn = ((command: string, args: string[], options: FakeSpawnCall["options"]) => {
			spawnCalls.push({ command, args, options });
			return fakeChild;
		}) as unknown as typeof spawn;

		const serverPromise = createWindowsPipeTransport(
			"\\\\.\\pipe\\veyyon-pipe-acl-verification",
			() => {},
			{
				spawnProcess: mockSpawn,
				systemRoot: "C:\\Windows",
				readinessTimeoutMs: 1000,
			},
		);

		fakeChild.stdout.write("READY veyyon-pipe-acl-verification\n");
		const server = await serverPromise;
		cleanupActions.push(() => server.close());

		expect(spawnCalls.length).toBe(1);
		const brokerScript = spawnCalls[0].args[6];
		expect(brokerScript).toBeDefined();

		const parsed = parseBrokerPipeSecurity(brokerScript);
		expect(parsed.constructorSecurityAssignment).toBe("CreateSecurity()");
		expect(parsed.pipeCreationSecurityArg).toBe("_pipeSecurity");
		expect(parsed.owner).toBe("identity");
		expect(parsed.ownerSource).toContain("WindowsIdentity.GetCurrent().User");
		expect(parsed.isProtected).toBe(true);
		expect(parsed.preserveInheritance).toBe(false);
		expect(parsed.rules).toEqual([
			{
				identityVar: "identity",
				sidType: parsed.ownerSource,
				rights: "PipeAccessRights.FullControl",
				type: "AccessControlType.Allow",
			},
			{
				identityVar: "systemSid",
				sidType: "WellKnownSidType.LocalSystemSid",
				rights: "PipeAccessRights.FullControl",
				type: "AccessControlType.Allow",
			},
		]);
		expect(parsed.sddl).toBe("D:P(A;;GA;;;identity)(A;;GA;;;SY)");

		expect(() => validateBrokerPipeSecurity(parsed)).not.toThrow();

		// Mutation 1: removing CreateSecurity and using default pipe descriptor in CreateInstance must fail
		const defaultDescriptorScript = brokerScript.replace("_pipeSecurity,", "null,");
		const parsedDefault = parseBrokerPipeSecurity(defaultDescriptorScript);
		expect(() => validateBrokerPipeSecurity(parsedDefault)).toThrow(
			/NamedPipeServerStream must receive _pipeSecurity/,
		);

		// Mutation 2: widening ACL with an extra ACE (e.g. Everyone) must fail
		const widenedScript = brokerScript.replace(
			"return security;",
			'security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.WorldSid, null), PipeAccessRights.Read, AccessControlType.Allow));\n        return security;',
		);
		const parsedWidened = parseBrokerPipeSecurity(widenedScript);
		expect(() => validateBrokerPipeSecurity(parsedWidened)).toThrow(
			/Expected exactly 2 access rules/,
		);

		// Mutation 3: unprotecting DACL or allowing inheritance must fail
		const unprotectScript = brokerScript.replace(
			"security.SetAccessRuleProtection(true, false);",
			"security.SetAccessRuleProtection(false, true);",
		);
		const parsedUnprotected = parseBrokerPipeSecurity(unprotectScript);
		expect(() => validateBrokerPipeSecurity(parsedUnprotected)).toThrow(
			/PipeSecurity must enforce protected DACL without inheritance/,
		);

		// Mutation 4: removing SYSTEM rule must fail
		const noSystemScript = brokerScript.replace(
			/security\.AddAccessRule\(new PipeAccessRule\(\s*systemSid[\s\S]*?\)\);/,
			"",
		);
		const parsedNoSystem = parseBrokerPipeSecurity(noSystemScript);
		expect(() => validateBrokerPipeSecurity(parsedNoSystem)).toThrow(
			/Expected exactly 2 access rules/,
		);

		// Mutation 5: bypassing constructor assignment (_pipeSecurity = null) must fail
		const nullCtorScript = brokerScript.replace(
			"_pipeSecurity = CreateSecurity();",
			"_pipeSecurity = null;",
		);
		const parsedNullCtor = parseBrokerPipeSecurity(nullCtorScript);
		expect(() => validateBrokerPipeSecurity(parsedNullCtor)).toThrow(
			/Broker constructor must assign _pipeSecurity = CreateSecurity\(\)/,
		);

		// Mutation 6: replacing LocalSystemSid with WorldSid must alter SDDL and fail validation
		const worldSidScript = brokerScript.replace(
			"WellKnownSidType.LocalSystemSid",
			"WellKnownSidType.WorldSid",
		);
		const parsedWorldSid = parseBrokerPipeSecurity(worldSidScript);
		expect(parsedWorldSid.sddl).toBe("D:P(A;;GA;;;identity)(A;;GA;;;WD)");
		expect(() => validateBrokerPipeSecurity(parsedWorldSid)).toThrow(
			/Invalid system rule \(must be LocalSystemSid\)/,
		);
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
	}

	if (process.platform === "win32") {
		it("runs real Windows named pipe broker with owner and SYSTEM ACL and verifies same-user delivery", async () => {
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
			expect(aclResult.Rules.length).toBe(2);
			expect(identity.exitCode, identity.stderr).toBe(0);
			const identityMatch = identity.stdout.match(/"[^"]+","(S-1-[^"]+)"/);
			expect(identityMatch, identity.stdout).not.toBeNull();
			const currentUserSid = identityMatch?.[1];
			expect(aclResult.Owner).toBe(currentUserSid);
			expect(aclResult.Rules).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						Identity: currentUserSid,
						Rights: "FullControl",
						Type: "Allow",
					}),
					expect.objectContaining({
						Identity: "S-1-5-18",
						Rights: "FullControl",
						Type: "Allow",
					}),
				]),
			);

			server.close();
		});
	}
});
