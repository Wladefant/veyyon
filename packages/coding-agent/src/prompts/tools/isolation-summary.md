{{#when kind "==" "captured"}}
{{#if branchName}}
Isolation: changes captured on branch `{{branchName}}` (apply=false). Not merged.
{{else}}
{{#if rootPatchPath}}
Isolation: changes captured at `{{rootPatchPath}}` (apply=false). Not applied.
{{else}}
{{#if nestedCount}}
Isolation: changes captured for {{pluralize nestedCount "nested repository" "nested repositories"}} (apply=false). Not applied.
{{else}}
Isolation: no changes captured.
{{/if}}
{{/if}}
{{/if}}
{{#list nestedPatchPaths prefix="- nested repository patch: `" suffix="`"}}{{this}}{{/list}}
{{/when}}
{{#when kind "==" "capture-error"}}
{{#if error}}<system-notification>Isolation: {{error}}</system-notification>{{/if}}
{{#if rootPatchPath}}
- patch: `{{rootPatchPath}}`
{{/if}}
{{#list nestedPatchPaths prefix="- nested repository patch: `" suffix="`"}}{{this}}{{/list}}
{{/when}}
{{#when kind "==" "nested-apply-failed"}}
<system-notification>Some nested repository patches failed to apply: {{#if error}}{{error}}{{/if}}{{#if nestedPatchPaths}}
Captured nested patches preserved at:
{{#list nestedPatchPaths prefix="- "}}{{this}}{{/list}}{{/if}}</system-notification>
{{/when}}
{{#when kind "==" "not-applied"}}
<system-notification>Patches were not applied and must be handled manually.</system-notification>

{{#if rootPatchPath}}
Patch artifact:
- {{rootPatchPath}}
{{/if}}
{{#if nestedPatchPaths}}
Nested repository patches (not applied):
{{#list nestedPatchPaths prefix="- "}}{{this}}{{/list}}
{{/if}}
{{/when}}
{{#when kind "==" "branch-merge-failed"}}
<system-notification>Branch merge failed: {{#if branchName}}{{branchName}}{{/if}}.
{{#if conflict}}
Conflict: {{conflict}}
{{/if}}
The unmerged branch remains for manual resolution.</system-notification>
{{#if nestedPatchPaths}}
Nested repository patches (not applied):
{{#list nestedPatchPaths prefix="- "}}{{this}}{{/list}}
{{/if}}
{{/when}}
{{#when kind "==" "merge-error"}}
<system-notification>Merge phase failed: {{#if error}}{{error}}{{/if}}
Task outputs are preserved but changes were not applied.</system-notification>
{{#if branchName}}
Unmerged branch preserved as {{branchName}} for manual resolution.
{{/if}}
{{#if rootPatchPath}}
Patch artifact:
- {{rootPatchPath}}
{{/if}}
{{#if nestedPatchPaths}}
Nested repository patches (not applied):
{{#list nestedPatchPaths prefix="- "}}{{this}}{{/list}}
{{/if}}
{{/when}}
