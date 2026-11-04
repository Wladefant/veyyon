# Artifact recovery by execution session

Refs #774. Artifact numbers are allocated by an artifact store. A number alone is not an
execution-session identity, and a caller's missing number must not silently resolve in a
different session's store.

| URL | Resolution |
| --- | --- |
| `artifact://3` with caller context | Only the caller's artifact directory |
| `artifact://3?session=<execution-session-id>` | The caller's matching store or the unique live registered owner |
| `artifact://3?session=<execution-session-id>&view=metadata` | Availability metadata without reading the content |
| `artifact://3` without caller context | Legacy registry scan, rejecting multiple matches |

An explicit session selector uses the execution session's `SessionManager.getSessionId()`,
not a display name, an agent ID, a directory path, or a conversation label. Supplying a
selector does not modify the caller's session. Repeated or malformed selectors are errors.
Duplicate matching files are ambiguous even when they are in the same artifact directory.

Metadata uses schema version 1 and reports `available`, `missing`, `ambiguous`, or
`unavailable`. An available result includes the selected session identity when known, the
size, and whether the file fits the existing 8 MiB inline-read ceiling. Files are opened and
statted without reading their bodies. Availability describes this inspection, not a promise
that storage will remain unchanged. Metadata errors do not substitute another owner's bytes.

A parked or unregistered owner without caller context is explicitly unavailable. Resume the
source execution session to restore its artifact-store mapping. The reader does not infer
an adopted artifact directory from a transcript filename or scan unrelated sessions for a
matching number. Identity selection here does not introduce a new authorization system.

Normal reads continue returning the raw artifact text. Both the version-1 structured
recovery envelope (`operation`, `branchLeafId`, `entries`) and older shake region text remain
intact. The handler does not strip fields, normalize whitespace, claim that a marker is an
original, or reinsert recovered images into a provider request. Large artifacts still use
the existing read selectors or path-only search/copy path; this change does not increase
the full-read ceiling. An explicitly scoped URL should be preserved when passing it to a
caller that resolves backing paths.

Remote regression target:

```sh
bun test packages/coding-agent/src/internal-urls/__tests__/artifact-recovery-stays-with-its-session.test.ts
```

The tests use two file-backed sessions with colliding numeric artifact IDs. They cover
caller misses, explicit owner selection, metadata states, raw structured and legacy
recovery, duplicate IDs, oversize/path-only behavior and malformed selectors. Tests and
typecheck have not been run in the authoring environment; the shared policy requires remote
execution, and Veyyon's OVH workflow currently needs an unavailable manual dispatch. Keep
the PR draft pending exact-head remote checks and combined continuity qualification.
