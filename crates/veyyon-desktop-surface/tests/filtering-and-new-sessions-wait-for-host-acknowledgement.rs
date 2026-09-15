//! WHY: filtering the rail and asking for a new session must not replace the
//! acknowledged session before the host answers. Both narrow or add to what the
//! rail lists, and both were able to move the displayed session, the title and
//! the draft off the session the host had confirmed.
//!
//! CLASS CLOSED: the filter queries that hide the open row and the requests
//! that create one, each asserted to leave `current_id`, the title, the draft
//! and the sections as they were and to record exactly the intent the host is
//! to answer.
//!
//! NOT CAUGHT: keyboard movement of the rail's cursor, which opens nothing and
//! is asserted by `arrowing-the-queue-moves-the-cursor-and-enter-opens-it`.

mod support;

use veyyon_desktop_surface::{Intent, intent::Intents};

#[test]
fn filtering_changes_only_the_filter_even_when_the_active_row_is_hidden() {
	for query in ["second", "THIRD", "missing", " ", ""] {
		let mut state = support::state();
		let before = state.clone();
		let mut intents = Intents::new();
		intents.dispatch(Intent::FilterQueue(query.into()), &mut state);
		assert_eq!(state.current_id, before.current_id);
		assert_eq!(state.title, before.title);
		assert_eq!(state.composer, before.composer);
		assert_eq!(state.sections, before.sections);
		assert_eq!(state.keymap.queue_filter.as_deref(), (!query.trim().is_empty()).then_some(query));
		assert!(intents.drain().is_empty());
	}
}

#[test]
fn creation_and_branch_requests_preserve_the_current_draft_and_session() {
	for intent in [Intent::NewSession, Intent::BranchSession(7), Intent::BranchTurn(0)] {
		let mut state = support::state();
		state.composer.attachments.push(support::attachment());
		state.keymap.queue_filter = Some("second".into());
		let before = state.clone();
		let mut intents = Intents::new();
		intents.dispatch(intent.clone(), &mut state);
		assert_eq!(state.current_id, before.current_id);
		assert_eq!(state.title, before.title);
		assert_eq!(state.composer, before.composer);
		if intent == Intent::NewSession {
			assert_eq!(state.keymap.queue_filter, None);
		}
		assert_eq!(intents.drain(), [intent]);
	}
}
