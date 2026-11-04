/**
 * `/memory`: the memory backend's payload, stats, diagnostics, clear and enqueue hooks, and the
 * Hindsight mental-model verbs under `/memory mm`.
 */
import { Markdown } from "@veyyon/tui";
import { errorMessage } from "@veyyon/utils";
import { buildMemoryPayloadForDisplay, type MemoryBackend, resolveMemoryBackend } from "../../../memory/backend";
import type * as hindsightModule from "../../../memory/hindsight";
import type { HindsightApi, HindsightSessionState } from "../../../memory/hindsight";
import { getMarkdownTheme } from "../../../theme/markdown-theme";
import { theme } from "../../../theme/theme-binding";
import { COMPOSER_INSET_COLS } from "../components/composer/composer-chrome";
import { mountTranscriptBlock } from "../components/transcript/transcript-block-chrome";
import { TranscriptBlock } from "../components/transcript/transcript-container";
import type { CommandControllerContext } from "./command-controller";
import { showMarkdownPanel } from "./command-controller-shared";

/** Loads the Hindsight mental-model helpers on first use; the caller holds the lazy import. */
export type LoadHindsight = () => Promise<typeof hindsightModule>;

export class MemoryCommandController {
	readonly #ctx: CommandControllerContext;
	readonly #loadHindsight: LoadHindsight;

	constructor(ctx: CommandControllerContext, loadHindsight: LoadHindsight) {
		this.#ctx = ctx;
		this.#loadHindsight = loadHindsight;
	}

	/** `/memory <action>`: view, stats, diagnose, clear, enqueue, and the `mm` mental-model verbs. */
	async handle(text: string): Promise<void> {
		const argumentText = text.slice(7).trim();
		const action = argumentText.split(/\s+/, 1)[0]?.toLowerCase() || "view";
		const agentDir = this.#ctx.settings.getAgentDir();
		const backend = await resolveMemoryBackend(this.#ctx.settings);

		switch (action) {
			case "view":
				return this.#showMemoryPayload(backend, agentDir);
			case "reset":
			case "clear":
				return this.#clearMemory(backend, agentDir);
			case "enqueue":
			case "rebuild":
				return this.#enqueueMemory(backend, agentDir);
			case "stats":
			case "diagnose":
				return this.#showMemoryReport(action, backend, agentDir);
			case "mm":
				return this.#handleMentalModelsSubcommand(argumentText);
			default:
				this.#ctx.showError("Usage: /memory <view|stats|diagnose|clear|reset|enqueue|rebuild|mm ...>");
		}
	}

	async #showMemoryPayload(backend: MemoryBackend, agentDir: string): Promise<void> {
		const payload = await buildMemoryPayloadForDisplay(backend, agentDir, this.#ctx.settings, this.#ctx.session);
		if (!payload) {
			this.#ctx.showWarning("Memory payload is empty (memory backend off, disabled, or no memory available).");
			return;
		}
		const block = new TranscriptBlock();
		mountTranscriptBlock(block, {
			header: theme.bold(theme.fg("accent", "Memory Injection Payload")),
			body: new Markdown(payload, COMPOSER_INSET_COLS, 0, getMarkdownTheme()),
		});
		this.#ctx.present(block);
	}

	async #clearMemory(backend: MemoryBackend, agentDir: string): Promise<void> {
		try {
			await backend.clear(agentDir, this.#ctx.sessionManager.getCwd(), this.#ctx.session);
			await this.#ctx.session.refreshBaseSystemPrompt("memory-clear");
			this.#ctx.showStatus("Memory data cleared and system prompt refreshed.");
		} catch (error) {
			this.#ctx.showError(`Memory clear failed: ${errorMessage(error)}`);
		}
	}

	async #enqueueMemory(backend: MemoryBackend, agentDir: string): Promise<void> {
		try {
			await backend.enqueue(agentDir, this.#ctx.sessionManager.getCwd(), this.#ctx.session);
			this.#ctx.showStatus("Memory consolidation enqueued.");
		} catch (error) {
			this.#ctx.showError(`Memory enqueue failed: ${errorMessage(error)}`);
		}
	}

	/** `/memory stats` or `/memory diagnose` as a panel; a backend without the hook shows a warning instead. */
	async #showMemoryReport(action: "stats" | "diagnose", backend: MemoryBackend, agentDir: string): Promise<void> {
		const hook = action === "stats" ? backend.stats : backend.diagnose;
		try {
			const payload = await hook?.(agentDir, this.#ctx.sessionManager.getCwd(), this.#ctx.session);
			if (!payload) {
				this.#ctx.showWarning(`Memory ${action} is not available for the ${backend.id} backend.`);
				return;
			}
			showMarkdownPanel(this.#ctx, `Memory ${action === "stats" ? "Stats" : "Diagnostics"}`, payload);
		} catch (error) {
			this.#ctx.showError(`Memory ${action} failed: ${errorMessage(error)}`);
		}
	}

	async #handleMentalModelsSubcommand(argumentText: string): Promise<void> {
		// Parse: "mm <verb> [arg]"
		const parts = argumentText.split(/\s+/).slice(1);
		const verb = parts[0]?.toLowerCase() ?? "list";
		const arg = parts[1];

		const state = this.#ctx.session.getHindsightSessionState();
		const primary = state && !state.aliasOf ? state : undefined;
		if (!primary) {
			this.#ctx.showError("Hindsight backend is not active for this session.");
			return;
		}
		if (!primary.config.mentalModelsEnabled) {
			this.#ctx.showError("Mental models are disabled (hindsight.mentalModelsEnabled = false).");
			return;
		}

		switch (verb) {
			case "list":
				await this.#mmList(primary);
				return;
			case "show":
				if (!arg) return this.#ctx.showError("Usage: /memory mm show <id>");
				await this.#mmShow(primary, arg);
				return;
			case "refresh":
				await this.#mmRefresh(primary, arg);
				return;
			case "history":
				if (!arg) return this.#ctx.showError("Usage: /memory mm history <id>");
				await this.#mmHistory(primary, arg);
				return;
			case "seed":
				await this.#mmSeed(primary);
				return;
			case "reload":
				await this.#mmReload(primary);
				return;
			case "delete":
			case "remove":
				if (!arg) return this.#ctx.showError("Usage: /memory mm delete <id>");
				await this.#mmDelete(primary, arg);
				return;
			default:
				this.#ctx.showError("Usage: /memory mm <list|show|refresh|history|seed|reload|delete>");
		}
	}

	async #mmList(state: HindsightSessionState): Promise<void> {
		const client: HindsightApi = state.client;
		try {
			const { summarizeMentalModel } = await this.#loadHindsight();
			const response = await client.listMentalModels(state.bankId, { detail: "metadata" });
			const items = response.items ?? [];
			if (items.length === 0) {
				this.#ctx.showStatus(`No mental models on bank ${state.bankId}.`);
				return;
			}
			const lines = items
				.slice()
				.sort((a, b) => a.id.localeCompare(b.id))
				.map(summarizeMentalModel);
			showMarkdownPanel(this.#ctx, `Mental Models — ${state.bankId}`, lines.join("\n"));
		} catch (error) {
			this.#ctx.showError(`mm list failed: ${errorMessage(error)}`);
		}
	}

	async #mmShow(state: HindsightSessionState, id: string): Promise<void> {
		try {
			const model = await state.client.getMentalModel(state.bankId, id, { detail: "content" });
			if (!model) {
				this.#ctx.showError(`Mental model not found: ${id}`);
				return;
			}
			const tags = model.tags && model.tags.length > 0 ? `\n_tags: ${model.tags.join(", ")}_` : "";
			const refreshed = model.last_refreshed_at ? `\n_last refreshed: ${model.last_refreshed_at}_` : "";
			const sourceQuery = model.source_query ? `\n\n**Source query:** ${model.source_query}` : "";
			const content = (model.content ?? "_(empty — background reflect may still be running)_").trim();
			showMarkdownPanel(
				this.#ctx,
				model.name,
				`**id:** \`${model.id}\`${tags}${refreshed}${sourceQuery}\n\n${content}`,
			);
		} catch (error) {
			this.#ctx.showError(`mm show failed: ${errorMessage(error)}`);
		}
	}

	async #mmRefresh(state: HindsightSessionState, id: string | undefined): Promise<void> {
		try {
			const { reloadMentalModelsForSession } = await this.#loadHindsight();
			if (id) {
				// Single-model refresh is explicit operator intent: bypass the
				// auto-refresh filter so curated/manual models can still be
				// refreshed on demand.
				await state.client.refreshMentalModel(state.bankId, id);
				this.#ctx.showStatus(`Refresh queued for mental model ${id}.`);
			} else {
				// Bulk refresh: only touch models that opted into automatic
				// refresh via `trigger.refresh_after_consolidation`. Curated
				// models are reviewed before publishing and must not be
				// silently regenerated by a bank-wide refresh sweep. Reading
				// `detail: "content"` here is required because the trigger
				// field is excluded from `detail: "metadata"`.
				const list = await state.client.listMentalModels(state.bankId, { detail: "content" });
				const items = list.items ?? [];
				if (items.length === 0) {
					this.#ctx.showStatus(`No mental models on bank ${state.bankId}.`);
					return;
				}
				const targets = items.filter(m => m.trigger?.refresh_after_consolidation === true);
				const skipped = items.length - targets.length;
				if (targets.length === 0) {
					this.#ctx.showStatus(
						`No mental models opted into auto-refresh; ${skipped} curated model(s) left untouched. Pass an explicit id to refresh one of them.`,
					);
					return;
				}
				let queued = 0;
				for (const item of targets) {
					try {
						await state.client.refreshMentalModel(state.bankId, item.id);
						queued++;
					} catch (error) {
						this.#ctx.showWarning(`Refresh failed for ${item.id}: ${errorMessage(error)}`);
					}
				}
				const skippedSuffix = skipped > 0 ? `; skipped ${skipped} curated model(s)` : "";
				this.#ctx.showStatus(
					`Refresh queued for ${queued}/${targets.length} auto-refresh model(s)${skippedSuffix}.`,
				);
			}
			// Reload the cache after a brief grace so the new content (if the refresh
			// completes synchronously on the server) flows into the system prompt.
			await Bun.sleep(500);
			await reloadMentalModelsForSession(state.session);
		} catch (error) {
			this.#ctx.showError(`mm refresh failed: ${errorMessage(error)}`);
		}
	}

	async #mmHistory(state: HindsightSessionState, id: string): Promise<void> {
		try {
			const { diffMentalModelContent } = await this.#loadHindsight();
			const [model, history] = await Promise.all([
				state.client.getMentalModel(state.bankId, id, { detail: "content" }),
				state.client.getMentalModelHistory(state.bankId, id),
			]);
			if (!model) {
				this.#ctx.showError(`Mental model not found: ${id}`);
				return;
			}
			if (history.length === 0) {
				this.#ctx.showStatus(`No history recorded for ${id}.`);
				return;
			}
			// History is most-recent first. Each entry stores the content BEFORE that
			// change. To diff "what changed at entry N", compare entry N's
			// previous_content (= state before that change) with entry N-1's
			// previous_content (= state after that change, which was state before
			// the next change). For the most recent change, compare against the
			// model's CURRENT content.
			const sections: string[] = [];
			for (let i = 0; i < history.length; i++) {
				const before = history[i].previous_content ?? "";
				const after = i === 0 ? (model.content ?? "") : (history[i - 1].previous_content ?? "");
				const diff = diffMentalModelContent(before, after);
				sections.push(`### ${history[i].changed_at}\n\n\`\`\`diff\n${diff}\n\`\`\``);
			}
			showMarkdownPanel(this.#ctx, `History — ${model.name}`, sections.join("\n\n"));
		} catch (error) {
			this.#ctx.showError(`mm history failed: ${errorMessage(error)}`);
		}
	}

	async #mmSeed(state: HindsightSessionState): Promise<void> {
		try {
			const { loadHindsightConfig, resolveSeedsForScope, seedAlreadyExists } = await this.#loadHindsight();
			const config = loadHindsightConfig(this.#ctx.settings);
			const seeds = resolveSeedsForScope(
				{
					bankId: state.bankId,
					retainTags: state.retainTags,
					recallTags: state.recallTags,
					recallTagsMatch: state.recallTagsMatch,
				},
				config.scoping,
			);
			if (seeds.length === 0) {
				this.#ctx.showStatus(`No built-in seeds apply to scoping=${config.scoping}.`);
				return;
			}
			const list = await state.client.listMentalModels(state.bankId, { detail: "metadata" });
			const existing = list.items ?? [];
			let created = 0;
			let skipped = 0;
			for (const seed of seeds) {
				if (seedAlreadyExists(seed, existing)) {
					skipped++;
					continue;
				}
				try {
					await state.client.createMentalModel(state.bankId, seed.name, seed.sourceQuery, {
						id: seed.id,
						tags: seed.tags.length > 0 ? seed.tags : undefined,
						maxTokens: seed.maxTokens,
						trigger: seed.trigger,
					});
					created++;
				} catch (error) {
					this.#ctx.showWarning(`Seed failed for ${seed.id}: ${errorMessage(error)}`);
				}
			}
			this.#ctx.showStatus(`Seeded ${created} new mental model(s); ${skipped} already present.`);
		} catch (error) {
			this.#ctx.showError(`mm seed failed: ${errorMessage(error)}`);
		}
	}

	async #mmReload(state: HindsightSessionState): Promise<void> {
		const { reloadMentalModelsForSession } = await this.#loadHindsight();
		const ok = await reloadMentalModelsForSession(state.session);
		if (ok) {
			this.#ctx.showStatus("Mental-model cache reloaded.");
		} else {
			this.#ctx.showError("Reload failed (Hindsight backend not active or mental models disabled).");
		}
	}

	async #mmDelete(state: HindsightSessionState, id: string): Promise<void> {
		try {
			const { reloadMentalModelsForSession } = await this.#loadHindsight();
			const removed = await state.client.deleteMentalModel(state.bankId, id);
			if (!removed) {
				this.#ctx.showError(`Mental model not found: ${id}`);
				return;
			}
			// Drop the cached snippet so the closing tag does not silently keep
			// stale content in the system prompt until the next agent_end TTL.
			await reloadMentalModelsForSession(state.session);
			this.#ctx.showStatus(`Deleted mental model ${id} from bank ${state.bankId}.`);
		} catch (error) {
			this.#ctx.showError(`mm delete failed: ${errorMessage(error)}`);
		}
	}
}
