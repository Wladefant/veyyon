//! Projection from protocol store domains onto overlay view models (§5.8,
//! §5.9).
//!
//! Synchronizes host settings, themes, keybindings, providers, authentication,
//! file trees, and search results onto active `Overlay::Settings` and
//! `Overlay::Palette` state.

use veyyon_desktop_model::{FileKind, Store};
use veyyon_desktop_surface::{
	Overlay, PaletteItem, PaletteMode, PaletteState, SettingsState, ShellState,
};

/// Projects domain store views onto active overlay state fields.
pub fn project_overlay(store: &Store, state: &mut ShellState) {
	match &mut state.overlay {
		Some(Overlay::Settings(settings_state)) => {
			project_settings_domains(store, settings_state);
		},
		Some(Overlay::Palette(palette_state)) => {
			project_palette_domains(store, palette_state);
		},
		None => {},
	}
}

/// Populates settings overlay categories from host domain snapshots.
fn project_settings_domains(store: &Store, state: &mut SettingsState) {
	if let Some(settings) = &store.domains.settings {
		state.settings = settings.clone();
	}
	if let Some(themes) = &store.domains.themes {
		state.themes = Some(themes.clone());
	}
	if !store.domains.keybindings.is_empty() {
		state.keybindings.clone_from(&store.domains.keybindings);
	}
	if !store.domains.providers.is_empty() {
		state.providers.clone_from(&store.domains.providers);
	}
	if let Some(auth_flow) = &store.domains.auth_flow {
		state.auth_flow = Some(auth_flow.clone());
	}
	if !store.domains.mcp.is_empty() {
		state.mcp.clone_from(&store.domains.mcp);
	}
	if !store.domains.agents.is_empty() {
		state.extensions.clone_from(&store.domains.agents);
	}
	if let Some(diagnostics) = &store.domains.diagnostics {
		state.diagnostics = Some(diagnostics.clone());
	}
	if let Some(active_session) = &store.persisted.shell.active_session {
		if let Some(usage) = store.domains.usage.get(active_session) {
			state.usage = Some(usage.clone());
		}
		if let Some(ctx) = store.domains.context.get(active_session) {
			state.context = Some(ctx.clone());
		}
	}
}

/// Populates palette items from file tree and search result domains.
fn project_palette_domains(store: &Store, state: &mut PaletteState) {
	match state.mode {
		PaletteMode::Files => {
			if !state.query.trim().is_empty() && let Some(search) = &store.domains.search {
				let mut items = Vec::new();
				for (idx, path) in search.paths.iter().enumerate() {
					items.push(PaletteItem::file(idx as u64 + 1000, path.clone()));
				}
				state.items = items;
			} else if let Some(tree) = &store.domains.file_tree {
				let mut items = Vec::new();
				for (idx, entry) in tree.entries.iter().enumerate() {
					if entry.kind == FileKind::File {
						items.push(PaletteItem::file(idx as u64 + 1000, entry.path.clone()));
					}
				}
				if !items.is_empty() {
					state.items = items;
				}
			}
		},
		PaletteMode::ContentSearch => {
			if let Some(search) = &store.domains.search {
				let mut items = Vec::new();
				for (idx, path) in search.paths.iter().enumerate() {
					items.push(PaletteItem::file(idx as u64 + 2000, path.clone()));
				}
				state.items = items;
			}
		},
		PaletteMode::Browse => {
			if let Some(tree) = &store.domains.file_tree {
				let mut items = Vec::new();
				for (idx, entry) in tree.entries.iter().enumerate() {
					if entry.kind == FileKind::Directory {
						items.push(PaletteItem::directory(idx as u64 + 3000, entry.path.clone()));
					}
				}
				if !items.is_empty() {
					state.items = items;
				}
			}
		},
		PaletteMode::Commands | PaletteMode::Sessions | PaletteMode::Models => {},
	}
}

#[cfg(test)]
mod tests {
	use std::collections::BTreeMap;

	use veyyon_desktop_model::{SettingEntry, SettingKind};

	use super::*;

	#[test]
	fn an_overlay_opened_after_initial_sync_receives_existing_settings() {
		let mut store = Store::new();
		store.domains.settings = Some(BTreeMap::from([(
			"editor.copy_on_select".to_string(),
			SettingEntry {
				value:       serde_json::Value::Bool(true),
				default:     serde_json::Value::Bool(true),
				source:      "profile".to_string(),
				kind:        SettingKind::Boolean,
				label:       Some("Copy on select".to_string()),
				description: None,
				tab:         Some("general".to_string()),
				group:       None,
				values:      Vec::new(),
				options:     Vec::new(),
				min:         None,
				max:         None,
				global:      false,
				advanced:    false,
				hidden:      false,
			},
		)]));
		let mut state = ShellState {
			overlay: Some(Overlay::Settings(Box::new(SettingsState::default()))),
			..ShellState::default()
		};

		project_overlay(&store, &mut state);

		let settings = state
			.overlay
			.as_ref()
			.and_then(Overlay::as_settings)
			.expect("settings overlay remains open");
		assert!(
			settings.entry("editor.copy_on_select").is_some(),
			"settings already in the store must reach an overlay opened later"
		);
	}

	#[test]
	fn palette_in_files_mode_projects_search_results_and_file_tree() {
		let mut store = Store::new();
		store.domains.search = Some(veyyon_desktop_model::SearchResultsView {
			query: "lib".to_string(),
			paths: vec!["src/lib.rs".to_string(), "crates/lib.rs".to_string()],
			truncated: false,
		});
		store.domains.file_tree = Some(veyyon_desktop_model::FileTreeView {
			root: ".".to_string(),
			entries: vec![
				veyyon_desktop_model::FileNode {
					name: "main.rs".to_string(),
					path: "src/main.rs".to_string(),
					kind: FileKind::File,
					depth: 1,
				},
			],
			truncated: false,
		});

		let mut state = ShellState {
			overlay: Some(Overlay::Palette(PaletteState {
				query: "lib".to_string(),
				mode: PaletteMode::Files,
				selected: 0,
				items: Vec::new(),
				browse_path: Vec::new(),
				browse_root: None,
			})),
			..ShellState::default()
		};

		project_overlay(&store, &mut state);

		let palette = state.overlay.as_ref().and_then(Overlay::as_palette).expect("palette open");
		assert_eq!(palette.items.len(), 2);
		assert_eq!(palette.items[0].title, "src/lib.rs");

		let mut state_empty = ShellState {
			overlay: Some(Overlay::Palette(PaletteState {
				query: String::new(),
				mode: PaletteMode::Files,
				selected: 0,
				items: Vec::new(),
				browse_path: Vec::new(),
				browse_root: None,
			})),
			..ShellState::default()
		};
		project_overlay(&store, &mut state_empty);
		let palette_empty = state_empty.overlay.as_ref().and_then(Overlay::as_palette).expect("palette open");
		assert_eq!(palette_empty.items.len(), 1);
		assert_eq!(palette_empty.items[0].title, "src/main.rs");
	}
}
