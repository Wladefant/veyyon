//! General settings page body rendering (§5.9).

use std::{
	cell::RefCell,
	collections::hash_map::DefaultHasher,
	hash::{Hash, Hasher},
	rc::Rc,
};

use veyyon_desktop_kit::{ColorRole, SearchField, SpacingStep, TextRamp, TokenSet, Tooltip};
use veyyon_desktop_model::{SettingsView, SurfaceId};
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{
	ClickEvent, Context, Div, ElementId, InteractiveElement, IntoElement, ListAlignment, ListOffset,
	ListState, ParentElement, StatefulInteractiveElement, Styled, div, px,
};

use crate::{
	Intent, ShellView,
	controls::ControlStates,
	settings::{
		SettingsState,
		body::{
			conditions::{is_setting_condition_met, matches_query},
			general_control::setting_control,
		},
		row::{empty_state_row, setting_row_with_secondary},
	},
};

/// Window-local retained list state for the General settings page (§5.9).
#[derive(Clone)]
pub struct GeneralSettingsListState(Rc<RefCell<GeneralSettingsListStateInner>>);

struct GeneralSettingsListStateInner {
	list_state:        ListState,
	visible_keys:      Vec<String>,
	text_fingerprints: Vec<u64>,
	query:             String,
}

impl Default for GeneralSettingsListState {
	fn default() -> Self {
		Self::new()
	}
}

impl GeneralSettingsListState {
	/// Creates a new empty general settings list state.
	#[must_use]
	pub fn new() -> Self {
		let list_state = ListState::new(0, ListAlignment::Top, px(44.0));
		Self(Rc::new(RefCell::new(GeneralSettingsListStateInner {
			list_state,
			visible_keys: Vec::new(),
			text_fingerprints: Vec::new(),
			query: String::new(),
		})))
	}

	/// Returns a clone of the underlying GPUI `ListState`.
	#[must_use]
	pub fn list_state(&self) -> ListState {
		self.0.borrow().list_state.clone()
	}

	/// Returns the number of visible settings in the list.
	#[must_use]
	pub fn item_count(&self) -> usize {
		self.0.borrow().visible_keys.len()
	}

	/// Returns the visible setting keys snapshot.
	#[must_use]
	pub fn visible_keys(&self) -> Vec<String> {
		self.0.borrow().visible_keys.clone()
	}

	/// Scrolls the list to reveal the setting at `index`.
	pub fn scroll_to_reveal_item(&self, index: usize) {
		self
			.0
			.borrow()
			.list_state
			.scroll_to(ListOffset { item_ix: index, offset_in_item: px(0.0) });
	}

	/// Scrolls the list to reveal the setting with `key`.
	pub fn scroll_to_reveal_key(&self, key: &str) {
		let inner = self.0.borrow();
		if let Some(ix) = inner.visible_keys.iter().position(|k| k == key) {
			inner
				.list_state
				.scroll_to(ListOffset { item_ix: ix, offset_in_item: px(0.0) });
		}
	}

	/// Sets the active search filter query.
	pub fn set_query(&self, query: String) {
		self.0.borrow_mut().query = query;
	}

	/// Returns the current search filter query.
	#[must_use]
	pub fn query(&self) -> String {
		self.0.borrow().query.clone()
	}

	/// Clears the search filter query.
	pub fn clear_query(&self) {
		self.0.borrow_mut().query.clear();
	}

	/// Synchronizes visible keys and invalidates measurements if text or
	/// visibility changes, while preserving scroll and layout when only values
	/// change.
	pub fn sync(&self, settings: &SettingsView) {
		let mut inner = self.0.borrow_mut();
		let mut new_keys = Vec::new();
		let mut new_fps = Vec::new();
		let query = inner.query.trim().to_lowercase();

		for (key, entry) in settings {
			if entry.hidden {
				continue;
			}
			if !is_setting_condition_met(key, settings) {
				continue;
			}
			if !query.is_empty() && !matches_query(key, entry, &query) {
				continue;
			}
			new_keys.push(key.clone());
			let mut hasher = DefaultHasher::new();
			key.hash(&mut hasher);
			entry.label.hash(&mut hasher);
			entry.description.hash(&mut hasher);
			entry.kind.hash(&mut hasher);
			new_fps.push(hasher.finish());
		}
		let new_count = new_keys.len();
		let old_count = inner.visible_keys.len();

		if new_count != old_count {
			if new_count > old_count {
				inner
					.list_state
					.splice(old_count..old_count, new_count - old_count);
			} else {
				inner.list_state.splice(new_count..old_count, 0);
			}
		}

		for (ix, &fp) in new_fps.iter().enumerate() {
			let key_changed = inner.visible_keys.get(ix) != new_keys.get(ix);
			let fp_changed = inner.text_fingerprints.get(ix) != Some(&fp);
			if key_changed || fp_changed {
				inner.list_state.remeasure_items(ix..ix + 1);
			}
		}

		inner.visible_keys = new_keys;
		inner.text_fingerprints = new_fps;
	}
}

/// Renders the General configuration settings page rows.
pub fn render_general_page(
	state: &SettingsState,
	list_state_handle: &GeneralSettingsListState,
	controls: &ControlStates,
	geometry: &SettingsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	// The sheet states the refusal of any field it draws in one row above the
	// page, which a virtualized list cannot scroll out of sight (§4.4).

	if state.settings.is_empty() {
		return div()
			.w_full()
			.h_full()
			.flex()
			.flex_col()
			.gap(px(geometry.row_gap))
			.child(empty_state_row(
				"No settings reported by host.",
				"Host capability Settings reported no schema; verify host connection",
				geometry,
				tokens,
			));
	}

	list_state_handle.sync(&state.settings);

	let visible_keys: Rc<[String]> = Rc::from(list_state_handle.visible_keys());
	if visible_keys.is_empty() {
		let (empty_msg, action_msg) = if list_state_handle.query().is_empty() {
			(
				"No configurable settings available.".to_string(),
				"Reported settings have unmet conditions or are hidden; configure settings in \
				 ~/.veyyon/config.yml"
					.to_string(),
			)
		} else {
			(
				format!("No settings matching \"{}\"", list_state_handle.query()),
				"Clear or edit the search query".to_string(),
			)
		};
		return div()
			.w_full()
			.h_full()
			.flex()
			.flex_col()
			.gap(px(geometry.row_gap))
			.child(empty_state_row(&empty_msg, &action_msg, geometry, tokens));
	}

	let list_state = list_state_handle.list_state();
	let controls_copy = controls.clone();
	let geometry_copy = geometry.clone();
	let tokens_copy = tokens.clone();
	let entity = cx.entity();
	let weak_view = cx.weak_entity();

	let list_el = veyyon_gpui::list(list_state, move |item_ix, window, app| {
		let Some(key) = visible_keys.get(item_ix) else {
			return div().into_any_element();
		};
		// The entry is cloned out of the view, because a text row creates its
		// editor through the same entity and cannot hold a read borrow of it.
		let entry = {
			let view_read = entity.read(app);
			let Some(entry) = view_read.active_settings().and_then(|s| s.entry(key)) else {
				return div().into_any_element();
			};
			entry.clone()
		};
		let entry = &entry;
		let field_id = SurfaceId::SettingsField(key.clone());
		let av = controls_copy.availability(&field_id);
		let is_invalid = controls_copy.error(&field_id).is_some();

		let control_el = setting_control(key, entry, &av, is_invalid, entity.clone(), window, app);
		let is_modified = entry.value != entry.default;
		let secondary_el = if is_modified {
			let key_clone = key.clone();
			let weak_for_reset = weak_view.clone();
			let foreground = tokens_copy.color(ColorRole::Foreground);
			let reset_btn = div()
				.id(ElementId::Name(format!("reset-{key}").into()))
				.cursor_pointer()
				.text_size(tokens_copy.font_size(TextRamp::Small))
				.text_color(tokens_copy.color(ColorRole::Muted))
				.hover(move |s| s.text_color(foreground))
				.on_click(move |_e: &ClickEvent, _w, app| {
					let _ = weak_for_reset.update(app, |view, cx| {
						view.dispatch(Intent::ResetSetting(key_clone.clone()), cx);
					});
				})
				.child("Reset");
			let default = entry
				.default
				.as_str()
				.map_or_else(|| entry.default.to_string(), crate::settings::row::shorten_path);
			Some(
				Tooltip::new(format!("Default: {default}"), reset_btn)
					.keyed(format!("reset-tip-{key}"))
					.into_any_element(),
			)
		} else {
			None
		};

		let prev_group = if item_ix > 0 {
			visible_keys.get(item_ix - 1).and_then(|k| {
				let view_read = entity.read(app);
				view_read
					.active_settings()
					.and_then(|s| s.entry(k))
					.and_then(|e| e.group.clone())
			})
		} else {
			None
		};
		let show_header = if item_ix == 0 {
			entry.group.is_some()
		} else {
			entry.group.is_some() && entry.group != prev_group
		};
		let group_header = if show_header {
			entry.group.as_deref().map(|g| {
				crate::settings::row::group_header_row(g, item_ix == 0, &geometry_copy, &tokens_copy)
			})
		} else {
			None
		};

		let mut row_container = div()
			.w_full()
			.flex()
			.flex_col()
			.gap(px(geometry_copy.row_gap));

		if let Some(gh) = group_header {
			row_container = row_container.child(gh);
		}

		row_container = row_container.child(setting_row_with_secondary(
			entry.label.as_deref().unwrap_or(key),
			entry.description.as_deref(),
			control_el,
			secondary_el,
			&av,
			&geometry_copy,
			&tokens_copy,
		));

		if item_ix > 0 && !show_header {
			row_container = row_container.mt(px(geometry_copy.row_gap));
		}
		row_container.into_any_element()
	})
	.w_full()
	.h_full();

	let query = list_state_handle.query();
	let weak_for_clear = cx.weak_entity();
	let search_bar = div().w_full().mb(tokens.spacing(SpacingStep::S3)).child(
		SearchField::new("settings-search", query)
			.placeholder("Search settings...")
			.on_clear(move |_win, app| {
				let _ = weak_for_clear.update(app, |view, cx| {
					view.general_settings_list().clear_query();
					cx.notify();
				});
			}),
	);

	div()
		.w_full()
		.h_full()
		.flex()
		.flex_col()
		.overflow_hidden()
		.child(search_bar)
		.child(div().flex_1().min_h_0().child(list_el))
}
