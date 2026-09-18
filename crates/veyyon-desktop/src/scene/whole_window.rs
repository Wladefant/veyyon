//! Whole-window scene builders (§9.2, pass X1).
//!
//! Synthesises whole-window states across the 12 lifecycle and assembly states:
//! rest, populated, streaming, panel docked, panel overlaid, drawer open,
//! both open, dialog up, toast, mid-approval, disconnected, and first-run.

use veyyon_desktop_model::{
	ApprovalInteraction, BadgeKind, Capability, CapabilityStatus, ChangeScope, ChangeStatus,
	ChangedFile, ChangesView, ConnectionState, ContentBlock, ContextBreakdownView, FileKind,
	FileNode, FileTreeView, InputModality, InteractionId, MessageRole, ModelRef, ModelView,
	ModelsView, Notification, NotificationPriority, NotificationSource, ProcessView, QueueMode,
	QueuePartition, SettingEntry, SettingKind, SettingsView, TerminalStatus, TerminalView,
	UsageTotals,
};
use veyyon_desktop_surface::{Badge, Overlay, TurnPhase};

use crate::{
	project::connection_notice,
	scene::seed::{Built, SCENE_CLOCK_MS, Seed},
};

fn base_populated_seed() -> (Seed, veyyon_desktop_model::SessionId) {
	let mut seed = Seed::attached();
	let active_id = seed.session(QueuePartition::Live);
	if let Some(s) = seed.store.sessions.get_mut(&active_id) {
		s.title = "File tree row retention".to_string();
	}
	let working_id = seed.badged_session(QueuePartition::Live, BadgeKind::Working);
	if let Some(s) = seed.store.sessions.get_mut(&working_id) {
		s.title = "Run clippy and cargo check".to_string();
	}
	let approval_id = seed.badged_session(QueuePartition::Live, BadgeKind::Approval);
	if let Some(s) = seed.store.sessions.get_mut(&approval_id) {
		s.title = "Deploy staging cluster".to_string();
	}
	let due_id = seed.badged_session(QueuePartition::Pinned, BadgeKind::Due);
	if let Some(s) = seed.store.sessions.get_mut(&due_id) {
		s.title = "Review PR #142: GPUI renderer".to_string();
	}
	let done_id = seed.badged_session(QueuePartition::Parked, BadgeKind::Done);
	if let Some(s) = seed.store.sessions.get_mut(&done_id) {
		s.title = "Add surface token tests".to_string();
	}

	seed.entry(&active_id, MessageRole::User, vec![ContentBlock::Text {
		text: "Keep the file tree's expanded rows across a panel resize, and line the gutter \
		       numbers up with the code beside them at every width."
			.to_string(),
	}]);
	seed.entry(&active_id, MessageRole::Assistant, vec![ContentBlock::Text {
		text: "The tree holds its expanded rows now, and the gutter shares the line height of the \
		       code:\n\n```rust\npub fn gutter(rows: RowWalk<'_>, geom: &PanelsSurfaceTokens) -> \
		       impl IntoElement \
		       {\n\tdiv().w(px(geom.gutter_width_px)).children(rows.numbers())\n}\n```\n\nThe \
		       numbers stay pinned while the pane scrolls sideways."
			.to_string(),
	}]);

	seed.store.domains.models = Some(ModelsView {
		models:          vec![ModelView {
			provider:       "anthropic".to_string(),
			id:             "claude-sonnet-4.5".to_string(),
			name:           "Claude Sonnet 4.5".to_string(),
			reasoning:      true,
			context_window: 200_000,
			max_output:     64_000,
			input:          vec![InputModality::Text, InputModality::Image],
		}],
		current:         Some(ModelRef {
			provider: "anthropic".to_string(),
			id:       "claude-sonnet-4.5".to_string(),
		}),
		thinking_level:  Some("high".to_string()),
		thinking_levels: ["off", "low", "medium", "high"].map(str::to_owned).to_vec(),
	});

	seed
		.store
		.domains
		.context
		.insert(active_id.clone(), ContextBreakdownView {
			session:      active_id.clone(),
			total_tokens: 38_420,
			limit_tokens: Some(200_000),
			categories:   Vec::new(),
		});

	seed
		.store
		.domains
		.usage
		.insert(active_id.clone(), UsageTotals {
			input_tokens:         48_210,
			output_tokens:        12_940,
			cache_read_tokens:    1_402_887,
			cache_write_tokens:   96_004,
			orchestration_tokens: 3_118,
			premium_requests:     42,
			cost_microusd:        Some(3_940_000),
		});

	seed.state.title = "veyyon · File tree row retention".to_string();
	(seed, active_id)
}

fn add_right_panel_content(seed: &mut Seed) {
	seed.store.domains.changes.set(ChangesView {
		revision:       1,
		repository:     Some("/repo/veyyon".to_string()),
		scope:          ChangeScope::WorkingTree,
		files:          vec![
			ChangedFile {
				path:          "crates/veyyon-desktop-surface/src/layout.rs".to_string(),
				previous_path: None,
				status:        ChangeStatus::Modified,
				additions:     8,
				deletions:     1,
			},
			ChangedFile {
				path:          "crates/veyyon-desktop-surface/src/titlebar.rs".to_string(),
				previous_path: None,
				status:        ChangeStatus::Modified,
				additions:     14,
				deletions:     3,
			},
		],
		diff:           "@@ -50,6 +50,8 @@\n-use super::layout::column_widths;\n+use \
		                 super::layout::{column_widths, gutter_width};\n+pub fn render_shell() {}\n"
			.to_string(),
		diff_truncated: false,
		files_withheld: 0,
	});

	seed.store.domains.file_tree = Some(FileTreeView {
		root:      "/repo/veyyon".to_string(),
		entries:   vec![
			FileNode {
				path:  "crates".to_string(),
				name:  "crates".to_string(),
				kind:  FileKind::Directory,
				depth: 0,
			},
			FileNode {
				path:  "crates/veyyon-desktop".to_string(),
				name:  "veyyon-desktop".to_string(),
				kind:  FileKind::Directory,
				depth: 1,
			},
			FileNode {
				path:  "crates/veyyon-desktop-surface".to_string(),
				name:  "veyyon-desktop-surface".to_string(),
				kind:  FileKind::Directory,
				depth: 1,
			},
			FileNode {
				path:  "Cargo.toml".to_string(),
				name:  "Cargo.toml".to_string(),
				kind:  FileKind::File,
				depth: 0,
			},
		],
		truncated: false,
	});
}

fn add_drawer_content(seed: &mut Seed) {
	seed
		.store
		.capabilities
		.set(Capability::Terminals, CapabilityStatus::Available);
	seed
		.store
		.capabilities
		.set(Capability::ProcessSupervisor, CapabilityStatus::Available);
	seed.store.domains.terminals.push(TerminalView {
		id:     "term_001".to_string(),
		cwd:    "/repo/veyyon".to_string(),
		shell:  "bash".to_string(),
		cols:   80,
		rows:   24,
		status: TerminalStatus::Running,
	});
	seed.store.domains.processes.push(ProcessView {
		name:          "cargo-check".to_string(),
		pid:           Some(4201),
		status:        "running".to_string(),
		application:   "cargo".to_string(),
		args:          vec!["check".to_string(), "-p".to_string(), "veyyon-desktop".to_string()],
		cwd:           "/repo/veyyon".to_string(),
		lifetime:      "last-client-exit".to_string(),
		started_at_ms: SCENE_CLOCK_MS - 12_000,
		exit_code:     None,
		terminated_by: None,
	});
}

/// 1. Whole window at rest: single session, transcript, idle composer, no
///    panels.
#[must_use]
pub fn whole_window_rest() -> Built {
	let mut seed = Seed::attached();
	let active_id = seed.session(QueuePartition::Live);
	if let Some(s) = seed.store.sessions.get_mut(&active_id) {
		s.title = "File tree row retention".to_string();
	}
	seed.entry(&active_id, MessageRole::User, vec![ContentBlock::Text {
		text: "Keep the file tree's expanded rows across a panel resize.".to_string(),
	}]);
	seed.entry(&active_id, MessageRole::Assistant, vec![ContentBlock::Text {
		text: "The tree holds its expanded rows across a resize.".to_string(),
	}]);
	seed.state.title = "veyyon · File tree row retention".to_string();
	let mut built = seed.finish();
	built.state.keymap.panel_collapsed = true;
	built.state.drawer_open = false;
	built
}

/// 2. Whole window with content and no panels: four sessions with badges, a
///    transcript carrying a code block, and both side surfaces closed (§9.2,
///    pass X1).
#[must_use]
pub fn whole_window_populated() -> Built {
	let (seed, _) = base_populated_seed();
	let mut built = seed.finish();
	built.state.keymap.panel_collapsed = true;
	built.state.drawer_open = false;
	built
}

/// 3. Whole window during active streaming turn with tool run status.
#[must_use]
pub fn whole_window_streaming() -> Built {
	let (mut seed, active_id) = base_populated_seed();
	add_right_panel_content(&mut seed);
	seed.stream(&active_id, "bash");
	let mut built = seed.finish();
	built.state.turn = TurnPhase::Running { queue_mode: QueueMode::Steer };
	built.state.run_status = Some((Badge::Working, "bash · compiling veyyon-desktop".to_string()));
	built
}

/// 4. Whole window with the right panel open beside the transcript.
///
/// The overlaid presentation is the same panel below the 980px row, which one
/// viewport cannot show, so the shed's own suite proves it instead.
#[must_use]
pub fn whole_window_panel_docked() -> Built {
	let (mut seed, _) = base_populated_seed();
	add_right_panel_content(&mut seed);
	let mut built = seed.finish();
	built.state.keymap.panel_collapsed = false;
	built.state.drawer_open = false;
	built
}

/// 5. Whole window with terminal drawer open.
#[must_use]
pub fn whole_window_drawer_open() -> Built {
	let (mut seed, _) = base_populated_seed();
	add_drawer_content(&mut seed);
	let mut built = seed.finish();
	built.state.keymap.panel_collapsed = true;
	built.state.drawer_open = true;
	built
}

/// 6. Whole window with both right panel and terminal drawer open.
#[must_use]
pub fn whole_window_both_open() -> Built {
	let (mut seed, _) = base_populated_seed();
	add_right_panel_content(&mut seed);
	add_drawer_content(&mut seed);
	let mut built = seed.finish();
	built.state.keymap.panel_collapsed = false;
	built.state.drawer_open = true;
	built
}

/// 7. Whole window with modal Settings dialog up.
#[must_use]
pub fn whole_window_dialog_up() -> Built {
	let (mut seed, _) = base_populated_seed();
	add_right_panel_content(&mut seed);
	let mut settings = SettingsView::new();
	let entry = |value: serde_json::Value, kind: SettingKind, label: &str| SettingEntry {
		value: value.clone(),
		default: value,
		source: "default".to_string(),
		kind,
		label: Some(label.to_string()),
		description: Some("Configures desktop interface behavior.".to_string()),
		tab: Some("General".to_string()),
		group: None,
		values: Vec::new(),
		options: Vec::new(),
		min: None,
		max: None,
		global: false,
		advanced: false,
		hidden: false,
	};
	settings.insert(
		"ui.compact".to_string(),
		entry(serde_json::Value::Bool(true), SettingKind::Boolean, "Compact rows"),
	);
	settings.insert(
		"ui.theme".to_string(),
		entry(serde_json::Value::String("dark".to_string()), SettingKind::String, "Theme"),
	);
	seed.store.domains.settings = Some(settings);
	let mut built = seed.finish();
	built.state.overlay = Some(Overlay::Settings(Box::default()));
	built
}

/// 8. Whole window with announcement toast cards displayed.
#[must_use]
pub fn whole_window_toast() -> Built {
	let (mut seed, _) = base_populated_seed();
	add_right_panel_content(&mut seed);
	seed.store.notifications.raise(Notification {
		key:          "toast_001".to_string(),
		source:       NotificationSource::RequestFailed,
		priority:     NotificationPriority::Normal,
		title:        "Host refused to write src/main.rs".to_string(),
		detail:       Some("The path is outside the workspace root".to_string()),
		raised_at_ms: SCENE_CLOCK_MS - 2_000,
	});
	seed.store.notifications.raise(Notification {
		key:          "toast_002".to_string(),
		source:       NotificationSource::DecisionWaiting,
		priority:     NotificationPriority::Low,
		title:        "Approval waiting on Run clippy and cargo check".to_string(),
		detail:       None,
		raised_at_ms: SCENE_CLOCK_MS - 1_000,
	});
	seed.finish()
}

/// 9. Whole window mid-approval with a pending action card above the composer.
#[must_use]
pub fn whole_window_mid_approval() -> Built {
	let (mut seed, active_id) = base_populated_seed();
	add_right_panel_content(&mut seed);
	let unread = SCENE_CLOCK_MS - 5_000;
	seed.decide(&active_id, |pending| {
		pending.approvals.push(ApprovalInteraction {
			id:              InteractionId::from("interaction_0001"),
			tool_name:       "bash".to_string(),
			detail:          "cargo test -p veyyon-desktop --all-targets".to_string(),
			requested_at_ms: unread,
		});
	});
	seed.finish()
}

/// 10. Whole window in reconnecting / disconnected state with attention strip.
#[must_use]
pub fn whole_window_disconnected() -> Built {
	let (mut seed, _) = base_populated_seed();
	add_right_panel_content(&mut seed);
	let conn = ConnectionState::Reconnecting {
		attempt:     3,
		retry_at_ms: SCENE_CLOCK_MS + 2_000,
		message:     "connection reset by peer".to_string(),
	};
	seed.notice = connection_notice(&conn);
	seed.store.connection = conn;
	let mut built = seed.finish();
	built.state.connection = veyyon_desktop_surface::ConnectionPhase::Reconnecting {
		attempt:     3,
		retry_at_ms: SCENE_CLOCK_MS + 2_000,
		message:     "connection reset by peer".to_string(),
	};
	built
}

/// 11. Whole window on first run with empty queue and welcome prompt.
#[must_use]
pub fn whole_window_first_run() -> Built {
	let mut seed = Seed::attached();
	seed.store.persisted.shell.active_session = None;
	let mut built = seed.finish();
	built.state.keymap.panel_collapsed = true;
	built.state.drawer_open = false;
	built.state.title = "veyyon".to_string();
	built
}
