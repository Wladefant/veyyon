//! What the right panel, the terminal drawer, the palette and the review layer
//! draw when they have nothing (§5.6, §5.11).
//!
//! One definition per surface, in one match over `EmptySurface`, so a surface
//! added to the enum does not compile until it states what an operator is
//! looking at and what to do about it. A view reads its pair from here rather
//! than holding the sentences beside its rows, which is how one of them came to
//! predict what would appear instead of stating a step.

use veyyon_desktop_kit::TokenSet;
use veyyon_gpui::IntoElement;

use crate::empty::{EmptyCopy, empty_state};

/// Every empty state drawn outside the settings sheet.
///
/// The diff and tree tenants draw one per load status, because what to do about
/// an empty pane depends on why it is empty: a pane nobody asked for takes a
/// different step from one a failed read left behind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, strum::EnumIter)]
pub enum EmptySurface {
	/// No diff was requested.
	DiffUnloaded,
	/// A diff is being read.
	DiffLoading,
	/// The working tree reported no modification.
	DiffClean,
	/// The diff could not be read.
	DiffFailed,
	/// No file is open in the File tenant.
	FileNone,
	/// The open file is not text.
	FileBinary,
	/// No directory tree was requested.
	TreeUnloaded,
	/// A directory tree is being walked.
	TreeLoading,
	/// The workspace holds no entry.
	TreeEmpty,
	/// The directory tree could not be read.
	TreeFailed,
	/// The host reported no accounting for the session.
	Usage,
	/// The host reports none of the panel's tenants. A host that stated a
	/// reason has that drawn as the condition instead of the one here.
	PanelUnavailable,
	/// No process is under supervision.
	ProcessList,
	/// The model picker opened with no model to pick.
	PaletteNoModels,
	/// A palette query matched no row.
	PaletteNoMatch,
	/// The session carries no local review thread.
	ReviewThreads,
}

impl EmptySurface {
	/// The region the empty state is recorded under, which is the tenant rather
	/// than the status: one pane draws one empty state at a time.
	#[must_use]
	pub const fn id(self) -> &'static str {
		match self {
			Self::DiffUnloaded | Self::DiffLoading | Self::DiffClean | Self::DiffFailed => {
				"right-panel-diff-empty"
			},
			Self::FileNone => "right-panel-file-empty",
			Self::FileBinary => "right-panel-file-binary",
			Self::TreeUnloaded | Self::TreeLoading | Self::TreeEmpty | Self::TreeFailed => {
				"right-panel-tree-empty"
			},
			Self::Usage => "right-panel-usage-empty",
			Self::PanelUnavailable => "right-panel-unavailable",
			Self::ProcessList => "process-list-empty",
			Self::PaletteNoModels | Self::PaletteNoMatch => "palette-empty",
			Self::ReviewThreads => "review-threads-empty",
		}
	}

	/// The condition the surface is in and the step out of it.
	///
	/// `DiffLoading` and `TreeLoading` state what is underway instead of a
	/// step, because a read in flight is not something to act on;
	/// `a-surface-with-nothing-on-it-states-the-condition-and-the-step.rs`
	/// holds that pair of exceptions by exact equality.
	#[must_use]
	pub const fn copy(self) -> EmptyCopy {
		match self {
			Self::DiffUnloaded => EmptyCopy {
				condition: "Changes not requested yet",
				action:    "Select working tree or staged above to inspect diffs",
			},
			Self::DiffLoading => EmptyCopy {
				condition: "Loading changes...",
				action:    "Inspecting working tree and index",
			},
			Self::DiffClean => EmptyCopy {
				condition: "Working tree is clean",
				action:    "Edit a file, or select staged above to inspect the index",
			},
			Self::DiffFailed => EmptyCopy {
				condition: "Unable to load repository changes",
				action:    "Check git repository status or retry from the command palette",
			},
			Self::FileNone => EmptyCopy {
				condition: "No file open",
				action:    "Select a file from the Tree tab or an artifact link to inspect contents",
			},
			Self::FileBinary => EmptyCopy {
				condition: "Binary file cannot be displayed",
				action:    "Select a UTF-8 text file from the Tree tab",
			},
			Self::TreeUnloaded => EmptyCopy {
				condition: "Directory tree not loaded",
				action:    "Open a workspace folder to view its directory structure",
			},
			Self::TreeLoading => EmptyCopy {
				condition: "Scanning workspace...",
				action:    "Building directory hierarchy",
			},
			Self::TreeEmpty => EmptyCopy {
				condition: "Workspace is empty",
				action:    "Create a file here, or open another workspace folder",
			},
			Self::TreeFailed => EmptyCopy {
				condition: "Unable to read directory tree",
				action:    "Check workspace directory access permissions",
			},
			Self::Usage => EmptyCopy {
				condition: "No accounting reported yet",
				action:    "Send a prompt in the composer to start this session's accounting",
			},
			Self::PanelUnavailable => EmptyCopy {
				condition: "This panel is unavailable",
				action:    "Attach a host that reports one of Changes, File, Tree or Usage",
			},
			Self::ProcessList => EmptyCopy {
				condition: "No supervised processes running",
				action:    "Start a process using the launch tool or run a command in the terminal",
			},
			Self::PaletteNoModels => EmptyCopy {
				condition: "No models available",
				action:    "Sign in to a provider under Settings ▸ Providers",
			},
			Self::PaletteNoMatch => EmptyCopy {
				condition: "No matching items",
				action:    "Clear or edit the search query",
			},
			Self::ReviewThreads => EmptyCopy {
				condition: "No local review threads",
				action:    "Click a line in the diff view to start a review thread",
			},
		}
	}
}

/// Draws `surface`'s empty state.
#[must_use]
pub fn empty_surface(surface: EmptySurface, tokens: &TokenSet) -> impl IntoElement {
	let EmptyCopy { condition, action } = surface.copy();
	empty_state(surface.id(), condition, action, tokens)
}

/// Draws the panel with none of its tenants reported, stating `reason` as the
/// condition and the step `EmptySurface::PanelUnavailable` defines.
#[must_use]
pub fn empty_unavailable(reason: &str, tokens: &TokenSet) -> impl IntoElement {
	let surface = EmptySurface::PanelUnavailable;
	empty_state(surface.id(), reason, surface.copy().action, tokens)
}
