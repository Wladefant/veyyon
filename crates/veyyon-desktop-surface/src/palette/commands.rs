//! Native command entries for existing desktop surfaces and composer actions.

use strum::{EnumIter, IntoEnumIterator};

use super::{PaletteItem, PaletteItemKind, PaletteMode, PaletteState};
use crate::{
	Intent, Overlay,
	settings::{SettingsPage, SettingsState},
};

/// Actions requiring the composer's editor or a local selection surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter)]
pub enum ComposerCommand {
	AttachFiles,
	Models,
	Effort,
	QueueMode,
	Steer,
	Queue,
}

impl ComposerCommand {
	#[must_use]
	pub const fn name(self) -> &'static str {
		match self {
			Self::AttachFiles => "/attach",
			Self::Models => "/model",
			Self::Effort => "/effort",
			Self::QueueMode => "/queue-mode",
			Self::Steer => "/steer",
			Self::Queue => "/queue",
		}
	}
}

/// Every settings page is reachable from command search without adding composer
/// chrome.
#[must_use]
pub fn command_items() -> Vec<PaletteItem> {
	let mut items = vec![
		PaletteItem::command(1, "/new", Intent::NewSession, Some("Cmd/Ctrl N")),
		PaletteItem::command(2, "/terminal", Intent::SetDrawer { open: true }, Some("Cmd/Ctrl J")),
		PaletteItem::command(3, "/abort", Intent::AbortTurn, Some("Cmd/Ctrl .")),
	];
	for page in SettingsPage::iter() {
		let name = match page {
			SettingsPage::General => "/settings",
			SettingsPage::Themes => "/settings themes",
			SettingsPage::Keybindings => "/hotkeys",
			SettingsPage::Providers => "/providers",
			SettingsPage::Authentication => "/login",
			SettingsPage::Mcp => "/mcp",
			SettingsPage::Extensions => "/extensions",
			SettingsPage::Diagnostics => "/settings diagnostics",
			SettingsPage::Usage => "/usage",
			SettingsPage::ContextBreakdown => "/context",
		};
		let mut item = PaletteItem::command(
			items.len() as u64 + 1,
			name,
			Intent::OpenOverlay(Box::new(Overlay::Settings(Box::new(SettingsState::new(page))))),
			None,
		);
		item.subtitle = Some(page.description().to_owned());
		items.push(item);
	}
	for command in ComposerCommand::iter() {
		let subtitle = match command {
			ComposerCommand::AttachFiles => Some("Attach files to composer".to_owned()),
			ComposerCommand::Models => Some("Choose language model".to_owned()),
			ComposerCommand::Effort => Some("Select reasoning effort level".to_owned()),
			ComposerCommand::QueueMode => Some("Toggle queue or steer mode".to_owned()),
			ComposerCommand::Steer => Some("Steer running turn".to_owned()),
			ComposerCommand::Queue => Some("Queue follow-up turn".to_owned()),
		};
		items.push(PaletteItem {
			id:       items.len() as u64 + 1,
			title:    command.name().to_owned(),
			subtitle,
			badge:    None,
			meta:     None,
			kind:     PaletteItemKind::Composer { command },
		});
	}
	let open_id = items.len() as u64 + 1;
	let mut open_item = PaletteItem::command(
		open_id,
		"/open",
		Intent::OpenOverlay(Box::new(Overlay::Palette(PaletteState::new(PaletteMode::Files)))),
		Some("Cmd/Ctrl P"),
	);
	open_item.subtitle = Some("Open workspace file".to_owned());
	items.push(open_item);
	let files_id = items.len() as u64 + 1;
	let mut files_item = PaletteItem::command(
		files_id,
		"/files",
		Intent::OpenOverlay(Box::new(Overlay::Palette(PaletteState::new(PaletteMode::Files)))),
		None,
	);
	files_item.subtitle = Some("Search files by name".to_owned());
	items.push(files_item);
	items
}
