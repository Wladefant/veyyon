import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import { escapeTerminalText } from "./terminal-safe";
import { errorMessage } from "./type-guards";

const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024;
export const WINDOWS_ACL_TIMEOUT_MS = 60_000;

/** Reject values Node would truncate or turn into a one-millisecond timer. */
export function getWindowsAclTimeoutMs(): number {
	const configured = process.env.VEYYON_WINDOWS_ACL_TIMEOUT_MS;
	if (configured === undefined || !/^[0-9]+$/.test(configured)) return WINDOWS_ACL_TIMEOUT_MS;
	const timeout = Number(configured);
	return Number.isInteger(timeout) && timeout > 0 && timeout <= 2_147_483_647 ? timeout : WINDOWS_ACL_TIMEOUT_MS;
}

export interface WindowsAclCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Injectable only so ACL behavior can be exercised on non-Windows test hosts. */
export type WindowsAclCommandRunner = (script: string, filePath: string) => Promise<WindowsAclCommandResult>;

/** Synchronous counterpart of {@link WindowsAclCommandRunner} for readers that cannot await. */
export type WindowsAclSyncCommandRunner = (script: string, filePath: string) => WindowsAclCommandResult;

export interface WindowsAclOptions {
	platform?: NodeJS.Platform;
	run?: WindowsAclCommandRunner;
	/** Used only by {@link verifyOwnerOnlyWindowsAclSync}. */
	runSync?: WindowsAclSyncCommandRunner;
	/** Low-level injection for exercising process lifecycle behavior without PowerShell. */
	spawn?: typeof spawn;
}

const VERIFY_ACL = `
if ($item.PSProvider.Name -ne 'FileSystem') { throw 'ACL target is not a filesystem path' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$actual = Get-Acl -LiteralPath $target -ErrorAction Stop
$owner = $actual.GetOwner([Security.Principal.SecurityIdentifier])
if (-not $owner.Equals($identity)) { throw 'ACL owner is not the current user' }
if (-not $actual.AreAccessRulesProtected) { throw 'ACL inheritance is enabled' }
$rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 2) { throw 'ACL does not contain exactly two access rules' }
$system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$expectedIdentities = @($identity, $system)
$expectedInheritance = [Security.AccessControl.InheritanceFlags]::None
if ($item.PSIsContainer) {
  $expectedInheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
}
foreach ($rule in $rules) {
  if ($rule.IsInherited) { throw 'ACL contains an inherited access rule' }
  $principalAllowed = $false
  foreach ($expectedIdentity in $expectedIdentities) {
    if ($rule.IdentityReference.Equals($expectedIdentity)) { $principalAllowed = $true }
  }
  if (-not $principalAllowed) { throw 'ACL grants another identity access' }
  if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw 'ACL principal rule is not an allow rule' }
  if ($rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'ACL principal rule is not exactly full control' }
  if ($rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { throw 'ACL principal rule has unexpected propagation flags' }
  if ($rule.InheritanceFlags -ne $expectedInheritance) { throw 'ACL principal rule has unexpected inheritance flags' }
}
foreach ($expectedIdentity in $expectedIdentities) {
  $principalRules = @($rules | Where-Object { $_.IdentityReference.Equals($expectedIdentity) })
  if ($principalRules.Count -ne 1) { throw 'ACL is missing an expected principal rule' }
}
if ($item.PSIsContainer) {
  foreach ($rule in $rules) {
    if ($rule.InheritanceFlags -ne $expectedInheritance) { throw 'ACL directory principal rule does not protect descendants' }
  }
} elseif ($rules | Where-Object { $_.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None }) {
  throw 'ACL file principal rule has unexpected inheritance flags'
}
`;

const APPLY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('VEYYON_OWNER_ONLY_ACL_PATH', 'Process')
if ([string]::IsNullOrEmpty($target)) { throw 'ACL target is missing' }
$item = Get-Item -LiteralPath $target -Force -ErrorAction Stop
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($item.PSIsContainer) {
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
} else {
  $acl = New-Object Security.AccessControl.FileSecurity
  $inheritance = [Security.AccessControl.InheritanceFlags]::None
}
$acl.SetOwner($identity)
$acl.SetAccessRuleProtection($true, $false)
$system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
foreach ($principal in @($identity, $system)) {
  $rule = New-Object Security.AccessControl.FileSystemAccessRule(
    $principal,
    [Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
}
# Set-Acl refuses to rewrite a DACL it already protected, demanding SeSecurityPrivilege for the SACL it
# never changes; SetAccessControl persists only the owner and DACL sections this object modified.
$item.SetAccessControl($acl)
${VERIFY_ACL}
[Console]::Out.Write('OK')
`;

const VERIFY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('VEYYON_OWNER_ONLY_ACL_PATH', 'Process')
if ([string]::IsNullOrEmpty($target)) { throw 'ACL target is missing' }
$item = Get-Item -LiteralPath $target -Force -ErrorAction Stop
if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'ACL target is a reparse point' }
${VERIFY_ACL}
[Console]::Out.Write('OK')
`;

const VERIFY_STREAM_SCRIPT = `
$ErrorActionPreference = 'Stop'
while ($null -ne ($request = [Console]::In.ReadLine())) {
  $separator = $request.IndexOf([char]9)
  if ($separator -lt 1) { throw 'Invalid ACL request frame' }
  $requestId = $request.Substring(0, $separator)
  if ($requestId -notmatch '^[1-9][0-9]*$') { throw 'Invalid ACL request identifier' }
  try {
    $target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($request.Substring($separator + 1)))
    if ([string]::IsNullOrEmpty($target)) { throw 'ACL target is missing' }
    $item = Get-Item -LiteralPath $target -Force -ErrorAction Stop
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'ACL target is a reparse point' }
${VERIFY_ACL}
    [Console]::Out.WriteLine($requestId + [char]9 + 'OK')
  } catch {
    $detail = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.Exception.Message))
    [Console]::Out.WriteLine($requestId + [char]9 + 'ERR' + [char]9 + $detail)
  }
  [Console]::Out.Flush()
}
`;

/**
 * Reuse one verifier process without caching any ACL decision or changing the caller's read order.
 * The process exists only within this scope. Requests are sequential and independently bounded.
 */
export async function withOwnerOnlyWindowsAclVerification<T>(
	operation: (options: WindowsAclOptions) => Promise<T>,
	options: WindowsAclOptions = {},
): Promise<T> {
	if ((options.platform ?? process.platform) !== "win32" || options.run !== undefined) return operation(options);
	let child: ChildProcessWithoutNullStreams | undefined;
	let closing = false;
	let closed = false;
	let terminating = false;
	let failure: Error | undefined;
	let nextId = 0;
	let pending: {
		id: number;
		output: string;
		bytes: number;
		timer: NodeJS.Timeout;
		resolve: (result: WindowsAclCommandResult) => void;
		reject: (error: Error) => void;
	} | undefined;
	const completion = Promise.withResolvers<void>();
	const fail = (error: Error, terminate: boolean): void => {
		failure ??= error;
		if (pending !== undefined) {
			const request = pending;
			pending = undefined;
			clearTimeout(request.timer);
			request.reject(failure);
		}
		if (terminate && child !== undefined && !closed && !terminating) {
			terminating = true;
			try { child.kill(); } catch {}
		}
	};
	const onStdout = (chunk: Buffer): void => {
		const request = pending;
		if (request === undefined) {
			fail(new Error("The Windows ACL verifier produced unsolicited output."), true);
			return;
		}
		request.bytes += chunk.length;
		if (request.bytes > MAX_COMMAND_OUTPUT_BYTES) {
			fail(new Error("The Windows ACL command produced excessive output."), true);
			return;
		}
		request.output += chunk.toString("utf8");
		if (!request.output.includes("\n")) return;
		const response = /^([1-9][0-9]*)\t(OK|ERR\t([A-Za-z0-9+/]*={0,2}))\r?\n$/.exec(request.output);
		if (response === null || response[1] !== String(request.id)) {
			fail(new Error("The Windows ACL verifier returned an invalid response frame."), true);
			return;
		}
		const encodedError = response[3];
		const detail = encodedError === undefined ? undefined : Buffer.from(encodedError, "base64");
		if (detail !== undefined && detail.toString("base64") !== encodedError) {
			fail(new Error("The Windows ACL verifier returned an invalid error frame."), true);
			return;
		}
		clearTimeout(request.timer);
		pending = undefined;
		request.resolve(detail === undefined
			? { exitCode: 0, stdout: "OK", stderr: "" }
			: { exitCode: 1, stdout: "", stderr: detail.toString("utf8") });
	};
	const onError = (error: Error): void => fail(error, true);
	const onStderr = (): void => fail(new Error("The Windows ACL verifier wrote unexpected stderr."), true);
	const run: WindowsAclCommandRunner = (script, filePath) => {
		if (closing || failure !== undefined) return Promise.reject(failure ?? new Error("The Windows ACL verifier scope ended."));
		if (script !== VERIFY_SCRIPT || pending !== undefined) {
			fail(new Error("The Windows ACL verifier only accepts sequential verification requests."), true);
			return Promise.reject(failure);
		}
		const result = Promise.withResolvers<WindowsAclCommandResult>();
		const id = ++nextId;
		pending = {
			id, output: "", bytes: 0, resolve: result.resolve, reject: result.reject,
			timer: setTimeout(() => fail(new Error("The Windows ACL command timed out."), true), getWindowsAclTimeoutMs()),
		};
		try {
			if (child === undefined) {
				const { executable, env } = trustedPowerShell("");
				child = (options.spawn ?? spawn)(executable,
					["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", VERIFY_STREAM_SCRIPT],
					{ env, cwd: path.win32.dirname(executable), stdio: "pipe", windowsHide: true });
				child.stdout.on("data", onStdout);
				child.stderr.on("data", onStderr);
				child.stdin.on("error", onError);
				child.stdout.on("error", onError);
				child.stderr.on("error", onError);
				child.on("error", onError);
				child.once("close", code => {
					closed = true;
					if (!closing || pending !== undefined || code !== 0) {
						fail(new Error("The Windows ACL verifier exited before completing its scope."), false);
					}
					child?.stdout.off("data", onStdout);
					child?.stderr.off("data", onStderr);
					completion.resolve();
				});
			}
			child.stdin.write(`${id}\t${Buffer.from(filePath, "utf8").toString("base64")}\n`);
		} catch (error) {
			fail(error instanceof Error ? error : new Error(String(error)), true);
		}
		return result.promise;
	};
	let operationFailed = false;
	try {
		return await operation({ ...options, run });
	} catch (error) {
		operationFailed = true;
		throw error;
	} finally {
		closing = true;
		if (child !== undefined) {
			let timer: NodeJS.Timeout | undefined;
			try {
				if (pending !== undefined) fail(new Error("The Windows ACL verifier has an unfinished request."), true);
				if (!closed) {
					child.stdin.end();
					await Promise.race([
						completion.promise,
						new Promise<never>((_resolve, reject) => {
							timer = setTimeout(() => {
								const error = new Error("The Windows ACL verifier did not exit.");
								fail(error, true);
								reject(error);
							}, getWindowsAclTimeoutMs());
						}),
					]);
				}
				if (failure !== undefined) throw failure;
			} catch (error) {
				if (!operationFailed) throw error;
			} finally {
				clearTimeout(timer);
			}
		}
	}
}

/** Apply a protected DACL granting full control only to the current user and LocalSystem. */
export async function applyOwnerOnlyWindowsAcl(filePath: string, options: WindowsAclOptions = {}): Promise<void> {
	await runOwnerOnlyAcl(APPLY_SCRIPT, filePath, options);
}

/** Verify that a path has a protected owner-only DACL; rejects on any ambiguity. */
export async function verifyOwnerOnlyWindowsAcl(filePath: string, options: WindowsAclOptions = {}): Promise<void> {
	await runOwnerOnlyAcl(VERIFY_SCRIPT, filePath, options);
}


/**
 * Synchronous {@link verifyOwnerOnlyWindowsAcl} for a reader that cannot await. It runs the same
 * VERIFY_SCRIPT with the same environment, deadline and output bound, and rejects the same way.
 */
export function verifyOwnerOnlyWindowsAclSync(filePath: string, options: WindowsAclOptions = {}): void {
	const platform = options.platform ?? process.platform;
	if (platform !== "win32") return;
	assertOwnerOnlyPath(filePath);

	let result: WindowsAclCommandResult;
	try {
		result =
			options.runSync === undefined
				? defaultWindowsAclSyncRunner(VERIFY_SCRIPT, filePath)
				: options.runSync(VERIFY_SCRIPT, filePath);
	} catch (error) {
		throw ownerOnlyAclFailure(error);
	}
	assertOwnerOnlyResult(result);
}

async function runOwnerOnlyAcl(script: string, filePath: string, options: WindowsAclOptions): Promise<void> {
	const platform = options.platform ?? process.platform;
	if (platform !== "win32") return;
	assertOwnerOnlyPath(filePath);

	let result: WindowsAclCommandResult;
	try {
		result =
			options.run === undefined
				? await defaultWindowsAclRunner(script, filePath, options.spawn)
				: await options.run(script, filePath);
	} catch (error) {
		throw ownerOnlyAclFailure(error);
	}
	assertOwnerOnlyResult(result);
}

function assertOwnerOnlyPath(filePath: string): void {
	if (filePath.length === 0 || filePath.includes("\0")) throw new Error("The Windows ACL path is invalid.");
}

function ownerOnlyAclFailure(error: unknown): Error {
	const message = errorMessage(error);
	const detail = boundedDiagnostic(message.length === 0 ? "unknown command error" : message);
	return new Error(`The owner-only Windows ACL operation failed (${detail}).`, { cause: error });
}

function assertOwnerOnlyResult(result: WindowsAclCommandResult): void {
	if (result.exitCode !== 0 || result.stdout !== "OK" || result.stderr !== "") {
		const status = result.exitCode === 0 ? "unexpected success output" : `exit code ${result.exitCode}`;
		const output = result.stderr || result.stdout;
		const detail = boundedDiagnostic(output.length === 0 ? status : `${status}: ${output}`);
		throw new Error(`The owner-only Windows ACL operation failed (${detail}).`);
	}
}

/**
 * The PowerShell both runners start: the one under the trusted system root, with only the ACL path and
 * that root in its environment. One resolver keeps the async and sync runners on the same trust rule.
 */
function trustedPowerShell(filePath: string): { executable: string; env: Record<string, string> } {
	const configuredSystemRoot = process.env.SystemRoot;
	const driveRoot = configuredSystemRoot === undefined ? "" : path.win32.parse(configuredSystemRoot).root;
	if (configuredSystemRoot === undefined || !/^[A-Za-z]:[\\/]$/.test(driveRoot)) {
		throw new Error("A trusted drive-qualified Windows system root is unavailable.");
	}
	const systemRoot = path.win32.normalize(configuredSystemRoot);
	return {
		executable: path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		env: { SystemRoot: systemRoot, VEYYON_OWNER_ONLY_ACL_PATH: filePath },
	};
}

async function defaultWindowsAclRunner(
	script: string,
	filePath: string,
	spawnProcess: typeof spawn = spawn,
): Promise<WindowsAclCommandResult> {
	const { executable, env } = trustedPowerShell(filePath);
	const { promise, resolve, reject } = Promise.withResolvers<WindowsAclCommandResult>();
	const child = spawnProcess(
		executable,
		["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
		{
			env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		},
	);
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let totalBytes = 0;
	let settled = false;
	let timer: NodeJS.Timeout | undefined;
	const stopCollecting = (destroy: boolean): void => {
		child.stdout.off("data", onStdout);
		child.stderr.off("data", onStderr);
		if (destroy) {
			child.stdout.destroy();
			child.stderr.destroy();
		}
	};
	const fail = (error: Error, terminate: boolean): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		if (terminate) {
			try {
				child.kill();
			} catch {}
		}
		stopCollecting(true);
		stdout.length = 0;
		stderr.length = 0;
		reject(error);
	};
	const collect = (destination: Buffer[], chunk: Buffer): void => {
		if (settled) return;
		totalBytes += chunk.length;
		if (totalBytes > MAX_COMMAND_OUTPUT_BYTES) {
			fail(new Error("The Windows ACL command produced excessive output."), true);
			return;
		}
		destination.push(chunk);
	};
	const onStdout = (chunk: Buffer): void => collect(stdout, chunk);
	const onStderr = (chunk: Buffer): void => collect(stderr, chunk);
	const decode = (chunks: Buffer[]): string => {
		if (chunks.length === 0) return "";
		const bytes = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
		return bytes.toString("utf8").trim();
	};
	child.stdout.on("data", onStdout);
	child.stderr.on("data", onStderr);
	child.once("error", error => fail(error, false));
	child.once("close", code => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		stopCollecting(false);
		resolve({
			exitCode: code ?? -1,
			stdout: decode(stdout),
			stderr: decode(stderr),
		});
	});
	timer = setTimeout(() => {
		fail(new Error("The Windows ACL command timed out."), true);
	}, getWindowsAclTimeoutMs());
	return await promise;
}

/**
 * Runs a verification synchronously with the async runner's bounds: a configurable deadline, a per-stream
 * output cap and no console window. A node-level failure (timeout, oversized output) throws.
 */
function defaultWindowsAclSyncRunner(script: string, filePath: string): WindowsAclCommandResult {
	const { executable, env } = trustedPowerShell(filePath);
	const result = spawnSync(
		executable,
		["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
		{
			encoding: "utf8",
			env,
			maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: getWindowsAclTimeoutMs(),
			windowsHide: true,
		},
	);
	if (result.error) throw result.error;
	return { exitCode: result.status ?? -1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function boundedDiagnostic(value: string): string {
	const inert = escapeTerminalText(value);
	return inert.length <= 512 ? inert : `${inert.slice(0, 511)}…`;
}
