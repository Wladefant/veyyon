//! The filter the General settings page draws its rows through (§5.9).
//!
//! A query is this window's own: the host stores none, reports none, and is
//! sent none. It is applied on the frame each character lands on, so the rows
//! narrow as the field is typed into rather than on a submit of it.

use veyyon_gpui::Context;

use super::FieldKey;
use crate::{ShellView, settings::SettingsPage};

impl ShellView {
	/// Narrows the General settings page to what the query field holds. The
	/// list reads the query out of its own state, so a repaint is asked for
	/// here: nothing is sent to the host, and no other path marks the window
	/// dirty on the frame a character was typed on.
	///
	/// The query lives in the list's own state rather than in this view, so
	/// writing it takes a shared borrow.
	pub(super) fn apply_settings_query(&self, cx: &mut Context<Self>) {
		let Some(editor) = self.retained_field(&FieldKey::SettingsQuery) else {
			return;
		};
		let query = editor.read(cx).text().to_owned();
		if self.general_settings_list().query() == query {
			return;
		}
		self.general_settings_list().set_query(query);
		cx.notify();
	}

	/// Empties the query field and the filter behind it, for the clear
	/// control the field draws once it holds text and for an Escape pressed
	/// inside it.
	pub fn clear_settings_query(&mut self, cx: &mut Context<Self>) {
		self.general_settings_list().clear_query();
		if let Some(editor) = self.retained_field(&FieldKey::SettingsQuery) {
			editor.update(cx, |editor, cx| editor.set_text(String::new(), cx));
		}
		cx.notify();
	}

	/// Whether the page on screen draws the query field: the General page,
	/// with settings to search. A page the host reported no schema for draws
	/// the row that states so and no field, and focusing a field no frame
	/// drew would leave the keyboard where no key reaches a handler. The page
	/// closing behind its own animation draws nothing either, so this reads
	/// the open overlay rather than the one the float still holds.
	#[must_use]
	pub fn settings_query_is_drawn(&self) -> bool {
		self.state().overlay_settings().is_some_and(|settings| {
			settings.page == SettingsPage::General && !settings.settings.is_empty()
		})
	}

	/// Whether a press of Escape has a query to widen: the General page is on
	/// screen and its rows are narrowed by one. The page is what the query
	/// belongs to, so a query left behind by a page that is not drawn widens
	/// nothing.
	#[must_use]
	pub fn settings_query_is_narrowing(&self) -> bool {
		self.settings_query_is_drawn() && !self.general_settings_list().query().is_empty()
	}
}
