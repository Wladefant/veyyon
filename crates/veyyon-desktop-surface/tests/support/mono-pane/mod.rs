//! Reading a mono pane's two columns out of a rendered frame (§5.11).
//!
//! The file pane and both diff panes are the same element, so the suites that
//! drive them read them the same way: the runs the pane's rows drew, split into
//! the numbers it pins and the code it scrolls.
//!
//! Several test binaries include this module and each uses a subset of it, so
//! each `mod` site carries its own `allow(dead_code)` and the run helpers are
//! re-exported under `allow(unused_imports)`: a test binary has no consumer
//! outside itself, so a `pub use` it does not reach counts as unused.

#[path = "../queue-scroll/mod.rs"]
#[allow(dead_code, reason = "this module uses a subset of the shared session helpers")]
mod queue_scroll;
mod runs;

use std::path::Path;

pub use queue_scroll::open_session;
#[allow(unused_imports, reason = "each binary reads a subset of the run helpers")]
pub use runs::{
	code_edge, code_runs, gutter_numbers, gutter_runs, is_number, lefts, over_code, pane_top,
	row_runs, tops, widest_row,
};
use veyyon_desktop_kit::{ColorRole, Tokens, load_bundled_theme};
use veyyon_desktop_model::{ChangeStatus, DiffMode};
use veyyon_desktop_scene::{
	BoxBounds, HeadlessSession,
	headless::{Headless, RenderOptions},
};
use veyyon_desktop_surface::{
	DiffFile, DiffRow, FileLine, FileView, HighlightSpan, PanelTab, ShellState, ShellView,
	damage::Region, fixture, install_tokens,
};
use veyyon_gpui::{App, AppContext, Bounds, Pixels};

/// Opens the shell on a token set the caller has edited, so a suite can prove
/// a metric follows its token rather than the value it happens to equal.
pub fn open_session_on_tokens(
	cx: &mut Headless,
	state: ShellState,
	width: u32,
	height: u32,
	tokens: Tokens,
) -> HeadlessSession<'_, ShellView> {
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	let options = RenderOptions { width, height, scale_factor: 1.0, ..RenderOptions::default() };
	HeadlessSession::open(cx, &options, move |_window, app: &mut App| {
		let installed =
			install_tokens(app, &tokens, &theme, Path::new("surface")).expect("the tokens install");
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("the session opens offscreen")
}

/// Wide enough for the panel to dock beside the transcript rather than overlay
/// it, so the pane has its authored width to be too narrow for.
pub const WINDOW_W: u32 = 1400;
pub const WINDOW_H: u32 = 900;

/// A line no 540px panel can hold, in the two highlighted pieces a real file
/// arrives in, and short ones around it, so the pane's content width is one
/// line's and the rest have room to spare.
///
/// Two pieces on purpose: a line's width is the sum of its spans, and a pane
/// that took the widest span for the widest line stops the code short of the
/// end of a line whose highlighting split it.
pub const LONG_HEAD: &str = "let the_widest_line_in_this_file = compose(the_left_hand_side, ";
pub const LONG_TAIL: &str = "the_right_hand_side, and_the_one_after_it, plus_another_argument);";

pub fn rect(bounds: Bounds<Pixels>) -> BoxBounds {
	BoxBounds {
		left:   f32::from(bounds.origin.x),
		top:    f32::from(bounds.origin.y),
		right:  f32::from(bounds.origin.x) + f32::from(bounds.size.width),
		bottom: f32::from(bounds.origin.y) + f32::from(bounds.size.height),
	}
}

pub fn line(number: usize, text: &str) -> FileLine {
	spans(number, &[text])
}

pub fn spans(number: usize, pieces: &[&str]) -> FileLine {
	FileLine {
		line_number: number,
		spans:       pieces
			.iter()
			.map(|piece| HighlightSpan { text: (*piece).to_owned(), role: ColorRole::Foreground })
			.collect(),
	}
}

/// A state whose File tab is open on a file whose second line is wider than
/// the pane, and whose transcript is empty.
///
/// Empty on purpose: a turn's prose runs the width of the session column and
/// crosses the pane's own rows, so a transcript here would put runs in the band
/// this reads and none of them would be the pane's.
pub fn state_with_long_line() -> ShellState {
	let mut state = fixture::populated();
	state.transcript.clear();
	state.keymap.panel_collapsed = false;
	state.panel.active_tab = PanelTab::File;
	state.panel.file = Some(FileView {
		path:      "crates/veyyon-desktop-surface/src/right_panel/mono_pane.rs".to_owned(),
		lines:     vec![
			line(1, "//! The pane's own module."),
			spans(2, &[LONG_HEAD, LONG_TAIL]),
			line(3, "fn short() {}"),
			line(4, "// end"),
		],
		truncated: false,
		binary:    false,
	});
	state
}

/// The same file with enough lines below the long one for the pane to have
/// somewhere to scroll vertically to.
pub fn state_with_a_long_file() -> ShellState {
	state_with_a_file_of(79)
}

/// The same file carried out to `count` lines, so a suite can state how far
/// past the pane's own height the rows reach.
///
/// A file far taller than any pane proves a scroll region that overflows by
/// hundreds of pixels and says nothing about one that overflows by twenty: a
/// container laid out taller than the viewport it sits in still scrolls the
/// first file and cannot scroll the second, which is what a real 40-line file
/// photographed.
pub fn state_with_a_file_of(count: usize) -> ShellState {
	let mut state = state_with_long_line();
	let mut lines = state
		.panel
		.file
		.clone()
		.expect("the state carries a file")
		.lines;
	lines.truncate(count);
	for number in lines.len() + 1..=count {
		lines.push(line(number, "// filler"));
	}
	state.panel.file = state.panel.file.map(|file| FileView { lines, ..file });
	state
}

/// A file of `count` lines whose last one is the line no pane can hold, and
/// whose every other line is filler, so a suite can state which end of a long
/// file is on screen: the wide line is the only row here the pane cannot draw
/// inside its own width, and no other row can be mistaken for it.
pub fn state_with_the_long_line_last(count: usize) -> ShellState {
	let mut state = state_with_a_file_of(count);
	let last = count.max(1);
	state.panel.file = state.panel.file.map(|file| {
		let mut lines: Vec<FileLine> = (1..last).map(|number| line(number, "// filler")).collect();
		lines.push(spans(last, &[LONG_HEAD, LONG_TAIL]));
		FileView { lines, ..file }
	});
	state
}

/// A file of one line, arriving in `count` highlighted pieces of three cells
/// each, which is the shape a real source line arrives in.
///
/// Syntect splits a line into a span per token, so a 900-column line of code
/// is hundreds of spans and only the handful inside the pane's own width are
/// on screen. One line on purpose: every code run the frame drew is then that
/// row's, and a count of them is a count of what one row cost.
pub fn state_with_a_line_of_pieces(count: usize) -> ShellState {
	let mut state = state_with_long_line();
	let pieces: Vec<String> = (0..count)
		.map(|piece| format!("a{:02}", piece % 100))
		.collect();
	let borrowed: Vec<&str> = pieces.iter().map(String::as_str).collect();
	state.panel.file = state
		.panel
		.file
		.map(|file| FileView { lines: vec![spans(1, &borrowed)], ..file });
	state
}

/// A file of `count` lines that are each `pieces` highlighted pieces wide,
/// which is the shape the native take of the pane recorded: rows past the
/// pane's box on one axis and columns past it on the other, at once.
///
/// A fixture wide on one axis only cannot state what a gesture on the other
/// costs, and the freeze this shape found arrived after a wheel down a file of
/// wide lines rather than at rest.
pub fn state_with_wide_lines(count: usize, pieces: usize) -> ShellState {
	let mut state = state_with_long_line();
	let text: Vec<String> = (0..pieces)
		.map(|piece| format!("a{:02}", piece % 100))
		.collect();
	let borrowed: Vec<&str> = text.iter().map(String::as_str).collect();
	let lines: Vec<FileLine> = (1..=count).map(|number| spans(number, &borrowed)).collect();
	state.panel.file = state.panel.file.map(|file| FileView { lines, ..file });
	state
}

/// The panel's box, as the frame just laid it out.
pub fn panel_region(session: &mut HeadlessSession<'_, ShellView>) -> BoxBounds {
	let bounds = session
		.update(|view, _window, _cx| view.laid_out().drawn_bounds(Region::Panel))
		.expect("the window updates")
		.expect("an open panel lays its region out");
	rect(bounds)
}

/// The diff tenant, whose rows are the other half of the class: a hunk header
/// is taller than a line, a split pair collapses two rows into one, and every
/// changed file scrolls in one region.
///
/// Built rather than taken from `fixture::populated`, which carries five rows:
/// a suite that states what a pane's box costs needs a file long enough that
/// the pane cannot draw all of it, in two sizes.
pub fn diff_state(lines: usize, mode: DiffMode) -> ShellState {
	let mut rows = vec![DiffRow::HunkHeader {
		old_start: 1,
		old_count: lines,
		new_start: 1,
		new_count: lines,
		symbol:    Some("fn changed".to_owned()),
	}];
	for number in 1..=lines {
		if number % 5 == 0 {
			// The name and the value, which is the two-piece shape an intraline
			// highlight arrives in: a changed line is one span of code with the
			// parts that differ marked inside it.
			let was = format!("\tlet was = {number};");
			let now = format!("\tlet now = {number};");
			let value = 11..was.len() - 1;
			rows.push(DiffRow::Removed {
				old_line:  number,
				intraline: vec![5..8, value.clone()],
				text:      was,
			});
			rows.push(DiffRow::Added {
				new_line:  number,
				intraline: vec![5..8, value],
				text:      now,
			});
		} else {
			rows.push(DiffRow::Context {
				old_line: number,
				new_line: number,
				text:     format!("\t// line {number}"),
			});
		}
	}

	// Two files, because every changed file scrolls in one region and one
	// cursor walks all of them: a file whose padding does not account for the
	// header and hairline above it draws its rows over the file before it.
	let mut state = fixture::populated();
	state.transcript.clear();
	state.keymap.panel_collapsed = false;
	state.panel.active_tab = PanelTab::Diff;
	state.panel.diff_mode = mode;
	state.panel.diff = ["diff_columns.rs", "diff_view.rs"]
		.into_iter()
		.map(|name| DiffFile {
			path:      format!("crates/veyyon-desktop-surface/src/right_panel/{name}"),
			old_path:  None,
			status:    ChangeStatus::Modified,
			additions: lines / 5,
			deletions: lines / 5,
			rows:      rows.clone(),
		})
		.collect();
	state
}
