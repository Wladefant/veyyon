//! What a float is made of: its ground, its backdrop, its grain and its
//! shadows (§6.5).
//!
//! A float is the one surface the system draws off the ground, so the values
//! that lift it are resolved together here rather than restated at each float.
//! Every fallback matches the authored elevation token, so a token file that
//! omits a value renders what the design system declares rather than nothing.

use veyyon_gpui::{BoxShadow, Hsla, Pixels, point, px};

use super::TokenSet;
use crate::ColorRole;

impl TokenSet {
	/// Resolves background color for float elevation (level 4) with token
	/// opacity.
	#[must_use]
	pub fn float_ground(&self) -> Hsla {
		let mut bg = self.color(ColorRole::Float);
		let op = self
			.elevation
			.as_ref()
			.and_then(|e| e.float().ground_opacity)
			.unwrap_or(0.82);
		bg.a = op;
		bg
	}

	/// Resolves backdrop blur radius in pixels for floating surfaces.
	#[must_use]
	pub fn float_blur(&self) -> Pixels {
		self
			.elevation
			.as_ref()
			.map_or(px(20.0), |e| px(e.float().blur_px))
	}

	/// Resolves backdrop blur radius for menu and dialog frosted overlays
	/// (§2.1).
	#[must_use]
	pub fn overlay_blur(&self) -> Pixels {
		px(44.0)
	}

	/// Resolves backdrop saturation factor for floating surfaces.
	#[must_use]
	pub fn float_saturation(&self) -> f32 {
		self
			.elevation
			.as_ref()
			.and_then(|e| e.float().saturation)
			.unwrap_or(1.06)
	}

	/// Resolves top inner highlight color for lit top edges (§6.5).
	#[must_use]
	pub fn inner_highlight(&self) -> Hsla {
		let is_dark = self.color(ColorRole::Ground).l < 0.5;
		if is_dark {
			Hsla { h: 0.0, s: 0.0, l: 1.0, a: 0.12 }
		} else {
			Hsla { h: 0.0, s: 0.0, l: 1.0, a: 0.85 }
		}
	}

	/// Resolves whether grain is enabled on level 0 (shell ground) (§6.5).
	#[must_use]
	pub fn grain_enabled(&self) -> bool {
		self
			.elevation
			.as_ref()
			.is_none_or(|e| e.shell_ground().grain_enabled)
	}

	/// Resolves grain opacity for level 0 (shell ground) (§6.5).
	#[must_use]
	pub fn grain_opacity(&self) -> f32 {
		self
			.elevation
			.as_ref()
			.and_then(|e| e.shell_ground().grain_opacity)
			.unwrap_or(0.025)
	}

	/// Resolves grain texture name for level 0 (§6.5).
	#[must_use]
	pub fn grain_texture(&self) -> Option<&str> {
		self
			.elevation
			.as_ref()
			.and_then(|e| e.shell_ground().grain_texture.as_deref())
	}

	/// Resolves physically plausible layered shadows for a float at a given rise
	/// (§6.5).
	#[must_use]
	pub fn float_shadows_elevation(&self, rise_px: f32) -> Vec<BoxShadow> {
		let is_dark = self.color(ColorRole::Ground).l < 0.5;
		let base_op = self
			.elevation
			.as_ref()
			.and_then(|e| e.float().shadow_opacity)
			.unwrap_or(0.45);
		let key_y = (rise_px * 0.20).clamp(1.0, 8.0);
		let key_blur = (rise_px * 0.40).clamp(2.0, 16.0);
		let key_spread = (-rise_px * 0.08).clamp(-4.0, 0.0);
		let amb_y = (rise_px * 0.65).clamp(4.0, 24.0);
		let amb_blur = (rise_px * 1.50).clamp(12.0, 48.0);
		let amb_spread = (-rise_px * 0.75).clamp(-20.0, -2.0);
		let (mut key_c, mut amb_c) = if is_dark {
			(self.color(ColorRole::Ground), self.color(ColorRole::Ground))
		} else {
			(self.color(ColorRole::Foreground), self.color(ColorRole::Foreground))
		};
		let (k_mul, a_mul) = if is_dark { (0.55, 0.45) } else { (0.22, 0.18) };
		key_c.a = base_op * k_mul;
		amb_c.a = base_op * a_mul;
		vec![
			BoxShadow {
				color:         amb_c,
				offset:        point(px(0.0), px(amb_y)),
				blur_radius:   px(amb_blur),
				spread_radius: px(amb_spread),
				inset:         false,
			},
			BoxShadow {
				color:         key_c,
				offset:        point(px(0.0), px(key_y)),
				blur_radius:   px(key_blur),
				spread_radius: px(key_spread),
				inset:         false,
			},
			BoxShadow {
				color:         self.inner_highlight(),
				offset:        point(px(0.0), px(1.0)),
				blur_radius:   px(0.0),
				spread_radius: px(0.0),
				inset:         true,
			},
		]
	}

	/// Resolves default level 4 box shadow set (outer drop shadows + inner top
	/// highlight).
	#[must_use]
	pub fn float_shadows(&self) -> Vec<BoxShadow> {
		self.float_shadows_elevation(24.0)
	}
}
