//! macOS APFS clonefile-based isolation.
//!
//! `clonefile(2)` recursively reflinks an entire directory tree in a single
//! syscall. Both paths share the same on-disk blocks until either side is
//! modified; the kernel handles per-block copy-on-write. The destination is
//! a fully independent directory tree from the caller's perspective — there
//! is no mount to undo, so [`stop`](IsolationBackend::stop) is a recursive
//! remove.

declare_backend!(
	ApfsBackend,
	Apfs,
	"APFS clonefile isolation is only available on macOS",
	target_os = "macos"
);

#[cfg(target_os = "macos")]
mod imp {
	use std::{fs, path::Path};

	use crate::{IsoError, IsoResult, ProbeResult, canonical_existing_dir};

	pub const fn probe() -> ProbeResult {
		ProbeResult::available()
	}

	pub fn start(lower: &Path, merged: &Path) -> IsoResult<()> {
		let lower = canonical_existing_dir(lower, "clone")?;
		if let Some(parent) = merged.parent() {
			fs::create_dir_all(parent).map_err(|err| {
				IsoError::other(format!("unable to create parent of {}: {err}", merged.display()))
			})?;
		}
		// `clonefile` refuses to overwrite. Drop any stale tree first.
		if merged.exists() {
			fs::remove_dir_all(merged).map_err(|err| {
				IsoError::other(format!("unable to clear {} before clone: {err}", merged.display()))
			})?;
		}

		let err = match crate::cow::clonefile(&lower, merged, 0) {
			Ok(()) => return Ok(()),
			Err(err) => err,
		};
		if crate::cow::is_unsupported(&err) {
			return Err(IsoError::unavailable(format!(
				"APFS clonefile unsupported on this volume ({err}); {} -> {}",
				lower.display(),
				merged.display()
			)));
		}
		Err(IsoError::other(format!("clonefile {} -> {}: {err}", lower.display(), merged.display())))
	}

	pub fn stop(merged: &Path) -> IsoResult<()> {
		match fs::remove_dir_all(merged) {
			Ok(()) => Ok(()),
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
			Err(err) => Err(IsoError::other(format!(
				"unable to remove cloned tree {}: {err}",
				merged.display()
			))),
		}
	}
}
