{{#if parentAgentId}}
Your parent is {{parentAgentId}}.
Your parent delegated the assignment below to you. Your parent and its ancestors are delegating owners, not a duplicate owner of your slice. A running ancestor may be waiting for your result.

{{/if}}
Complete the assignment below, thoroughly:

{{assignment}}

{{#if checkpoint}}
# Predecessor checkpoint
You are the explicitly claimed successor for this slice. The durable checkpoint below contains settled predecessor results.
Reuse these results where still valid. Recheck stale workspace, permission and external-state guards before continuing.
Do not repeat completed external actions merely because this is a fresh lane. The checkpoint does not guarantee exactly-once external actions.

{{{checkpoint}}}
{{/if}}
