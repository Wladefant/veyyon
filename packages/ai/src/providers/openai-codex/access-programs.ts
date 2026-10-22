/**
 * The `access_programs` field of a ChatGPT Codex request (codex-rs `AccessPrograms`).
 *
 * Codex discovery lists, per model, the cyber access programs one ChatGPT account may select
 * (`available_access_programs`). A standard account is offered `standard`; a Daybreak account is also
 * offered `daybreak_blue` or `daybreak_red`, and only a Daybreak account is listed the Daybreak-only
 * models. The inference endpoint rejects a program the account or the model is not offered:
 * `daybreak_blue` on a model with no Daybreak program answers 403, a Daybreak-only model sent another
 * program answers 400, and a tier the model offers the account no access to ends the stream with
 * `invalid_access_program`. A request without the field is accepted and judged under the server's
 * automatic treatment, whose `cyber_policy` refusal states that `access_programs.cyber` must be set.
 *
 * Discovery lists every signed-in account and records, per model, each account's entry
 * ({@link Model.accountAccess}): whether the account is listed the model and the programs it is offered.
 * A request selects from the entry of the account that signs it. A model with no entry for that account
 * (a model never discovered, or an account signed in after discovery ran) lists that account's models
 * before it selects a program. A compaction lists no account: it reads the listing its turn fetched.
 */
import { fetchCodexModels } from "@veyyon/catalog/discovery/codex";
import { CODEX_BASE_URL, getCodexAccountId } from "@veyyon/catalog/wire/codex";
import { logger } from "@veyyon/utils";
import { untilAborted } from "@veyyon/utils/abortable";
import { settleWithin } from "@veyyon/utils/scoped-timeout";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import type { CyberAccessProgram, FetchImpl, ModelAccountAccess } from "../../types";

/** The `access_programs` request field. */
export interface CodexAccessPrograms {
	cyber: CyberAccessProgram;
}

/** The model fields program selection reads. */
export interface CodexAccessProgramModel {
	id: string;
	baseUrl?: string;
	accountAccess?: Readonly<Record<string, ModelAccountAccess>>;
}

/** How long one account's listing is reused. */
export const CODEX_ACCESS_PROGRAM_LISTING_TTL_MS = 60 * 60 * 1000;
/** How long a failed listing is reused before the account is listed again. */
export const CODEX_ACCESS_PROGRAM_FAILURE_TTL_MS = 60 * 1000;
/** Upper bound on one listing request. */
export const CODEX_ACCESS_PROGRAM_LISTING_TIMEOUT_MS = 5_000;

/** The account's entry for each model its listing includes, by model id. */
type AccountListing = ReadonlyMap<string, ModelAccountAccess> | null;

interface AccountListingEntry {
	expiresAt: number;
	listing: Promise<AccountListing>;
}

/** Per-account listings, keyed by base URL and account id. One entry per signed-in account. */
const accountListings = new Map<string, AccountListingEntry>();

/** Drops every per-account listing. Test seam. */
export function resetCodexAccessProgramListings(): void {
	accountListings.clear();
}

/**
 * The Daybreak program a model offers, `daybreak_blue` before `daybreak_red` as codex-rs
 * `ModelAccessPrograms::daybreak` selects, or undefined to omit the field.
 *
 * A model offering no Daybreak program omits the field rather than sending `standard`: the server
 * treats an omitted field as the automatic treatment, which accepts every model, while a model such
 * as GPT-6 Astra works under either.
 */
export function selectCodexAccessPrograms(
	cyber: readonly CyberAccessProgram[] | undefined,
): CodexAccessPrograms | undefined {
	if (cyber === undefined) return undefined;
	if (cyber.includes("daybreak_blue")) return { cyber: "daybreak_blue" };
	if (cyber.includes("daybreak_red")) return { cyber: "daybreak_red" };
	return undefined;
}

/** One account's model listing, or null when it could not be read. Never rejects. */
async function fetchAccountListing(
	baseUrl: string,
	accessToken: string,
	accountId: string,
	fetchImpl: FetchImpl | undefined,
): Promise<AccountListing> {
	try {
		const discovered = await fetchCodexModels({
			accessToken,
			accountId,
			baseUrl,
			fetchFn: fetchImpl,
			signal: AbortSignal.timeout(CODEX_ACCESS_PROGRAM_LISTING_TIMEOUT_MS),
			onFailure: ({ stage, detail }) => logger.debug("Codex access program listing failed", { stage, detail }),
		});
		if (!discovered) return null;
		const listing = new Map<string, ModelAccountAccess>();
		for (const model of discovered.models) {
			const entry = model.accountAccess?.[accountId];
			if (entry) listing.set(model.id, entry);
		}
		return listing;
	} catch (error) {
		logger.debug("Codex access program listing failed", { error: String(error) });
		return null;
	}
}

/**
 * The account's listing, shared by every request of the account until it expires. With `reuseOnly`, a
 * listing already fetched or in flight, or undefined when there is none; nothing is fetched.
 */
function listAccountPrograms(
	baseUrl: string,
	accessToken: string,
	accountId: string,
	fetchImpl: FetchImpl | undefined,
	reuseOnly: boolean,
): Promise<AccountListing> | undefined {
	const key = `${baseUrl}\n${accountId}`;
	const now = Date.now();
	const cached = accountListings.get(key);
	if (cached && cached.expiresAt > now) return cached.listing;
	if (reuseOnly) return undefined;

	const entry: AccountListingEntry = {
		expiresAt: now + CODEX_ACCESS_PROGRAM_LISTING_TTL_MS,
		listing: fetchAccountListing(baseUrl, accessToken, accountId, fetchImpl),
	};
	void entry.listing.then(listing => {
		if (listing === null) entry.expiresAt = Date.now() + CODEX_ACCESS_PROGRAM_FAILURE_TTL_MS;
	});
	accountListings.set(key, entry);
	return entry.listing;
}

/**
 * The `access_programs` a Codex request signed with `accessToken` carries for `model`, or undefined to
 * omit the field.
 *
 * The request's account is the `chatgpt-account-id` the request sends: `options.accountId` when the
 * caller sends its own, else the account the access token names. A model with an entry for that account
 * selects from the entry's programs with no request, and an entry stating the account is not listed the
 * model omits the field. A model with no entry for the account selects from the account's own listing,
 * fetched once per account and backend and reused for {@link CODEX_ACCESS_PROGRAM_LISTING_TTL_MS}.
 * A token that names no account, a model the listing does not include, a listing that fails, and a
 * caller already aborted all omit the field; the aborted caller lists nothing.
 *
 * `options.waitMs` bounds how long this caller waits for a listing in flight. Past it the field is
 * omitted and the listing keeps running for the account's later requests, so a caller with a deadline
 * shorter than {@link CODEX_ACCESS_PROGRAM_LISTING_TIMEOUT_MS} keeps that deadline.
 *
 * `options.reuseListing` reads only a listing of the account already fetched or in flight and fetches
 * none; with no such listing the field is omitted.
 *
 * Rejects only when `options.signal` aborts while a listing is in flight.
 */
export async function resolveCodexAccessPrograms(
	model: CodexAccessProgramModel,
	accessToken: string,
	options: {
		accountId?: string;
		fetch?: FetchImpl;
		signal?: AbortSignal;
		waitMs?: number;
		reuseListing?: boolean;
	} = {},
): Promise<CodexAccessPrograms | undefined> {
	const accountId = options.accountId ?? getCodexAccountId(accessToken);
	if (!accountId) return undefined;
	const entry = model.accountAccess?.[accountId];
	if (entry !== undefined) return selectCodexAccessPrograms(entry.cyber);
	if (options.signal?.aborted) return undefined;
	// A Codex base URL may name the backend root, its `/codex` route or the `/codex/responses` endpoint, as
	// the turn's URL resolution accepts; the listing is read under the root, so every spelling shares it.
	const backendRoot = trimTrailingSlashes(model.baseUrl?.trim() || CODEX_BASE_URL).replace(
		/\/codex(?:\/responses)?$/,
		"",
	);
	const listing = listAccountPrograms(
		backendRoot,
		accessToken,
		accountId,
		options.fetch,
		options.reuseListing === true,
	);
	if (!listing) return undefined;
	const waitMs = options.waitMs;
	const offered = await untilAborted(
		options.signal,
		waitMs !== undefined && waitMs > 0 ? settleWithin(listing, waitMs, null) : listing,
	);
	return selectCodexAccessPrograms(offered?.get(model.id)?.cyber);
}
