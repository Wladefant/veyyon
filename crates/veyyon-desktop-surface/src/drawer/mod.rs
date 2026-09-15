//! The terminal drawer surface (§5.6, §5.12).
//!
//! Provides a resizable docking drawer hosting terminal sessions and supervised
//! background processes with an 80-column monospace grid, 16 ANSI colours, SGR
//! styling, selection highlighting, and raw byte input forwarding.

mod chrome;
mod content;
mod grid;
mod measure;
mod process_list;
mod signals;

use veyyon_desktop_kit::{
	ColorRole, SpacingStep, TokenSet,
	input::{Editor, TextField},
};
use veyyon_desktop_tokens::{DrawerPlacement, PanelsSurfaceTokens};
use veyyon_gpui::{
	Context, Entity, InteractiveElement, IntoElement, ParentElement, Styled, div, px,
};

pub use self::{
	chrome::drawer_chrome,
	content::{
		CursorShape, DEFAULT_COLUMNS, DEFAULT_ROWS, DrawerContent, DrawerFailure, DrawerSearch,
		DrawerTab, ProcessRow,
	},
	grid::{render_terminal_grid, resolve_indexed_color, resolve_ink, resolve_named_color},
	process_list::process_list,
	signals::{SignalMenu, signal_menu_items, signal_menu_layer},
};
use crate::{
	ShellView,
	controls::{ControlStates, error_hairline},
	damage::{LaidOut, Region},
};

/// The editors the supervisor's controls read, drawn on the tab that offers
/// those controls: `command` is what a `Start` starts, and `input` is what a
/// row's `Send` writes to that process.
#[derive(Clone, Copy, Default)]
pub struct SupervisorFields<'a> {
	/// The command line a `Start` reads, when the supervisor is open.
	pub command: Option<&'a Entity<Editor>>,
	/// The line a row's `Send` reads, when a process is running to take it.
	pub input:   Option<&'a Entity<Editor>>,
}

/// Builds the terminal drawer component.
///
/// A docked drawer is the second pane of a split, and the split's handle draws
/// the hairline between the drawer and the column above it. An overlaid
/// drawer has no split, so it draws that edge itself: without the placement
/// the docked drawer draws a second hairline a grip's half-height under the
/// first.
pub fn terminal_drawer(
	content: &DrawerContent,
	placement: DrawerPlacement,
	height: f32,
	controls: &ControlStates,
	session_id: u64,
	fields: SupervisorFields<'_>,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	laid_out: &LaidOut,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	if !content.offered {
		return div().w_full().h(px(0.0)).overflow_hidden();
	}
	let body = if content.is_processes_active() {
		div()
			.flex_1()
			.w_full()
			.overflow_hidden()
			.flex()
			.flex_col()
			// The supervisor starts what this field states, so the tab that
			// offers `Start` is the tab that offers somewhere to say what to
			// start: without it the control can only ask the host to run
			// nothing (§5.12).
			.children(fields.command.map(|editor| {
				div()
					.w_full()
					.flex_shrink_0()
					.px(tokens.spacing(SpacingStep::S3))
					.pt(tokens.spacing(SpacingStep::S2))
					.child(TextField::new("process-command-field", editor.clone()))
			}))
			.child(process_list(&content.processes, controls, session_id, geometry, tokens, cx))
			// A row's `Send` writes what this field states, so the field is
			// drawn wherever a row offers one: without it the control can
			// only write nothing, which the host reports as a success
			// (§5.12).
			.children(fields.input.map(|editor| {
				div()
					.w_full()
					.flex_shrink_0()
					.px(tokens.spacing(SpacingStep::S3))
					.pb(tokens.spacing(SpacingStep::S2))
					.child(TextField::new("process-input-field", editor.clone()))
			}))
	} else {
		div()
			.flex_1()
			.w_full()
			.overflow_hidden()
			.child(render_terminal_grid(content, geometry, tokens, laid_out, cx))
	};

	let mut shell = div()
		.occlude()
		.w_full()
		.h(px(height))
		.flex_shrink_0()
		.flex()
		.flex_col()
		.bg(tokens.color(ColorRole::Canvas))
		.overflow_hidden();
	if placement == DrawerPlacement::Overlay {
		shell = shell
			.border_t(px(geometry.chrome_resize_handle_line_px))
			.border_color(tokens.color(ColorRole::Hairline));
	}

	// The host's sentence for whatever the drawer last asked it for, above
	// the tab it was asked from. The drawer read one control for this -- the
	// terminal it creates on its own opening -- so a start the host refused,
	// a line it could not write and a process it could not stop each landed
	// on a control nothing draws (§4.4). What lands here is resolved every
	// projection, so an error the operator dismissed is gone from the next
	// frame.
	let failure_row = content.failure.as_ref().map(|failure| {
		div()
			.id("drawer-failure")
			.flex_shrink_0()
			.w_full()
			.px(tokens.spacing(SpacingStep::S3))
			.py(tokens.spacing(SpacingStep::S1))
			.child(error_hairline(&failure.error, failure.surface.clone(), tokens, cx))
	});

	laid_out.track_children(
		shell
			.child(drawer_chrome(content, controls, session_id, geometry, tokens, cx))
			.children(failure_row)
			.child(body),
		|index| (index == 0).then_some(Region::DrawerChrome),
	)
}

/// Converts a keystroke chord into raw terminal byte sequences.
#[must_use]
pub fn keystroke_to_terminal_bytes(key: &str, ctrl: bool) -> Option<Vec<u8>> {
	if ctrl {
		if key == "space" || key == " " {
			return Some(vec![0]);
		}
		if key.len() == 1 {
			let b = key.as_bytes()[0].to_ascii_lowercase();
			if b.is_ascii_lowercase() {
				return Some(vec![b - b'a' + 1]);
			}
		}
		return None;
	}

	match key {
		"enter" | "return" => Some(vec![b'\r']),
		"backspace" => Some(vec![0x7f]),
		"tab" => Some(vec![b'\t']),
		"escape" => Some(vec![0x1b]),
		"space" => Some(vec![b' ']),
		"delete" => Some(b"\x1b[3~".to_vec()),
		"insert" => Some(b"\x1b[2~".to_vec()),
		"up" => Some(b"\x1b[A".to_vec()),
		"down" => Some(b"\x1b[B".to_vec()),
		"right" => Some(b"\x1b[C".to_vec()),
		"left" => Some(b"\x1b[D".to_vec()),
		"home" => Some(b"\x1b[H".to_vec()),
		"end" => Some(b"\x1b[F".to_vec()),
		"pageup" => Some(b"\x1b[5~".to_vec()),
		"pagedown" => Some(b"\x1b[6~".to_vec()),
		other => {
			if other.chars().count() == 1 {
				Some(other.as_bytes().to_vec())
			} else {
				None
			}
		},
	}
}
