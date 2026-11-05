import * as path from "node:path";
import { prompt } from "@veyyon/utils";
import type { Rule } from "../../../discovery/capability/rule";
import { sideChannelPrompts } from "../../../prompts/side-channel/rows";
import { shortenPath } from "../../../tools/core/render-utils";
import { OmfgPanelComponent } from "../components/dialogs/omfg-panel";
import type { InteractiveModeContext } from "../types";
import {
	buildOmfgRuleForPath,
	extractGeneratedRuleJson,
	type OmfgRuleSourceLevel,
	type ParsedGeneratedRule,
	parseGeneratedRule,
	validateParsedRuleAgainstAssistantHistory,
} from "./omfg-rule";
import { SidePanelSlot } from "./side-panel-slot";

/**
 * The slice of the interactive context this controller uses: 10 members of the
 * 215 `InteractiveModeContext` requires. Naming the slice keeps the dependency
 * legible and lets a test build one without the `as unknown as
 * InteractiveModeContext` cast the full interface forces (see
 * `CollabHostContext`).
 */
export type OmfgControllerContext = Pick<
	InteractiveModeContext,
	| "omfgContainer"
	| "session"
	| "sessionManager"
	| "settings"
	| "showError"
	| "showHookConfirm"
	| "showHookInput"
	| "showHookSelector"
	| "showStatus"
	| "ui"
>;

interface OmfgRequest {
	component: OmfgPanelComponent;
	abortController: AbortController;
	complaint: string;
}

interface OmfgCandidate extends ParsedGeneratedRule {
	validated: boolean;
}

interface GenerateCandidateOptions {
	initialFeedback?: string;
	previousRule?: string;
}

type SaveCandidateResult = { kind: "saved" | "aborted" | "rejected" } | { kind: "amend"; feedback: string };

const MAX_ATTEMPTS = 3;
const PROFILE_OPTION = "This profile — every project";
const AMEND_OPTION = "Amend with feedback…";

export class OmfgController {
	readonly #slot = new SidePanelSlot<OmfgRequest>({
		container: () => this.ctx.omfgContainer,
		requestRender: () => this.ctx.ui.requestRender(),
	});

	constructor(private readonly ctx: OmfgControllerContext) {}

	hasActiveRequest(): boolean {
		return this.#slot.open !== undefined;
	}

	handleEscape(): boolean {
		return this.#slot.escape();
	}

	dispose(): void {
		this.#slot.close({ abort: true });
	}

	async start(complaint: string): Promise<void> {
		const trimmedComplaint = complaint.trim();
		if (!trimmedComplaint) {
			this.ctx.showStatus("Usage: /omfg <complaint>");
			return;
		}

		const model = this.ctx.session.model;
		if (!model) {
			this.ctx.showError("No active model available for /omfg.");
			return;
		}

		const request: OmfgRequest = {
			component: new OmfgPanelComponent({ complaint: trimmedComplaint, tui: this.ctx.ui }),
			abortController: new AbortController(),
			complaint: trimmedComplaint,
		};
		this.#slot.show(request);
		void this.#slot.run(request, () => this.#forge(request));
	}

	async #forge(request: OmfgRequest): Promise<void> {
		let candidate = await this.#generateCandidate(request);
		for (;;) {
			if (!this.#slot.isOpen(request)) return;
			if (!candidate) {
				request.component.markError("The model did not return a valid TTSR rule.");
				return;
			}

			if (!candidate.validated) {
				request.component.setStatus("confirming", "Couldn't confirm a conversation match.");
				const shouldSave = await this.ctx.showHookConfirm(
					"Validation",
					"Couldn't confirm this rule matches the conversation. Save anyway?",
				);
				if (!this.#slot.isOpen(request)) return;
				if (!shouldSave) {
					request.component.markRejected();
					return;
				}
			}

			const saveResult = await this.#saveCandidate(request, candidate);
			if (!this.#slot.isOpen(request)) return;
			if (saveResult.kind !== "amend") {
				return;
			}

			candidate = await this.#generateCandidate(request, {
				initialFeedback: `User requested this amendment before saving:\n${saveResult.feedback}`,
				previousRule: candidate.fileContent,
			});
		}
	}

	async #generateCandidate(
		request: OmfgRequest,
		options: GenerateCandidateOptions = {},
	): Promise<OmfgCandidate | undefined> {
		const failedAttempts = options.initialFeedback ? [options.initialFeedback] : [];
		let previousRule = options.previousRule;
		let lastCandidate: ParsedGeneratedRule | undefined;

		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			if (this.#slot.isStopped(request)) return undefined;
			request.component.setRule("");
			request.component.setStatus("generating", `Attempt ${attempt}/${MAX_ATTEMPTS} · generating…`);
			const promptText = prompt.render(sideChannelPrompts["side-channel/omfg-user"].text, {
				complaint: request.complaint,
				feedback: failedAttempts.length > 0 ? failedAttempts.join("\n\n") : undefined,
				previousRule,
			});
			const { replyText } = await this.ctx.session.runEphemeralTurn({
				promptText,
				dedupeReply: false,
				onTextDelta: delta => {
					if (this.#slot.isOpen(request)) {
						request.component.appendDraft(delta);
					}
				},
				signal: request.abortController.signal,
			});
			if (this.#slot.isStopped(request)) return undefined;

			const parsed = parseGeneratedRule(replyText);
			if ("error" in parsed) {
				const failedRule = extractGeneratedRuleJson(replyText) ?? replyText.trim();
				failedAttempts.push(
					`Attempt ${attempt} failed: invalid rule (${parsed.error}).\nFailed candidate:\n${failedRule}`,
				);
				previousRule = failedRule;
				request.component.setStatus("validating", `Attempt ${attempt}/${MAX_ATTEMPTS} · ${parsed.error}`);
				continue;
			}

			request.component.setRule(parsed.fileContent);
			request.component.setStatus("validating", `Attempt ${attempt}/${MAX_ATTEMPTS} · validating…`);
			const validated = await validateParsedRuleAgainstAssistantHistory(parsed, this.ctx.session.messages);
			if (validated.repairedCondition) {
				request.component.setRule(validated.candidate.fileContent);
			}
			if (validated.validation.matched) {
				return { ...validated.candidate, validated: true };
			}

			lastCandidate = validated.candidate;
			const failure =
				validated.validation.feedback ?? "The rule condition did not match any earlier assistant output.";
			failedAttempts.push(
				`Attempt ${attempt} failed validation:\n${failure}\nFailed candidate:\n${validated.candidate.fileContent}`,
			);
			previousRule = validated.candidate.fileContent;
		}

		return lastCandidate ? { ...lastCandidate, validated: false } : undefined;
	}

	async #saveCandidate(request: OmfgRequest, candidate: OmfgCandidate): Promise<SaveCandidateResult> {
		if (this.#slot.isStopped(request)) return { kind: "aborted" };
		request.component.setStatus("saving", "Choose where to save or amend the TTSR rule…");
		const location = await this.ctx.showHookSelector("Save TTSR rule where?", [PROFILE_OPTION, AMEND_OPTION]);
		if (!this.#slot.isOpen(request)) return { kind: "aborted" };
		if (!location) {
			request.component.markAborted();
			this.#slot.close({ abort: false });
			return { kind: "aborted" };
		}

		if (location === AMEND_OPTION) {
			request.component.setStatus("confirming", "Describe how to amend the rule…");
			const amendment = await this.ctx.showHookInput(
				"Amend TTSR rule",
				"e.g. Make it specific to Ruby string eval in tool:write(*.rb)",
			);
			if (!this.#slot.isOpen(request)) return { kind: "aborted" };
			const feedback = amendment?.trim();
			if (!feedback) {
				request.component.markAborted();
				this.#slot.close({ abort: false });
				return { kind: "aborted" };
			}
			return { kind: "amend", feedback };
		}

		const target = this.#resolveTarget(candidate.rule.name);
		if (await Bun.file(target.filePath).exists()) {
			const shouldOverwrite = await this.ctx.showHookConfirm(
				"Overwrite TTSR rule?",
				`${shortenPath(target.filePath)} already exists. Overwrite it?`,
			);
			if (!this.#slot.isOpen(request)) return { kind: "aborted" };
			if (!shouldOverwrite) {
				request.component.markRejected();
				return { kind: "rejected" };
			}
		}

		request.component.setStatus("saving", `Saving ${candidate.rule.name}…`);
		await Bun.write(target.filePath, candidate.fileContent);
		if (!this.#slot.isOpen(request)) return { kind: "aborted" };

		const savedRule = buildOmfgRuleForPath(candidate.rule.name, candidate.fileContent, target.filePath, target.level);
		this.#registerLive(savedRule);
		request.component.markSaved(shortenPath(target.filePath));
		return { kind: "saved" };
	}

	/**
	 * The only save target: the active profile's rules directory.
	 *
	 * A project `.veyyon/rules/` target used to sit beside this one, but nothing
	 * discovers that directory — rule discovery reads the HOME-side profile and
	 * foreign-tool conventions only, deliberately, because a checked-out working
	 * tree is untrusted input. A rule saved there was live for this session and
	 * gone at the next launch, and never reached the settings list. The profile
	 * directory is the location discovery reads, so a forged rule persists,
	 * appears under "User created" in Settings → Stream Interrupts (TTSR), and is
	 * toggleable there like any other rule.
	 */
	#resolveTarget(ruleName: string): { filePath: string; level: OmfgRuleSourceLevel } {
		return {
			filePath: path.join(this.ctx.settings.getAgentDir(), "rules", `${ruleName}.md`),
			level: "user",
		};
	}

	#registerLive(rule: Rule): void {
		this.ctx.session.ttsrManager?.addRule(rule);
	}
}
