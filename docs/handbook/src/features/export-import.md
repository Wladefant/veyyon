# Export and import

## Session export

`/export [path]` writes the current session transcript as a standalone offline HTML file. With no
argument it writes `veyyon-session-<session>.html` in the session's working directory, and prints
the absolute path it wrote.

A relative path resolves against the session's working directory, `~` expands to the home
directory, and outer double quotes are stripped, as for `/move` and `/cwd`, so
`/export "my session.html"` writes one file whose name holds a space. There is no directory
fallback, so pass a full file path ending in `.html`.

The export draws every tool card from the same view the terminal draws, with the plain Unicode
glyph set. A `task` card shows each spawned agent as a chip that opens the agent's own transcript.

### Export from the command line

```sh
vey --export <session.jsonl> [output.html]
```

`--export` reads a session file that is not open and writes the same HTML. A path that does not
exist or is not a file is an error: `Error: Session file not found: <path>` on stderr, exit status
1, and no output file.

### Secret redaction

`/export` inside a session and `export_html` over RPC run the secret obfuscator over the transcript
when `share.redactSecrets` is on, replacing each configured secret (`secrets.*`) with its `#NAME#`
placeholder. Provider keys that are not configured secrets are not replaced.

`vey --export` performs no redaction. It runs before the settings store and the secret store are
loaded, so the HTML contains every string the session file contains. Redact a transcript for
sharing from inside a session, or with `export_html` over RPC.

## Migration from Claude Code

`/import` is **not** in the builtin slash registry; Claude migration runs through the setup wizard's
import scene. It offers user-level foreign skills and `CLAUDE.md`/`AGENTS.md` instruction files and
copies the selected ones into the active profile.

Typical migrated items:

- Skills → the active profile's `skills` directory (`~/.veyyon/profiles/<profile>/agent/skills`)
- `CLAUDE.md`/`AGENTS.md` content → appended to the profile `AGENTS.md` under an `<!-- imported from … -->` marker

Ambient loading of foreign `.claude` configuration is a separate opt-in (`discovery.importForeignConfig`,
default off).

See [Migration guide](../using/migration-guide.md).
