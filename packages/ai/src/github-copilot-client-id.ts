/**
 * The OAuth client ID Veyyon uses for the GitHub Copilot device-code login: one owner, and nothing else.
 *
 * Veyyon ships NO client ID of its own and borrows none from another product. The ID is the operator's
 * own GitHub OAuth app (device flow enabled), supplied through `VEYYON_GITHUB_COPILOT_CLIENT_ID` or the
 * `providers.githubCopilot.oauthClientId` setting. The harness writes the setting here; the login flow
 * reads it once per login. This module imports nothing, so the settings store can name the setter
 * without pulling in the OAuth flow.
 *
 * Stored Copilot logins are NOT tied to a client ID: the stored GitHub token is used as-is and refresh
 * returns the same token. The ID matters only while `/login github-copilot` runs the device flow.
 */

/** Environment variable that carries the client ID. It wins over the setting. */
export const GITHUB_COPILOT_CLIENT_ID_ENV = "VEYYON_GITHUB_COPILOT_CLIENT_ID";

let configuredClientId: string | undefined;

/**
 * Set the client ID from settings. `undefined`, an empty string or whitespace CLEARS it, so a removed
 * setting does not leave the previous ID in force.
 */
export function configureGitHubCopilotOAuthClientId(clientId: string | undefined): void {
	const trimmed = clientId?.trim();
	configuredClientId = trimmed ? trimmed : undefined;
}

/** The client ID in force (environment first, then the setting), or `undefined` when none is configured. */
export function resolveGitHubCopilotOAuthClientId(): string | undefined {
	const fromEnv = process.env[GITHUB_COPILOT_CLIENT_ID_ENV]?.trim();
	return fromEnv ? fromEnv : configuredClientId;
}

/** The message `/login github-copilot` fails with when no client ID is configured. */
export const GITHUB_COPILOT_CLIENT_ID_MISSING_MESSAGE =
	"GitHub Copilot login needs your own GitHub OAuth app. Veyyon ships no client ID. " +
	"Register one at https://github.com/settings/developers (OAuth Apps, New OAuth App; " +
	'for GitHub Enterprise use the same page on your enterprise host), enable "Enable Device Flow", ' +
	`then set the app's Client ID in the \`providers.githubCopilot.oauthClientId\` setting or in ${GITHUB_COPILOT_CLIENT_ID_ENV}, ` +
	"and run /login github-copilot again. Existing Copilot logins keep working without it.";
