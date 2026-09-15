//! WHY: the light theme shipped `inset` at a contrast ratio of 1.028 against
//! `canvas` and `float` at 1.010 — four values and two values out of 255. Both
//! are invisible, both were reported as "validated for contrast floors and
//! hierarchy parity", and every existing check passed. The contrast floors in
//! `loader_theme` compare an ink against the grounds it is drawn on, which is
//! legibility; the scene gate reports clutter and alignment. Nothing compared
//! one ground against another, so the elevation stack could collapse into a
//! flat surface while the whole suite stayed green.
//!
//! CLASS CLOSED: two elevation levels resolving to grounds a viewer cannot
//! tell apart, in any bundled theme. The stack is read from `elevation.toml`
//! at run time and each level's `ground_role` is resolved through the theme, so
//! a sixth level, a reordered stack, a renamed ground role, or a theme that
//! quietly lifts one level onto its neighbour fails here until someone records
//! the decision. Every appearance is swept, because the defect appeared in
//! light while dark was correct: a floor asserted on one appearance proves
//! nothing about the other, and near-white has no headroom above it.
//!
//! NOT CAUGHT: whether a surface paints the role its level declares. The
//! transcript canvas painted `ColorRole::Ground` for a while, so L0 and L2
//! rendered as one value with both roles correctly declared, and this suite
//! would have passed throughout — that needs the surface crate. Nor does this
//! model the glass material: blur, grain, shadow and `ground_opacity`
//! composite on top of a ground, so a level that clears the floor here can
//! still render indistinctly once its material is applied.

use std::path::PathBuf;

use veyyon_desktop_tokens::{
	APPEARANCES, ColorRole, ElevationLevel, Theme, load_bundled_themes, load_bundled_tokens,
};

/// The bundled theme directory that ships with the tokens crate.
fn bundled_dir() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("themes")
}

/// The separation two stacked grounds must clear to read as different levels.
///
/// This is a lower bound on visible difference, not a judgement of depth. The
/// two defects that shipped measured 1.028 and 1.010; the weakest pair that
/// reads correctly today measures 1.137. The floor sits below the working pair
/// and above both defects, so it fails a collapse without dictating the
/// palette.
const SEPARATION_FLOOR: f32 = 1.10;

/// The elevation stack, ordered by the level index the token file declares.
///
/// Ordering here rather than trusting file order means a hand-reordered
/// `elevation.toml` is still checked against the stack it describes.
fn stack() -> Vec<ElevationLevel> {
	let tokens = load_bundled_tokens().expect("bundled tokens load");
	let mut levels = tokens.elevation.levels.to_vec();
	levels.sort_by_key(|level| level.index);
	levels
}

/// The colour role named by a level's `ground_role`, or `None` when the string
/// names no role in the enum.
///
/// Resolved by sweeping `ColorRole::all()` rather than by a match written here,
/// so a renamed role fails rather than falling through to a default.
fn role_named(name: &str) -> Option<ColorRole> {
	ColorRole::all()
		.into_iter()
		.find(|role| role.as_str() == name)
}

/// Every bundled theme, paired with the appearance it declares.
fn themes() -> Vec<Theme> {
	load_bundled_themes(&bundled_dir()).expect("bundled themes load")
}

#[test]
fn the_stack_is_contiguous_from_zero_and_every_level_names_a_declared_role() {
	let levels = stack();
	let indices: Vec<u8> = levels.iter().map(|level| level.index).collect();
	let expected: Vec<u8> = (0..u8::try_from(levels.len()).expect("stack fits a byte")).collect();
	assert_eq!(
		indices, expected,
		"elevation levels are indexed contiguously from 0; a gap or a repeat leaves a level \
		 unordered and so unchecked by the separation sweep"
	);
	for level in &levels {
		assert!(
			role_named(&level.ground_role).is_some(),
			"level {} ({}) names ground role {:?}, which is not in ColorRole",
			level.index,
			level.role,
			level.ground_role
		);
	}
}

#[test]
fn every_adjacent_pair_of_levels_clears_the_separation_floor_in_every_appearance() {
	let levels = stack();
	let themes = themes();
	assert_eq!(themes.len(), APPEARANCES.len(), "one bundled theme per appearance");

	for theme in &themes {
		let path = bundled_dir().join(format!("{}.toml", theme.appearance));
		for pair in levels.windows(2) {
			let (lower, upper) = (&pair[0], &pair[1]);
			let lower_role =
				role_named(&lower.ground_role).expect("lower ground role is a declared role");
			let upper_role =
				role_named(&upper.ground_role).expect("upper ground role is a declared role");
			let lower_colour = theme
				.role(&path, lower_role)
				.expect("lower ground declared");
			let upper_colour = theme
				.role(&path, upper_role)
				.expect("upper ground declared");
			let ratio = lower_colour.contrast_ratio(upper_colour);
			assert!(
				ratio >= SEPARATION_FLOOR,
				"{}: level {} ({}) and level {} ({}) separate at only {ratio:.3}, below the \
				 {SEPARATION_FLOOR} floor — the two levels render as one surface",
				theme.appearance,
				lower.index,
				lower.ground_role,
				upper.index,
				upper.ground_role
			);
		}
	}
}

#[test]
fn no_two_levels_resolve_to_the_same_ground_in_any_appearance() {
	let levels = stack();
	for theme in &themes() {
		let path = bundled_dir().join(format!("{}.toml", theme.appearance));
		for (i, lower) in levels.iter().enumerate() {
			for upper in &levels[i + 1..] {
				let lower_role = role_named(&lower.ground_role).expect("declared role");
				let upper_role = role_named(&upper.ground_role).expect("declared role");
				if lower_role == upper_role {
					panic!(
						"{}: level {} and level {} both declare ground role {:?}",
						theme.appearance, lower.index, upper.index, lower.ground_role
					);
				}
				let lower_colour = theme.role(&path, lower_role).expect("declared");
				let upper_colour = theme.role(&path, upper_role).expect("declared");
				assert_ne!(
					lower_colour, upper_colour,
					"{}: level {} ({}) and level {} ({}) resolve to the same colour, so the stack has \
					 one fewer visible level than it declares",
					theme.appearance, lower.index, lower.ground_role, upper.index, upper.ground_role
				);
			}
		}
	}
}

/// The floor only guards the pairs the sweep visits. A level whose ground role
/// is absent from the stack is separated from nothing, which is the shape the
/// original defect would have taken had `float` been dropped from
/// `elevation.toml` rather than lightened.
#[test]
fn every_ground_role_in_the_enum_is_claimed_by_exactly_one_level() {
	let levels = stack();
	let claimed: Vec<ColorRole> = levels
		.iter()
		.filter_map(|level| role_named(&level.ground_role))
		.collect();
	let grounds =
		[ColorRole::Ground, ColorRole::Rail, ColorRole::Canvas, ColorRole::Inset, ColorRole::Float];
	for ground in grounds {
		let count = claimed.iter().filter(|role| **role == ground).count();
		assert_eq!(
			count,
			1,
			"ground role {:?} is claimed by {count} elevation levels; each ground belongs to exactly \
			 one level or the stack does not describe the product",
			ground.as_str()
		);
	}
	assert_eq!(
		claimed.len(),
		grounds.len(),
		"the stack claims {} ground roles against {} grounds in the enum",
		claimed.len(),
		grounds.len()
	);
}
