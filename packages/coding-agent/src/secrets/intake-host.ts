import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which } from "@veyyon/utils";
import { applyOwnerOnlyWindowsAcl } from "@veyyon/utils/windows-acl";
import { executeBash } from "../exec/bash-executor";
import { SecretIntakeBroker, type SecretIntakeContext } from "./intake-broker";
import { runWithProducerSecretOwner, type ProducerSecretOwner } from "./producer-owner";
import type { ProtectedCredentialResource } from "./protected-resources";
import type { SessionSecretRuntime } from "./session-runtime";
import { BitwardenUsIntakeVault } from "./intake-vault";

/** Operator-owned metadata only. Authentication remains in the existing Bitwarden US helper session. */
export interface SecretIntakeHostConfiguration {
	version: 1;
	projects: readonly SecretIntakeProjectGrant[];
}
export interface SecretIntakeProjectGrant {
	projectRoot: string;
	organizationId: string;
	collectionId: string;
	vaultCollection: string;
	/** Optional trusted local setup; otherwise the authenticated daemon binds its configured actor. */
	actorId?: string;
	operations: readonly SecretIntakeCommandGrant[];
}
export interface SecretIntakeCommandGrant {
	tool: "bash";
	purpose: string;
	/** Fixed operator-approved command. Never interpolate the value into this string. */
	command: string;
	envKey: string;
	timeoutMs?: number;
}
export interface PreparedSecretIntakeHost {
	actorId?: string;
	protectedResources: readonly ProtectedCredentialResource[];
	create(actorId: string): Promise<{ broker: SecretIntakeBroker; context: SecretIntakeContext }>;
	close(): void;
}
export interface PrepareSecretIntakeHostOptions {
	agentDir: string;
	cwd: string;
	ownerSessionId: string;
	runtime: SessionSecretRuntime;
	configuration?: SecretIntakeHostConfiguration;
	getCwd?: () => string;
	getOwnerSessionId?: () => string;
}

/** Native identity, returned to remote adapters rather than recomputed from a route's workspace string. */
export async function deriveSecretIntakeProjectId(cwd: string): Promise<string> {
	const real = await fs.realpath(cwd);
	const canonical = process.platform === "win32" ? real.toLowerCase() : real;
	return `project:${createHash("sha256").update(canonical).digest("hex")}`;
}

function refused(): never { throw new Error("Secret intake host configuration refused"); }
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) refused();
	return value as Record<string, unknown>;
}
function text(value: unknown, limit = 8192): string {
	if (typeof value !== "string" || !value || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) refused();
	return value;
}
function parseConfiguration(value: unknown): SecretIntakeHostConfiguration {
	const root = record(value);
	if (root.version !== 1 || Object.keys(root).some(key => key !== "version" && key !== "projects") || !Array.isArray(root.projects) || root.projects.length > 256) refused();
	const projects = root.projects.map(candidate => {
		const project = record(candidate);
		if (Object.keys(project).some(key => !["projectRoot", "organizationId", "collectionId", "vaultCollection", "actorId", "operations"].includes(key)) || !Array.isArray(project.operations) || project.operations.length === 0 || project.operations.length > 128) refused();
		const operations = project.operations.map(candidateOperation => {
			const operation = record(candidateOperation);
			if (Object.keys(operation).some(key => !["tool", "purpose", "command", "envKey", "timeoutMs"].includes(key)) || operation.tool !== "bash") refused();
			const envKey = text(operation.envKey, 128);
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)) refused();
			const timeoutMs = operation.timeoutMs;
			if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)) refused();
			return { tool: "bash" as const, purpose: text(operation.purpose, 512), command: text(operation.command), envKey, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
		});
		if (new Set(operations.map(operation => operation.purpose)).size !== operations.length) refused();
		const actorId = project.actorId;
		if (actorId !== undefined && (typeof actorId !== "string" || !/^[0-9]{1,32}$/.test(actorId))) refused();
		return { projectRoot: text(project.projectRoot), organizationId: text(project.organizationId, 128), collectionId: text(project.collectionId, 128), vaultCollection: text(project.vaultCollection, 128), operations, ...(actorId === undefined ? {} : { actorId }) };
	});
	return { version: 1, projects };
}

/** Reuse existing US account/session paths; never establish another authentication store. */
export async function prepareSecretIntakeHost(options: PrepareSecretIntakeHostOptions): Promise<PreparedSecretIntakeHost | undefined> {
	let configuration: SecretIntakeHostConfiguration;
	try {
		if (options.configuration) configuration = parseConfiguration(options.configuration);
		else {
			const file = path.join(options.agentDir, "secret-intake.json");
			let raw: string;
			try {
				const stat = await fs.lstat(file);
				if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) refused();
				raw = await fs.readFile(file, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			}
			configuration = parseConfiguration(JSON.parse(raw));
		}
		const projectId = await deriveSecretIntakeProjectId(options.cwd);
		const matching: SecretIntakeProjectGrant[] = [];
		for (const grant of configuration.projects) {
			if (await deriveSecretIntakeProjectId(grant.projectRoot) === projectId) matching.push(grant);
		}
		if (matching.length === 0) return undefined;
		if (matching.length !== 1) refused();
		const grant = matching[0]!;
		const initialCwd = await fs.realpath(options.cwd);
		const isCurrentScope = (): boolean => {
			try {
				const current = realpathSync(options.getCwd?.() ?? options.cwd);
				return (options.getOwnerSessionId?.() ?? options.ownerSessionId) === options.ownerSessionId
					&& (process.platform === "win32" ? current.toLowerCase() === initialCwd.toLowerCase() : current === initialCwd);
			} catch {
				return false;
			}
		};
		const home = os.homedir();
		const appData = path.join(home, ".config", "bw-us");
		const sessionFile = path.join(home, ".veyyon", "shared-auth", "bw-us.session");
		const protectedResources: ProtectedCredentialResource[] = [
			{ owner: "Bitwarden US secure intake", canonicalPath: sessionFile, kind: "credential" },
			{ owner: "Bitwarden US secure intake", canonicalPath: path.join(appData, "data.json"), kind: "credential" },
		];
		let database: Database | undefined;
		let broker: SecretIntakeBroker | undefined;
		let closed = false;
		let boundActor: string | undefined;
		return {
			actorId: grant.actorId,
			protectedResources,
			async create(actorId) {
				if (closed || !isCurrentScope() || !/^[0-9]{1,32}$/.test(actorId) || (grant.actorId && grant.actorId !== actorId) || (boundActor && boundActor !== actorId)) refused();
				const context = { actorId, ownerSessionId: options.ownerSessionId, projectId };
				if (broker) return { broker, context };
				boundActor = actorId;
				const windowsUsWrapper = process.platform === "win32";
				const executable = $which(windowsUsWrapper ? "cmd.exe" : "bw-us");
				if (!executable) refused();
				const env: NodeJS.ProcessEnv = {};
				for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
					if (process.env[key] !== undefined) env[key] = process.env[key];
				}
				const root = path.join(options.agentDir, "secret-intake");
				await fs.mkdir(root, { recursive: true, mode: 0o700 });
				if ((await fs.lstat(root)).isSymbolicLink()) refused();
				if (process.platform === "win32") await applyOwnerOnlyWindowsAcl(root);
				else await fs.chmod(root, 0o700);
				const databasePath = path.join(root, `${createHash("sha256").update(options.ownerSessionId).digest("hex")}.sqlite`);
				const handle = await fs.open(databasePath, "a", 0o600);
				await handle.close();
				if ((await fs.lstat(databasePath)).isSymbolicLink()) refused();
				if (process.platform === "win32") await applyOwnerOnlyWindowsAcl(databasePath);
				else await fs.chmod(databasePath, 0o600);
				database = new Database(databasePath);
				database.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
				const vault = new BitwardenUsIntakeVault({ executable, windowsUsWrapper, env, cwd: options.cwd, organizationId: grant.organizationId, projectCollections: { [projectId]: grant.collectionId }, lockDirectory: root });
				let producerOwner: ProducerSecretOwner | undefined;
				broker = new SecretIntakeBroker({
					database, vault, context, vaultCollection: grant.vaultCollection,
					allowedOperations: grant.operations,
					isCurrentScope,
					protection: {
						async register(value) { producerOwner = options.runtime.registerPrivateSecret(value); },
						async execute(value, operation) {
							const approved = grant.operations.find(candidate => candidate.tool === operation.tool && candidate.purpose === operation.purpose);
							if (!isCurrentScope() || !approved || !producerOwner) refused();
							const owner = producerOwner;
							const result = await runWithProducerSecretOwner(owner, () => executeBash(approved.command, {
								cwd: options.cwd, env: { [approved.envKey]: value }, timeout: approved.timeoutMs ?? 60_000,
								sessionKey: `${options.ownerSessionId}:async:intake:${randomUUID()}`,
								redactOutput: text => owner.redact(text),
							}));
							if (result.exitCode !== 0 || result.cancelled || result.timedOut || result.outputIncomplete) throw new Error("Secret intake private operation failed");
						},
					},
				});
				return { broker, context };
			},
			close() {
				closed = true;
				broker?.close();
				database?.close();
			},
		};
	} catch { throw new Error("Secret intake host unavailable"); }
}
