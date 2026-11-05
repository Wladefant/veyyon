import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import type { ExtensionAPI } from "@veyyon/coding-agent";
import {
	assertPublishable,
	assertSameAccess,
	validateRecord,
	type ApprovedContextRecord,
	type ContextAccess,
	type ContextReference,
	type ContextReceipt,
	type ContextScope,
	type TeamContextProvider,
} from "./team-context";

type Project = {
	email: string;
	directory: string;
	team_id: string;
	repo_id: string;
};
export type SageOxWindowsConfig = { distro?: string; binary?: string; systemRoot?: string };
const MAX_RECORD_BYTES = 300 * 1024;
const MAX_REFERENCE_BYTES = 4000;
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export function createSageOxProvider(
	pi: Pick<ExtensionAPI, "exec" | "zod">,
	teamID = process.env.VEYYON_SAGEOX_TEAM_ID,
	windows: SageOxWindowsConfig | undefined = process.platform === "win32"
		? { distro: process.env.VEYYON_SAGEOX_WSL_DISTRO, binary: process.env.VEYYON_SAGEOX_WSL_OX, systemRoot: process.env.SystemRoot }
		: undefined,
	scope?: ContextScope,
): TeamContextProvider {
	const { z } = pi.zod;
	const importReceiptShape = z.discriminatedUnion("status", [
		z.object({
			status: z.literal("imported"),
			team_id: z.string(),
			source_oid: z.string(),
			path: z.string(),
		}),
		z.object({ status: z.literal("already_imported"), id: z.string().min(1) }),
	]);
	const neutralScope = scope
		? Object.freeze({ team: scope.team, repository: scope.repository })
		: process.env.VEYYON_CONTEXT_TEAM && process.env.VEYYON_CONTEXT_REPOSITORY
			? Object.freeze({ team: process.env.VEYYON_CONTEXT_TEAM, repository: process.env.VEYYON_CONTEXT_REPOSITORY })
			: undefined;
	const statusShape = z.object({
		auth: z.object({ authenticated: z.literal(true), endpoint: z.literal("sageox.ai"), email: z.string().optional() }),
		project: z.object({
			initialized: z.literal(true),
			directory: z.string(),
			team_id: z.string(),
			repo_id: z.string().regex(/^repo_[a-zA-Z0-9-]+$/),
		}),
		team_contexts: z.array(z.object({ team_id: z.string(), exists: z.boolean(), is_repo_team: z.boolean().optional() })),
	});
	const referenceShape = z.object({
		text: z.string(),
		title: z.string().optional(),
		url: z.string().optional(),
		source_id: z.string().optional(),
		id: z.string().optional(),
		file_path: z.string().optional(),
		timestamp: z.string().optional(),
	});
	async function run(cwd: string, args: string[], signal?: AbortSignal, program: "ox" | "wslpath" = "ox"): Promise<string> {
		let executable = "/usr/bin/env";
		const endpoint = "SAGEOX_ENDPOINT=https://sageox.ai";
		let argv = [endpoint, program, ...args];
		if (windows) {
			const { distro, systemRoot, binary = "/usr/local/bin/ox" } = windows;
			if (!distro || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(distro) || !systemRoot || !win32.isAbsolute(systemRoot) || !posix.isAbsolute(binary))
				throw new Error("Select a WSL distribution and an absolute Linux ox binary path.");
			executable = win32.join(systemRoot, "System32", "wsl.exe");
			argv = ["--distribution", distro, "--cd", cwd, "--exec", ...(program === "ox" ? ["/usr/bin/env", endpoint, binary] : ["/usr/bin/wslpath"]), ...args];
		}
		const response = await pi.exec(executable, argv, { cwd, signal, timeout: args[0] === "import" ? 120_000 : 30_000 });
		if (response.killed || response.code !== 0) throw new Error(`ox ${args[0]} did not complete. Check ox status --json in this checkout.`);
		return response.stdout.trim();
	}
	async function project(cwd: string, signal?: AbortSignal) {
		if (!teamID || !/^team_[a-zA-Z0-9-]+$/.test(teamID)) throw new Error("Set VEYYON_SAGEOX_TEAM_ID to the enrolled team ID.");
		const status = statusShape.parse(JSON.parse(await run(cwd, ["status", "--json"], signal)));
		const p = { ...status.project, email: status.auth.email?.trim().toLowerCase() ?? "" };
		if (p.team_id !== teamID || !posix.isAbsolute(p.directory) ||
			!status.team_contexts.some(tc => tc.team_id === teamID && tc.exists && tc.is_repo_team))
			throw new Error("SageOx account, project or local team context does not match the enrolled team.");
		if (!p.email) throw new Error("Sign in to SageOx as an individual coworker before publishing.");
		return p;
	}
	function accessFor(p: Project): ContextAccess {
		const boundScope = neutralScope ?? { team: `sageox:${p.team_id}`, repository: `sageox:${p.repo_id}` };
		const allowedPrivacy: ContextAccess["allowedPrivacy"] = ["repository", "team"];
		Object.freeze(allowedPrivacy);
		return Object.freeze({
			scope: Object.freeze({ team: boundScope.team, repository: boundScope.repository }),
			actor: p.email,
			binding: `sageox.ai|${p.team_id}|${p.repo_id}|${p.directory}|${p.email}`,
			allowedPrivacy,
		});
	}
	async function recheck(cwd: string, access: ContextAccess, signal?: AbortSignal) {
		const current = accessFor(await project(cwd, signal));
		assertSameAccess(access, current);
		return current;
	}
	const approved = (value: unknown, access: ContextAccess) => {
		if (typeof value === "string") {
			try { value = JSON.parse(value); } catch { return undefined; }
		}
		try { return validateRecord(value, access); } catch { return undefined; }
	};
	async function query(cwd: string, access: ContextAccess, queryText: string, signal?: AbortSignal): Promise<unknown[]> {
		const current = await project(cwd, signal);
		assertSameAccess(access, accessFor(current));
		const raw = z.object({ team_context: z.object({ results: z.array(z.unknown()).nullable() }) }).parse(
			JSON.parse(await run(cwd, ["query", "--json", "--source", "team", "--team", teamID!, "--repo", current.repo_id, "--limit", "10", "--", queryText], signal)),
		);
		return (raw.team_context.results ?? []).slice(0, 10);
	}
	async function references(cwd: string, access: ContextAccess, queryText: string, signal?: AbortSignal): Promise<ContextReference[]> {
		const rows = await query(cwd, access, queryText, signal);
		return rows.flatMap(row => {
			const parsed = referenceShape.safeParse(row);
			if (!parsed.success) return [];
			return [{ text: parsed.data.text.slice(0, MAX_REFERENCE_BYTES), title: parsed.data.title, source: parsed.data.source_id ?? parsed.data.url ?? parsed.data.file_path }];
		});
	}
	async function handoffRows(cwd: string, access: ContextAccess, signal?: AbortSignal) {
		await recheck(cwd, access, signal);
		const raw = z.object({ murmurs: z.array(z.object({ content: z.string(), id: z.string().optional(), timestamp: z.string().optional() })) })
			.parse(JSON.parse(await run(cwd, ["murmur", "list", "--scope=ledger", "--topic=handoff", "--since=24h", "--limit=10", "--json"], signal)));
		return raw.murmurs.slice(0, 10);
	}
	const provider: TeamContextProvider = {
		name: "sageox",
		async resolve(cwd, signal) { return accessFor(await project(cwd, signal)); },
		async list(cwd, access, signal) { return provider.search(cwd, access, "Veyyon approved", signal); },
		async read(cwd, access, id, signal) { return (await provider.search(cwd, access, id, signal)).find(record => record.id === id); },
		async search(cwd, access, text, signal) {
			const rows = await query(cwd, access, text, signal);
			return rows.flatMap(row => {
				const candidate = row && typeof row === "object" && "text" in row ? row.text : undefined;
				const record = approved(candidate, access);
				return record ? [record] : [];
			});
		},
		async publish(cwd, access, record, signal): Promise<ContextReceipt> {
			assertPublishable(record, access);
			if (!neutralScope || record.privacy !== "team") throw new Error("Portable SageOx publication requires an explicit neutral scope and team privacy.");
			const serialized = JSON.stringify(record);
			const bytes = Buffer.from(serialized, "utf8");
			if (bytes.byteLength > MAX_RECORD_BYTES) throw new Error("Approved context record exceeds the SageOx import limit.");
			const digest = `sha256:${sha256(bytes)}`;
			const title = `Veyyon approved ${record.id.slice(0, 16)} ${sha256(bytes).slice(0, 16)}`;
			const dir = await mkdtemp(join(tmpdir(), "veyyon-sageox-"));
			try {
				const path = join(dir, "approved-context.json");
				await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
				const importPath = windows ? await run(cwd, ["-a", "-u", path], signal, "wslpath") : path;
				if (!posix.isAbsolute(importPath) || /[\r\n\0]/.test(importPath)) throw new Error("Cannot map the approved record into the selected WSL distribution.");
				await recheck(cwd, access, signal);
				const raw = await run(cwd, ["import", "--json", "--team", teamID!, "--title", title, "--text", importPath, "--", importPath], signal);
				const receipt = importReceiptShape.parse(JSON.parse(raw));
				if (receipt.status === "imported") {
					const pathSuffix = `veyyon-approved-${record.id.slice(0, 16)}-${sha256(bytes).slice(0, 16)}`;
					if (receipt.team_id !== teamID || receipt.source_oid !== digest ||
						!/^data\/docs\/\d{4}\/\d{2}\/\d{2}\/[^/]+$/.test(receipt.path) ||
						!receipt.path.endsWith(pathSuffix))
						throw new Error("SageOx import receipt does not match the approved record bytes.");
					return { status: "stored", id: record.id, revision: record.revision, contentDigest: record.contentDigest, message: `Imported ${receipt.path}`, provider: { name: "sageox", path: receipt.path, durable: "team-context" } };
				}
				return { status: "duplicate", id: record.id, revision: record.revision, contentDigest: record.contentDigest, message: `Already imported: ${receipt.id}`, provider: { name: "sageox", path: receipt.id, durable: "team-context" } };
			} finally { await rm(dir, { recursive: true, force: true }); }
		},
		async recentReferences(cwd, access, signal) {
			const rows = await handoffRows(cwd, access, signal);
			return rows.map(row => ({ text: row.content.slice(0, 500), title: "Untrusted SageOx handoff", source: row.id, timestamp: row.timestamp }));
		},
		async searchReferences(cwd, access, text, signal) { return references(cwd, access, text, signal); },
		async publishHandoff(cwd, access, record, signal) {
			assertPublishable(record, access);
			if (record.privacy !== "repository") throw new Error("SageOx handoffs require repository privacy.");
			const content = record.body;
			if (!content.trim() || Buffer.byteLength(content) > 500) throw new Error("Provide 1–500 UTF-8 bytes of handoff text.");
			await recheck(cwd, access, signal);
			const response = await run(cwd, ["murmur", "--topic=handoff", "--scope=ledger", "--", JSON.stringify({ content })], signal);
			const status = /queued/i.test(response) ? "queued" : "stored";
			return { status, id: record.id, revision: record.revision, contentDigest: record.contentDigest, message: response, provider: { name: "sageox", scope: "ledger", durable: "false" } };
		},
	};
	return provider;
}
