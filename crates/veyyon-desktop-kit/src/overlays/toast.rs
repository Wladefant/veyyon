//! One announcement's card, as drawn in the stack (§8.26).
//!
//! A toast states a line, the detail under it when it has one, and the tint of
//! the thing it is announcing. It is a card and not a container: the stack that
//! places it owns where it sits and how many of them are drawn, so a toast
//! never reads the window's size or decides its own corner.
//!
//! The card carries its entrance whole, ground and text together, the way the
//! popover does: a transition on the text alone draws a card that was already
//! there with its words arriving inside it.

use std::rc::Rc;

use veyyon_desktop_motion::FloatFrame;
use veyyon_gpui::{
	App, IntoElement, MouseButton, MouseDownEvent, RenderOnce, SharedString, Window, div,
	prelude::*, px,
};

use crate::{
	indicators::dot::Dot,
	token_set::{
		ColorRole, RadiusStep, SpacingStep, StrokeStep, TextRamp, TextWeight, TintRole, TokenSet,
	},
};

/// How wide a toast is drawn, in pixels of the window it is stacked in.
///
/// An announcement is one line and its detail, so the card is narrower than a
/// dialog and wider than a chip: wide enough for a sentence that is read at a
/// glance without reflowing into four lines.
pub const TOAST_WIDTH_PX: f32 = 320.0;

/// How many lines of the detail under it a card draws.
const DETAIL_LINES: usize = 2;

/// One announcement's card.
#[derive(IntoElement)]
pub struct Toast {
	id:         SharedString,
	title:      SharedString,
	detail:     Option<SharedString>,
	tint:       TintRole,
	entrance:   Option<FloatFrame>,
	exit:       Option<FloatFrame>,
	on_dismiss: Option<Rc<dyn Fn(&mut Window, &mut App)>>,
}

impl Toast {
	/// Creates a toast stating `title`.
	#[must_use]
	pub fn new(id: impl Into<SharedString>, title: impl Into<SharedString>) -> Self {
		Self {
			id:         id.into(),
			title:      title.into(),
			detail:     None,
			tint:       TintRole::Attention,
			entrance:   None,
			exit:       None,
			on_dismiss: None,
		}
	}

	/// States what the line left out, drawn under it.
	#[must_use]
	pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
		self.detail = Some(detail.into());
		self
	}

	/// Draws the card on `tint` rather than the attention tint.
	#[must_use]
	pub const fn tint(mut self, tint: TintRole) -> Self {
		self.tint = tint;
		self
	}

	/// Applies the frame the stack's motion driver sampled.
	#[must_use]
	pub const fn entrance(mut self, frame: FloatFrame) -> Self {
		self.entrance = Some(frame);
		self
	}

	/// Applies the exit frame the stack's motion driver sampled.
	#[must_use]
	pub const fn exit(mut self, frame: FloatFrame) -> Self {
		self.exit = Some(frame);
		self
	}

	/// Answers a press on the card by dismissing the announcement.
	#[must_use]
	pub fn on_dismiss(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
		self.on_dismiss = Some(Rc::new(handler));
		self
	}
}

impl RenderOnce for Toast {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let resolved = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved;

		let mut card = div()
			.id(self.id)
			.occlude()
			.w(px(TOAST_WIDTH_PX))
			.bg(tokens.float_ground())
			.backdrop_blur(tokens.float_blur())
			.backdrop_saturation(tokens.float_saturation())
			.rounded(tokens.radius(RadiusStep::Xl))
			.border(tokens.stroke(StrokeStep::Hairline))
			.border_color(tokens.color(ColorRole::Hairline))
			.p(tokens.spacing(SpacingStep::S4))
			.shadow(tokens.float_shadows())
			.cursor_pointer()
			.overflow_hidden()
			.flex()
			.flex_col()
			.gap(tokens.spacing(SpacingStep::S1))
			.child(
				div()
					.flex()
					.flex_row()
					// The row spans the card's content box and may shrink
					// inside it: the title is a flex child here rather than a
					// child of the card's column, so it takes its width from
					// this row rather than from the card. A row sized to its
					// own content instead measures the title at the full
					// sentence, which the card then masks at its edge -- the
					// line is drawn whole and cut mid-glyph with nothing to
					// say it was cut.
					.w_full()
					.min_w_0()
					.items_center()
					.gap(tokens.spacing(SpacingStep::S2))
					.child(Dot::new(self.tint))
					.child(
						div()
							// The title is held to one row and cut with an
							// ellipsis the shaper writes into the line. The
							// host writes the sentence and can write a long
							// one: a value it rejected is quoted back in full,
							// and a path arrives whole. Wrapped to a few rows
							// instead, the card grows with the sentence, a
							// full stack of them reaches the composer, and the
							// cut lands between rows where nothing states it,
							// because a clamp cuts the last row it drew rather
							// than the text it shaped.
							//
							// The row's free space is what it is shaped
							// against: a basis of `auto` measures the sentence
							// whole and shrinks the box without reshaping the
							// text to it, leaving the line drawn at full
							// length and masked at the card's edge.
							.flex_1()
							.min_w_0()
							.overflow_hidden()
							.text_size(tokens.font_size(TextRamp::Body))
							.line_height(tokens.line_height(TextRamp::Body))
							.font_weight(tokens.font_weight(TextWeight::Medium))
							.text_color(tokens.color(ColorRole::Foreground))
							.whitespace_nowrap()
							.truncate()
							.child(self.title),
					),
			);
		if let Some(detail) = self.detail {
			card = card.child(
				div()
					.min_w_0()
					.overflow_hidden()
					.text_size(tokens.font_size(TextRamp::Micro))
					.line_height(tokens.line_height(TextRamp::Micro))
					.text_color(tokens.color(ColorRole::Secondary))
					.text_ellipsis()
					.line_clamp(DETAIL_LINES)
					.child(detail),
			);
		}
		if let Some(frame) = self.exit {
			card = card.opacity(frame.opacity).translate_y(px(frame.offset_y));
		} else if let Some(frame) = self.entrance {
			card = card.opacity(frame.opacity).translate_y(px(frame.offset_y));
		}
		if let Some(handler) = self.on_dismiss {
			card =
				card.on_mouse_down(MouseButton::Left, move |_event: &MouseDownEvent, window, cx| {
					handler(window, cx);
				});
		}
		card
	}
}
