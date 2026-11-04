---

name: {{jsonStringify name}}
description: {{jsonStringify description}}
{{#if spawns}}spawns: {{jsonStringify spawns}}
{{/if}}{{#if model}}model: {{jsonStringify model}}
{{/if}}{{#if thinkingLevel}}thinking-level: {{jsonStringify thinkingLevel}}
{{/if}}{{#if blocking}}blocking: true
{{/if}}{{#if autoloadSkills}}autoloadSkills: {{jsonStringify autoloadSkills}}
{{/if}}{{#if contextVariant}}contextVariant: {{jsonStringify contextVariant}}
{{/if}}{{#if skillList}}skillList: {{jsonStringify skillList}}
{{/if}}---
{{body}}
