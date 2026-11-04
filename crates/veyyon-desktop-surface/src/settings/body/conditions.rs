//! Setting condition evaluation and query matching (§5.9).

use veyyon_desktop_model::{SettingEntry, SettingsView};

/// Evaluates whether a setting should be displayed based on master feature
/// toggles.
#[must_use]
pub fn is_setting_condition_met(key: &str, settings: &SettingsView) -> bool {
	if key.starts_with("argot.") && key != "argot.enabled" {
		return is_master_on(settings, "argot.enabled");
	}
	if key.starts_with("lsp.") && key != "lsp.enabled" {
		return is_master_on(settings, "lsp.enabled");
	}
	if key.starts_with("speech.") && key != "speech.enabled" {
		return is_master_on(settings, "speech.enabled");
	}
	if key.starts_with("stt.") && key != "stt.enabled" {
		return is_master_on(settings, "stt.enabled");
	}
	if key.starts_with("bash.autoBackground.") && key != "bash.autoBackground.enabled" {
		return is_master_on(settings, "bash.autoBackground.enabled");
	}
	if key.starts_with("bash.stallDetection.") && key != "bash.stallDetection.enabled" {
		return is_master_on(settings, "bash.stallDetection.enabled");
	}
	if key.starts_with("browser.") && key != "browser.enabled" {
		return is_master_on(settings, "browser.enabled");
	}
	if key.starts_with("github.") && key != "github.enabled" {
		return is_master_on(settings, "github.enabled");
	}
	if key.starts_with("advisor.") && key != "advisor.enabled" {
		return is_master_on(settings, "advisor.enabled");
	}
	if key.starts_with("secrets.") && key != "secrets.enabled" {
		return is_master_on(settings, "secrets.enabled");
	}
	if key.starts_with("launch.") && key != "launch.enabled" {
		return is_master_on(settings, "launch.enabled");
	}
	if key.starts_with("statusLine.") && key != "statusLine.enabled" {
		return is_master_on(settings, "statusLine.enabled");
	}
	true
}

/// Checks whether a master boolean toggle is enabled in settings.
#[must_use]
pub fn is_master_on(settings: &SettingsView, master_key: &str) -> bool {
	match settings.get(master_key) {
		Some(e) => match &e.value {
			serde_json::Value::Bool(b) => *b,
			serde_json::Value::String(s) => s == "true",
			_ => false,
		},
		None => true,
	}
}

/// Checks if a setting matches a search query across key, label, description,
/// and group.
#[must_use]
pub fn matches_query(key: &str, entry: &SettingEntry, query: &str) -> bool {
	if key.to_lowercase().contains(query) {
		return true;
	}
	if entry
		.label
		.as_deref()
		.is_some_and(|l| l.to_lowercase().contains(query))
	{
		return true;
	}
	if entry
		.description
		.as_deref()
		.is_some_and(|d| d.to_lowercase().contains(query))
	{
		return true;
	}
	if entry
		.group
		.as_deref()
		.is_some_and(|g| g.to_lowercase().contains(query))
	{
		return true;
	}
	false
}
