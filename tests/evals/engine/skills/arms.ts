import { createHash } from "node:crypto";

export interface FrozenSkillArm {
	readonly id: string;
	readonly kind: "baseline" | "full" | "ablation" | "candidate";
	readonly skillName: string;
	readonly content: string | null;
	readonly contentHash: string;
	readonly sourceHash: string;
	readonly omittedComponents: readonly string[];
	readonly recipeHash: string;
}

export interface SkillExperimentManifest {
	readonly version: 1;
	readonly skillName: string;
	readonly sourceHash: string;
	readonly content: string;
	readonly components: readonly { readonly name: string; readonly content: string }[];
}

const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const forbiddenName = /(?:safety|security|auth(?:entication|orization)?|policy|core|system[-_ ]?prompt|guardrail)/i;
const forbiddenContent = /(?:ignore|override|disable|bypass|remove|ablate|omit|do not follow).{0,80}(?:safety|security|auth(?:entication|orization)?|policy|system prompt|guardrail)|(?:safety|security|auth(?:entication|orization)?|policy|system prompt|guardrail).{0,80}(?:ignore|override|disable|bypass|remove|ablate|omit)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
	throw new Error(`Invalid skill experiment manifest: ${message}`);
}

function freezeArm(arm: FrozenSkillArm): FrozenSkillArm {
	Object.freeze(arm.omittedComponents);
	return Object.freeze(arm);
}

/** Build baseline, full and one-component-omission arms from an inline, frozen resource snapshot. */
export function buildSkillArms(value: unknown): readonly FrozenSkillArm[] {
	if (!isRecord(value) || value.version !== 1) fail("version must be 1");
	const { skillName, sourceHash, content, components } = value;
	if (typeof skillName !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(skillName) || skillName.includes("..")) {
		fail("skillName must be a safe resource name");
	}
	if (typeof content !== "string" || content.length === 0) fail("content must be non-empty text");
	if (typeof sourceHash !== "string" || !/^[a-f0-9]{64}$/i.test(sourceHash) || sourceHash.toLowerCase() !== hash(content)) {
		fail("sourceHash must be the SHA-256 digest of full content");
	}
	if (forbiddenContent.test(content)) fail("content contains a safety or core-policy ablation directive");
	if (!Array.isArray(components) || components.length === 0) fail("components must declare at least one separable component");
	const seenNames = new Set<string>();
	const seenContents = new Set<string>();
	const componentRanges: { start: number; end: number }[] = [];
	for (const component of components) {
		if (!isRecord(component) || typeof component.name !== "string" || typeof component.content !== "string") fail("each component needs a name and exact content");
		if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(component.name) || component.name.includes("..")) fail("component name is unsafe or traverses a path");
		if (forbiddenName.test(component.name) || /(?:safety|security|auth(?:entication|orization)?|policy|system[-_ ]?prompt|guardrail)/i.test(component.content)) fail(`component ${component.name} targets protected policy`);
		if (component.content.length === 0) fail(`component ${component.name} must not be empty`);
		if (seenNames.has(component.name) || seenContents.has(component.content)) fail("component names and contents must be unique");
		seenNames.add(component.name);
		seenContents.add(component.content);
		const start = content.indexOf(component.content);
		if (start < 0 || content.indexOf(component.content, start + component.content.length) >= 0) fail(`component ${component.name} must occur exactly once in full content`);
		componentRanges.push({ start, end: start + component.content.length });
	}
	componentRanges.sort((a, b) => a.start - b.start);
	for (let index = 1; index < componentRanges.length; index++) {
		if (componentRanges[index]!.start < componentRanges[index - 1]!.end) fail("component spans must not overlap");
	}
	const recipeBase = JSON.stringify({ version: 1, skillName, sourceHash, content, components });
	const recipeHash = hash(recipeBase);
	const baseline = freezeArm({ id: "baseline", kind: "baseline", skillName, content: null, contentHash: hash(""), sourceHash, omittedComponents: Object.freeze([]), recipeHash: hash(`${recipeHash}:baseline`) });
	const full = freezeArm({ id: "full", kind: "full", skillName, content, contentHash: hash(content), sourceHash, omittedComponents: Object.freeze([]), recipeHash: hash(`${recipeHash}:full`) });
	const ablations = components.map(component => {
		const first = content.indexOf(component.content as string);
		const ablated = content.slice(0, first) + content.slice(first + (component.content as string).length);
		return freezeArm({
			id: `ablation-${component.name}`,
			kind: "ablation",
			skillName,
			content: ablated,
			contentHash: hash(ablated),
			sourceHash,
			omittedComponents: Object.freeze([component.name as string]),
			recipeHash: hash(`${recipeHash}:ablation:${component.name}`),
		});
	});
	return Object.freeze([baseline, full, ...ablations]);
}
