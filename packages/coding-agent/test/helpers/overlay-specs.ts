/**
 * Every overlay card the terminal host mounts, constructed for a terminal of a given height.
 *
 * Suites that sweep the overlays import this list instead of keeping a copy, so a card added
 * here reaches every sweep at once. `a-card-first-frame-is-settled.test.ts` pins the names by
 * exact equality, which is what turns a new card red until someone adds it here.
 */
import type { Model } from "@veyyon/ai";
import type { AuthStorage } from "@veyyon/ai/auth-storage";
import { Effort } from "@veyyon/catalog/effort";
import type { HistoryStorage } from "@veyyon/kernel/session/history-storage";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import type { Component, TUI } from "@veyyon/tui";
import type { KeyId } from "@veyyon/utils/keys";
import type { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AccountManagerComponent } from "../../src/modes/terminal/components/account/account-manager";
import { HistorySearchComponent } from "../../src/modes/terminal/components/composer/history-search";
import { AgentDashboard } from "../../src/modes/terminal/components/dashboard/agent-dashboard";
import { AgentTranscriptViewer } from "../../src/modes/terminal/components/dashboard/agent-transcript-viewer";
import { AdvisorConfigOverlayComponent } from "../../src/modes/terminal/components/dialogs/advisor-config";
import { AskDialogComponent } from "../../src/modes/terminal/components/dialogs/ask-dialog";
import { HookEditorComponent } from "../../src/modes/terminal/components/dialogs/hook-editor";
import { HookInputComponent } from "../../src/modes/terminal/components/dialogs/hook-input";
import { LoginDialogComponent } from "../../src/modes/terminal/components/dialogs/login-dialog";
import { MCPAddWizard } from "../../src/modes/terminal/components/dialogs/mcp-add-wizard";
import {
	PlanReviewOverlay,
	type PlanReviewOverlayOptions,
} from "../../src/modes/terminal/components/dialogs/plan-review-overlay";
import { ExtensionDashboard } from "../../src/modes/terminal/components/extensions/extension-dashboard";
import { CopySelectorComponent } from "../../src/modes/terminal/components/selectors/copy-selector";
import { HookSelectorComponent } from "../../src/modes/terminal/components/selectors/hook-selector";
import { ModalSelectListComponent } from "../../src/modes/terminal/components/selectors/modal-select-list";
import { ModelHubComponent } from "../../src/modes/terminal/components/selectors/model-hub";
import { ModelPickerComponent } from "../../src/modes/terminal/components/selectors/model-picker";
import { MoveOverlay } from "../../src/modes/terminal/components/selectors/move-overlay";
import { OAuthSelectorComponent } from "../../src/modes/terminal/components/selectors/oauth-selector";
import { QueueModeSelectorComponent } from "../../src/modes/terminal/components/selectors/queue-mode-selector";
import { ResetUsageSelectorComponent } from "../../src/modes/terminal/components/selectors/reset-usage-selector";
import { RollbackPickerComponent } from "../../src/modes/terminal/components/selectors/rollback-picker";
import { SessionSelectorComponent } from "../../src/modes/terminal/components/selectors/session-selector";
import { SettingsSelectorComponent } from "../../src/modes/terminal/components/selectors/settings-selector";
import { ShowImagesSelectorComponent } from "../../src/modes/terminal/components/selectors/show-images-selector";
import { SubcommandPickerComponent } from "../../src/modes/terminal/components/selectors/subcommand-picker";
import { ThemeSelectorComponent } from "../../src/modes/terminal/components/selectors/theme-selector";
import { ThinkingSelectorComponent } from "../../src/modes/terminal/components/selectors/thinking-selector";
import { TreeSelectorComponent } from "../../src/modes/terminal/components/selectors/tree-selector";
import { UserMessageSelectorComponent } from "../../src/modes/terminal/components/selectors/user-message-selector";
import type { AgentRegistry } from "../../src/registry/agent-registry";
import { getSelectListTheme } from "../../src/theme/theme";
import type { ConfiguredThinkingLevel } from "../../src/thinking";

/** A host whose terminal is `rows` tall and 100 columns wide. */
export function dummyUi(rows: number): TUI {
	return {
		requestRender: () => {},
		terminal: { rows, columns: 100 },
		showOverlay: () => ({ hide: () => {}, update: () => {} }),
		setFocus: () => {},
	} as unknown as TUI;
}

const DUMMY_REGISTRY = {
	getAll: () => [],
	getAllModels: () => [],
	getAvailable: () => [],
	getModels: () => [],
	findModel: () => undefined,
	getDefaultModel: () => undefined,
	getError: () => undefined,
	isAvailable: () => true,
	getDisabledServices: () => [],
	getDiscoverableProviders: () => [],
	refresh: async () => {},
	onAvailabilityChange: () => () => {},
	onServicesChange: () => () => {},
} as unknown as ModelRegistry;

const DUMMY_AUTH_STORAGE = {
	getProviders: () => [],
	hasToken: () => false,
	hasAuth: () => false,
	getToken: () => undefined,
	getCredentialOrigin: () => undefined,
	saveToken: () => {},
} as unknown as AuthStorage;

export type OverlayCard = Component | { render(width: number): readonly string[] | string[]; dispose?(): void };

export interface OverlaySpec {
	name: string;
	/**
	 * Build the card for a terminal `rows` tall. Every height the card takes from its host or
	 * its options is `rows`; a card that reads `process.stdout.rows` itself needs that stubbed too.
	 */
	create: (rows: number) => Promise<OverlayCard> | OverlayCard;
}

export const OVERLAY_SPECS: readonly OverlaySpec[] = [
	{
		name: "AccountManagerComponent",
		create: () =>
			new AccountManagerComponent(
				{ providers: [], totalAccounts: 0, unhealthyCount: 0 },
				{
					onUseAccount: () => {},
					onRename: () => {},
					onRefresh: () => {},
					onLogout: () => {},
					onShowUsage: () => {},
					onAddAccount: () => {},
					onClearRateLimitBlock: () => {},
					onForgetSignedOut: () => {},
					onCancel: () => {},
				},
			),
	},
	{
		name: "AdvisorConfigOverlayComponent",
		create: rows =>
			new AdvisorConfigOverlayComponent(
				dummyUi(rows),
				{
					modelRegistry: DUMMY_REGISTRY,
					settings: Settings.isolated({}),
					scopedModels: [],
					availableToolNames: ["read", "search"],
				},
				"project",
				// More advisors than any short terminal can list, so the roster is clamped to the
				// screen rather than sized by its own content.
				{ advisors: Array.from({ length: 40 }, (_, index) => ({ name: `Advisor ${index + 1}` })) },
				{
					loadDoc: async () => ({ advisors: [] }),
					save: async () => {},
					close: () => {},
					requestRender: () => {},
					notify: () => {},
				},
			),
	},
	{
		name: "AgentDashboard",
		create: () => new AgentDashboard(),
	},
	{
		name: "AgentTranscriptViewer",
		create: rows =>
			new AgentTranscriptViewer({
				agentId: "agent-1",
				ui: dummyUi(rows),
				registry: { get: () => undefined } as unknown as AgentRegistry,
				cwd: process.cwd(),
				expandKeys: ["e" as unknown as KeyId],
				hubKeys: ["h" as unknown as KeyId],
				requestRender: () => {},
				onClose: () => {},
				onHubClose: () => {},
			}),
	},
	{
		name: "AskDialogComponent",
		create: () =>
			new AskDialogComponent(
				[
					{
						id: "q1",
						question: "Proceed?",
						options: [{ label: "Yes" }, { label: "No" }],
					},
				],
				{ onSubmit: () => {}, onCancel: () => {}, onPrompt: async () => undefined },
			),
	},
	{
		name: "CopySelectorComponent",
		create: () =>
			new CopySelectorComponent([{ id: "1", label: "Item 1", preview: "Preview 1", content: "Text 1" }], {
				onPick: () => {},
				onCancel: () => {},
			}),
	},
	{
		name: "ExtensionDashboard",
		create: async rows => await ExtensionDashboard.create(process.cwd(), await Settings.init(), rows),
	},
	{
		name: "HistorySearchComponent",
		create: () =>
			new HistorySearchComponent(
				{
					getRecent: () => [],
					search: () => [],
				} as unknown as HistoryStorage,
				() => {},
				() => {},
			),
	},
	{
		name: "HookEditorComponent",
		create: rows =>
			new HookEditorComponent(
				dummyUi(rows),
				"Hook Editor",
				"echo test",
				() => {},
				() => {},
			),
	},
	{
		name: "HookInputComponent",
		create: () =>
			new HookInputComponent(
				"Hook Input",
				undefined,
				() => {},
				() => {},
			),
	},
	{
		name: "HookSelectorComponent",
		create: () =>
			new HookSelectorComponent(
				"Hook Selector",
				[{ label: "Hook A" }],
				() => {},
				() => {},
			),
	},
	{
		name: "LoginDialogComponent",
		create: rows =>
			new LoginDialogComponent(dummyUi(rows), "GitHub", () => {}, {
				browserLogin: true,
				getTerminalRows: () => rows,
			}),
	},
	{
		name: "MCPAddWizard",
		create: () =>
			new MCPAddWizard(
				() => {},
				() => {},
			),
	},
	{
		name: "ModalSelectListComponent",
		create: rows =>
			new ModalSelectListComponent(
				{
					title: "Items",
					items: [{ value: "1", label: "One" }],
					theme: getSelectListTheme(),
					getTerminalRows: () => rows,
				},
				{ onSelect: () => {}, onCancel: () => {} },
			),
	},
	{
		name: "ModelHubComponent",
		create: async rows =>
			new ModelHubComponent(dummyUi(rows), await Settings.init(), DUMMY_REGISTRY, [], {
				onSetDefault: () => {},
				onClearDefault: () => {},
				onCancel: () => {},
			}),
	},
	{
		name: "ModelPickerComponent",
		create: async rows =>
			new ModelPickerComponent(dummyUi(rows), await Settings.init(), DUMMY_REGISTRY, [], {
				onPick: () => {},
				onCancel: () => {},
			}),
	},
	{
		name: "MoveOverlay",
		create: () => new MoveOverlay("/test/path", () => {}),
	},
	{
		name: "OAuthSelectorComponent",
		create: () =>
			new OAuthSelectorComponent(
				DUMMY_AUTH_STORAGE,
				() => {},
				() => {},
			),
	},
	{
		name: "PlanReviewOverlay",
		create: () =>
			new PlanReviewOverlay(
				"# Plan\n- step 1\n- step 2",
				{
					options: [{ label: "Accept", description: "Accept plan" }],
					onReopenProposal: () => {},
					onDiscard: () => {},
					onClose: () => {},
				} as unknown as PlanReviewOverlayOptions,
				{ onPick: () => {}, onCancel: () => {} },
			),
	},
	{
		name: "QueueModeSelectorComponent",
		create: () =>
			new QueueModeSelectorComponent(
				"all",
				() => {},
				() => {},
			),
	},
	{
		name: "ResetUsageSelectorComponent",
		create: () =>
			new ResetUsageSelectorComponent(
				[
					{
						label: "Default Account",
						providerName: "OpenAI Codex",
						availableCount: 1,
						target: { provider: "openai-codex", accountId: "acc-1" },
						active: true,
					},
				],
				() => {},
				() => {},
			),
	},
	{
		name: "RollbackPickerComponent",
		create: () =>
			new RollbackPickerComponent(
				[
					{
						version: "1.0.0",
						publishedAt: "2026-01-01",
						current: true,
						newer: false,
						visited: true,
						changelogUrl: "https://example.com",
					},
				],
				{ onSelect: () => {}, onCancel: () => {}, openUrl: async () => true },
			),
	},
	{
		name: "SessionSelectorComponent",
		create: rows =>
			new SessionSelectorComponent(
				[],
				() => {},
				() => {},
				() => {},
				{ getTerminalRows: () => rows },
			),
	},
	{
		name: "SettingsSelectorComponent",
		create: async () =>
			new SettingsSelectorComponent(
				{
					availableThemes: ["dark", "light", "titanium"],
					availablePersonalities: [],
					availableThinkingLevels: [Effort.Low, Effort.Medium, Effort.High],
					thinkingLevel: undefined,
					providers: ["openai", "anthropic"],
					cwd: process.cwd(),
				},
				{
					onChange: () => {},
					onCancel: () => {},
				},
			),
	},
	{
		name: "ShowImagesSelectorComponent",
		create: () =>
			new ShowImagesSelectorComponent(
				true,
				() => {},
				() => {},
			),
	},
	{
		name: "SubcommandPickerComponent",
		create: () =>
			new SubcommandPickerComponent(
				"test",
				[{ name: "sub1", description: "First subcommand" }],
				() => {},
				() => {},
			),
	},
	{
		name: "ThemeSelectorComponent",
		create: () =>
			new ThemeSelectorComponent(
				"dark",
				["dark", "light", "titanium"],
				() => {},
				() => {},
				() => {},
			),
	},
	{
		name: "ThinkingSelectorComponent",
		create: () =>
			new ThinkingSelectorComponent(
				"medium" as ConfiguredThinkingLevel,
				{ id: "o3-mini", name: "o3-mini", reasoningEfforts: ["low", "medium", "high"] } as unknown as Model,
				() => {},
				() => {},
			),
	},
	{
		name: "TreeSelectorComponent",
		create: () =>
			new TreeSelectorComponent(
				[
					{
						entry: { id: "root", type: "session_init", timestamp: Date.now() } as unknown as SessionEntry,
						children: [],
					},
				],
				"root",
				() => {},
				() => {},
			),
	},
	{
		name: "UserMessageSelectorComponent",
		create: () =>
			new UserMessageSelectorComponent(
				[{ id: "m1", text: "Hello", timestamp: "2026-01-01" }],
				() => {},
				() => {},
			),
	},
];
