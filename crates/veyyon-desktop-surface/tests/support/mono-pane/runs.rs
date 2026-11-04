//! What a captured frame says a mono pane drew: which runs are rows, which of
//! those are the gutter's numbers, and where a row sits.
//!
//! The pane is read out of the display list rather than out of the element
//! tree, because the claims are about what reached the glass: a number that
//! travelled with the code, a line clipped instead of scrolled, and a row
//! drawn at a size its tokens do not author are all differences in the runs.

use veyyon_desktop_scene::{BoxBounds, Captured};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{Pixels, Point};

use super::rect;

/// The top edge of the pane's rows: under the tab strip and under the file
/// header, both of which draw runs of their own that are not rows.
pub fn pane_top(panel: BoxBounds, panels: &PanelsSurfaceTokens) -> f32 {
	panel.top + panels.tabs_height_px + panels.chrome_row_height_px
}

/// Every text run the pane's rows drew, with the run's own font size.
pub fn row_runs(
	captured: &Captured,
	panel: BoxBounds,
	panels: &PanelsSurfaceTokens,
) -> Vec<(BoxBounds, f32)> {
	captured
		.text_runs
		.iter()
		.map(|run| (rect(run.bounds), f32::from(run.font_size)))
		.filter(|(bounds, _)| {
			bounds.top >= pane_top(panel, panels) - 0.5
				&& bounds.right > panel.left
				&& bounds.left < panel.right
		})
		.collect()
}

/// The left edge of the code column: the gutter's own width in from the
/// panel's left edge.
pub fn code_edge(panel: BoxBounds, panels: &PanelsSurfaceTokens) -> f32 {
	panel.left + panels.diff_gutter_width_px
}

/// Whether a row run is one of the gutter's numbers: it sits wholly inside the
/// band the gutter pins, left of the code column's edge.
///
/// Reading the two columns apart by their left edges instead would have been
/// circular, since the code column's left edge is what the gesture moves. The
/// band is fixed, and no code line of this file fits inside it -- every line
/// here is wider than the gutter, which
/// `every_row_of_the_pane_is_the_size_and_the_line_its_tokens_author` asserts
/// rather than assumes.
pub fn is_number(run: BoxBounds, panel: BoxBounds, panels: &PanelsSurfaceTokens) -> bool {
	run.left >= panel.left - 0.5 && run.right <= code_edge(panel, panels) + 0.5
}

/// The pane's code runs: every row run that is not one of the gutter's
/// numbers.
pub fn code_runs(
	captured: &Captured,
	panel: BoxBounds,
	panels: &PanelsSurfaceTokens,
) -> Vec<BoxBounds> {
	row_runs(captured, panel, panels)
		.into_iter()
		.filter(|(bounds, _)| !is_number(*bounds, panel, panels))
		.map(|(bounds, _)| bounds)
		.collect()
}

/// The pane's gutter runs: the line numbers.
pub fn gutter_runs(
	captured: &Captured,
	panel: BoxBounds,
	panels: &PanelsSurfaceTokens,
) -> Vec<BoxBounds> {
	row_runs(captured, panel, panels)
		.into_iter()
		.filter(|(bounds, _)| is_number(*bounds, panel, panels))
		.map(|(bounds, _)| bounds)
		.collect()
}

/// The line numbers the gutter drew, top to bottom.
///
/// A mono pane virtualizes its rows: the built rows always paint from the top
/// of the region and the padding stands in for the rows outside it, so a
/// vertical scroll changes which lines are built rather than where a row sits.
/// The numbers are what a vertical scroll is read from; a row's position is
/// what a horizontal one is read from.
pub fn gutter_numbers(
	captured: &Captured,
	panel: BoxBounds,
	panels: &PanelsSurfaceTokens,
) -> Vec<String> {
	captured
		.text_runs
		.iter()
		.map(|run| (rect(run.bounds), run.text.to_string()))
		.filter(|(bounds, _)| {
			bounds.top >= pane_top(panel, panels) - 0.5
				&& bounds.right > panel.left
				&& bounds.left < panel.right
				&& is_number(*bounds, panel, panels)
		})
		.map(|(_, text)| text.trim().to_owned())
		.filter(|text| !text.is_empty() && text.chars().all(|c| c.is_ascii_digit()))
		.collect()
}

pub fn lefts(runs: &[BoxBounds]) -> Vec<f32> {
	runs.iter().map(|run| run.left).collect()
}

pub fn tops(runs: &[BoxBounds]) -> Vec<f32> {
	runs.iter().map(|run| run.top).collect()
}

/// Somewhere inside the code column, for the wheel to arrive at.
pub fn over_code(panel: BoxBounds, panels: &PanelsSurfaceTokens) -> Point<Pixels> {
	Point {
		x: Pixels::from(f32::midpoint(panel.left + panels.diff_gutter_width_px, panel.right)),
		y: Pixels::from(pane_top(panel, panels) + panels.diff_row_height_px),
	}
}

/// How wide the pane's widest row is, measured across the pieces one line
/// arrives in.
///
/// A line's own width is its spans' together. Reading the widest run instead
/// would have measured one piece of a highlighted line and called it the line.
pub fn widest_row(runs: &[BoxBounds]) -> f32 {
	let mut rows: Vec<(f32, f32, f32)> = Vec::new();
	for run in runs {
		match rows
			.iter_mut()
			.find(|(top, ..)| (*top - run.top).abs() < 0.5)
		{
			Some((_, left, right)) => {
				*left = left.min(run.left);
				*right = right.max(run.right);
			},
			None => rows.push((run.top, run.left, run.right)),
		}
	}
	rows
		.into_iter()
		.map(|(_, left, right)| right - left)
		.fold(0.0, f32::max)
}
