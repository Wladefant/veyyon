export const CATEGORY_MAP = {
	PREFERENCE: "PREF",
	TRAIT: "TRAIT",
	STATUS: "STAT",
	INSTRUCTION: "INST",
	PROJECT: "PROJ",
	LOCATION: "LOC",
	FAMILY: "FAM",
	OCCUPATION: "OCC",
	DECISION: "DEC",
	EVENT: "EVT",
	TOOL: "TOOL",
	FACT: "FACT",
	OPINION: "OPN",
} as const;

export const PHRASE_MAP = {
	"User asked ": "ASK ",
	"User wants ": "WANT ",
	"User prefers ": "PREF ",
	"User likes ": "LIKE ",
	"User dislikes ": "DISLIKE ",
	"User is ": "IS ",
	"User has ": "HAS ",
	"User built ": "BUILT ",
	"User asked for ": "ASK ",
	"User requested ": "REQ ",
	"Married to ": "MARRIED→",
	"Email: ": "@",
	"GitHub: ": "GH:",
	"Location: ": "LOC:",
	"Phone: ": "PH:",
	"User email is ": "@",
	"User voice message ": "VM ",
	"User stack: ": "STACK|",
	"Full-stack developer": "FSDEV",
	"Software Developer": "SDEV",
	"AI Systems Engineer": "AIENG",
	"real-time": "RT",
	"Real-time": "RT",
	bilingual: "bi",
	Bilingual: "bi",
	"self-hosted": "selfhost",
	automation: "auto",
	transcription: "transc",
	translation: "transl",
} as const;

export const STRUCTURAL_REPLACEMENTS: readonly (readonly [pattern: string, replacement: string])[] = [
	[" - ", " | "],
	[" -- ", " | "],
	[" | ", " | "],
	[", ", " | "],
	[" and ", "+"],
	[" or ", "/"],
	[" for ", "→"],
	[" to ", "→"],
	[" with ", " w/ "],
	[" over ", ">"],
	[" instead of ", "!>"],
	[" because of ", "∵"],
	[" due to ", "∵"],
	[" using ", "→"],
	[" built ", "→"],
	[" in ", ":"],
	[" at ", "@"],
	[" on ", "@"],
	[" from ", "<-"],
];

const SORTED_PHRASES = Object.entries(PHRASE_MAP).sort(([left], [right]) => right.length - left.length);

/** Replace every literal `pattern` in `text` with its `replacement`, in table order. */
function replaceAllLiteral(text: string, table: Iterable<readonly [pattern: string, replacement: string]>): string {
	let result = text;
	for (const [pattern, replacement] of table) {
		result = result.replaceAll(pattern, replacement);
	}
	return result;
}

export function applyCategoryPrefixes(text: string): string {
	for (const rawFull in CATEGORY_MAP) {
		const full = rawFull as keyof typeof CATEGORY_MAP;
		const prefix = `${full}: `;
		if (text.startsWith(prefix)) {
			return text.replace(prefix, `${CATEGORY_MAP[full]}|`);
		}
	}
	return text;
}

export function applyPhrases(text: string): string {
	return replaceAllLiteral(text, SORTED_PHRASES);
}

export function applyStructural(text: string): string {
	return replaceAllLiteral(text, STRUCTURAL_REPLACEMENTS);
}

export function compactParens(text: string): string {
	return text.replace(/\(\s*/g, "(").replaceAll(" )", ")");
}

export function encode(text: string): string {
	if (text.length === 0) {
		return text;
	}

	if (text.includes("|") && text.trim().split(/\s+/).length <= 3) {
		return text;
	}

	let result = text.trim();
	result = applyCategoryPrefixes(result);
	result = applyPhrases(result);
	result = applyStructural(result);
	result = compactParens(result);
	return applyStatusWords(result).trim();
}

/**
 * Status words compacted to a token. Each matches a whole word, so "incomplete" and "networking" keep their
 * meaning and "completed" compacts to DONE rather than leaving a stray suffix.
 */
const STATUS_WORDS: readonly (readonly [pattern: RegExp, replacement: string])[] = [
	[/\bworking correctly\b/g, "OK"],
	[/\bworking\b/g, "OK"],
	[/\bcompleted?\b/g, "DONE"],
];

function applyStatusWords(text: string): string {
	let result = text;
	for (const [pattern, replacement] of STATUS_WORDS) {
		result = result.replace(pattern, replacement);
	}
	return result;
}
