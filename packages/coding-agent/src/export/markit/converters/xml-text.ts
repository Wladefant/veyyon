/**
 * The one owner of fast-xml-parser handling for the markit Office converters
 * (xlsx, pptx, epub): the parser they read XML parts with, the shape of an
 * element that may repeat, and the text of a node.
 *
 * fast-xml-parser number-parses tag text by default, and wraps an element that
 * also carries attributes as a `{ "#text": ... }` node instead of a bare value.
 * Both facts trip up the obvious hand-rolled extraction, and each converter had
 * grown its own slightly-different copy. Two coercions have to be right:
 *
 *   - A value like the cell/run text "0", "1984", or "true" arrives as a JS
 *     number or boolean, not a string, so it must be stringified rather than
 *     dropped (the `typeof === "string"`-only path silently lost it).
 *   - A `#text` of the number `0` (a "0" run/cell that also has an attribute
 *     such as `xml:space="preserve"`) is a real value. It must be read with a
 *     null check; `node["#text"] || ""` discards a legitimate 0, turning the
 *     text "0" into "".
 */

import { XMLParser } from "fast-xml-parser";

/** Entity expansions one parse may perform. fast-xml-parser leaves the total uncapped by default. */
const MAX_ENTITY_EXPANSIONS = 1_000_000;

/**
 * The parser for an Office XML part: attributes under an `@_` prefix, element
 * text under `#text`, and at most {@link MAX_ENTITY_EXPANSIONS} entity
 * expansions, so a part that references an entity millions of times fails
 * instead of expanding without bound.
 */
export function createMarkitXmlParser(): XMLParser {
	return new XMLParser({
		ignoreAttributes: false,
		attributeNamePrefix: "@_",
		textNodeName: "#text",
		processEntities: { maxTotalExpansions: MAX_ENTITY_EXPANSIONS },
	});
}

/**
 * The occurrences of an element that may repeat. fast-xml-parser yields a
 * single occurrence as the bare node and several as an array; an absent
 * element is `[]`.
 */
export function xmlList<T>(node: T | T[] | undefined): T[] {
	if (!node) return [];
	return Array.isArray(node) ? node : [node];
}

/** A text-bearing node as fast-xml-parser produces it: a bare scalar, or a `{ "#text" }` node when the element also has attributes. */
export type XmlTextNode = string | number | boolean | { "#text"?: unknown } | null | undefined;

/**
 * Text of a fast-xml-parser text node, or `""` when the node holds no text.
 *
 * Handles the number/boolean coercion and the `{ "#text" }` attribute-node
 * shape, and keeps a `#text` of the number `0`. Does not recurse into arrays:
 * a converter that can see a repeated element (EPUB's `dc:creator`) selects the
 * element first, then calls this on the scalar.
 *
 * The EPUB metadata reader needs to distinguish "absent" (skip the line) from
 * "empty", so it keeps a thin `getText` wrapper that returns `undefined` for a
 * missing value and delegates the scalar coercion here.
 */
export function xmlNodeText(node: XmlTextNode): string {
	if (node == null) return "";
	if (typeof node === "string") return node;
	if (typeof node === "number" || typeof node === "boolean") return String(node);
	const text = node["#text"];
	if (text == null) return "";
	return typeof text === "string" ? text : String(text);
}
