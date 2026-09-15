//! Centred, quiet empty, loading, and error states for panel tabs (§5.6,
//! §5.11).

use veyyon_desktop_kit::{ColorRole, SpacingStep, TextRamp, TextWeight, TokenSet};
use veyyon_gpui::{InteractiveElement, IntoElement, ParentElement, Styled, div};

/// Renders a quiet, centred empty state with a primary line and secondary
/// action beneath it, without boxes or illustrations.
#[must_use]
pub fn empty_state(
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
