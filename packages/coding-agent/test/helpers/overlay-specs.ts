/**
 * Every overlay card the terminal host mounts, constructed for a terminal of a given height.
 *
 * Suites that sweep the overlays import this list instead of keeping a copy, so a card added
 * here reaches every sweep at once. `a-card-first-frame-is-settled.test.ts` pins the names by
 * exact equality, which is what turns a new card red until someone adds it here.
 */
import type { AgentMessage } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import type { AuthStorage } from "@veyyon/ai/auth-storage";
import { Effort } from "@veyyon/catalog/effort";
import type { HistoryEntry, HistoryStorage } from "@veyyon/kernel/session/history-storage";
import type { SessionTreeNode } from "@veyyon/kernel/session/session-entries";
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
import { PlanReviewOverlay } from "../../src/modes/terminal/components/dialogs/plan-review-overlay";
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

/**
 * Entries in every list fixture: more than the tallest swept terminal has rows, so a card that
 * sizes its list by its own content rather than by the rows its card has turns the sweeps red.
 */
const LONG_LIST = 80;

/** `LONG_LIST` entries built by `make` from their index. */
function longList<T>(make: (index: number) => T): T[] {
	return Array.from({ length: LONG_LIST }, (_, index) => make(index));
}

const HISTORY: readonly HistoryEntry[] = longList(i => ({ id: i, prompt: `Prompt ${i}`, created_at: i }));

/** One chain of `count` user turns, `turn-0` to `turn-<count-1>`, so the tree card has more rows than a short card shows. */
function userTurnChain(count: number): SessionTreeNode {
	const nodes: SessionTreeNode[] = [];
	for (let i = 0; i < count; i++) {
		const message: AgentMessage = { role: "user", content: `turn ${i}`, timestamp: i };
		const parent = nodes[i - 1];
		const node: SessionTreeNode = {
			entry: {
				type: "message",
				id: `turn-${i}`,
				parentId: parent?.entry.id ?? null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message,
			},
			children: [],
		};
		parent?.children.push(node);
		nodes.push(node);
	}
	const root = nodes[0];
	if (!root) throw new Error("userTurnChain needs at least one turn");
	return root;
}

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
				{ advisors: longList(index => ({ name: `Advisor ${index + 1}` })) },
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
			new CopySelectorComponent(
				longList(i => ({ id: `${i}`, label: `Item ${i}`, preview: `Preview ${i}`, content: `Text ${i}` })),
				{
					onPick: () => {},
					onCancel: () => {},
				},
			),
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
					getRecent: () => HISTORY,
					search: () => HISTORY,
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
				longList(i => ({ label: `Hook ${i}` })),
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
					items: longList(i => ({ value: `${i}`, label: `Item ${i}` })),
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
					promptTitle: "Plan mode - next step",
					options: [
						"Approve and execute",
						"Approve and compact context",
						"Approve and keep context",
						"Refine plan",
					],
				},
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
				longList(i => ({
					label: `Account ${i}`,
					providerName: "OpenAI Codex",
					availableCount: 1,
					target: { provider: "openai-codex", accountId: `acc-${i}` },
					active: i === 0,
				})),
				() => {},
				() => {},
			),
	},
	{
		name: "RollbackPickerComponent",
		create: () =>
			new RollbackPickerComponent(
				longList(i => ({
					version: `1.0.${i}`,
					publishedAt: "2026-01-01",
					current: i === 0,
					newer: false,
					visited: true,
					changelogUrl: "https://example.com",
				})),
				{ onSelect: () => {}, onCancel: () => {}, openUrl: async () => true },
			),
	},
	{
		name: "SessionSelectorComponent",
		create: rows =>
			new SessionSelectorComponent(
				longList(i => ({
					path: `/sessions/${i}.jsonl`,
					id: `session-${i}`,
					cwd: "/repo",
					title: `Session ${i}`,
					created: new Date(0),
					modified: new Date(0),
					messageCount: 2,
					size: 1024,
					firstMessage: `First message ${i}`,
					allMessagesText: `First message ${i}`,
				})),
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
				longList(i => ({ name: `sub${i}`, description: `Subcommand ${i}` })),
				() => {},
				() => {},
			),
	},
	{
		name: "ThemeSelectorComponent",
		create: () =>
			new ThemeSelectorComponent(
				"dark",
				["dark", "light", "titanium", ...longList(i => `theme-${i}`)],
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
				[userTurnChain(LONG_LIST)],
				`turn-${LONG_LIST - 1}`,
				() => {},
				() => {},
			),
	},
	{
		name: "UserMessageSelectorComponent",
		create: () =>
			new UserMessageSelectorComponent(
				longList(i => ({ id: `m${i}`, text: `Message ${i}`, timestamp: "2026-01-01" })),
				() => {},
				() => {},
			),
	},
];
