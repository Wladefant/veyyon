{{#if parentAgentId}}
Your parent is {{parentAgentId}}.
Your parent delegated the assignment below to you. A running ancestor may be waiting for your result; seeing that ancestor in the roster alone does not identify a competing lane.
Delegation does not establish exclusive write ownership. Follow the named writer and exact paths in the assignment. If your parent or another lane has overlapping edits, coordinate with that owner before writing. Do not stop merely because your parent is running.

{{/if}}
Complete the assignment below, thoroughly:

{{assignment}}

{{#if checkpoint}}
# Predecessor checkpoint
You are the explicitly claimed successor for this slice. The durable checkpoint below contains settled predecessor results.
Reuse these results where still valid. Recheck stale workspace, permission and external-state guards before continuing.
Do not repeat completed external actions merely because this is a fresh lane. The checkpoint does not guarantee exactly-once external actions.

{{checkpoint}}
{{/if}}
