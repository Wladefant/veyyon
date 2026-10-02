/**
 * The small, shared pieces of GitHub view rendering and argument shaping. Two modules deep, and that
 * is the whole point: everything here is a pure function over strings and small records.
 *
 * WHY THESE LIVE TOGETHER AND WHY HERE. `tools/web/gh.ts` is the `github` tool, and `tools/web/gh-fetch.ts` is
 * the cache-aware issue/PR/diff fetcher that both the tool and the `issue://` and `pr://` protocol
 * handlers call. Both sides normalise the same text, name the same `--repo` flag and print the same
 * author and label lines, so these helpers had to end up in exactly one of three places: duplicated
 * (banned), in the tool (which would put the tool's 352-module graph on the protocol handlers' path), or
 * here. This module already owned `formatShortSha` for the same reason.
 *
 * `ToolError` is the one import, for `requireNonEmpty`: an empty `--repo` or issue identifier is a
 * caller mistake and has to surface as the same error class every other tool argument failure uses.
 * `tools/core/tool-errors.ts` is itself a leaf, so this module reaches two, and a single import here is paid
 * by every GitHub surface. Keep it that way.
 */

import { ToolError } from "../core/tool-errors";

/**
 * Return the first 12 hex characters of a commit SHA, or undefined when the
 * input is missing. Shared between GitHub tool argument normalization and the
 * run-watch renderer.
 */
export function formatShortSha(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	return value.slice(0, 12);
}

export interface GhUser {
	login?: string;
	name?: string | null;
}

export interface GhLabel {
	name?: string;
}

export function normalizeText(value: string | null | undefined): string {
	return (value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\t", "    ").trim();
}

export function normalizeBlock(value: string | null | undefined): string {
	return (value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\t", "    ").trimEnd();
}

export function normalizeOptionalString(value: string | null | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

export function requireNonEmpty(value: string | null | undefined, label: string): string {
	const normalized = normalizeOptionalString(value);
	if (!normalized) {
		throw new ToolError(`${label} must not be empty`);
	}
	return normalized;
}

export function appendRepoFlag(args: string[], repo: string | undefined, identifier?: string): void {
	// A full URL identifier already names host, repo, and number; `gh` derives
	// all three from it and rejects a competing `--repo`.
	if (!repo || identifier?.startsWith("https://")) {
		return;
	}

	args.push("--repo", repo);
}

/** The host `gh` assumes when a ref names none and `GH_HOST` is unset. */
export const GITHUB_HOST = "github.com";

/**
 * A repository in the GitHub CLI's `[HOST/]OWNER/REPO` form. A ref that names
 * no host is left for `gh` to resolve against `GH_HOST` (github.com by
 * default), so a host that is known — including github.com itself — is worth
 * keeping: it is what pins the request to the right instance.
 */
export interface GhRepoRef {
	/** Host this repo lives on, or undefined when unknown. */
	host?: string;
	/** `OWNER/REPO`, never host-qualified. */
	slug: string;
}

/** Split `[HOST/]OWNER/REPO`; anything with another shape is taken as a slug. */
export function parseRepoRef(repo: string): GhRepoRef {
	const firstSlash = repo.indexOf("/");
	if (firstSlash < 0) return { slug: repo };
	const secondSlash = repo.indexOf("/", firstSlash + 1);
	if (secondSlash < 0 || repo.includes("/", secondSlash + 1)) return { slug: repo };
	return { host: repo.slice(0, firstSlash), slug: repo.slice(firstSlash + 1) };
}

/** Join a known host and `OWNER/REPO` into the form `--repo` accepts. */
export function formatRepoRef(host: string | undefined, slug: string): string {
	return host ? `${host}/${slug}` : slug;
}

/**
 * `gh api` endpoint paths carry no host, so a ref has to name its host with a
 * flag instead.
 */
export function ghApiHostArgs(ref: GhRepoRef): string[] {
	return ref.host ? ["--hostname", ref.host] : [];
}

const REPO_URL_PATTERN = /^https?:\/\/([^/]+)\/([^/]+)\/([^/?#]+)/;

/**
 * `https://HOST/OWNER/REPO` → the repository's identity: `OWNER/REPO` on
 * github.com, `HOST/OWNER/REPO` anywhere else. Used for the session
 * checkout, whose identity should read the way users write it.
 */
export function repoFromUrl(value: string | undefined): string | undefined {
	const match = REPO_URL_PATTERN.exec(value?.trim() ?? "");
	if (!match) return undefined;
	const host = match[1].toLowerCase();
	const slug = `${match[2]}/${match[3]}`;
	return host === GITHUB_HOST ? slug : formatRepoRef(host, slug);
}

/**
 * Case-insensitive repo comparison. Hosts are compared only when both sides
 * name one: a host-less ref means "wherever `gh` resolves it", so it must not
 * be declared a mismatch against the same slug on a named host.
 */
export function githubRepoSlugEquals(left: string | undefined, right: string): boolean {
	if (left === undefined) return false;
	const leftRef = parseRepoRef(left);
	const rightRef = parseRepoRef(right);
	if (leftRef.host && rightRef.host && leftRef.host.toLowerCase() !== rightRef.host.toLowerCase()) {
		return false;
	}
	return leftRef.slug.toLowerCase() === rightRef.slug.toLowerCase();
}

export function formatAuthor(author: GhUser | null | undefined): string | undefined {
	if (!author) return undefined;
	if (author.login) return `@${author.login}`;
	if (author.name) return author.name;
	return undefined;
}

export function formatLabels(labels: GhLabel[] | undefined): string | undefined {
	const names = labels?.map(label => label.name).filter((value): value is string => Boolean(value)) ?? [];
	if (names.length === 0) return undefined;
	return names.join(", ");
}

export function pushLine(lines: string[], label: string, value: string | number | boolean | undefined): void {
	if (value === undefined || value === "") return;
	lines.push(`${label}: ${value}`);
}

/**
 * Parse a digit-only decimal positive integer or return undefined. Rejects
 * `1e2`, `0x10`, `12.0`, leading +/-, or any other shape `Number()` would
 * accept — those would otherwise key the cache against the wrong row.
 */
export function parsePositiveDecimalInt(value: string | undefined): number | undefined {
	if (!value || !/^\d+$/.test(value)) return undefined;
	const num = Number(value);
	if (!Number.isSafeInteger(num) || num <= 0) return undefined;
	return num;
}

