/**
 * Tool renderer registry. Keys are current wire tool names; aliases keep old
 * transcript names renderable. Unknown tools fall back to the generic JSON renderer.
 */
import { createElement } from "react";
import { agentDescriptors } from "./descriptors/agent";
import { fsDescriptors } from "./descriptors/fs";
import { memoryDescriptors } from "./descriptors/memory";
import { searchDescriptors } from "./descriptors/search";
import { systemDescriptors } from "./descriptors/system";
import { genericRenderer } from "./generic";
import type { ToolDescriptor, ToolRenderer, ToolRenderProps } from "./types";
import { ToolExecutionBody, ToolExecutionSummary } from "./ViewRenderer";

const ALL_DESCRIPTORS: readonly ToolDescriptor[] = [
	...fsDescriptors,
	...agentDescriptors,
	...systemDescriptors,
	...searchDescriptors,
	...memoryDescriptors,
];

function wrapDescriptor(desc: ToolDescriptor): ToolDescriptor {
	const SpecializedSummary = desc.Summary;
	const SpecializedBody = desc.Body;

	const Summary = (props: ToolRenderProps) => {
		if (props.display) {
			return createElement(ToolExecutionSummary, { ...props, name: props.name || desc.name });
		}
		return createElement(SpecializedSummary, props);
	};

	const Body = SpecializedBody
		? (props: ToolRenderProps) => {
				if (props.display) {
					return createElement(ToolExecutionBody, { ...props, name: props.name || desc.name });
				}
				return createElement(SpecializedBody, props);
			}
		: undefined;

	return {
		name: desc.name,
		aliases: desc.aliases,
		Summary,
		Body,
	};
}

export const RENDERERS: Record<string, ToolRenderer> = Object.create(null);

for (const rawDesc of ALL_DESCRIPTORS) {
	const desc = wrapDescriptor(rawDesc);
	RENDERERS[desc.name] = desc;
	if (desc.aliases) {
		for (const alias of desc.aliases) {
			RENDERERS[alias] = desc;
		}
	}
}

export function getRegisteredToolNames(): string[] {
	return Object.keys(RENDERERS);
}

/**
 * Wire tool names are attacker/model-controlled input, so a plain-object
 * lookup must not fall through the prototype chain: `RENDERERS.constructor`
 * or `RENDERERS.toString` resolve to `Object.prototype` members (truthy, so
 * `??` never reaches the fallback) instead of `undefined`, which would hand
 * `ToolView` a non-`ToolRenderer` whose `.Summary` is `undefined` and crash
 * the render (`Object.hasOwn` restricts lookups to declared own keys).
 */
export function resolveToolRenderer(name: string): ToolRenderer {
	return Object.hasOwn(RENDERERS, name) ? RENDERERS[name]! : genericRenderer;
}
