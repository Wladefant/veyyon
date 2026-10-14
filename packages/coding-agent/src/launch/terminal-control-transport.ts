import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface TerminalSocket extends EventEmitter {
	readonly destroyed: boolean;
	readonly writableLength: number;
	setEncoding(encoding: BufferEncoding | string): this;
	write(
		chunk: string | Uint8Array,
		encodingOrCb?: BufferEncoding | ((err?: Error) => void),
		cb?: (err?: Error) => void,
	): boolean;
	destroy(error?: Error): this;
	on(event: "data", listener: (chunk: string | Buffer) => void): this;
	on(event: "error", listener: (err: Error) => void): this;
	on(event: "close", listener: () => void): this;
	on(event: string, listener: (...args: unknown[]) => void): this;
	once(event: "data", listener: (chunk: string | Buffer) => void): this;
	once(event: "error", listener: (err: Error) => void): this;
	once(event: "close", listener: () => void): this;
	once(event: string, listener: (...args: unknown[]) => void): this;
	off(event: string, listener: (...args: unknown[]) => void): this;
	emit(event: string, ...args: unknown[]): boolean;
	removeListener(event: string, listener: (...args: unknown[]) => void): this;
}

export interface TerminalControlServer {
	readonly endpoint: string;
	close(cb?: (err?: Error) => void): void;
	onClose?(listener: () => void): void;
}

export interface TerminalControlTransportOptions {
	spawnProcess?: typeof spawn;
	readinessTimeoutMs?: number;
	systemRoot?: string;
	forceWindows?: boolean;
}

const DEFAULT_READINESS_TIMEOUT_MS = 15_000;
const MAX_STDERR_DIAGNOSTIC_BYTES = 16 * 1024;

export class VirtualTerminalSocket extends EventEmitter implements TerminalSocket {
	readonly clientId: number;
	private _destroyed = false;
	private _writableLength = 0;
	private _decoder?: StringDecoder;
	private readonly _writeFn: (clientId: number, base64: string, cb?: (err?: Error) => void) => boolean;
	private readonly _destroyFn: (clientId: number) => void;

	constructor(
		clientId: number,
		writeFn: (clientId: number, base64: string, cb?: (err?: Error) => void) => boolean,
		destroyFn: (clientId: number) => void,
	) {
		super();
		this.clientId = clientId;
		this._writeFn = writeFn;
		this._destroyFn = destroyFn;
	}

	get destroyed(): boolean {
		return this._destroyed;
	}

	get writableLength(): number {
		return this._destroyed ? 0 : this._writableLength;
	}

	setEncoding(encoding: BufferEncoding | string): this {
		this._decoder = new StringDecoder(encoding as BufferEncoding);
		return this;
	}

	write(
		chunk: string | Uint8Array,
		encodingOrCb?: BufferEncoding | ((err?: Error) => void),
		cb?: (err?: Error) => void,
	): boolean {
		if (this._destroyed) {
			const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
			callback?.(new Error("Socket is destroyed"));
			return false;
		}

		let encoding: BufferEncoding = "utf8";
		let callback: ((err?: Error) => void) | undefined;
		if (typeof encodingOrCb === "function") {
			callback = encodingOrCb;
		} else if (typeof encodingOrCb === "string") {
			encoding = encodingOrCb;
			callback = cb;
		}

		const buf = typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk);
		const base64 = buf.toString("base64");
		this._writableLength += buf.length;

		return this._writeFn(this.clientId, base64, err => {
			this._writableLength = Math.max(0, this._writableLength - buf.length);
			callback?.(err);
		});
	}

	destroy(error?: Error): this {
		if (this._destroyed) return this;
		this._destroyed = true;
		this._destroyFn(this.clientId);
		if (this._decoder) {
			const rest = this._decoder.end();
			if (rest.length > 0) {
				this.emit("data", rest);
			}
		}
		if (error) {
			this.emit("error", error);
		}
		this.emit("close");
		return this;
	}

	_receiveChunk(buf: Buffer): void {
		if (this._destroyed) return;
		const payload = this._decoder ? this._decoder.write(buf) : buf;
		if (!this._decoder || payload.length > 0) {
			this.emit("data", payload);
		}
	}

	_handleRemoteClose(): void {
		if (this._destroyed) return;
		this._destroyed = true;
		if (this._decoder) {
			const rest = this._decoder.end();
			if (rest.length > 0) {
				this.emit("data", rest);
			}
		}
		this.emit("close");
	}
}

const WINDOWS_POWERSHELL_BROKER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$pipeName = $env:VEYYON_PIPE_NAME
if (-not $pipeName) {
    [Console]::Error.WriteLine("ERROR: Missing VEYYON_PIPE_NAME environment variable.")
    exit 1
}

$csharpSource = @'
using System;
using System.Collections.Concurrent;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public class VeyyonTerminalPipeBroker {
    private sealed class ClientSession {
        public readonly int Id;
        public readonly NamedPipeServerStream Stream;
        public readonly object Lock = new object();
        public Task WriteChain = Task.FromResult(true);
        public int PendingBytes = 0;
        public bool Disposed = false;
        public const int MaxPendingBytes = 1024 * 1024;

        public ClientSession(int id, NamedPipeServerStream stream) {
            Id = id;
            Stream = stream;
        }
    }

    private readonly string _pipeName;
    private readonly PipeSecurity _pipeSecurity;
    private readonly ConcurrentDictionary<int, ClientSession> _clients = new ConcurrentDictionary<int, ClientSession>();
    private readonly CancellationTokenSource _cts = new CancellationTokenSource();
    private int _nextClientId = 0;
    private bool _readyEmitted = false;
    private static readonly object _stdoutLock = new object();

    public VeyyonTerminalPipeBroker(string pipeName) {
        _pipeName = pipeName;
        _pipeSecurity = CreateSecurity();
    }

    private static PipeSecurity CreateSecurity() {
        var identity = WindowsIdentity.GetCurrent().User;
        if (identity == null) {
            throw new InvalidOperationException("Failed to resolve current Windows user SID.");
        }
        var systemSid = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);

        var security = new PipeSecurity();
        security.SetOwner(identity);
        security.SetAccessRuleProtection(true, false);

        security.AddAccessRule(new PipeAccessRule(
            identity,
            PipeAccessRights.FullControl,
            AccessControlType.Allow
        ));

        security.AddAccessRule(new PipeAccessRule(
            systemSid,
            PipeAccessRights.FullControl,
            AccessControlType.Allow
        ));

        return security;
    }

    private NamedPipeServerStream CreateInstance() {
        return new NamedPipeServerStream(
            _pipeName,
            PipeDirection.InOut,
            NamedPipeServerStream.MaxAllowedServerInstances,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous,
            65536,
            65536,
            _pipeSecurity,
            HandleInheritability.None
        );
    }

    public void Run() {
        var stdinThread = new Thread(ReadStdinLoop) {
            IsBackground = true,
            Name = "VeyyonStdinReader"
        };
        stdinThread.Start();

        try {
            ListenLoop();
        } catch (Exception ex) {
            if (!_cts.IsCancellationRequested) {
                WriteError("Pipe listener fatal error: " + ex.Message);
                Environment.Exit(2);
            }
        } finally {
            Shutdown();
            stdinThread.Join(1000);
        }
    }

    private void ListenLoop() {
        while (!_cts.IsCancellationRequested) {
            NamedPipeServerStream server = null;
            try {
                server = CreateInstance();
            } catch (Exception ex) {
                WriteError("Pipe creation fatal error: " + ex.Message);
                Environment.Exit(1);
                return;
            }

            if (!_readyEmitted) {
                _readyEmitted = true;
                WriteStdout("READY " + _pipeName);
            }

            try {
                var waitTask = server.WaitForConnectionAsync(_cts.Token);
                waitTask.Wait(_cts.Token);
            } catch (OperationCanceledException) {
                try { server.Dispose(); } catch {}
                break;
            } catch (Exception) {
                try { server.Dispose(); } catch {}
                if (_cts.IsCancellationRequested) break;
                WriteError("Listener connection failure after readiness");
                Environment.Exit(2);
                break;
            }

            if (_cts.IsCancellationRequested) {
                try { server.Dispose(); } catch {}
                break;
            }

            int clientId = Interlocked.Increment(ref _nextClientId);
            var session = new ClientSession(clientId, server);
            _clients[clientId] = session;
            WriteStdout("C " + clientId);

            Task.Run(() => HandleClientAsync(session, _cts.Token));
        }
    }

    private async Task HandleClientAsync(ClientSession session, CancellationToken token) {
        byte[] buffer = new byte[65536];
        try {
            while (!token.IsCancellationRequested && session.Stream.IsConnected && !session.Disposed) {
                int bytesRead = await session.Stream.ReadAsync(buffer, 0, buffer.Length, token);
                if (bytesRead <= 0) break;
                string base64 = Convert.ToBase64String(buffer, 0, bytesRead);
                WriteStdout("D " + session.Id + " " + base64);
            }
        } catch (Exception) {
        } finally {
            CloseClient(session.Id);
        }
    }

    private void CloseClient(int clientId) {
        ClientSession session;
        if (_clients.TryRemove(clientId, out session)) {
            lock (session.Lock) {
                session.Disposed = true;
                try {
                    if (session.Stream.IsConnected) session.Stream.Disconnect();
                    session.Stream.Dispose();
                } catch {}
            }
            WriteStdout("X " + clientId);
        }
    }

    private void ReadStdinLoop() {
        string line;
        while (!_cts.IsCancellationRequested && (line = Console.ReadLine()) != null) {
            line = line.Trim();
            if (line.Length == 0) continue;

            if (line == "Q") {
                _cts.Cancel();
                break;
            }

            if (line.StartsWith("D ")) {
                int firstSpace = line.IndexOf(' ');
                int secondSpace = line.IndexOf(' ', firstSpace + 1);
                if (secondSpace > firstSpace) {
                    string cidStr = line.Substring(firstSpace + 1, secondSpace - firstSpace - 1);
                    string payloadBase64 = line.Substring(secondSpace + 1);
                    int cid;
                    if (int.TryParse(cidStr, out cid)) {
                        ClientSession session;
                        if (_clients.TryGetValue(cid, out session)) {
                            EnqueueWrite(session, payloadBase64);
                        }
                    }
                }
            } else if (line.StartsWith("X ")) {
                string cidStr = line.Substring(2).Trim();
                int cid;
                if (int.TryParse(cidStr, out cid)) {
                    CloseClient(cid);
                }
            }
        }
        _cts.Cancel();
    }

    private void EnqueueWrite(ClientSession session, string payloadBase64) {
        byte[] bytes;
        try {
            bytes = Convert.FromBase64String(payloadBase64);
        } catch {
            return;
        }

        lock (session.Lock) {
            if (session.Disposed) return;

            if (session.PendingBytes + bytes.Length > ClientSession.MaxPendingBytes) {
                CloseClient(session.Id);
                return;
            }

            session.PendingBytes += bytes.Length;
            session.WriteChain = session.WriteChain.ContinueWith(async _ => {
                try {
                    if (!session.Disposed && session.Stream.IsConnected) {
                        await session.Stream.WriteAsync(bytes, 0, bytes.Length);
                        await session.Stream.FlushAsync();
                    }
                } catch {
                    CloseClient(session.Id);
                } finally {
                    lock (session.Lock) {
                        session.PendingBytes = Math.Max(0, session.PendingBytes - bytes.Length);
                    }
                }
            }, TaskContinuationOptions.None).Unwrap();
        }
    }

    private void Shutdown() {
        _cts.Cancel();
        foreach (var kvp in _clients) {
            var session = kvp.Value;
            lock (session.Lock) {
                session.Disposed = true;
                try {
                    if (session.Stream.IsConnected) session.Stream.Disconnect();
                    session.Stream.Dispose();
                } catch {}
            }
        }
        _clients.Clear();
    }

    private static void WriteStdout(string msg) {
        lock (_stdoutLock) {
            Console.WriteLine(msg);
            Console.Out.Flush();
        }
    }

    private static void WriteError(string msg) {
        lock (_stdoutLock) {
            Console.Error.WriteLine(msg);
            Console.Error.Flush();
        }
    }
}
'@

Add-Type -TypeDefinition $csharpSource -Language CSharp
$broker = New-Object VeyyonTerminalPipeBroker($pipeName)
$broker.Run()
`;

export async function createWindowsPipeTransport(
	endpoint: string,
	onConnection: (socket: TerminalSocket) => void,
	options: TerminalControlTransportOptions = {},
): Promise<TerminalControlServer> {
	const pipeName = endpoint.replace(/^[/\\]{2}\.[/\\]pipe[/\\]/, "");
	if (!pipeName || pipeName.includes("/") || pipeName.includes("\\")) {
		throw new Error(`Invalid Windows named pipe endpoint: ${endpoint}`);
	}

	const configuredSystemRoot = options.systemRoot ?? process.env.SystemRoot;
	const driveRoot = configuredSystemRoot === undefined ? "" : path.win32.parse(configuredSystemRoot).root;
	if (configuredSystemRoot === undefined || !/^[A-Za-z]:[\\/]$/.test(driveRoot)) {
		throw new Error("A trusted drive-qualified Windows system root is unavailable.");
	}
	const systemRoot = path.win32.normalize(configuredSystemRoot);
	const powershell = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

	const spawnProcess = options.spawnProcess ?? spawn;
	const readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;

	const child = spawnProcess(
		powershell,
		[
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			WINDOWS_POWERSHELL_BROKER_SCRIPT,
		],
		{
			env: {
				SystemRoot: systemRoot,
				VEYYON_PIPE_NAME: pipeName,
			},
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		},
	);

	const sockets = new Map<number, VirtualTerminalSocket>();
	const { promise: readyPromise, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers<void>();
	let readySettled = false;

	const readinessTimer = setTimeout(() => {
		if (!readySettled) {
			readySettled = true;
			try {
				child.kill();
			} catch {}
			rejectReady(new Error(`Windows named pipe broker timed out waiting for readiness after ${readinessTimeoutMs}ms`));
		}
	}, readinessTimeoutMs);

	const writeToBroker = (cid: number, base64: string, cb?: (err?: Error) => void): boolean => {
		if (!child.stdin || child.stdin.destroyed) {
			cb?.(new Error("Broker stdin is closed"));
			return false;
		}
		return child.stdin.write(`D ${cid} ${base64}\n`, cb);
	};

	const destroyClient = (cid: number): void => {
		sockets.delete(cid);
		if (child.stdin && !child.stdin.destroyed) {
			try {
				child.stdin.write(`X ${cid}\n`);
			} catch {}
		}
	};

	let stdoutBuffer = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdoutBuffer += chunk.toString("utf8");
		let newlineIdx: number;
		while ((newlineIdx = stdoutBuffer.indexOf("\n")) !== -1) {
			const line = stdoutBuffer.slice(0, newlineIdx).replace(/\r$/, "").trim();
			stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
			if (line.length === 0) continue;

			if (line.startsWith("READY ")) {
				if (!readySettled) {
					readySettled = true;
					clearTimeout(readinessTimer);
					resolveReady();
				}
				continue;
			}

			if (line.startsWith("C ")) {
				const cid = parseInt(line.slice(2).trim(), 10);
				if (!Number.isNaN(cid)) {
					const socket = new VirtualTerminalSocket(cid, writeToBroker, destroyClient);
					sockets.set(cid, socket);
					onConnection(socket);
				}
				continue;
			}

			if (line.startsWith("D ")) {
				const firstSpace = line.indexOf(" ");
				const secondSpace = line.indexOf(" ", firstSpace + 1);
				if (firstSpace !== -1 && secondSpace !== -1) {
					const cid = parseInt(line.slice(firstSpace + 1, secondSpace), 10);
					const base64 = line.slice(secondSpace + 1);
					const socket = sockets.get(cid);
					if (socket) {
						const buf = Buffer.from(base64, "base64");
						socket._receiveChunk(buf);
					}
				}
				continue;
			}

			if (line.startsWith("X ")) {
				const cid = parseInt(line.slice(2).trim(), 10);
				const socket = sockets.get(cid);
				if (socket) {
					sockets.delete(cid);
					socket._handleRemoteClose();
				}
				continue;
			}
		}
	});

	let stderrBuffer = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		if (stderrBuffer.length < MAX_STDERR_DIAGNOSTIC_BYTES) {
			stderrBuffer += chunk.toString("utf8");
		}
	});

	child.on("error", (err: Error) => {
		if (!readySettled) {
			readySettled = true;
			clearTimeout(readinessTimer);
			rejectReady(err);
		}
		for (const socket of sockets.values()) {
			socket.destroy(err);
		}
		sockets.clear();
	});

	let serverClosed = false;
	let unexpectedDeath = false;
	const closeListeners = new Set<() => void>();
	let killTimer: NodeJS.Timeout | undefined;

	child.on("exit", (code: number | null, signal: string | null) => {
		if (killTimer !== undefined) {
			clearTimeout(killTimer);
			killTimer = undefined;
		}
		if (!readySettled) {
			readySettled = true;
			clearTimeout(readinessTimer);
			const diag = stderrBuffer.trim() ? `: ${stderrBuffer.trim().slice(0, 500)}` : "";
			rejectReady(new Error(`Windows named pipe broker exited prematurely with code ${code ?? signal}${diag}`));
		} else if (!serverClosed) {
			serverClosed = true;
			unexpectedDeath = true;
			const err = new Error(`Windows named pipe broker terminated unexpectedly with code ${code ?? signal}`);
			for (const socket of sockets.values()) {
				socket.destroy(err);
			}
			sockets.clear();
			for (const listener of closeListeners) {
				try {
					listener();
				} catch {}
			}
			closeListeners.clear();
		}
		for (const socket of sockets.values()) {
			socket._handleRemoteClose();
		}
		sockets.clear();
	});

	try {
		await readyPromise;
	} catch (err) {
		try {
			child.kill();
		} catch {}
		throw err;
	}

	const server: TerminalControlServer = {
		endpoint: `\\\\.\\pipe\\${pipeName}`,
		close: (cb?: (err?: Error) => void): void => {
			if (serverClosed) {
				cb?.();
				return;
			}
			serverClosed = true;
			clearTimeout(readinessTimer);

			for (const socket of sockets.values()) {
				socket.destroy();
			}
			sockets.clear();

			if (child.stdin && !child.stdin.destroyed) {
				try {
					child.stdin.write("Q\n");
					child.stdin.end();
				} catch {}
			}

			if (!child.killed) {
				killTimer = setTimeout(() => {
					try {
						child.kill();
					} catch {}
				}, 2000);
				killTimer.unref?.();
			}

			cb?.();
		},
		onClose: (listener: () => void): void => {
			if (unexpectedDeath) {
				try {
					listener();
				} catch {}
				return;
			}
			closeListeners.add(listener);
		},
	};

	return server;
}

export async function createPosixSocketServer(
	endpoint: string,
	onConnection: (socket: TerminalSocket) => void,
): Promise<TerminalControlServer> {
	const server = net.createServer(socket => {
		onConnection(socket);
	});

	const { promise: readyPromise, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers<void>();
	server.once("error", rejectReady);
	server.listen(endpoint, () => resolveReady());

	await readyPromise;

	try {
		await fs.chmod(endpoint, 0o600);
	} catch (err) {
		server.close();
		throw err;
	}

	let posixClosed = false;
	const posixCloseListeners = new Set<() => void>();
	server.on("close", () => {
		posixClosed = true;
		for (const listener of posixCloseListeners) {
			try {
				listener();
			} catch {}
		}
		posixCloseListeners.clear();
	});

	return {
		endpoint,
		close: (cb?: (err?: Error) => void): void => {
			server.close(cb);
		},
		onClose: (listener: () => void): void => {
			if (posixClosed) {
				try {
					listener();
				} catch {}
				return;
			}
			posixCloseListeners.add(listener);
		},
	};
}

export async function createTerminalControlTransport(
	endpoint: string,
	onConnection: (socket: TerminalSocket) => void,
	options: TerminalControlTransportOptions = {},
): Promise<TerminalControlServer> {
	if (options.forceWindows || process.platform === "win32") {
		return createWindowsPipeTransport(endpoint, onConnection, options);
	}
	return createPosixSocketServer(endpoint, onConnection);
}
