# Project trust

A repository can contain code Veyyon loads at startup, such as a plugin registry, and skills it can
show to the model. The registry is `.veyyon/plugins/installed_plugins.json`; it can name
extensions or hooks. Project skills live in the root `.agents/skills`, `.github/skills` or
`.claude/skills` directory. Opening a directory does not approve its contents. Veyyon withholds
untrusted project code and skills.

## What is withheld

| Project file | What it grants |
| --- | --- |
| `.veyyon/plugins/installed_plugins.json` | extensions, hooks, custom tools, slash commands and MCP servers, from the directories it names |
| an extension or hook file inside the project | module top-level code and its factory, at import |
| a project skill's `SKILL.md` | skill instructions and any sibling files those instructions use |

Veyyon approves a project skill by its `SKILL.md` path. The SHA-256 digest covers the entire skill
directory: every relative path and file content, in sorted order. A change to `SKILL.md`, a script,
an asset or path requires approval again. Scripts and assets are included in this single skill-folder approval. Veyyon does not approve them separately and does not sandbox them.
A symlink inside a project skill that resolves outside the project root is refused.

A bounded scan returns `null` without logging when it refuses a folder. Project skill discovery logs a warning for that refusal, and `veyyon trust` lists the candidate as unreadable.

Project plugin folders use the same conservative bounds: 8 nested directory levels, 256 files, 1 MiB per file and 16 MiB total. Every directory is scanned and every file counts; no names are excluded. The gate refuses an unreadable, unsupported, cyclic, overbound or symlink-escaping folder. Install paths must resolve inside the canonical project, and every child must resolve inside its own install folder. A changed registry or payload appears changed and needs approval again.

Project plugins load LSP commands from configuration files inside their approved install folder.
They do not use an ancestor `marketplace.json` to supply commands or select a configuration file.
User-scoped plugins retain that marketplace fallback.

A file outside the project root is not affected. Profile extensions, installed plugins, profile
skills and paths you set in `extensions:` load as before: a configured path is your own instruction
and loads even when stored inside the project, which is where an extension is written while you are
developing it. Settings come from your profile and your home directory, so a repository cannot add
itself to that list.


## Deciding

```sh
veyyon trust           # show project code and skill files, then approve the discovered candidates
veyyon trust --list    # show candidates without deciding
veyyon trust --deny    # refuse, and remember the refusal
veyyon trust --forget  # drop the decision
veyyon trust path/to/skill/SKILL.md   # decide one named skill
veyyon trust a.ts b.ts  # decide the named files
```

Inside a session, bare `/trust` lists the project files and reports their decisions. `/trust approve`,
`/trust deny` and `/trust forget` set the decision. `/trust approve <path>` approves one named file.



## What a decision records

The project trust store is `<agent dir>/project-trust.json`. It keys each decision by the canonical
project root. Extension and hook candidates use a SHA-256 digest of each file. A skill candidate is
identified by its `SKILL.md` path. Its digest covers every relative path and file content in the skill
directory, in sorted order.

Consequences:

- A changed file or path in a skill directory changes its digest. Veyyon withholds that skill until you approve it again.
- A new skill was not approved by an earlier decision.
- Approving a plugin registry approves its exact bytes and every named install directory, including disabled entries. Each folder digest covers every path and file, plus its resolved path identity. Changes require approval again.
- A denial is stored, so the next launch neither loads the code nor prompts again.
- A store written by another version of Veyyon, or one whose records are malformed, is discarded. Nothing is trusted and you are prompted again.
- A skill with a symlink that resolves outside the project root is refused and logged as a warning.

## Reading a refusal

```
extensions: ext/hostile.ts was not loaded because this project has not been
trusted. Project code runs with your permissions; approve it with `/trust
approve` in this session or `veyyon trust` in this directory, or leave it
untrusted.
```

The startup logger also warns when it refuses an unapproved, denied or changed project skill. The
warning names the skill's `SKILL.md` path. Review the folder and approve that path again with
`veyyon trust <path>` or `/trust approve <path>`.


| Reason | Meaning |
| --- | --- |
| has not been trusted | no decision exists for this project |
| marked untrusted | you denied this project |
| changed since it was trusted | the file's bytes differ from the approved ones |
| not part of the approved set | the file was not in the decision |

Refusals appear as startup warnings. Nothing prompts: a session that cannot prompt
loads nothing rather than defaulting to yes.
