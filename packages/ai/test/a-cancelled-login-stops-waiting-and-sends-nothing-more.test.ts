/**
 * WHY: a sign-in waits on the person at the keyboard (for a browser redirect, for a device code to be
 * approved, or for the answer to a prompt) and Esc aborts the controller's `signal`. Cursor's poll never
 * read that signal: after Esc the dialog closed, the poll ran on for up to twenty minutes, and a browser
 * approval that came later stored the credential anyway. Kilo and the Codex device login slept through the
 * abort on `Bun.sleep`, Kimi surfaced the raw `AbortError` of its wait, and Perplexity reported the empty
 * answer of a cancelled prompt as a missing email. The start request of Kilo, Kimi, xAI and the Codex
 * device login, and the poll request of Copilot and the Codex device login, were sent without the signal,
 * so Esc on a request that hung waited out the request; Perplexity's surfaced the raw `AbortError`.
 *
 * Class closed: every provider in the registry whose credential is OAuth is driven to each point where
 * its login waits on the user or the network (each prompt it shows, each request it makes before that
 * wait when the request hangs, the sign-in URL it hands over, and the first poll after that, answered
 * "not approved yet", "approved", or never) and aborted there. The login must reject with `LoginCancelledError` within
 * `CANCEL_BOUND_MS` and start no request after the abort, so an approval that lands after the abort
 * stores no credential. A provider with no fixture fails the roster test, so a new OAuth provider stays
 * red until its fixture states how it waits.
 *
 * Not caught: a wait after the token arrives (account lookup, model enablement, project provisioning),
 * which no fixture reaches; a provider whose real server answers differently from its fixture; and an
 * abort the login honours only on a path its fixture does not take.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { LoginCancelledError } from "@veyyon/ai/error";
import { PROVIDER_REGISTRY } from "@veyyon/ai/registry";
import type { ProviderDefinition } from "@veyyon/ai/registry/types";
import type { FetchImpl } from "@veyyon/ai/types";

afterEach(() => {
	vi.restoreAllMocks();
});

/** Time a login gets, after its abort, to reject. A wait that ignores the abort runs past it. */
const CANCEL_BOUND_MS = 1000;
/** Time a fixture gets to bring its login to the wait under test. */
const REACH_BOUND_MS = 2000;

type Answer = { status: number; body?: Record<string, unknown> };

/** How a login waits on the user once it has handed over the sign-in URL, if it hands one over. */
type LoginFixture =
	/** A loopback redirect or a pasted one; nothing is requested while it waits. */
	| { waits: "redirect" }
	/**
	 * A device or browser approval polled at the provider: `pending` answers "not approved yet" and
	 * `approved` answers with the grant.
	 */
	| { waits: "poll"; prompts?: readonly string[]; pending: Answer; approved: Answer }
	/** Answers typed into prompts and nothing else. */
	| { waits: "prompts"; prompts: readonly string[] };

const RFC_PENDING: Answer = { status: 400, body: { error: "authorization_pending" } };
const RFC_APPROVED: Answer = {
	status: 200,
	body: { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 },
};

const FIXTURES: Readonly<Record<string, LoginFixture>> = {
	anthropic: { waits: "redirect" },
	cursor: {
		waits: "poll",
		pending: { status: 404 },
		approved: { status: 200, body: { accessToken: "access-1", refreshToken: "refresh-1" } },
	},
	devin: { waits: "redirect" },
	"github-copilot": {
		waits: "poll",
		prompts: [""],
		pending: { status: 200, body: { error: "authorization_pending" } },
		approved: { status: 200, body: { access_token: "access-1" } },
	},
	"gitlab-duo": { waits: "redirect" },
	"gitlab-duo-agent": { waits: "redirect" },
	"google-antigravity": { waits: "redirect" },
	"google-gemini-cli": { waits: "redirect" },
	kilo: {
		waits: "poll",
		pending: { status: 202 },
		approved: { status: 200, body: { status: "approved", token: "access-1" } },
	},
	"kimi-code": { waits: "poll", prompts: [""], pending: RFC_PENDING, approved: RFC_APPROVED },
	"muse-code": { waits: "poll", pending: RFC_PENDING, approved: RFC_APPROVED },
	"nous-research": { waits: "poll", pending: RFC_PENDING, approved: RFC_APPROVED },
	"openai-codex": { waits: "redirect" },
	"openai-codex-device": {
		waits: "poll",
		pending: { status: 403 },
		approved: { status: 200, body: { authorization_code: "code-1", code_verifier: "verifier-1" } },
	},
	perplexity: { waits: "prompts", prompts: ["user@example.com", "123456"] },
	"xai-oauth": { waits: "poll", pending: RFC_PENDING, approved: RFC_APPROVED },
};

/**
 * The answer to every request a login makes before it hands over the sign-in URL. One body carries the
 * fields each provider's start request reads: the RFC 8628 device authorization, xAI's discovery
 * document, Kilo's and Codex's own device responses, and Perplexity's CSRF token.
 */
const START_BODY = {
	device_code: "device-1",
	user_code: "ABCD-1234",
	verification_uri: "https://auth.x.ai/device",
	verification_uri_complete: "https://auth.x.ai/device?user_code=ABCD-1234",
	expires_in: 600,
	interval: 1,
	token_endpoint: "https://auth.x.ai/oauth2/token",
	code: "ABCD-1234",
	verificationUrl: "https://kilo.ai/verify",
	expiresIn: 600,
	device_auth_id: "device-auth-1",
	csrfToken: "csrf-1",
};

type Trigger =
	| { at: "prompt"; index: number }
	| { at: "sign-in URL" }
	/**
	 * Aborted while the login's request `index` (counting from zero) is in flight; it answers only by
	 * rejecting once its own signal aborts.
	 */
	| { at: "request"; index: number }
	/**
	 * Aborted while the first poll is in flight, which then answers `pending` or `approved`, or, as a
	 * request that hangs does, answers only by rejecting once its own signal aborts.
	 */
	| { at: "first poll"; answer: "pending" | "approved" | "never" };

function triggersOf(fixture: LoginFixture): Trigger[] {
	const prompts = fixture.waits === "redirect" ? [] : (fixture.prompts ?? []);
	const triggers: Trigger[] = prompts.map((_, index) => ({ at: "prompt", index }));
	if (fixture.waits !== "prompts") triggers.push({ at: "sign-in URL" });
	if (fixture.waits === "poll") {
		for (const answer of ["pending", "approved", "never"] as const) triggers.push({ at: "first poll", answer });
	}
	return triggers;
}

function describeTrigger(trigger: Trigger): string {
	if (trigger.at === "prompt") return `prompt ${trigger.index + 1}`;
	if (trigger.at === "request") return `request ${trigger.index + 1}, which hangs`;
	if (trigger.at === "first poll") {
		return trigger.answer === "never" ? "first poll, which hangs" : `first poll, answered ${trigger.answer}`;
	}
	return trigger.at;
}

interface CancelOutcome {
	/** The login reached the wait under test and the abort fired there. */
	reached: boolean;
	/** `LoginCancelledError`, the name and message of any other rejection, "resolved", or "still running". */
	result: string;
	requestsAfterAbort: number;
	/** Requests the login made before the abort; with no abort, every request it made. */
	requestsBeforeAbort: number;
}

function answer(response: Answer): Response {
	return response.body === undefined
		? new Response(null, { status: response.status })
		: Response.json(response.body, { status: response.status });
}

async function cancelAt(def: ProviderDefinition, fixture: LoginFixture, trigger: Trigger): Promise<CancelOutcome> {
	const controller = new AbortController();
	let abortedAt = 0;
	let reached = false;
	let shownUrl = false;
	let prompts = 0;
	let requestsAfterAbort = 0;
	let requestsBeforeAbort = 0;
	const abort = () => {
		reached = true;
		abortedAt = performance.now();
		controller.abort();
	};

	/** A request that hangs: aborts the login, then rejects once its own signal aborts and never otherwise. */
	const hangUntilAborted = (signal: AbortSignal | undefined): Promise<Response> => {
		// A login that leaves the request without its abort signal waits on it forever.
		const { promise, reject } = Promise.withResolvers<Response>();
		signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
		if (!controller.signal.aborted) abort();
		else if (signal?.aborted) reject(signal.reason);
		return promise;
	};

	const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
		if (controller.signal.aborted) {
			requestsAfterAbort += 1;
			// A login that ignores the abort polls forever; end it here so it cannot spin.
			if (requestsAfterAbort > 3) throw new Error("the login kept requesting after its abort");
		} else {
			const index = requestsBeforeAbort++;
			if (trigger.at === "request" && trigger.index === index) return hangUntilAborted(init?.signal ?? undefined);
		}
		await new Promise(resolve => setImmediate(resolve));
		if (!shownUrl) return Response.json(START_BODY);
		if (fixture.waits !== "poll") return answer({ status: 404 });
		if (trigger.at !== "first poll") return answer(fixture.pending);
		if (trigger.answer === "never") return hangUntilAborted(init?.signal ?? undefined);
		if (!controller.signal.aborted) abort();
		return answer(trigger.answer === "approved" ? fixture.approved : fixture.pending);
	}) as FetchImpl;
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl as typeof fetch);
	// A redirect login binds no port here: the abort under test fires before any callback could arrive.
	vi.spyOn(Bun, "serve").mockImplementation(((options: { port?: number }) => ({
		port: options.port || 49_152,
		stop: () => undefined,
	})) as unknown as typeof Bun.serve);
	// Every wait between polls returns at the next turn of the event loop, and rejects as the real one does
	// once the signal it was given is aborted. A wait on `Bun.sleep` still takes its full time.
	vi.spyOn(scheduler, "wait").mockImplementation(async (_delay: number, options?: { signal?: AbortSignal }) => {
		await new Promise(resolve => setImmediate(resolve));
		options?.signal?.throwIfAborted();
	});

	const answers = fixture.waits === "redirect" ? [] : (fixture.prompts ?? []);
	let settledAs: string | undefined;
	const login = def.login!({
		onAuth: () => {
			shownUrl = true;
			if (trigger.at === "sign-in URL") abort();
		},
		onPrompt: async () => {
			const index = prompts++;
			if (trigger.at === "prompt" && trigger.index === index) abort();
			// The login dialog answers a prompt it closed on Esc with an empty string.
			return controller.signal.aborted ? "" : (answers[index] ?? "");
		},
		onProgress: () => undefined,
		signal: controller.signal,
		fetch: fetchImpl,
	});
	login.then(
		() => {
			settledAs = "resolved";
		},
		(error: unknown) => {
			settledAs =
				error instanceof LoginCancelledError
					? "LoginCancelledError"
					: error instanceof Error
						? `${error.name}: ${error.message}`
						: String(error);
		},
	);

	const started = performance.now();
	while (settledAs === undefined) {
		const now = performance.now();
		if (!reached && now - started > REACH_BOUND_MS) break;
		if (reached && now - abortedAt > CANCEL_BOUND_MS) break;
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	return { reached, result: settledAs ?? "still running", requestsAfterAbort, requestsBeforeAbort };
}

const OAUTH_PROVIDERS = PROVIDER_REGISTRY.filter(def => typeof def.login === "function" && def.credential === "oauth");

/** A login that was cancelled where the abort fired, in time, and sent nothing after it. */
const CANCELLED = { reached: true, result: "LoginCancelledError", requestsAfterAbort: 0 };

function verdictOf({ reached, result, requestsAfterAbort }: CancelOutcome): typeof CANCELLED {
	return { reached, result, requestsAfterAbort };
}

describe("a cancelled login stops waiting and sends nothing more", () => {
	it("records how every OAuth provider's login waits on the user", () => {
		expect(OAUTH_PROVIDERS.map(def => def.id).sort()).toEqual(Object.keys(FIXTURES).sort());
	});

	for (const def of OAUTH_PROVIDERS) {
		const fixture = FIXTURES[def.id];
		if (!fixture) continue;
		for (const trigger of triggersOf(fixture)) {
			it(`${def.id} rejects as cancelled when aborted at its ${describeTrigger(trigger)}`, async () => {
				expect(verdictOf(await cancelAt(def, fixture, trigger))).toEqual(CANCELLED);
			}, 10_000);
		}

		// The requests a login makes before it waits on the user are counted by running it to the sign-in URL
		// it hands over (to the end, for a login that hands over none), so a start request a provider adds is
		// covered without a fixture change.
		it(`${def.id} rejects as cancelled when any request before its wait hangs`, async () => {
			const { requestsBeforeAbort: startRequests } = await cancelAt(def, fixture, { at: "sign-in URL" });
			vi.restoreAllMocks();
			const verdicts: Array<typeof CANCELLED & { request: number }> = [];
			for (let index = 0; index < startRequests; index++) {
				verdicts.push({ request: index + 1, ...verdictOf(await cancelAt(def, fixture, { at: "request", index })) });
				vi.restoreAllMocks();
			}
			expect(verdicts).toEqual(
				Array.from({ length: startRequests }, (_, index) => ({ request: index + 1, ...CANCELLED })),
			);
		}, 20_000);
	}
});
