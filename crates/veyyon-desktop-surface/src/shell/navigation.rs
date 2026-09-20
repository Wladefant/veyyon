//! Why a navigation transition is refused while work still owns the current
//! draft.

use crate::ShellView;

impl ShellView {
	/// A navigation transition cannot outrun work that still owns the current
	/// draft.
	pub const fn navigation_rejection(&self) -> Option<&'static str> {
		if self.submitted.is_some() {
			Some("Wait for the pending submission before changing tabs or spaces")
		} else if self.state.navigation_pending {
			Some("Wait for the session to finish opening before changing its draft or navigating")
		} else if self.attachments_loading() {
			Some("Wait for attachment loading before changing tabs or spaces")
		} else {
			None
		}
	}
}
