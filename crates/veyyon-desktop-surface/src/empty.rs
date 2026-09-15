//! The two sentences a surface with nothing on it draws, and the element that
//! draws them (§5.6, §5.9, §5.11).
//!
//! A surface that has nothing states the condition it is in and the step out of
//! it. The shape is one definition here; which sentences a given surface draws
//! is owned by that surface's own table -- `settings::empty` for the settings
//! sheet, `right_panel::empty` for the panel and the surfaces drawn beside it.

use veyyon_desktop_kit::{ColorRole, SpacingStep, TextRamp, TextWeight, TokenSet};
use veyyon_gpui::{InteractiveElement, IntoElement, ParentElement, Styled, div};

/// The two sentences an empty surface draws: what is missing, and the step that
/// puts something there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EmptyCopy {
	/// What the surface has nothing of.
	pub condition: &'static str,
	/// The step that fills it, naming where it is taken.
	pub action:    &'static str,
}

/// Renders a quiet, centred empty state with a primary line and secondary
/// action beneath it, without boxes or illustrations.
#[must_use]
pub(crate) fn empty_state(
	id: &'static str,
	primary: &str,
	action: &str,
	tokens: &TokenSet,
) -> impl IntoElement {
	div()
		.id(id)
		.flex_1()
		.w_full()
		.flex()
		.flex_col()
		.items_center()
		.justify_center()
		.gap(tokens.spacing(SpacingStep::S2))
		.px(tokens.spacing(SpacingStep::S4))
		.py(tokens.spacing(SpacingStep::S6))
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.text_color(tokens.color(ColorRole::Foreground))
				.child(primary.to_string()),
		)
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Muted))
				.child(action.to_string()),
		)
}
