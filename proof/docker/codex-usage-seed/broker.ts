// Runs a real auth broker holding two Codex OAuth logins. Its usage fetch is
// answered locally: each account reports a chat meter and a Spark meter over
// the same 5-hour and weekly windows, so `veyyon usage` has two meters per
// window to keep apart. Everything after the fetch (the Codex usage parser,
// the broker's /v1/usage route, the CLI client and its formatter) is the
// shipped code.
//   bun broker.ts <port> <token> <db-path>
import { startAuthBroker } from "../../../packages/ai/src/auth-broker/server";
import { AuthStorage } from "../../../packages/ai/src/auth-storage";
// The usage backends register on import; the broker the CLI starts imports this too.
import "../../../packages/ai/src/usage/defaults";

const [port = "18431", token = "proof-token", dbPath = "/tmp/codex-usage-broker.db"] = process.argv.slice(2);

const window = (usedPercent: number, seconds: number, resetAfter: number) => ({
	used_percent: usedPercent,
	limit_window_seconds: seconds,
	reset_after_seconds: resetAfter,
});

const payload = (chat: [number, number], spark: [number, number]) => ({
	plan_type: "pro",
	rate_limit: {
		allowed: true,
		limit_reached: false,
		primary_window: window(chat[0], 18_000, 7_200),
		secondary_window: window(chat[1], 604_800, 302_400),
	},
	additional_rate_limits: [
		{
			limit_name: "GPT-5.3-Codex-Spark",
			metered_feature: "codex_bengalfox",
			rate_limit: {
				allowed: true,
				limit_reached: false,
				primary_window: window(spark[0], 18_000, 9_000),
				secondary_window: window(spark[1], 604_800, 410_000),
			},
		},
	],
});

const usageByAccount: Record<string, object> = {
	"acct-demo-1": payload([20, 10], [90, 80]),
	"acct-demo-2": payload([40, 30], [100, 60]),
};

const usageFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
	const url = String(input instanceof Request ? input.url : input);
	const account = new Headers(init?.headers).get("chatgpt-account-id") ?? "";
	const body = url.includes("/wham/usage") ? usageByAccount[account] : undefined;
	return new Response(JSON.stringify(body ?? { error: "not found" }), {
		status: body ? 200 : 404,
		headers: { "Content-Type": "application/json" },
	});
};

const storage = await AuthStorage.create(dbPath, { usageFetch: usageFetch as typeof fetch });
const expires = Date.now() + 86_400_000;
const claims = (accountId: string, email: string) =>
	Buffer.from(
		JSON.stringify({
			exp: Math.floor(expires / 1000),
			"https://api.openai.com/auth": { chatgpt_account_id: accountId },
			"https://api.openai.com/profile": { email },
		}),
	).toString("base64url");
const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
await storage.set(
	"openai-codex",
	[
		{ accountId: "acct-demo-1", email: "first@example.com" },
		{ accountId: "acct-demo-2", email: "second@example.com" },
	].map(({ accountId, email }) => ({
		type: "oauth" as const,
		access: `${header}.${claims(accountId, email)}.proof`,
		refresh: `refresh-${accountId}`,
		expires,
		accountId,
		email,
	})),
);

startAuthBroker({ storage, bind: `127.0.0.1:${port}`, bearerTokens: [token], disableRefresher: true });
