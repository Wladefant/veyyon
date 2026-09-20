//! WHY: Right panel tabs (Diff, File, Tree) must remain present at rest before
//! host attachment (`CapabilityStatus::UnknownUntilAttached`), preventing
//! visual layout shift upon initial handshake (§1.2 item 2, §4.3). Only an
//! explicit `CapabilityStatus::Unavailable` withholds a tab.
//!
//! CLASS CLOSED: A panel projection that treats `UnknownUntilAttached` as
//! `Unavailable` rather than at rest, withholding panel tabs pre-attachment.
//!
//! WHAT IT DOES NOT CATCH: Host action dispatching or detailed surface layout
//! inside individual tab contents.

use veyyon_desktop::project::project_panel;
use veyyon_desktop_model::{Capability, CapabilityMap, CapabilityStatus, Domains};
use veyyon_desktop_surface::{PanelContent, PanelTab};

fn tabs_for(capabilities: &CapabilityMap) -> Vec<PanelTab> {
	project_panel(&Domains::default(), capabilities, None, PanelContent::default()).tabs
}

fn panel_for(capabilities: &CapabilityMap) -> PanelContent {
	project_panel(&Domains::default(), capabilities, None, PanelContent::default())
}

#[test]
fn unattached_capabilities_preserve_diff_file_and_tree_tabs_at_rest() {
	let caps = CapabilityMap::new();
	assert_eq!(caps.get(Capability::Changes), &CapabilityStatus::UnknownUntilAttached);
	assert_eq!(caps.get(Capability::Files), &CapabilityStatus::UnknownUntilAttached);

	let panel = panel_for(&caps);
	assert!(
		panel.tabs.contains(&PanelTab::Diff),
		"UnknownUntilAttached Changes must preserve Diff tab at rest"
	);
	assert!(
		panel.tabs.contains(&PanelTab::File),
		"UnknownUntilAttached Files must preserve File tab at rest"
	);
	assert!(
		panel.tabs.contains(&PanelTab::Tree),
		"UnknownUntilAttached Files must preserve Tree tab at rest"
	);
	assert_eq!(panel.unavailable_reason, None);
}

#[test]
fn changes_capability_exercises_all_three_statuses() {
	let mut caps = CapabilityMap::new();

	// 1. UnknownUntilAttached: at rest, offered
	caps.set(Capability::Changes, CapabilityStatus::UnknownUntilAttached);
	assert!(
		tabs_for(&caps).contains(&PanelTab::Diff),
		"UnknownUntilAttached Changes must offer Diff tab"
	);

	// 2. Available: confirmed, offered
	caps.set(Capability::Changes, CapabilityStatus::Available);
	assert!(tabs_for(&caps).contains(&PanelTab::Diff), "Available Changes must offer Diff tab");

	// 3. Unavailable: explicitly refused, withheld
	caps.set(Capability::Changes, CapabilityStatus::Unavailable {
		reason: "git binary not found".to_string(),
	});
	assert!(
		!tabs_for(&caps).contains(&PanelTab::Diff),
		"Unavailable Changes must withhold Diff tab"
	);
}

#[test]
fn files_capability_exercises_all_three_statuses() {
	let mut caps = CapabilityMap::new();

	// 1. UnknownUntilAttached: at rest, offered
	caps.set(Capability::Files, CapabilityStatus::UnknownUntilAttached);
	let tabs = tabs_for(&caps);
	assert!(tabs.contains(&PanelTab::File), "UnknownUntilAttached Files must offer File tab");
	assert!(tabs.contains(&PanelTab::Tree), "UnknownUntilAttached Files must offer Tree tab");

	// 2. Available: confirmed, offered
	caps.set(Capability::Files, CapabilityStatus::Available);
	let tabs = tabs_for(&caps);
	assert!(tabs.contains(&PanelTab::File), "Available Files must offer File tab");
	assert!(tabs.contains(&PanelTab::Tree), "Available Files must offer Tree tab");

	// 3. Unavailable: explicitly refused, withheld
	caps.set(Capability::Files, CapabilityStatus::Unavailable {
		reason: "filesystem access denied".to_string(),
	});
	let tabs = tabs_for(&caps);
	assert!(!tabs.contains(&PanelTab::File), "Unavailable Files must withhold File tab");
	assert!(!tabs.contains(&PanelTab::Tree), "Unavailable Files must withhold Tree tab");
}

#[test]
fn exhaustive_three_by_three_capability_status_matrix() {
	let statuses = [
		CapabilityStatus::UnknownUntilAttached,
		CapabilityStatus::Available,
		CapabilityStatus::Unavailable { reason: "feature disabled on host".to_string() },
	];

	for changes_status in &statuses {
		for files_status in &statuses {
			let mut caps = CapabilityMap::new();
			caps.set(Capability::Changes, changes_status.clone());
			caps.set(Capability::Files, files_status.clone());

			let panel = panel_for(&caps);
			let changes_offered = !matches!(changes_status, CapabilityStatus::Unavailable { .. });
			let files_offered = !matches!(files_status, CapabilityStatus::Unavailable { .. });

			assert_eq!(
				panel.tabs.contains(&PanelTab::Diff),
				changes_offered,
				"Diff tab presence mismatch for Changes status {changes_status:?}"
			);
			assert_eq!(
				panel.tabs.contains(&PanelTab::File),
				files_offered,
				"File tab presence mismatch for Files status {files_status:?}"
			);
			assert_eq!(
				panel.tabs.contains(&PanelTab::Tree),
				files_offered,
				"Tree tab presence mismatch for Files status {files_status:?}"
			);

			if !changes_offered && !files_offered {
				assert!(
					panel.tabs.is_empty(),
					"when both capabilities are unavailable, panel tabs must be empty"
				);
				assert_eq!(
					panel.unavailable_reason.as_deref(),
					Some("feature disabled on host"),
					"unavailable reason must be reported when all tabs are withheld"
				);
			} else {
				assert!(
					!panel.tabs.is_empty(),
					"panel tabs must not be empty when at least one capability is offered"
				);
				assert_eq!(panel.unavailable_reason, None);
			}
		}
	}
}

#[test]
fn active_tab_falls_back_when_selected_tab_becomes_unavailable() {
	let refused = {
		let mut caps = CapabilityMap::new();
		caps.set(Capability::Changes, CapabilityStatus::Unavailable {
			reason: "Changes off".to_string(),
		});
		caps.set(Capability::Files, CapabilityStatus::Available);
		caps
	};

	let remembered = PanelContent { active_tab: PanelTab::Diff, ..PanelContent::default() };
	let panel = project_panel(&Domains::default(), &refused, None, remembered);
	assert_eq!(
		panel.active_tab,
		PanelTab::File,
		"when remembered Diff tab is unavailable, active tab falls back to the first available tab"
	);
}
