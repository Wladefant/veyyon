//! Motion driver for FLIP layout shift transitions (`MotionRole::Shift`).
//!
//! Provides First-Last-Invert-Play translation tracking keyed by element slot
//! in the motion registry, ensuring layout-affecting repositioning animates
//! as visual transform offsets without causing reflow of sibling elements.

use std::time::Instant;

use crate::{
	curves::EasingCurve,
	registry::{AnimatorKey, AnimatorRegistry, SurfaceId},
	role::{FlipModel, MotionModel, MotionRole, ResolvedMotion, resolve_motion},
	tokens::MotionTokens,
};

/// Motion driver for FLIP layout shift transitions (`MotionRole::Shift`).
#[derive(Debug)]
pub struct ShiftMotion {
	surface_id:     SurfaceId,
	slot:           u64,
	registry:       AnimatorRegistry,
	current_offset: f32,
}

impl ShiftMotion {
	/// Creates a new shift motion driver.
	#[must_use]
	pub fn new(surface_id: SurfaceId, slot: u64) -> Self {
		Self { surface_id, slot, registry: AnimatorRegistry::new(), current_offset: 0.0 }
	}

	/// Records a layout position change from `previous_pos` to `current_pos`.
	///
	/// Computes the inverted visual delta and animates to zero offset.
	pub fn record_shift(
		&mut self,
		previous_pos: f32,
		current_pos: f32,
		tokens: &MotionTokens,
		reduced: bool,
		now: Instant,
	) {
		let delta = previous_pos - current_pos;
		if delta.abs() <= 0.001 {
			return;
		}

		let key = AnimatorKey::new(self.surface_id, MotionRole::Shift, self.slot);
		match resolve_motion(MotionRole::Shift, tokens, reduced) {
			ResolvedMotion::Instant => {
				let model =
					MotionModel::Flip(FlipModel { duration_ms: 0, curve: EasingCurve::EaseOut });
				let active = self.registry.get_or_create(key, 0.0, model, now);
				active.start_value = 0.0;
				active.current_value = 0.0;
				active.target_value = 0.0;
				active.is_at_rest = true;
				self.current_offset = 0.0;
			},
			ResolvedMotion::Duration { duration_ms, curve } => {
				let model = MotionModel::Flip(FlipModel { duration_ms, curve });
				let current_offset = if let Some(active) = self.registry.sample(&key, now) {
					delta + active
				} else {
					delta
				};
				let active = self.registry.get_or_create(key, 0.0, model, now);
				active.start_value = current_offset;
				active.current_value = current_offset;
				active.target_value = 0.0;
				active.start_time = now;
				active.model = model;
				active.is_at_rest = false;
				self.current_offset = current_offset;
			},
			_ => {},
		}
	}

	/// Samples the current visual translation offset and settled state at `now`.
	pub fn sample(&mut self, now: Instant) -> (f32, bool) {
		let key = AnimatorKey::new(self.surface_id, MotionRole::Shift, self.slot);
		if let Some((offset, _, at_rest)) = self.registry.sample_full(&key, now) {
			self.current_offset = offset;
			(offset, at_rest)
		} else {
			(0.0, true)
		}
	}

	/// Returns current offset without sampling.
	#[must_use]
	pub const fn current_offset(&self) -> f32 {
		self.current_offset
	}

	/// Returns true if the shift transition has settled at rest (0.0 offset).
	#[must_use]
	pub fn is_settled(&self) -> bool {
		self
			.registry
			.is_at_rest(&AnimatorKey::new(self.surface_id, MotionRole::Shift, self.slot))
	}
}
