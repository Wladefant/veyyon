//! WHY: narrowing or widening the General settings query draws a different set
//! of rows, and the virtualized list holds its offset as an item index. Holding
//! that index across the change leaves the page scrolled to whatever setting
//! now sits at it, or to a blank band past the end of a shorter list.
//!
//! CLASS CLOSED: the offset a query change is drawn from, for both directions
//! the index survives the splice:
//! 1. Widening from an emptied page, where no item anchors the offset.
//! 2. Narrowing to a set the offset still falls inside, so the list clamps
//!    nothing and only the reset can put the page back at its first row.
//!
//! NOT CAUGHT: which rows a query keeps, which is
//! `typing-in-the-settings-query-narrows-the-rows-the-page-draws.rs`, and the
//! boundedness of the viewport itself, which is
//! `the-general-settings-list-virtualizes-and-preserves-scroll.rs`.

mod support;

use support::general_settings_list::{make_large_settings, open_general_settings_session};
use veyyon_desktop_scene::{HeadlessSession, headless::headless_context};
use veyyon_desktop_surface::ShellView;

/// Reads the list's own scroll offset.
fn scroll_top(session: &mut HeadlessSession<'_, ShellView>) -> veyyon_gpui::ListOffset {
	session
		.update(|view, _, _| {
			view
				.general_settings_list()
				.list_state()
				.logical_scroll_top()
		})
		.expect("the list's scroll offset is read back")
}

/// Sets the query the page narrows by and draws the frame it lands on.
fn narrow_to(session: &mut HeadlessSession<'_, ShellView>, query: &str) {
	let query = query.to_owned();
	session
		.update(move |view, _window, cx| {
			view.general_settings_list().set_query(query);
			cx.notify();
		})
		.expect("the query is set");
	session
		.frame()
		.expect("the frame the query lands on renders");
}

#[test]
fn a_query_that_empties_the_page_leaves_the_widened_list_at_its_first_row() {
	let mut cx = headless_context().expect("headless renderer available");
	let settings_view = make_large_settings(100);
	let mut session = open_general_settings_session(&mut cx, settings_view, true);
	session
		.update(|view, _window, cx| {
			view.general_settings_list().scroll_to_reveal_item(50);
			cx.notify();
		})
		.expect("scrolled to setting 50");
	session.frame().expect("the scrolled frame renders");
	assert!(scroll_top(&mut session).item_ix > 0, "the comparison must start away from the top");

	// A query nothing matches empties the list, which is the offset a widened
	// page is drawn from: the empty page anchors no item, so the offset it was
	// left at is a row in the middle of the schema once every row is back.
	narrow_to(&mut session, "no-setting-carries-this");
	session
		.update(|view, _, _| {
			assert_eq!(
				view.general_settings_list().item_count(),
				0,
				"the query must empty the page for this to be the widened-from state"
			);
		})
		.expect("the emptied count is read back");

	session
		.update(|view, _window, cx| {
			view.general_settings_list().clear_query();
			cx.notify();
		})
		.expect("the page is widened");
	session.frame().expect("the widened frame renders");

	assert_eq!(
		scroll_top(&mut session).item_ix,
		0,
		"the widened page drew rows from the offset the emptied query left behind"
	);
	session
		.update(|view, _, _| {
			assert_eq!(
				view.general_settings_list().item_count(),
				100,
				"widening the query must list every row again"
			);
		})
		.expect("the widened count is read back");
}

#[test]
fn a_narrowing_query_draws_the_rows_it_kept_from_the_first_of_them() {
	let mut cx = headless_context().expect("headless renderer available");
	// Two hundred rows, and a query that keeps a hundred of them: an offset
	// inside the rows the query keeps survives the splice that drops the
	// rest, so what puts the page back at its first row is the reset and not
	// the list clamping an offset past its end.
	let settings_view = make_large_settings(200);
	let mut session = open_general_settings_session(&mut cx, settings_view, true);
	session
		.update(|view, _window, cx| {
			view.general_settings_list().scroll_to_reveal_item(20);
			cx.notify();
		})
		.expect("scrolled to setting 020");
	session.frame().expect("the scrolled frame renders");
	assert_eq!(
		scroll_top(&mut session).item_ix,
		20,
		"the comparison must start at an offset inside the rows the query keeps"
	);

	narrow_to(&mut session, "setting.1");
	session
		.update(|view, _, _| {
			assert_eq!(
				view.general_settings_list().item_count(),
				100,
				"the query must keep the hundred rows this case is written for"
			);
		})
		.expect("the narrowed count is read back");

	assert_eq!(
		scroll_top(&mut session).item_ix,
		0,
		"the narrowed page kept the offset it was scrolled to before the query"
	);
}
