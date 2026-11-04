/**
 * Minimized historical decisions, not executable session transcripts.
 * Private provenance maps connect neutral evidence keys to real trace locations.
 * This format does not authorize execution of recorded calls.
 */
export type CaseValue = null | boolean | number | string | CaseValue[] | { [key: string]: CaseValue };

export interface HistoricalToolCall {
	tool: string;
	arguments: { [key: string]: CaseValue };
}

/** The collection format admits all three proof kinds; current cases use later-success only. */
export type HistoricalProvenance =
	| { kind: "later-success"; evidenceKey: string; observation: string; successfulCall: HistoricalToolCall; result: CaseValue }
	| { kind: "merged-fix"; evidenceKey: string; observation: string; url: string }
	| { kind: "operator-correction"; evidenceKey: string; observation: string; correction: string };

export interface ToolFailureCase {
	schemaVersion: 1;
	id: string;
	incidentFamily: string;
	category: "failure-recovery" | "wrong-tool-success" | "guard" | "ordinary-work";
	input: {
		/** Decision-relevant tools observed in the trace; omissions belong in limitations. */
		toolSet: string[];
		/** Neutral text retains the decision-relevant intent, never the original private prose. */
		priorMessages: { role: "system" | "user" | "assistant" | "tool"; content: CaseValue }[];
		call: HistoricalToolCall;
	};
	expected: {
		requiredCalls: HistoricalToolCall[];
		forbiddenTools: string[];
		outcome: string;
	};
	provenance: HistoricalProvenance;
	/** State information lost by minimization, so consumers cannot assume causal parity. */
	limitations: string[];
}
