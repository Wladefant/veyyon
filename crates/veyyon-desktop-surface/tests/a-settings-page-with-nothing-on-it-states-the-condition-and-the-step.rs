//! WHY: a settings page the host reported nothing for drew an empty body, or
//! a sentence naming what was missing and nothing an operator could do about
//! it. The sentences were literals beside each page's rows, so a page added to
//! the sheet drew whatever its author remembered, and two of them stated a
//! condition with no step out of it.
//!
//! CLASS CLOSED: the empty copy of every page is one definition,
//! `settings::empty::empty_copy`, over a match on `SettingsPage`, and the
//! sweep here is over `SettingsPage::iter()`:
//! 1. Every page either declares a condition and a step, or is a recorded
//!    opt-out pinned by exact equality. A page added to the enum does not
//!    compile until it declares one, and a page that opts out turns this red
//!    until the decision is written down.
//! 2. The step is a step: present, distinct from the condition, and more than a
//!    restatement of it.
//! 3. The page draws both sentences when it has nothing, in both shapes the
//!    sheet is drawn in -- the whole dialog, and one page a command routed to
//!    -- so a page that declares copy and never renders it fails here.
//! 4. A page with something on it draws neither sentence, so the empty state is
//!    a condition rather than a fixture the page always draws.
//! 5. The one opt-out, Keybindings, draws the shipped default bindings instead,
//!    and is checked to draw them rather than to draw nothing.
//!
//! NOT CAUGHT: the wording of a sentence, which no test can judge; the
//! right-hand panel's own empty states, which `right_panel/empty.rs` owns;
//! and where on the page the two lines sit, which
//! `a-settings-row-is-the-height-it-declares-whatever-it-says.rs` measures.

mod support;

use std::path::Path;

use strum::IntoEnumIterator;
use support::settings_seed::seed_state_for_page;
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	headless::{Captured, RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	ConnectionPhase, Keymap, Overlay, SettingsPage, SettingsState, ShellState, ShellView,
	install_tokens,
	navigation::SurfaceRoute,
	settings::empty::{EmptyCopy, empty_copy},
};
use veyyon_gpui::{App, AppContext};

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

/// The pages that draw rows rather than an empty state. Keybindings falls back
/// to the shipped defaults, which are what a press actually matches, so a
/// sentence saying nothing is bound would be false.
fn opted_out() -> Vec<SettingsPage> {
	vec![SettingsPage::Keybindings]
}

/// Both shapes the sheet is drawn in: the whole dialog, and the one page a
/// command routed to.
const fn shapes(page: SettingsPage) -> [Option<SurfaceRoute>; 2] {
	[None, Some(SurfaceRoute::Page(page))]
}

/// The sheet open on `page` with nothing in it, in the shape `route` names.
fn empty_sheet(page: SettingsPage, route: Option<SurfaceRoute>) -> ShellState {
	let mut settings = SettingsState::new(page);
	settings.route = route;
	ShellState {
		connection: ConnectionPhase::Attached,
		overlay: Some(Overlay::Settings(Box::new(settings))),
		..ShellState::default()
	}
}

/// The sheet open on `page` with the rows its own seed gives it.
fn seeded_sheet(page: SettingsPage, route: Option<SurfaceRoute>) -> ShellState {
	let mut settings = seed_state_for_page(page);
	settings.route = route;
	ShellState {
		connection: ConnectionPhase::Attached,
		overlay: Some(Overlay::Settings(Box::new(settings))),
		..ShellState::default()
	}
}

/// Draws one frame of `state`.
fn drawn(state: ShellState) -> Captured {
	let mut cx = headless_context().expect("headless renderer available");
	let tokens = load_bundled_tokens().expect("bundled tokens load");
	let theme = load_bundled_theme("dark").expect("bundled theme loads");
	let options =
		RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() };
	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed =
			install_tokens(app, &tokens, &theme, Path::new("surface")).expect("tokens install");
		app.bind_keys(Keymap::default().bindings());
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("the sheet opens");
	session.frame().expect("the sheet renders")
}

/// Every word the frame drew, with the spaces taken out.
///
/// A sentence longer than the column wraps, and the frame records each line it
/// wrapped to as its own run. Reading the runs without their whitespace is what
/// makes a wrapped sentence one string again, whether the break fell on a space
/// or inside a path.
fn drawn_text(captured: &Captured) -> String {
	captured
		.text_runs
		.iter()
		.flat_map(|run| run.text.as_ref().chars())
		.filter(|character| !character.is_whitespace())
		.collect()
}

/// `sentence` without its whitespace, which is how it is looked for.
fn squeezed(sentence: &str) -> String {
	sentence.chars().filter(|c| !c.is_whitespace()).collect()
}

#[test]
fn every_page_declares_an_empty_condition_and_a_step_or_is_a_recorded_opt_out() {
	let mut without: Vec<SettingsPage> = Vec::new();
	for page in SettingsPage::iter() {
		let Some(EmptyCopy { condition, action }) = empty_copy(page) else {
			without.push(page);
			continue;
		};
		assert!(!condition.trim().is_empty(), "{page:?} declares an empty condition for {page:?}");
		assert!(
			condition.trim_end().ends_with('.'),
			"{page:?} states its condition as a sentence, stated {condition:?}"
		);
		assert!(!action.trim().is_empty(), "{page:?} states no step out of its empty page");
		assert_ne!(
			squeezed(action),
			squeezed(condition),
			"{page:?} restates its condition where the step belongs"
		);
		assert!(
			action.split_whitespace().count() >= 4,
			"{page:?} states {action:?} as its step, which is too short to state an action"
		);
	}
	assert_eq!(
		without,
		opted_out(),
		"a page that draws rows instead of an empty state is a decision, and this is the record of \
		 it"
	);
}

#[test]
fn a_page_with_nothing_on_it_draws_the_condition_and_the_step_in_both_shapes() {
	for page in SettingsPage::iter() {
		let Some(EmptyCopy { condition, action }) = empty_copy(page) else {
			continue;
		};
		for route in shapes(page) {
			let captured = drawn(empty_sheet(page, route));
			let text = drawn_text(&captured);
			assert!(
				text.contains(&squeezed(condition)),
				"{page:?} in the {} shape drew no condition; it was expected to state {condition:?}",
				if route.is_some() { "routed" } else { "dialog" }
			);
			assert!(
				text.contains(&squeezed(action)),
				"{page:?} in the {} shape stated its condition and no step; it was expected to state \
				 {action:?}",
				if route.is_some() { "routed" } else { "dialog" }
			);
		}
	}
}

#[test]
fn a_page_with_rows_on_it_draws_neither_sentence() {
	for page in SettingsPage::iter() {
		let Some(EmptyCopy { condition, .. }) = empty_copy(page) else {
			continue;
		};
		for route in shapes(page) {
			let text = drawn_text(&drawn(seeded_sheet(page, route)));
			assert!(
				!text.contains(&squeezed(condition)),
				"{page:?} drew {condition:?} over the rows it was given, so the empty state is not a \
				 condition"
			);
		}
	}
}

#[test]
fn the_keybindings_page_draws_the_shipped_defaults_rather_than_an_empty_state() {
	let keymap = Keymap::default();
	let first = keymap
		.rows()
		.first()
		.expect("the shipped keymap declares bindings")
		.clone();
	for route in shapes(SettingsPage::Keybindings) {
		let text = drawn_text(&drawn(empty_sheet(SettingsPage::Keybindings, route)));
		assert!(
			text.contains(&squeezed(&first.label)),
			"the Keybindings page with nothing reported drew none of the shipped defaults; {:?} was \
			 expected",
			first.label
		);
		for page in SettingsPage::iter() {
			if let Some(EmptyCopy { condition, .. }) = empty_copy(page) {
				assert!(
					!text.contains(&squeezed(condition)),
					"the Keybindings page drew {condition:?}, which belongs to {page:?}"
				);
			}
		}
	}
}
