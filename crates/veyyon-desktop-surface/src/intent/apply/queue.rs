//! What a queue intent changes in the session rail the window owns (§5.14).

use crate::model::ShellState;

/// Narrows the rail without changing the host-confirmed active session.
pub fn filter(state: &mut ShellState, filter: &str) {
	let trimmed = filter.trim();
	state.keymap.queue_filter = if trimmed.is_empty() {
		None
	} else {
		Some(filter.to_string())
	};
}

/// The row a movement of `delta` lands the rail's cursor on, or `None` when
/// there is nowhere to go.
///
/// The anchor is the cursor, falling back to the open session while no arrow
/// has moved it, so repeated presses walk the list instead of stepping off the
/// open session every time.
pub fn selection_target(state: &ShellState, delta: i32) -> Option<u64> {
	if delta == 0 {
		return None;
	}
	let listed: Vec<u64> = state.listed_rows().map(|row| row.id).collect();
	let last = listed.len().checked_sub(1)?;
	let anchor = state.selected_row();
	let current = listed.iter().position(|&id| id == anchor);
	let stepped = match current {
		Some(current) if delta < 0 => current.saturating_sub(delta.unsigned_abs() as usize),
		Some(current) => current.saturating_add(delta as usize).min(last),
		None if delta < 0 => last,
		None => 0,
	};
	let next = listed[stepped];
	(next != anchor).then_some(next)
}

/// Moves the rail's selection cursor, opening nothing (§5.14).
///
/// An arrow changes which row `Enter`, `P`, `D` and `K` act on and which row
/// the rail scrolls to, and it reaches no host. Dispatching the open here
/// instead put a session open and a transcript load on every press of a held
/// arrow key.
pub fn move_selection(state: &mut ShellState, delta: i32) {
	if let Some(next) = selection_target(state, delta) {
		state.keymap.queue_cursor = Some(next);
	}
}

/// Closes one panel tab, or parks the session when it is the last one.
pub fn close_tab_or_park(state: &mut ShellState) {
	if state.panel.tabs.len() <= 1 {
		state.keymap.parked_session = Some(state.current_id);
		return;
	}
	let closing = state
		.panel
		.tabs
		.iter()
		.position(|&tab| tab == state.panel.active_tab)
		.unwrap_or(0);
	state.panel.tabs.remove(closing);
	let next = closing.min(state.panel.tabs.len().saturating_sub(1));
	if let Some(&tab) = state.panel.tabs.get(next) {
		state.panel.active_tab = tab;
	}
}
