//! State models and presentation parameters (§8.25).

use veyyon_gpui::SharedString;

use crate::icons::IconName;

mod chord;

pub use chord::KeyChord;

/// General interactive state for clickable and focusable components.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum InteractiveState {
	#[default]
	Default,
	Hovered,
	Focused,
	Active,
	Disabled,
}

/// General selection state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum SelectionState {
	#[default]
	None,
	Selected,
	Active,
}

/// Row visual presentation shapes in list containers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum ListRowShape {
	#[default]
	Card,
	Line,
}

/// Interactive state flags for selectable and draggable rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum RowInteractiveState {
	#[default]
	Rest,
	Hover,
	Focused,
	Selected,
	Open,
	Dragging,
}

/// Semantic badge kind indicating task or session execution state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RowBadgeKind {
	Approval,
	Input,
	Plan,
	Failed,
	Due,
	Done,
	Working,
	Watching,
}

/// Structured specification for a badge rendered in a list row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowBadgeSpec {
	pub kind:   RowBadgeKind,
	pub label:  SharedString,
	pub detail: Option<SharedString>,
}

impl RowBadgeSpec {
	/// Creates a badge specification with kind and label.
	#[must_use]
	pub fn new(kind: RowBadgeKind, label: impl Into<SharedString>) -> Self {
		Self { kind, label: label.into(), detail: None }
	}

	/// Attaches optional secondary detail string to the badge.
	#[must_use]
	pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
		self.detail = Some(detail.into());
		self
	}
}

/// Visual presentation variant for button controls.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum ButtonVariant {
	#[default]
	Default,
	Primary,
	Ghost,
	Danger,
}

/// Control sizing steps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum ControlSize {
	Micro,
	Small,
	#[default]
	Medium,
	Large,
}

/// Badge visual presentation variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum BadgeVariant {
	#[default]
	Default,
	Subtle,
	Solid,
	Outline,
}

/// Option entry for `Select` dropdown controls.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectOption {
	pub value: SharedString,
	pub label: SharedString,
}

impl SelectOption {
	/// Creates a select option with value and label.
	#[must_use]
	pub fn new(value: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
		Self { value: value.into(), label: label.into() }
	}
}

/// Segment entry for `SegmentedControl`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SegmentItem {
	pub label: SharedString,
	pub icon:  Option<IconName>,
}

impl SegmentItem {
	/// Creates a segment item with text label.
	#[must_use]
	pub fn new(label: impl Into<SharedString>) -> Self {
		Self { label: label.into(), icon: None }
	}

	/// Attaches icon to the segment item.
	#[must_use]
	pub fn icon(mut self, icon: IconName) -> Self {
		self.icon = Some(icon);
		self
	}
}

/// Tree hierarchy node coordinate index.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TreeIndex {
	pub depth:  usize,
	pub row:    usize,
	pub parent: Option<usize>,
}

/// Item specification for dropdown and context menus.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuItem {
	pub label:          SharedString,
	pub icon:           Option<IconName>,
	pub shortcut:       Option<SharedString>,
	pub is_disabled:    bool,
	pub is_danger:      bool,
	pub is_separator:   bool,
	pub is_section:     bool,
	/// Where the keyboard stands, drawn as the row's own selection so a
	/// walk with no pointer in the window states which row Return takes.
	pub is_highlighted: bool,
	pub submenu:        Option<Vec<Self>>,
}

impl MenuItem {
	/// Creates a menu item with label.
	#[must_use]
	pub fn new(label: impl Into<SharedString>) -> Self {
		Self {
			label:          label.into(),
			icon:           None,
			shortcut:       None,
			is_disabled:    false,
			is_danger:      false,
			is_separator:   false,
			is_section:     false,
			is_highlighted: false,
			submenu:        None,
		}
	}

	/// Creates a separator item.
	#[must_use]
	pub fn separator() -> Self {
		Self {
			label:          SharedString::default(),
			icon:           None,
			shortcut:       None,
			is_disabled:    false,
			is_danger:      false,
			is_separator:   true,
			is_section:     false,
			is_highlighted: false,
			submenu:        None,
		}
	}

	/// Creates a section header item.
	#[must_use]
	pub fn section(label: impl Into<SharedString>) -> Self {
		Self {
			label:          label.into(),
			icon:           None,
			shortcut:       None,
			is_disabled:    true,
			is_danger:      false,
			is_separator:   false,
			is_section:     true,
			is_highlighted: false,
			submenu:        None,
		}
	}

	/// Attaches submenu items to this menu item.
	#[must_use]
	pub fn submenu(mut self, items: impl IntoIterator<Item = Self>) -> Self {
		self.submenu = Some(items.into_iter().collect());
		self
	}

	/// Attaches leading icon to the menu item.
	#[must_use]
	pub fn icon(mut self, icon: IconName) -> Self {
		self.icon = Some(icon);
		self
	}

	/// Attaches keyboard shortcut string.
	#[must_use]
	pub fn shortcut(mut self, shortcut: impl Into<SharedString>) -> Self {
		self.shortcut = Some(shortcut.into());
		self
	}

	/// Sets whether item is disabled.
	#[must_use]
	pub fn disabled(mut self, disabled: bool) -> Self {
		self.is_disabled = disabled;
		self
	}

	/// Sets whether the keyboard stands on this item.
	#[must_use]
	pub fn highlighted(mut self, highlighted: bool) -> Self {
		self.is_highlighted = highlighted;
		self
	}

	/// Sets whether item is destructive.
	#[must_use]
	pub fn danger(mut self, danger: bool) -> Self {
		self.is_danger = danger;
		self
	}

	/// Resolves the ink this row is drawn in.
	///
	/// Refusal outranks destruction: a row that cannot be taken states that
	/// first, because its mark would otherwise read as an offer.
	#[must_use]
	pub fn tone(&self) -> MenuRowTone {
		if self.is_disabled {
			MenuRowTone::Refused
		} else if self.is_danger {
			MenuRowTone::Destructive
		} else {
			MenuRowTone::Offered
		}
	}
}

/// The ink a menu row is drawn in, resolved from what the row is for.
///
/// A row states its purpose with `disabled` and `danger`; the renderer needs
/// one of three inks. Resolving the pair to this enum keeps the ink space
/// enumerable, so a new tone is swept by the tests that check a row is legible
/// on the ground a menu draws on rather than added silently.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, strum::EnumIter)]
pub enum MenuRowTone {
	#[default]
	Offered,
	Refused,
	Destructive,
}

/// Button specification for modal dialog action rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialogButtonSpec {
	pub label:   SharedString,
	pub variant: ButtonVariant,
}

impl DialogButtonSpec {
	/// Creates a dialog button specification.
	#[must_use]
	pub fn new(label: impl Into<SharedString>, variant: ButtonVariant) -> Self {
		Self { label: label.into(), variant }
	}
}

/// Image source descriptor for avatars.
pub struct ImageSource {
	pub uri: SharedString,
}

impl ImageSource {
	/// Creates an image source with URI.
	#[must_use]
	pub fn from_uri(uri: impl Into<SharedString>) -> Self {
		Self { uri: uri.into() }
	}
}
