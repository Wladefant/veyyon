//! WHY: the diff pane states a changed file's status in a badge beside its
//! path, and the decision was written inline in the row renderer as a `match`
//! on `ChangeStatus` mixed into the element it built. Nothing outside that
//! element could read the decision, so the badge set was unassertable and the
//! handbook's list of it was written from a reading of the renderer rather
//! than from the renderer. A status added to `ChangeStatus` picks up the arm a
//! later editor finds convenient, and an ordinary modification, which draws no
//! badge on purpose, is indistinguishable from a status nobody decided.
//!
//! CLASS CLOSED: every member of `ChangeStatus` has a recorded badge decision,
//! swept from the enum at run time through `strum::EnumIter` rather than from a
//! list written here, with the word it draws and the token it draws in pinned
//! by exact equality, the statuses that draw no badge pinned as a set, and the
//! decision read back out of a rendered frame so a decision the renderer stops
//! consulting fails here. A variant added to the enum turns the pinned sets
//! red until someone records what it draws.
//!
//! NOT CAUGHT: the glyphs of a badge's word, since a captured text run carries
//! its box and its size and not its characters -- the frame reading is a run
//! count, and the words themselves are pinned against `status_badge`. Where
//! the badge sits on the header row, which is the row's own layout and is read
//! by the pane suites. Whether the host classified a path correctly, which is
//! `diff::parse` and the changes snapshot.

#[path = "support/mono-pane/mod.rs"]
#[allow(dead_code, reason = "this binary uses a subset of the shared pane helpers")]
mod mono_pane;

use mono_pane::{WINDOW_H, WINDOW_W, diff_state, open_session, panel_region, rect};
use strum::IntoEnumIterator as _;
use veyyon_desktop_kit::{ColorRole, TintRole, TokenSet, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::{ChangeStatus, DiffMode};
use veyyon_desktop_scene::headless::headless_context;
use veyyon_desktop_surface::right_panel::diff_view::status_badge;
use veyyon_gpui::Hsla;

/// The token set the shell draws in, which is the one the decision resolves
/// its colours from.
fn tokens() -> TokenSet {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	TokenSet::from_tokens(&tokens, &theme).expect("the token set resolves")
}

/// The word each status draws, swept from the enum rather than listed.
fn words() -> Vec<(ChangeStatus, Option<&'static str>)> {
	let set = tokens();
	ChangeStatus::iter()
		.map(|status| (status, status_badge(status, &set).map(|(word, _)| word)))
		.collect()
}

/// The number of text runs the panel drew, for a diff whose first file carries
/// `status`.
///
/// A count rather than a reading of the words: a shaped run carries its box,
/// so the badge is legible here as the run the header row gained.
fn panel_runs(status: ChangeStatus) -> usize {
	let mut state = diff_state(12, DiffMode::Unified);
	state
		.panel
		.diff
		.first_mut()
		.expect("the diff fixture carries a file")
		.status = status;
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open_session(&mut cx, state, WINDOW_W, WINDOW_H);
	let frame = session.frame().expect("the shell renders at rest");
	let panel = panel_region(&mut session);
	frame
		.text_runs
		.iter()
		.map(|run| rect(run.bounds))
		.filter(|bounds| bounds.left >= panel.left - 0.5)
		.count()
}

#[test]
fn every_status_states_the_word_the_panel_decided_for_it() {
	assert_eq!(
		words(),
		vec![
			(ChangeStatus::Added, Some("new")),
			(ChangeStatus::Modified, None),
			(ChangeStatus::Deleted, Some("deleted")),
			(ChangeStatus::Renamed, Some("renamed")),
			(ChangeStatus::Untracked, Some("untracked")),
			(ChangeStatus::Conflicted, Some("conflict")),
		],
		"a status the enum carries draws the word recorded for it, in the order the enum declares"
	);
}

#[test]
fn only_an_ordinary_modification_draws_no_badge() {
	let unbadged: Vec<ChangeStatus> = words()
		.into_iter()
		.filter_map(|(status, word)| word.is_none().then_some(status))
		.collect();

	assert_eq!(
		unbadged,
		vec![ChangeStatus::Modified],
		"the added and deleted counts state a modification, and nothing else is stated by them"
	);
}

#[test]
fn no_two_statuses_state_the_same_word() {
	let mut spoken: Vec<&'static str> = words().into_iter().filter_map(|(_, word)| word).collect();
	let count = spoken.len();
	spoken.sort_unstable();
	spoken.dedup();

	assert_eq!(spoken.len(), count, "a badge names one status: {spoken:?}");
	assert!(
		spoken.iter().all(|word| !word.trim().is_empty()),
		"a badge with nothing in it states nothing: {spoken:?}"
	);
}

#[test]
fn each_badge_draws_in_the_token_its_status_carries() {
	let set = tokens();
	let colour = |status: ChangeStatus| -> Hsla {
		status_badge(status, &set)
			.expect("this status draws a badge")
			.1
	};

	assert_eq!(colour(ChangeStatus::Added), set.tint(TintRole::Done).ink, "an addition is done");
	assert_eq!(
		colour(ChangeStatus::Deleted),
		set.tint(TintRole::Error).ink,
		"a deletion is drawn in the error ink, which is what a removed path is"
	);
	assert_eq!(
		colour(ChangeStatus::Conflicted),
		set.tint(TintRole::Error).ink,
		"an unresolved conflict is drawn in the error ink"
	);
	assert_eq!(
		colour(ChangeStatus::Renamed),
		set.color(ColorRole::Secondary),
		"a rename moved a path and changed nothing in it"
	);
	assert_eq!(
		colour(ChangeStatus::Untracked),
		set.color(ColorRole::Muted),
		"an untracked path is not in the history the diff is against"
	);
	assert_ne!(
		colour(ChangeStatus::Added),
		colour(ChangeStatus::Deleted),
		"an addition and a deletion are told apart by their colour as well as their word"
	);
	assert_ne!(
		colour(ChangeStatus::Untracked),
		colour(ChangeStatus::Renamed),
		"an untracked path and a moved one are told apart by their colour as well as their word"
	);
}

#[test]
fn a_badged_file_draws_the_run_a_modified_one_does_not() {
	let modified = panel_runs(ChangeStatus::Modified);

	for (status, word) in words() {
		let drawn = panel_runs(status);
		let expected = if word.is_some() {
			modified + 1
		} else {
			modified
		};
		assert_eq!(
			drawn, expected,
			"{status:?} draws {word:?}: {drawn} runs against the {modified} an ordinary modification \
			 draws"
		);
	}
}
