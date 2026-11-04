//! Rail footer pinned to the lower edge of the queue rail (§5.2).
//!
//! Renders a 36px footer with the settings gear.

use veyyon_desktop_kit::{
	SpacingStep, TokenSet,
	controls::{IconButton, IconButtonVariant},
	icons::{IconName, IconSize},
};
use veyyon_desktop_tokens::QueueSurfaceTokens;
use veyyon_gpui::{
	ClickEvent, Context, InteractiveElement, IntoElement, ParentElement, Styled, div, px,
};

use crate::{ShellView, navigation::SurfaceRoute};

/// Renders the queue rail's bottom-pinned footer containing the settings gear
/// anchored in its own grounded container.
pub fn queue_footer(
	geometry: &QueueSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	div()
		.id("queue-footer")
		.flex_shrink_0()
		.h(px(geometry.footer_height_px))
		.w_full()
		.px(tokens.spacing(SpacingStep::S2))
		.flex()
		.flex_row()
		.items_center()
		.child(
			IconButton::new("queue-settings-gear", IconName::Settings)
				.variant(IconButtonVariant::Ghost)
				.size(IconSize::Size16)
				.on_click(cx.listener(|view, _event: &ClickEvent, _window, cx| {
					view.navigate_surface(SurfaceRoute::Settings, cx);
				})),
		)
}
