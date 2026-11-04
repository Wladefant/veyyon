import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { link, lstat, mkdir, open, readFile, readdir, realpath, stat, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	assertPublishable,
	assertSameAccess,
	validateRecord,
	type ApprovedContextRecord,
	type ContextAccess,
	type ContextReference,
	type ContextReceipt,
	type TeamContextProvider,
} from "./team-context";

const MAX_RECORD_BYTES = 1024 * 1024;
const execFileAsync = promisify(execFile);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown) => JSON.stringify(value);

export function createGitContextProvider(options: {
	path: string;
	authorize: (cwd: string, signal?: AbortSignal) => Promise<ContextAccess>;
}): TeamContextProvider {
	if (!options.path || !isAbsolute(options.path)) throw new Error("Git context path must be absolute");
	const configuredPath = resolve(options.path);

	async function identity(cwd: string, signal?: AbortSignal) {
		if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
		const configured = await realpath(configuredPath);
		const repo = await realpath(cwd);
		if (repo !== configured) throw new Error("Git context checkout does not match configured path");
		const { stdout } = await execFileAsync(
			"git",
			["rev-parse", "--show-toplevel"],
			{ cwd: repo, windowsHide: true, timeout: 3000, maxBuffer: 16 * 1024 },
		);
		if (await realpath(stdout.trim()) !== repo) throw new Error("Selected path is not the Git checkout root");
		const access = await options.authorize(cwd, signal);
		if (!access || typeof access.actor !== "string" || !access.actor.trim() ||
			typeof access.binding !== "string" || !access.binding.trim() ||
			typeof access.scope?.team !== "string" || !access.scope.team.trim() ||
			typeof access.scope.repository !== "string" || !access.scope.repository.trim())
			throw new Error("Trusted authorization callback returned invalid access");
		if (!Array.isArray(access.allowedPrivacy) ||
			access.allowedPrivacy.some(p => p !== "repository" && p !== "team"))
			throw new Error("Trusted authorization callback returned invalid privacy policy");
		if (access.binding !== `git:${repo}`)
			throw new Error("Context binding is not bound to selected Git checkout");
		const snapshot: ContextAccess = {
			scope: { team: access.scope.team, repository: access.scope.repository },
			actor: access.actor,
			binding: access.binding,
			allowedPrivacy: [...access.allowedPrivacy],
		};
		Object.freeze(snapshot.scope);
		Object.freeze(snapshot.allowedPrivacy);
		Object.freeze(snapshot);
		return { repo, access: snapshot };
	}

	async function checked(cwd: string, supplied: ContextAccess, signal?: AbortSignal) {
		const current = await identity(cwd, signal);
		assertSameAccess(supplied, current.access);
		return current;
	}

	async function storage(repo: string, create: boolean): Promise<string> {
		let current = repo;
		for (const part of [".veyyon", "approved-context"]) {
			current = join(current, part);
			try {
				const info = await stat(current);
				if (!info.isDirectory()) throw new Error("Approved context path is not a directory");
				if ((await realpath(current)) !== current) throw new Error("Symlink in approved context path is not allowed");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error;
				try {
					await mkdir(current, { mode: 0o700 });
				} catch (mkdirError) {
					if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
				}
			}
		}
		const resolved = await realpath(current);
		const rel = relative(repo, resolved);
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Approved context path escapes checkout");
		return resolved;
	}

	function filename(record: Pick<ApprovedContextRecord, "id" | "revision">) {
		return `${digest(`${record.id}\0${record.revision}`)}.json`;
	}

	async function loadFile(path: string, access: ContextAccess) {
		const info = await stat(path);
		if (!info.isFile() || info.size > MAX_RECORD_BYTES) throw new Error("Invalid approved context file size");
		const raw = await readFile(path);
		if (raw.byteLength > MAX_RECORD_BYTES) throw new Error("Approved context file exceeds size limit");
		let parsed: unknown;
		try { parsed = JSON.parse(raw.toString("utf8")); } catch { throw new Error("Invalid approved context JSON"); }
		return validateRecord(parsed, access);
	}

	async function readAll(repo: string, access: ContextAccess) {
		const directory = await storage(repo, false);
		const files = await readdir(directory);
		const records: ApprovedContextRecord[] = [];
		for (const file of files.sort()) {
			if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
			const path = join(directory, file);
			if ((await realpath(path)) !== path) throw new Error("Symlink in approved context records is not allowed");
			const record = await loadFile(path, access);
			if (filename(record) !== file) throw new Error("Approved context filename identity mismatch");
			records.push(record);
		}
		return records;
	}

	function references(records: ApprovedContextRecord[]): ContextReference[] {
		return records.map(record => ({
			text: record.body,
			title: record.kind,
			source: record.source.uri,
			timestamp: record.approval.at,
		}));
	}

	async function recordsOrEmpty(repo: string, access: ContextAccess): Promise<ApprovedContextRecord[]> {
		try {
			return await readAll(repo, access);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}

	async function publish(cwd: string, access: ContextAccess, record: ApprovedContextRecord, signal?: AbortSignal): Promise<ContextReceipt> {
		const { repo } = await checked(cwd, access, signal);
		assertPublishable(record, access);
		const serialized = canonical(record);
		const bytes = Buffer.from(serialized, "utf8");
		if (bytes.byteLength > MAX_RECORD_BYTES) throw new Error("Approved context record exceeds size limit");
		const directory = await storage(repo, true);
		const path = join(directory, filename(record));
		if ((await realpath(dirname(path))) !== directory) throw new Error("Approved context path escaped checkout");
		let status: "stored" | "duplicate" = "stored";
		const temporary = join(directory, `.${randomUUID()}.tmp`);
		let handle: FileHandle | undefined;
		try {
			handle = await open(temporary, "wx", 0o600);
			await handle.writeFile(bytes);
			await handle.sync();
			await handle.close();
			handle = undefined;
			try {
				await checked(cwd, access, signal);
				await link(temporary, path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				await checked(cwd, access, signal);
				const existingInfo = await lstat(path);
				if (!existingInfo.isFile() || existingInfo.isSymbolicLink() ||
					(await realpath(path)) !== path || existingInfo.size > MAX_RECORD_BYTES)
					throw new Error("Invalid approved context destination");
				const existing = await readFile(path);
				if (!existing.equals(bytes)) throw new Error("Approved context revision conflict");
				status = "duplicate";
			}
		} finally {
			await handle?.close().catch(() => undefined);
			await unlink(temporary).catch(() => undefined);
		}
		return {
			status,
			id: record.id,
			revision: record.revision,
			contentDigest: record.contentDigest,
			message: status === "stored" ? "Stored locally in the selected Git checkout; no commit or push was performed." : "Identical approved record already exists locally.",
			provider: { storage: "local", git: "trackable", checkout: repo },
		};
	}

	return {
		name: "git",
		resolve: async (cwd, signal) => (await identity(cwd, signal)).access,
		list: async (cwd, access, signal) => {
			const { repo } = await checked(cwd, access, signal);
			return recordsOrEmpty(repo, access);
		},
		read: async (cwd, access, id, signal) => {
			const { repo } = await checked(cwd, access, signal);
			return (await recordsOrEmpty(repo, access)).find(record => record.id === id);
		},
		search: async (cwd, access, query, signal) => {
			const { repo } = await checked(cwd, access, signal);
			const term = query.toLocaleLowerCase();
			return (await recordsOrEmpty(repo, access)).filter(record =>
				`${record.body}\n${record.kind}\n${record.author}`.toLocaleLowerCase().includes(term));
		},
		publish: (cwd, access, record, signal) => publish(cwd, access, record, signal),
		recentReferences: async (cwd, access, signal) => {
			const { repo } = await checked(cwd, access, signal);
			return references(await recordsOrEmpty(repo, access));
		},
		searchReferences: async (cwd, access, query, signal) => {
			const { repo } = await checked(cwd, access, signal);
			const term = query.toLocaleLowerCase();
			return references(await recordsOrEmpty(repo, access)).filter(reference =>
				`${reference.title ?? ""}\n${reference.text}`.toLocaleLowerCase().includes(term));
		},
		publishHandoff: (cwd, access, record, signal) => publish(cwd, access, record, signal),
	};
}
