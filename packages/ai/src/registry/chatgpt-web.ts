import type { ProviderDefinition } from "./types";

/**
 * The local `codex-chatgpt-web` Responses bridge.
 *
 * No `login` and no `refreshToken`, and both absences are deliberate. The
 * bridge runs on loopback and authenticates the browser side itself, through a
 * Chrome profile the user signs in to once with the daemon's own `setup`
 * command; there is no OAuth flow Veyyon could drive and no token it should
 * mint. Its catalog request needs the ChatGPT/Codex bearer, which the catalog
 * table supplies from the environment (`CODEX_CHATGPT_WEB_OAUTH_TOKEN`, then
 * `OPENAI_CODEX_OAUTH_TOKEN`).
 *
 * Declaring a `login` here would put a second "ChatGPT Plus/Pro" row in the
 * `/login` list that mints credentials for the OFFICIAL provider, which is
 * exactly the confusion between the two that has to stay impossible:
 * `openai-codex` keeps its own flow, its own credentials and its own host.
 */
export const chatgptWebProvider = {
	id: "chatgpt-web",
	name: "ChatGPT Web (local codex-chatgpt-web bridge)",
} as const satisfies ProviderDefinition;
