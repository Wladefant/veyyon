//! WHY: the General settings page drew its search bar from the query string it
//! already held, which produced an `EditorSlot::Static`. A static slot takes no
//! focus and receives no keystroke, so the field looked typeable and was not:
//! every character an operator pressed went to the surface behind the sheet and
//! the page never narrowed. A page of two hundred rows with a dead filter is
//! the whole reason the filter exists.
//!
//! CLASS CLOSED: a retained field whose editor the page never creates. The
//! query field is driven here the way every other field is — the editor the
//! frame retained, focused, then typed into through the window's own dispatch —
//! and the assertions are on what the list draws afterwards, not on what the
//! field holds. Each behaviour of the filter is covered: typing narrows on the
//! frame the character landed on, a non-matching query states itself and its
//! corrective action, the clear control and Escape both empty the filter and
//! the field, a submit of the query sends the host nothing, and the query
//! survives a page the operator left and came back to.
//!
//! NOT CAUGHT: which rows a query is expected to match, which
//! `matches_query`'s own cases own; and the virtualization of the narrowed
//! list, which `the-general-settings-list-virtualizes-and-preserves-scroll`
//! owns.

mod support;

use serde_json::Value;
use veyyon_desktop_model::{SettingEntry, SettingKind, SettingsView};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{Headless, headless_context},
};
use veyyon_desktop_surface::{
	FieldKey, Overlay, SettingsPage, SettingsState, ShellView, navigation::SurfaceRoute,
};

use support::general_settings_list::open_general_settings_session;

/// The keys the page is given. One carries the query's text in its key, one in
/// its description, and the rest match nothing it is typed.
const KEYS: [(&str, &str, &str); 5] = [
	("mnemopi.enabled", "Memory engine", "Records recall triples on disk"),
	("mnemopi.budget", "Memory budget", "How much of the window recall may spend"),
	("drawer.copy_on_select", "Copy on select", "Takes the selection into the clipboard"),
	("rail.width", "Rail width", "How wide the queue rail draws"),
	("transcript.density", "Density", "How much air a turn is drawn with"),
];

/// What is typed into the field. Two of the five rows carry it.
const QUERY: &str = "mnemopi";

/// A query no row carries, which is what draws the empty state.
const ABSENT: &str = "zzzz";

fn settings_view() -> SettingsView {
	let mut view = SettingsView::new();
	for (key, label, description) in KEYS {
		view.insert(key.to_owned(), SettingEntry {
			value:       Value::Bool(true),
			default:     Value::Bool(true),
			source:      "default".to_owned(),
			kind:        SettingKind::Boolean,
			label:       Some(label.to_owned()),
			description: Some(description.to_owned()),
			tab:         Some("general".to_owned()),
			group:       None,
			values:      Vec::new(),
			options:     Vec::new(),
			min:         None,
			max:         None,
			global:      false,
			advanced:    false,
			hidden:      false,
		});
	}
	view
}

/// The window with the General page open, sized wide enough that the sheet
/// draws its field and its rows rather than shedding either.
fn open_general(cx: &mut Headless) -> HeadlessSession<'_, ShellView> {
	open_general_settings_session(cx, settings_view(), true)
}

/// Focuses the query field the frame retained and types `text` into it,
/// through the window's own key dispatch.
///
/// The field is focused by hand rather than by a click at its pixels: what is
/// under test is that the page created an editor at all and narrows as it is
/// typed, and a click resolves to the same focus handle either way.
fn type_query(session: &mut HeadlessSession<'_, ShellView>, text: &str) {
	let editor = session
		.update(|view, _window, _cx| view.retained_field(&FieldKey::SettingsQuery))
		.expect("the retained field is read back")
		.expect("the General page draws a query field");
	session
		.update(|_view, window, cx| {
			let focus = editor.read(cx).focus_handle().clone();
			window.focus(&focus, cx);
		})
		.expect("the field takes the keyboard");
	session.frame().expect("the focused field draws");
	session.type_text(text).expect("the query is typed");
	session.frame().expect("the narrowed page draws");
}

/// How many rows the page is currently narrowed to.
fn visible(session: &mut HeadlessSession<'_, ShellView>) -> usize {
	session
		.update(|view, _window, _cx| view.general_settings_list().item_count())
		.expect("the visible count is read back")
}

/// Whether the query field is the thing the keyboard reaches.
fn field_has_keyboard(session: &mut HeadlessSession<'_, ShellView>) -> bool {
	session
		.update(|view, window, cx| {
			view
				.retained_field(&FieldKey::SettingsQuery)
				.is_some_and(|editor| editor.read(cx).focus_handle().is_focused(window))
		})
		.expect("the focus is read back")
}

/// What the query field holds.
fn field_text(session: &mut HeadlessSession<'_, ShellView>) -> String {
	session
		.update(|view, _window, cx| {
			view
				.retained_field(&FieldKey::SettingsQuery)
				.map(|editor| editor.read(cx).text().to_owned())
				.unwrap_or_default()
		})
		.expect("the field's text is read back")
}

#[test]
fn a_typed_query_narrows_the_rows_on_the_frame_it_was_typed_on() {
	let mut cx = headless_context().expect("headless renderer available");
	let mut session = open_general(&mut cx);
	session.frame().expect("the page draws");
	assert_eq!(visible(&mut session), KEYS.len(), "the unnarrowed page must draw every row");

	type_query(&mut session, QUERY);

	assert_eq!(field_text(&mut session), QUERY, "the keystrokes reached no editor");
	assert_eq!(
		visible(&mut session),
		2,
		"the page drew rows the query excludes, so the typing narrowed nothing"
	);
}

#[test]
fn a_narrowed_page_sheds_the_shaped_text_of_the_rows_it_dropped() {
	let mut cx = headless_context().expect("headless renderer available");
	let mut session = open_general(&mut cx);
	let before = session.frame().expect("the page draws").text_runs.len();

	type_query(&mut session, QUERY);
	let after = session
		.frame()
		.expect("the narrowed page draws")
		.text_runs
		.len();

	assert!(
		after < before,
		"the narrowed page shaped {after} runs against {before} unnarrowed, so the rows it dropped \
		 were still drawn"
	);
}

#[test]
fn a_query_no_row_carries_states_itself_and_what_to_do_about_it() {
	let mut cx = headless_context().expect("headless renderer available");
	let mut session = open_general(&mut cx);
	session.frame().expect("the page draws");

	type_query(&mut session, ABSENT);

	assert_eq!(visible(&mut session), 0, "a query no row carries must narrow the page to none");
	// The page states the condition and what to do about it, so a query that
	// matched nothing draws more than the field it was typed into. The strings
	// themselves are `render_general_page`'s, and a shaped run carries no text
	// to assert against, so what is pinned here is that the page did not go
	// blank under a query it could not satisfy.
	let empty = session.frame().expect("the emptied page draws");
	let field_only = 2;
	assert!(
		empty.text_runs.len() > field_only,
		"the page narrowed to no rows shaped {} runs, so it stated neither the query nor the way \
		 out of it",
		empty.text_runs.len()
	);

	// The field is still drawn and still holds the keyboard, which is the way
	// out of the empty result: typing the query down brings the rows back. A
	// page that replaced its own field with the row above would leave the
	// query uneditable and every key pressed on it reaching nothing.
	assert!(
		field_has_keyboard(&mut session),
		"the page narrowed to no rows took its own field away with the keyboard inside it"
	);
	for _ in 0..ABSENT.len() {
		assert!(
			session
				.keystroke("backspace")
				.expect("backspace dispatches"),
			"backspace reached no handler over the field"
		);
	}
	session.frame().expect("the widened page draws");
	assert_eq!(field_text(&mut session), "", "the query was not typed back down");
	assert_eq!(visible(&mut session), KEYS.len(), "the rows did not come back with the query");
}

#[test]
fn the_clear_control_empties_the_filter_and_the_field_together() {
	let mut cx = headless_context().expect("headless renderer available");
	let mut session = open_general(&mut cx);
	session.frame().expect("the page draws");
	type_query(&mut session, QUERY);

	session
		.update(|view, _window, cx| view.clear_settings_query(cx))
		.expect("the clear control runs");
	session.frame().expect("the widened page draws");

	assert_eq!(field_text(&mut session), "", "the field kept text the filter no longer has");
	assert_eq!(visible(&mut session), KEYS.len(), "clearing the query must draw every row again");
}

#[test]
fn escape_in_the_field_widens_the_page_and_leaves_it_open() {
	let mut cx = headless_context().expect("headless renderer available");
	let mut session = open_general(&mut cx);
	session.frame().expect("the page draws");
	type_query(&mut session, QUERY);

	assert!(
		session.keystroke("escape").expect("escape dispatches"),
		"escape reached no handler over the field"
	);
	session.frame().expect("the widened page draws");

	assert_eq!(field_text(&mut session), "", "escape left the query in the field");
	assert_eq!(visible(&mut session), KEYS.len(), "escape left the page narrowed");
	let open = session
		.update(|view, _window, _cx| matches!(view.state().overlay, Some(Overlay::Settings(_))))
		.expect("the overlay is read back");
	assert!(open, "the first escape closed the page instead of widening it");
}

#[test]
fn a_submit_of_the_query_sends_the_host_nothing() {
	let mut cx = headless_context().expect("headless renderer available");
	let mut session = open_general(&mut cx);
	session.frame().expect("the page draws");
	session
		.update(|view, _window, _cx| {
			view.drain_intents();
		})
		.expect("the opening frame's intents are dropped");

	type_query(&mut session, QUERY);
	assert!(
		session
			.keystroke("enter")
			.expect("the return key dispatches"),
		"the return key reached no handler over the field"
	);
	session.frame().expect("the page draws after the submit");

	let sent = session
		.update(|view, _window, _cx| view.drain_intents())
		.expect("what the submit sent is read back");
	assert!(sent.is_empty(), "a query is this window's own and reported {sent:?} to the host");
	assert_eq!(visible(&mut session), 2, "the submit widened the page it was narrowed to");
}

#[test]
fn a_page_left_narrowed_is_drawn_narrowed_when_it_is_returned_to() {
	let mut cx = headless_context().expect("headless renderer available");
	let mut session = open_general(&mut cx);
	session.frame().expect("the page draws");
	type_query(&mut session, QUERY);

	// The sheet is closed and opened again, which is what discards the editor
	// the field was drawn from and creates the next one.
	session
		.update(|view, _window, cx| {
			view.state_mut().overlay = None;
			cx.notify();
		})
		.expect("the page closes");
	session.frame().expect("the shell draws without the page");
	session
		.update(|view, _window, cx| {
			let mut settings = SettingsState::new(SettingsPage::General);
			settings.route = Some(SurfaceRoute::Page(SettingsPage::General));
			settings.settings = settings_view();
			view.state_mut().overlay = Some(Overlay::Settings(Box::new(settings)));
			cx.notify();
		})
		.expect("the page opens again");
	session.frame().expect("the page draws again");

	assert_eq!(field_text(&mut session), QUERY, "the field forgot the query the page still has");
	assert_eq!(visible(&mut session), 2, "the page was returned to unnarrowed");
}

#[test]
fn the_page_hands_its_keyboard_to_the_query_field() {
	let mut cx = headless_context().expect("headless renderer available");
	let mut session = open_general(&mut cx);
	session.frame().expect("the page draws");

	assert!(
		field_has_keyboard(&mut session),
		"the page drew with the keyboard somewhere a character cannot be typed"
	);
	// Typed without focusing anything by hand, which is the reach under test.
	session.type_text(QUERY).expect("the query is typed");
	session.frame().expect("the narrowed page draws");
	assert_eq!(visible(&mut session), 2, "what was typed on the open page narrowed nothing");
}

#[test]
fn a_page_that_draws_no_query_field_does_not_hold_the_keyboard_in_it() {
	let mut cx = headless_context().expect("headless renderer available");
	let mut session = open_general(&mut cx);
	session.frame().expect("the page draws");
	assert!(field_has_keyboard(&mut session), "the General page must start in its field");

	session
		.update(|view, _window, cx| {
			let Some(Overlay::Settings(settings)) = view.state_mut().overlay.as_mut() else {
				panic!("the settings page is open");
			};
			settings.page = SettingsPage::Keybindings;
			settings.route = Some(SurfaceRoute::Page(SettingsPage::Keybindings));
			cx.notify();
		})
		.expect("the operator moves to another page");
	session.frame().expect("the other page draws");

	assert!(
		!field_has_keyboard(&mut session),
		"a page drawing no query field left the keyboard inside one, so every key pressed on it was \
		 typed out of sight"
	);
}
