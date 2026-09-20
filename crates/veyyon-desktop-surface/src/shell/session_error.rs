//! The strip that states a refused session action under the column that
//! carried it.
//!
//! The strip sits in the session column rather than the titlebar, at the
//! composer's measure, so the sentence naming what failed is read at the
//! control the operator pressed (§4.4).

use veyyon_desktop_kit::{ColorRole, RadiusStep, SpacingStep, StrokeStep, TextRamp, TokenSet};
use veyyon_gpui::{CursorStyle, Div, ParentElement, Pixels, Styled, div};

use crate::controls::ControlError;

/// Builds the error strip for `err` at the column's measure.
///
/// `Retry` is drawn only for a refusal the host stated as retryable, so the
/// strip never offers a corrective action that cannot be taken; `Dismiss` is
/// always drawn, because a strip the operator cannot clear is a strip that
/// owns the column.
pub fn session_error_strip(err: &ControlError, width: Pixels, tokens: &TokenSet) -> Div {
	let font_size = tokens.font_size(TextRamp::Micro);
	let line_h = tokens.line_height(TextRamp::Micro);
	let ink = tokens.color(ColorRole::AttentionInk);
	let btn = |label, fill| {
		let b = div()
			.px(tokens.spacing(SpacingStep::S2))
			.py(tokens.spacing(SpacingStep::S0))
			.rounded(tokens.radius(RadiusStep::Xs))
			.text_size(font_size)
			.cursor(CursorStyle::PointingHand)
			.child(label);
		if fill {
			b.bg(ink).text_color(tokens.color(ColorRole::AttentionFill))
		} else {
			b.border(tokens.stroke(StrokeStep::Hairline))
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
				.rounded(tokens.radius(RadiusStep::Sm))
				.bg(tokens.color(ColorRole::AttentionFill))
				.border(tokens.stroke(StrokeStep::Hairline))
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
