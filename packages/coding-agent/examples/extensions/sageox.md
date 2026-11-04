# Share a Veyyon handoff with Codex and Claude Code

Use SageOx 0.25.0 in a trusted checkout registered to your team. Sign in as yourself and check `ox status --json` for an authenticated account, an initialized repo and the matching team context. For Codex and Claude Code, use their native project hooks from `ox init`. Veyyon writes version 4 sessions and supports multiple storage backends. Its extension reads the active branch through the Veyyon session API.

Set `VEYYON_SAGEOX_TEAM_ID` to the intended team's exact ID and start Veyyon with the absolute extension path. Loading the extension registers two read tools and two operator commands. At session entry it checks the enrolled project and reads recent ledger handoffs in the background. The first prompt after that read completes receives up to five notes as untrusted reference material. Slow or failed reads leave the prompt available. Publishing always requires an operator command.

```sh
export VEYYON_SAGEOX_TEAM_ID=team_REPLACE_ME
veyyon --extension /absolute/path/to/sageox.ts
```

### Windows 11

For a native Windows Veyyon installation, install ox and run `ox login` as your ordinary Linux user in one WSL distribution. Initialize and verify the same checkout there. In PowerShell select that distribution and the Linux binary shown by `command -v ox`:

```powershell
$env:VEYYON_SAGEOX_TEAM_ID = 'team_REPLACE_ME'
$env:VEYYON_SAGEOX_WSL_DISTRO = 'Ubuntu-24.04'
$env:VEYYON_SAGEOX_WSL_OX = '/home/youruser/.local/bin/ox'
veyyon --extension 'C:\tools\veyyon\packages\coding-agent\examples\extensions\sageox.ts'
```

Use a checkout accessible in both systems and a private user TEMP directory accessible through WSL. The extension calls the system wsl.exe with an explicit distribution, working directory and Linux executable. `wslpath` translates the reviewed temporary document, which inherits the Windows user's temp folder permissions. Both the preflight and import use the same WSL account. Alternatively, launch both binaries inside WSL and use the shell command above. Physical Windows acceptance is tracked on [#954](https://github.com/Wladefant/veyyon/issues/954).

### Use

- Ask Veyyon to use `sageox_search` to find a decision in team documents, meetings or this project's ledger. Use `sageox_handoffs` to check recent repository handoffs. The read tools also work in `veyyon --extension /absolute/path/to/sageox.ts -p 'Use sageox_handoffs to list recent handoffs'`.
- Enter `/sageox-handoff <short update and issue or PR URL>` to send a repository-scoped note. The limit is 500 UTF-8 bytes. Ox reports whether it published or queued the note. Teammates in the same project can run `ox murmur list --topic handoff --scope ledger --since 24h --json`. These signals expire after 24 hours.
- Enter `/sageox-capture` to review a snapshot of the current branch's human and assistant text. Edit the draft to remove private material before confirming the destination. Saving publishes the reviewed text as a **team document**. Its deterministic title contains a content fingerprint. Repeating the same snapshot uses ox's content deduplication. Teammates can search for a distinctive phrase with `ox query 'phrase' --source team --json` after indexing. Capture is explicit each time. It omits tools, media, synthetic messages and structured reasoning. Visible prose can still contain sensitive information.
- Omit `--extension` to disable these tools and commands. Removing the extension does not revoke previously published records.

## Cross-seat acceptance

Using synthetic material, have one person capture a unique phrase from a branched Veyyon session. Put a different phrase on the sibling branch and keep another private phrase out of the edited draft. In a second signed-in account, retrieve the published phrase via Codex and Claude Code and check the returned source. Verify that the omitted phrases are absent from the document. Have the second person send a distinct project handoff back with `ox murmur --scope ledger --topic handoff -- 'short update'` and retrieve it via `sageox_handoffs`. Record the receipt, source reference and both independently observed values on the owning issue. A local receipt alone does not verify indexing or delivery to another account.

[Upstream ox 0.25.0](https://github.com/sageox/ox/tree/v0.25.0) · [Agent support and hooks](https://github.com/sageox/ox/blob/v0.25.0/docs/guides/agent-compatibility.md)
