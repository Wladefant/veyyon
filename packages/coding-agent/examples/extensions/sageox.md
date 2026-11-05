# Share approved Veyyon context

Use SageOx 0.25.0 in a trusted checkout registered to your team. Sign in as yourself and check `ox status --json` for an authenticated account, an initialized repo and the matching team context. For Codex and Claude Code, use their native project hooks from `ox init`. Veyyon writes version 4 sessions and supports multiple storage backends. The SageOx extension reads the active branch through the Veyyon session API.

The Sage extension needs both `team-context.ts` and `team-context-sageox.ts`. Install them with `sageox.ts` in one subdirectory so the helper modules do not load as separate extensions. For a Git provider, add `team-context-git.ts` and select it explicitly through trusted host code. Stable neutral deployment keys `VEYYON_CONTEXT_TEAM` and `VEYYON_CONTEXT_REPOSITORY` (or explicit `ContextScope`) are required for durable portable publication. These are opaque keys, not SageOx `team_` or `repo_` identifiers. Do not derive identity from record content or Git configuration.

The Git provider requires `createGitContextProvider({ path, authorize })`. A trusted host must provide an explicit `authorize(cwd, signal)` callback. It returns current `ContextAccess` with stable scope keys, authenticated actor, checkout-bound `binding`, and allowed privacy classes. Set the binding to `git:${realpath(path)}` for the exact selected checkout. The adapter rechecks this callback on each operation. Git `user.name` and `user.email` are local commit metadata, not authentication. Git ACLs and branch rules control access to repository files. They do not label record privacy. The adapter stores complete records as local files in the selected checkout. It does not commit, push, or claim remote sharing. Its receipt proves only local storage. A later commit or push follows ordinary Git rules.
- Repository/team labels in an envelope do not grant access. Current provider authorization and repository Git ACLs are separate controls. Team Context is team-wide. Ledger is repository-scoped. Never send a repository-private durable record to Team Context. Exported Git content carries no permissions.

```text
~/.veyyon/profiles/team-work/agent/extensions/sageox/
├── index.ts                 # copy sageox.ts here
├── team-context.ts
├── team-context-sageox.ts
└── team-context-git.ts      # only when explicitly selected
```

Set `index.ts` to the reviewed `sageox.ts` extension. The extension loader resolves a subdirectory containing `index.ts` as one extension entry. Configure the team and SageOx values in the profile's `agent/.env`:

```sh
export VEYYON_SAGEOX_TEAM_ID=team_REPLACE_ME
export VEYYON_CONTEXT_TEAM=YOUR_STABLE_TEAM_KEY
export VEYYON_CONTEXT_REPOSITORY=YOUR_STABLE_REPOSITORY_KEY
veyyon --profile team-work
```

The Git provider's `authorize` callback belongs in trusted host code. Do not configure it with an environment variable or Git identity. There is no safe generic callback example because the host must supply a real authenticated actor and enforce the selected checkout's access policy.

### Install once for everyday work
Choose or create a dedicated profile with `veyyon profile new team-work`. Copy all required files together from the same reviewed revision into `~/.veyyon/profiles/team-work/agent/extensions/sageox/`, creating the directory if needed. Copy `sageox.ts` as `index.ts`. Do not place helper TypeScript files loose in the extensions directory. The extension uses `pi.zod` and built-in runtime imports. SageOx credentials stay in the normal ox login store. Run `veyyon --profile team-work` or select it as the launch default once with `veyyon profile default team-work` and use plain `veyyon` afterward. For a pinned install, replace all copied files together when adopting a newer revision. Remove the directory and restart the profile to uninstall the extension.

### Windows 11

For a native Windows Veyyon installation, install ox and run `ox login` as your ordinary Linux user in one WSL distribution. Initialize and verify the same checkout there. In PowerShell select that distribution and the Linux binary shown by `command -v ox`:

```powershell
$env:VEYYON_SAGEOX_TEAM_ID = 'team_REPLACE_ME'
$env:VEYYON_SAGEOX_WSL_DISTRO = 'Ubuntu-24.04'
$env:VEYYON_SAGEOX_WSL_OX = '/home/youruser/.local/bin/ox'
$env:VEYYON_CONTEXT_TEAM = 'YOUR_STABLE_TEAM_KEY'
$env:VEYYON_CONTEXT_REPOSITORY = 'YOUR_STABLE_REPOSITORY_KEY'
veyyon --profile team-work
```

Use a checkout accessible in both systems and a private user TEMP directory accessible through WSL. The extension calls the system wsl.exe with an explicit distribution, working directory and Linux executable. `wslpath` translates the reviewed temporary document, which inherits the Windows user's temp folder permissions. Both the preflight and import use the same WSL account. Alternatively, launch both binaries inside WSL and use the shell command above. Physical Windows acceptance is tracked on [#954](https://github.com/Wladefant/veyyon/issues/954).

### Use

- Ask Veyyon to use `sageox_search` to find a decision in team documents, meetings or this project's ledger. Use `sageox_handoffs` to check recent repository handoffs. The read tools also work in `veyyon --profile team-work -p 'Use sageox_handoffs to list recent handoffs'`.
- Enter `/sageox-handoff <short update and issue or PR URL>` to send a repository-scoped note. The limit is 500 UTF-8 bytes. Ox reports whether it published or queued the note. Teammates in the same project can run `ox murmur list --topic handoff --scope ledger --since 24h --json`. These signals expire after 24 hours.
- Enter `/sageox-capture` to review a snapshot of the current branch's human and assistant text. Edit the draft to remove private material before confirming the destination. Publishing requires the same individual account throughout review. Saving publishes the reviewed text as a **team document**. Its deterministic title contains a content fingerprint. Capture is explicit each time. It omits tools, media, synthetic messages and structured reasoning. Visible prose can still contain sensitive information.
- Portable approval captures a complete JSON record. `contentDigest` is SHA-256 of the body bytes. The approval digest binds the canonical draft and its metadata, content digest, and approval actor/time. Validation rejects incomplete, unknown, unapproved, revoked, private or tampered records. These digests are integrity checks, not signatures and not substitutes for current provider authorization. Reviewers and publishers must confirm the exact frozen draft. Publishing checks author and approver against the current authenticated actor.
- SageOx's legacy references from `sageox_search` and `sageox_handoffs` remain raw, untrusted references. A query snippet is never an approved record, even if it looks like JSON or mentions an approval. A hosted query result proves neither complete envelope retrieval nor approval. Only a complete envelope that passes validation is a portable approved record. Existing short handoffs remain transient raw reference text on SageOx. Their receipts do not claim durable storage or retained approval. Murmurs cap content at 500 bytes, expire after 24 hours and may queue. They cannot carry a complete portable approval envelope.
- An exact retry of the same approved envelope is deduplicated by the provider. A fresh approval timestamp changes the approved envelope and may produce a distinct record. Do not rely on repeated captures to deduplicate across separate approvals.
- Repository/team labels in an envelope do not grant access. Current provider authorization and repository Git ACLs are separate controls. Team Context is team-wide. Ledger is repository-scoped. Never send a repository-private durable record to Team Context. Exported Git content carries no permissions.
- For a one-shot launch, omit `--profile team-work` to disable the profile integration, or use a profile that does not contain this extension.

## Cross-seat acceptance

Using synthetic material, have one person capture a unique phrase from a branched Veyyon session. Put a different phrase on the sibling branch and keep another private phrase out of the edited draft. In a second signed-in account, retrieve the published phrase via Codex and Claude Code and check the returned source. Verify that the omitted phrases are absent from the document. Have the second person send a distinct project handoff back with `ox murmur --scope ledger --topic handoff -- 'short update'` and retrieve it via `sageox_handoffs`. Record the receipt, source reference and both independently observed values on the owning issue. A local receipt alone does not verify indexing or delivery to another account. Real second-person acceptance remains slice 3. No local Git receipt or hosted query snippet substitutes for that check.

[Upstream ox 0.25.0](https://github.com/sageox/ox/tree/v0.25.0) · [Agent support and hooks](https://github.com/sageox/ox/blob/v0.25.0/docs/guides/agent-compatibility.md)
