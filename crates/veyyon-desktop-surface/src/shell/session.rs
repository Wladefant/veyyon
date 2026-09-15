//! The middle column: transcript, attached cards, composer, run bar, drawer.
//!
//! The column is the surface being read, so it is the one region that takes
//! whatever width the queue and the right panel leave. Everything in it shares
//! the composer's measure, so a decision, the reply to it and the line stating
//! what the session is doing all sit in one column rather than three.

use std::{cell::Cell, rc::Rc};

use veyyon_desktop_kit::{Axis, ColorRole, Resizable, SpacingStep, TextSelection, input::Editor};
use veyyon_desktop_tokens::DrawerPlacement;
use veyyon_gpui::{
	Context, Div, Entity, FocusHandle, InteractiveElement, MouseButton, ParentElement, Pixels,
	Point, Styled, Window, div, point, px,
};

use super::keys::bind_composer_keys;
use crate::{
	ShellView,
	cards::card_stack,
	composer::{ComposerLocal, MIN_COMPOSER_WIDTH_PX, composer, opening_line, run_bar},
	damage::{LaidOut, Region},
	drawer::{SupervisorFields, terminal_drawer},
	layout::ShellWidths,
	model::ShellState,
	tokens::InstalledTokens,
	transcript::{TranscriptViewportState, transcript_viewport},
};

/// Builds the session surface for the state and the resolved widths.
///
/// The box of every region in the column is recorded in `laid_out` as the
/// column is prepainted, so a change confined to one region repaints that
/// region alone (P5).
pub fn session_surface(
	state: &ShellState,
	editor: Option<&Entity<Editor>>,
	supervisor: SupervisorFields<'_>,
	local: ComposerLocal<'_>,
	has_text: bool,
	widths: &ShellWidths,
	installed: &InstalledTokens,
	laid_out: &LaidOut,
	palette_anchor: Rc<Cell<Point<Pixels>>>,
	viewport: &TranscriptViewportState,
	transcript_focus: &FocusHandle,
	cards_focus: &FocusHandle,
	cards_expanded: bool,
	reduced_motion: bool,
	find_bar: Option<Div>,
	selection: Option<TextSelection>,
	panel_overlay: Option<Div>,
	window: &mut Window,
	cx: &Context<ShellView>,
) -> Div {
	let tokens = &installed.set;
	let is_focused = editor.is_some_and(|ed| ed.read(cx).focus_handle().is_focused(window));
	let mut local = local;
	local.focused = is_focused || local.focused;
	let clamped_composer_px = widths.composer_px.max(MIN_COMPOSER_WIDTH_PX);
	let composer_width = px(clamped_composer_px);
	let surface = &installed.surface;

	let has_transcript = !state.transcript.is_empty();
	let body = if has_transcript {
		div()
			.key_context("Transcript")
			.track_focus(transcript_focus)
			.flex()
			.flex_col()
			.justify_end()
			.w_full()
			.flex_1()
			.overflow_hidden()
			.px(tokens.spacing(SpacingStep::S4))
			.pt(tokens.spacing(SpacingStep::S4))
			.child(transcript_viewport(
				viewport,
				&surface.transcript,
				installed.user_turn_ground,
				tokens,
				&installed.motion,
				reduced_motion,
				laid_out,
				widths.composer_px,
				0.0,
				selection,
				window,
				cx,
			))
	} else {
		div()
	};

	// An overlaid right panel dims the region it annotates: the transcript it
	// was opened against. The composer keeps its light, the cards above it
	// stay legible, and a press in either still reaches them (§5.6). The
	// float's own box is recorded from in here, because the scrim it sits in
	// spans this region rather than the columns row.
	let body = match panel_overlay {
		None => body,
		Some(float) => div()
			.relative()
			.flex()
			.flex_col()
			.w_full()
			.flex_1()
			.min_w_0()
			.overflow_hidden()
			.child(body)
			.child(float),
	};

	let mut regions = Vec::new();
	if has_transcript {
		regions.push(Region::Transcript);
	}
	if !state.cards.is_empty() {
		regions.push(Region::Cards);
	}
	regions.extend([Region::Composer, Region::RunBar]);
	if state.drawer_open && state.drawer.offered {
		regions.push(Region::Drawer);
	}

	// A press inside the composer's box that missed the editor's own text area
	// — the padding around it, the row of controls under it, the button that
	// was pressed — left the draft blurred: the keyboard went nowhere, the
	// next keystroke was dropped on the floor, and the composer's own chords
	// stopped resolving because the `Composer` context left the focus path.
	// The box hands the keyboard back to the editor whatever the press landed
	// on (§5.4).
	//
	// It captures rather than bubbles: a control that answers the press stops
	// propagation, and a bubble listener above it never runs. A control that
	// wants the focus for itself still takes it, because it runs after this.
	let composer_input = match editor {
		Some(editor) => {
			let focus = editor.read(cx).focus_handle().clone();
			div()
				.key_context("Composer")
				.capture_any_mouse_down(move |event, window, app| {
					if event.button == MouseButton::Left {
						window.focus(&focus, app);
						// gpui transfers focus to every focusable element under
						// the pointer during the bubble phase, and the window
						// root is focusable: without this the root takes the
						// keyboard back one phase later and the draft is blurred
						// by a press on its own controls.
						window.prevent_default();
					}
				})
		},
		None => div().key_context("Composer"),
	};

	let mut column = div()
		.relative()
		.flex()
		.flex_col()
		.flex_1()
		.min_w_0()
		.h_full()
		.bg(tokens.color(ColorRole::Canvas))
		.overflow_hidden()
		.gap(tokens.spacing(SpacingStep::S3))
		.pb(tokens.spacing(SpacingStep::S3));
	let session_error = if state.current_id > 0 {
		let sid = veyyon_desktop_model::SessionId::from(state.current_id.to_string());
		state
			.controls
			.error(&veyyon_desktop_model::SurfaceId::ComposerSendButton(sid.clone()))
			.or_else(|| {
				state
					.controls
					.error(&veyyon_desktop_model::SurfaceId::QueueSessionRow(sid))
			})
	} else {
		None
	};
	if let Some(err) = session_error {
		column = column.child(session_error_strip(err, composer_width, tokens));
	}

	if state.current_id == 0 {
		column = column.justify_center().child(
			div()
				.w_full()
				.px(tokens.spacing(SpacingStep::S4))
				.flex()
				.flex_row()
				.justify_center()
				.child(opening_line("Create a session to begin", &surface.composer, tokens)),
		);
	} else if has_transcript {
		column = column.child(body);
	} else {
		column = column.justify_center().child(
			div()
				.w_full()
				.px(tokens.spacing(SpacingStep::S4))
				.flex()
				.flex_row()
				.justify_center()
				.child(opening_line("What should this session do?", &surface.composer, tokens)),
		);
	}

	let column = column
		.children((!state.cards.is_empty()).then(|| {
			// The stack shares the composer's measure and sits directly above
			// it, so a decision and the reply to it occupy one column.
			div()
				.w_full()
				.px(tokens.spacing(SpacingStep::S4))
				.flex()
				.flex_row()
				.justify_center()
				.child(div().w(composer_width).child(card_stack(
					&state.cards,
					&state.card_answers,
					&surface.attached_cards,
					tokens,
					cards_focus,
					cards_expanded,
					cx,
				)))
		}))
		.child(bind_composer_keys(
			composer_input
				.w_full()
				.px(tokens.spacing(SpacingStep::S4))
				.on_children_prepainted(move |children, _window, _cx| {
					if let Some(bounds) = children.first() {
						palette_anchor.set(point(
							bounds.origin.x + (bounds.size.width - composer_width) / 2.0,
							bounds.origin.y,
						));
					}
				})
				.child(composer(
					editor,
					&state.turn,
					&state.composer,
					local,
					has_text,
					state.current_id,
					widths.composer_px,
					widths.labels.footer,
					&state.controls,
					&surface.composer,
					tokens,
					cx,
				)),
			cx,
		))
		.child(
			div()
				.w_full()
				.px(tokens.spacing(SpacingStep::S4))
				.child(run_bar(
					state.run_status.clone(),
					clamped_composer_px,
					widths.labels.run_bar,
					state.turn.is_stoppable(),
					state.current_id,
					&state.controls,
					&surface.composer,
					tokens,
					cx,
				)),
		)
		.children(
			(state.drawer_open
				&& state.drawer.offered
				&& widths.drawer.placement == DrawerPlacement::Overlay)
				.then(|| {
					div()
						.absolute()
						.bottom_0()
						.left_0()
						.right_0()
						.child(terminal_drawer(
							&state.drawer,
							DrawerPlacement::Overlay,
							widths.drawer.height_px,
							&state.controls,
							state.current_id,
							supervisor,
							&surface.panels,
							tokens,
							laid_out,
							cx,
						))
				}),
		);
	let column = column.children(find_bar.map(|bar| {
		div()
			.absolute()
			.top(tokens.spacing(SpacingStep::S4))
			.right(tokens.spacing(SpacingStep::S4))
			.child(bar)
	}));
	let column = laid_out.track_children(column, move |index| regions.get(index).copied());
	if state.drawer_open && state.drawer.offered && widths.drawer.placement == DrawerPlacement::Row {
		let extent = widths.columns_px.max(1.0);
		let maximum = extent * surface.panels.terminal_drawer_max_viewport_ratio;
		let minimum = surface.panels.terminal_drawer_min_height_px.min(maximum);
		let grip = surface.panels.chrome_resize_handle_hit_px;
		let drawer = terminal_drawer(
			&state.drawer,
			DrawerPlacement::Row,
			(widths.drawer.height_px - grip).max(0.0),
			&state.controls,
			state.current_id,
			supervisor,
			&surface.panels,
			tokens,
			laid_out,
			cx,
		);
		let drawer = laid_out.track_children(div().w_full().h_full().child(drawer), |index| {
			(index == 0).then_some(Region::Drawer)
		});
		let shell = cx.weak_entity();
		let release_shell = shell.clone();
		div().flex().flex_1().min_w_0().h_full().child(
			Resizable::new("session-drawer-split", Axis::Vertical, px(grip), column, drawer)
				.ratio((extent - widths.drawer.height_px) / extent)
				.on_resize(move |ratio, _window, cx| {
					let _ = shell.update(cx, |view, cx| {
						view.drag_drawer((1.0 - ratio) * extent, minimum, maximum, cx);
						cx.notify();
					});
				})
				.on_resize_end(move |_window, cx| {
					let _ = release_shell.update(cx, |view, cx| {
						view.release_drawer(cx);
						cx.notify();
					});
				}),
		)
	} else {
		column
	}
}
fn session_error_strip(
	err: &crate::controls::ControlError,
	width: Pixels,
	tokens: &veyyon_desktop_kit::TokenSet,
) -> Div {
	let font_size = tokens.font_size(veyyon_desktop_kit::TextRamp::Micro);
	let line_h = tokens.line_height(veyyon_desktop_kit::TextRamp::Micro);
	let ink = tokens.color(ColorRole::AttentionInk);
	let btn = |label, fill| {
		let b = div()
			.px(tokens.spacing(SpacingStep::S2))
			.py(tokens.spacing(SpacingStep::S0))
			.rounded(tokens.radius(veyyon_desktop_kit::RadiusStep::Xs))
			.text_size(font_size)
			.cursor(veyyon_gpui::CursorStyle::PointingHand)
			.child(label);
		if fill {
			b.bg(ink).text_color(tokens.color(ColorRole::AttentionFill))
		} else {
			b.border(tokens.stroke(veyyon_desktop_kit::StrokeStep::Hairline))
				.border_color(ink)
				.text_color(ink)
		}
	};
	div()
		.w_full()
		.px(tokens.spacing(SpacingStep::S4))
		.flex()
		.justify_center()
		.child(
			div()
				.w(width)
				.flex()
				.items_center()
				.justify_between()
				.px(tokens.spacing(SpacingStep::S3))
				.py(tokens.spacing(SpacingStep::S2))
				.rounded(tokens.radius(veyyon_desktop_kit::RadiusStep::Sm))
				.bg(tokens.color(ColorRole::AttentionFill))
				.border(tokens.stroke(veyyon_desktop_kit::StrokeStep::Hairline))
				.border_color(ink)
				.child(
					div()
						.flex()
						.items_center()
						.gap(tokens.spacing(SpacingStep::S2))
						.min_w_0()
						.child(div().text_size(font_size).text_color(ink).child("⚠"))
						.child(
							div()
								.text_size(font_size)
								.line_height(line_h)
								.text_color(ink)
								.min_w_0()
								.truncate()
								.child(err.message.clone()),
						),
				)
				.child(
					div()
						.flex()
						.items_center()
						.gap(tokens.spacing(SpacingStep::S2))
						.flex_shrink_0()
						.children((err.retryable).then(|| btn("Retry", true)))
						.child(btn("Dismiss", false)),
				),
		)
}
