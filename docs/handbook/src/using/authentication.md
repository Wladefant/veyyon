# Signing in

Veyyon authenticates to whichever provider you point it at and calls provider APIs directly with keys
you supply. Optional OpenTelemetry export runs only when `OTEL_EXPORTER_OTLP_*` is configured. Logins
are **provider-scoped**: authenticating `anthropic` does not authenticate `openai`, and each provider
tracks its own credentials. Those credentials are shared across profiles by default (see
[Credentials are shared across profiles](#credentials-are-shared-across-profiles)).

## Sign in from the TUI

Use the interactive slash commands inside a session:

- `/login`: opens the OAuth/key selector.
- `/login <provider>`: jumps straight to one provider, e.g. `/login anthropic`, `/login github-copilot`.
- `/login <redirect-url>`: completes an MCP server's OAuth flow that needs a pasted callback URL. A
  provider login takes the pasted address in its own login card (see
  [Signing in over SSH](#signing-in-over-ssh)).
- `/logout`: opens the provider selector to remove stored credentials.

On first run, the first-run setup (`veyyon setup`, or `/setup` later) walks the same flow.

## Signing in over SSH

A browser login opens a browser on the machine Veyyon runs on. Over SSH that is the remote host, so
open the link on your own machine:

1. The login card sends the link to your clipboard when it appears. Inside tmux the copy goes
   through `tmux load-buffer -w`, which forwards it to the terminal you are attached from; outside
   tmux it is an OSC 52 escape, which your terminal must allow. Press `c` to send it again, or
   `alt+c` while the card's field holds typed text.
2. Paste the link into your local browser and sign in.
3. The provider sends the browser back to a `localhost` address, which nothing on your machine
   answers. Copy the full address from the browser's address bar and paste it into the card's
   field, then press `enter`. The field's placeholder shows the shape of that address. An address
   that does not complete the sign-in is asked for again.

To have the browser reach Veyyon directly, forward the callback port before you sign in. The port
is in the `redirect_uri` of the link; for `openai-codex` it is 1455:

```console
$ ssh -L 1455:localhost:1455 <host>
```

## Using several accounts for one provider

You can sign in to the same provider more than once. Run `/login anthropic` twice with two different
logins and Veyyon stores both, each with its own quota. To see them, open the account manager:

```text
/providers
```

The sidebar lists your providers and the body lists that provider's accounts, one row each, with the
email, the plan, how the credential was supplied, and how much of its quota is spent. A row marked
`this session` is the one serving your current session.

From that card you press `enter` to use the selected account, `n` to name it, `r` to re-check it,
`u` to open its usage, `x` twice to log it out, and `a` to add another account for the same
provider. `r` on the `+ add another … account` row re-checks every account of that provider and no
other. Each key reports its result on the line above the key chips; `r` shows `Checking …` at once,
then whether the provider accepted the login, and updates the usage bars from the same request.
`/account manager` opens the same card.

Below the accounts is `+ add another … account`. It is a position in the list like any other:
arrow down past your last account to land on it, and press `enter` there to start a login. A
provider with a second way to sign in lists it beneath, as `+ add with <login>`: OpenCode Go offers
`+ add with OpenCode Go (API key, legacy)`, Nous Research its API key, and ChatGPT its device login.
Each stores the account under the same provider. `a` always starts the provider's default login.
The mouse works on the card as well. Click an account to select it, click an add row to start that
login, and click any key chip in the footer to run what it names.

The provider list filters. Press `ctrl+s`, type part of a provider's name or id, and the sidebar
keeps the providers that match; the arrows move within them and `enter` still switches to the
selected account. Press `esc` to leave the filter and get the full list back, and `esc` again to
close the card.

Switching is **per provider**. Choosing another Anthropic account changes Anthropic and nothing else,
because several providers serve one session at the same time: your main model, your agent roles,
and web search can each be a different provider. Moving between providers is a model choice, so it
is in `/models`.

## Naming an account

An email is not always the thing you recognise, especially when two subscriptions share one login.
Give an account a name and every surface uses it:

```text
/account name work
```

The name belongs to the account, not to the stored token, so it survives a token refresh and a later
re-login to the same account. An account you never named shows its email instead, and Veyyon prints
how to set one.

## Which account am I using?

```text
/account
```

This reports one line per provider your session has routed to, with the account it is using
and that account's remaining quota. A provider you hold credentials for but have not used this
session is not listed.

If your chosen account hits its rate limit, Veyyon moves to another one so your work continues, and
reports it:

```text
Anthropic          personal                    main model  (opus-5)
                   pinned to work, rotated off it (usage limit)
                   /account switch anthropic to re-pin work · 2h 14m until it unblocks
```

Your choice is kept, not discarded. Once the limit resets, traffic returns to the account you picked
with no further action.

## When a login is signed out for you

A stored login can stop working without you doing anything: the provider revokes the grant, or
refuses a token refresh, and the credential is set aside. A refusal is a 401, an OAuth error code such
as `invalid_grant`, or a 403 whose JSON body states one. A refresh that times out, fails on the
network, meets a provider outage, is answered with a bare 403, or receives a token response that is
not a JSON object does not set the login aside: the account stays in place and the
next request refreshes again. The account manager marks a signed-out provider and prints the
provider's own reason:

```text
Kimi Code · 1 account
  a previous login was signed out: oauth refresh failed:
  invalid_grant: The provided authorization grant is invalid
  press a to sign in again, or f to forget it
```

If that provider had only one login, it now has none, and the card states that rather than showing the
provider as one you never signed into. `/account` shows it too, so you do not have to open the card
to find out:

```text
1 provider has a signed-out login (Kimi Code) · /providers to sign in again or forget it
```

A logout you performed yourself is not reported this way.

Press `f` on the card to forget a signed-out login you do not intend to sign back in. The note and the
`/account` line stop reporting it; the credential stays disabled in the auth database and a later
refresh does not bring it back.

A Google login (Google Antigravity, Gemini CLI) records the Google account id. A login under a new
address of the same Google account replaces the login under the old address and clears its
signed-out note. A login stored before the account id was recorded carries none and is not linked;
forget its note with `f`.

## Headless and remote hosts

For CI, servers, or a shared team credential store, use the auth broker from the shell:

```console
$ veyyon auth-broker login <provider>
$ veyyon auth-broker status
$ veyyon auth-broker list
$ veyyon auth-broker logout
```

`import` and `migrate` are also available. See [Providers](../models/providers.md) and `docs/handbook/src/architecture/secrets.md`
for the broker model.

## Using an environment variable instead

Every API-key provider reads one or more environment variables, so a key already exported in your shell (or in
a `.env` file) is used without an interactive sign-in. OAuth-only providers (for example `google-antigravity`, `google-gemini-cli`, `kimi-code`) take no key variable: sign in with `/login`.

| Provider | Environment variable |
| --- | --- |
| `openai` | `OPENAI_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` (or `ANTHROPIC_OAUTH_TOKEN`) |
| `google` | `GEMINI_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `moonshot` | `MOONSHOT_API_KEY` |
| `zai` | `ZAI_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `xai` | `XAI_API_KEY` |
| `groq` | `GROQ_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` |

The full provider → variable map is documented in [Providers](../models/providers.md). `.env` files are loaded
from `<cwd>/.env`, `~/.veyyon/profiles/default/agent/.env`, `~/.veyyon/.env`, and `~/.env`, with earlier sources winning.

## How keys are resolved

When a provider needs a key, Veyyon resolves it in order (first match wins):

1. A runtime `--api-key` for the current process (never persisted).
2. A `models.yml` `apiKey` on a custom provider.
3. A stored OAuth credential (refreshed as needed).
4. A stored API key in the auth store (persisted by `/login`).
5. The provider's environment variable (including `.env`).
6. Any other stored API-key credential, then a custom-provider resolver fallback.

Stored credentials live in a machine-wide auth store at `~/.veyyon/shared-auth/agent.db` (or the configured
auth-broker snapshot in broker mode). `VEYYON_CODING_AGENT_DIR` relocates the agent base for a profile's own
files, but the shared auth store stays at the global config root so every profile reads the same logins.

### Credentials are shared across profiles

By default every profile reads one machine-wide set of provider logins, so signing in once works everywhere.
The first time a profile opens the shared store, any login already saved in that profile is promoted into it,
so turning sharing on never signs you out.

Concurrent launches wait for temporary database locks during credential-store initialization.
If the database remains locked after the bounded retries, startup reports the database path and SQLite error.

To give a profile its own private credentials instead, turn sharing off in the global config
`~/.veyyon/config.yml`:

```yaml
profileSharing: false
```

or toggle **Share Credentials Across Profiles** on the **Global** tab of `/settings`. With sharing off, each
profile keeps its logins in its own `~/.veyyon/profiles/<name>/agent/agent.db` and never reads another
profile's credentials. The auth broker (above) is a separate cross-host mechanism and is unaffected by this
setting.

## Provider data is data-driven

Provider identity (display name, env var, OAuth parameters) and endpoints (base URL, API kind) come
from the bundled model catalog plus your `~/.veyyon/profiles/default/agent/models.yml`. A new BYOK provider becomes
selectable by adding a `providers:` entry, not by changing code. See
[Configuring providers](./configuring-providers.md) and `docs/handbook/src/reference/providers.md`.

See also: [Models and providers](../reference/models-yml.md) and the [CLI reference](../reference/cli.md).
