/**
 * Providers whose accounts all sit on one shared GCP project, so the project id says nothing about
 * WHICH account a limit, report or stored credential belongs to. An identity fallback on the project
 * would attribute one account's quota to every sibling and collapse their stored rows into one.
 *
 * ONE owner for the membership, a zero-import leaf so the credential row helpers can read it without
 * reaching the usage machinery (`credential-store-is-not-the-oauth-machinery` bounds that reach).
 * `usage.ts` re-exports it for the surfaces that already import from there.
 */
export function providerSharesProjectAcrossAccounts(provider: string): boolean {
	return provider === "google-antigravity";
}
