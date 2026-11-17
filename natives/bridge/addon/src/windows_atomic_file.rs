//! Owned Windows staging and ACL-preserving publication. No recovery data is deleted on drop.

use std::sync::{Arc, Mutex, TryLockError};

use napi::bindgen_prelude::AsyncTask;
use napi_derive::napi;

use crate::{napi_error::to_napi, task::{Blocking, blocking}};

/// A publication result is distinct from a later cleanup failure.
#[derive(Debug, Clone, PartialEq, Eq)]
#[napi(object)]
pub struct WindowsAtomicOutcome {
	pub state: String,
	pub error_code: u32,
	pub operation: String,
	pub recovery_error_code: Option<u32>,
}

impl WindowsAtomicOutcome {
	fn new(state: &str, error_code: u32, operation: &str) -> Self {
		Self { state: state.into(), error_code, operation: operation.into(), recovery_error_code: None }
	}
}

/// Constructor errors retain their raw Win32 code across Node-API conversion.
#[derive(Debug)]
pub struct WindowsAtomicStatus(String);
impl AsRef<str> for WindowsAtomicStatus {
	fn as_ref(&self) -> &str { &self.0 }
}
impl From<napi::Status> for WindowsAtomicStatus {
	fn from(status: napi::Status) -> Self { Self(status.as_ref().into()) }
}

struct WinFailure {
	code: u32,
	operation: &'static str,
	path: String,
}
impl WinFailure {
	fn napi(self) -> napi::Error<WindowsAtomicStatus> {
		napi::Error::new(
			WindowsAtomicStatus(format!("WIN32_{}", self.code)),
			format!("{} failed for {} (Win32 error {})", self.operation, self.path, self.code),
		)
	}
}

/// The directory handle prevents its replacement while a producer owns the path.
#[napi]
pub struct WindowsAtomicStage {
	#[napi(readonly)]
	pub directory: String,
	#[napi(readonly)]
	pub path: String,
	inner: Arc<Mutex<platform::Stage>>,
}

#[napi]
impl WindowsAtomicStage {
	#[napi(constructor)]
	pub fn new(directory: String) -> napi::Result<Self, WindowsAtomicStatus> {
		let stage = platform::Stage::reserve(&directory).map_err(WinFailure::napi)?;
		let path = stage.payload_path();
		Ok(Self { directory, path, inner: Arc::new(Mutex::new(stage)) })
	}

	#[napi]
	pub fn publish_sync(&self, target: String) -> napi::Result<WindowsAtomicOutcome> {
		let mut stage = self.inner.lock().map_err(|_| to_napi("Windows atomic stage lock was poisoned; retain its directory"))?;
		Ok(stage.publish(&target))
	}

	#[napi]
	pub fn publish(&self, target: String) -> AsyncTask<Blocking<WindowsAtomicOutcome>> {
		let inner = Arc::clone(&self.inner);
		blocking("windows_atomic_publish", (), move |_| {
			let mut stage = inner.lock().map_err(|_| to_napi("Windows atomic stage lock was poisoned; retain its directory"))?;
			Ok(stage.publish(&target))
		})
	}

	#[napi]
	pub fn cleanup_sync(&self) -> WindowsAtomicOutcome {
		match self.inner.try_lock() {
			Ok(mut stage) => stage.cleanup(),
			Err(TryLockError::WouldBlock) => WindowsAtomicOutcome::new("recovery-required", 170, "native stage is busy"),
			Err(TryLockError::Poisoned(_)) => WindowsAtomicOutcome::new("recovery-required", 5023, "native stage lock was poisoned"),
		}
	}

	#[napi]
	pub fn cleanup(&self) -> AsyncTask<Blocking<WindowsAtomicOutcome>> {
		let inner = Arc::clone(&self.inner);
		blocking("windows_atomic_cleanup", (), move |_| {
			Ok(match inner.try_lock() {
				Ok(mut stage) => stage.cleanup(),
				Err(TryLockError::WouldBlock) => WindowsAtomicOutcome::new("recovery-required", 170, "native stage is busy"),
				Err(TryLockError::Poisoned(_)) => WindowsAtomicOutcome::new("recovery-required", 5023, "native stage lock was poisoned"),
			})
		})
	}
}

#[cfg(not(windows))]
mod platform {
	use super::{WinFailure, WindowsAtomicOutcome};
	pub struct Stage;
	impl Stage {
		pub fn reserve(path: &str) -> Result<Self, WinFailure> {
			Err(WinFailure { code: 50, operation: "Windows atomic staging is unsupported on this platform", path: path.into() })
		}
		pub fn payload_path(&self) -> String { unreachable!("unsupported constructor cannot create a stage") }
		pub fn publish(&mut self, _: &str) -> WindowsAtomicOutcome { unreachable!("unsupported constructor cannot create a stage") }
		pub fn cleanup(&mut self) -> WindowsAtomicOutcome { unreachable!("unsupported constructor cannot create a stage") }
	}
}

#[cfg(windows)]
mod platform {
	use std::{ffi::c_void, fs, mem::size_of, os::windows::ffi::OsStrExt, path::{Path, PathBuf}, ptr::{null, null_mut}};
	use windows_sys::Win32::{
		Foundation::{CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE, LocalFree, GENERIC_READ, GENERIC_WRITE},
		Security::{
			Authorization::{ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo, SetSecurityInfo, SE_FILE_OBJECT},
			ACE_HEADER, ACL, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
			GetAce, GetSecurityDescriptorControl, GetSecurityDescriptorDacl, GetSecurityDescriptorOwner,
			GetTokenInformation, EqualSid, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
		},
		Storage::FileSystem::{
			BY_HANDLE_FILE_INFORMATION, CREATE_NEW, CreateDirectoryW, CreateFileW, DELETE,
			FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
			FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
			FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_SHARE_DELETE, FILE_DISPOSITION_INFO,
			FileDispositionInfo, GetFileAttributesW, GetFileInformationByHandle, GetVolumeInformationByHandleW,
			MoveFileExW, OPEN_EXISTING, READ_CONTROL, ReplaceFileW, SetFileInformationByHandle, WRITE_DAC, WRITE_OWNER,
		},
		System::{Threading::{GetCurrentProcess, OpenProcessToken}, WindowsProgramming::FS_PERSISTENT_ACLS},
	};
	use super::{WinFailure, WindowsAtomicOutcome};

	const PAYLOAD: &str = "payload.tmp";
	const BACKUP: &str = "previous";
	const PROTECTED: u16 = 0x1000;

	struct Handle(HANDLE);
	// SAFETY: Windows kernel handles may be used and closed from any process thread.
	unsafe impl Send for Handle {}
	impl Drop for Handle {
		fn drop(&mut self) {
			// SAFETY: this wrapper only owns successful, non-pseudo CreateFile/OpenProcessToken handles.
			unsafe { CloseHandle(self.0); }
		}
	}

	struct LocalAllocation(*mut c_void);
	impl Drop for LocalAllocation {
		fn drop(&mut self) {
			// SAFETY: Windows allocated this non-null buffer using LocalAlloc-compatible security APIs.
			if !self.0.is_null() { unsafe { LocalFree(self.0); } }
		}
	}

	struct Descriptor(Vec<u32>);
	impl Descriptor {
		fn pointer(&self) -> PSECURITY_DESCRIPTOR { self.0.as_ptr().cast_mut().cast() }
		fn from_sddl(sddl: &str) -> Result<Self, u32> {
			let text: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
			let mut descriptor = null_mut();
			let mut bytes = 0;
			// SAFETY: text is terminated, outputs are live, revision 1 is the documented SDDL revision.
			if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(text.as_ptr(), 1, &raw mut descriptor, &raw mut bytes) } == 0 {
				return Err(last_error());
			}
			let allocation = LocalAllocation(descriptor);
			if allocation.0.is_null() || bytes == 0 { return Err(87); }
			let mut words = vec![0_u32; (bytes as usize).div_ceil(size_of::<u32>())];
			// SAFETY: the conversion returned `bytes` readable bytes; the aligned destination has at least that capacity.
			unsafe { std::ptr::copy_nonoverlapping(allocation.0.cast::<u8>(), words.as_mut_ptr().cast::<u8>(), bytes as usize); }
			Ok(Self(words))
		}
	}

	#[derive(Clone, Copy, PartialEq, Eq)]
	enum Phase { Staging, Published, Recovery, Closed }

	pub struct Stage {
		directory: PathBuf,
		payload: PathBuf,
		backup: PathBuf,
		handle: Option<Handle>,
		backup_handle: Option<Handle>,
		identity: (u32, u32, u32),
		directory_security: Descriptor,
		file_security: Descriptor,
		phase: Phase,
		recovery_code: u32,
		recovery_error: Option<u32>,
	}

	fn last_error() -> u32 {
		// SAFETY: captures this thread's Win32 error immediately after the failed native operation.
		unsafe { GetLastError() }
	}

	fn wide(path: &Path) -> Result<Vec<u16>, u32> {
		if !path.is_absolute() { return Err(87); }
		let mut text: Vec<u16> = path.as_os_str().encode_wide().collect();
		if text.contains(&0) { return Err(87); }
		text.push(0);
		Ok(text)
	}

	fn current_sid() -> Result<String, u32> {
		let mut token = null_mut();
		// SAFETY: GetCurrentProcess is a pseudo handle; token is a writable HANDLE output.
		if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw mut token) } == 0 { return Err(last_error()); }
		let token = Handle(token);
		let mut bytes = 0;
		// SAFETY: the documented size query writes only the output length.
		let queried = unsafe { GetTokenInformation(token.0, TokenUser, null_mut(), 0, &raw mut bytes) };
		if queried == 0 {
			let code = last_error();
			if code != 122 { return Err(code); }
		}
		if bytes < size_of::<TOKEN_USER>() as u32 || bytes > 65_536 { return Err(87); }
		let mut buffer = vec![0_usize; (bytes as usize).div_ceil(size_of::<usize>())];
		// SAFETY: buffer is aligned for TOKEN_USER and holds the size returned by the token query.
		if unsafe { GetTokenInformation(token.0, TokenUser, buffer.as_mut_ptr().cast(), bytes, &raw mut bytes) } == 0 { return Err(last_error()); }
		// SAFETY: successful TokenUser output begins with a TOKEN_USER; its SID remains alive in buffer.
		let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() }.User.Sid;
		let mut string = null_mut();
		// SAFETY: user is the live token SID and string is a writable, initially null output.
		if unsafe { ConvertSidToStringSidW(user, &raw mut string) } == 0 { return Err(last_error()); }
		let allocation = LocalAllocation(string.cast());
		let mut length = 0;
		// SAFETY: the security API returns a terminated UTF-16 SID string in this owned allocation.
		unsafe { while *string.add(length) != 0 { length += 1; } }
		// SAFETY: the preceding scan established this slice inside the allocated terminated string.
		let result = String::from_utf16(unsafe { std::slice::from_raw_parts(string, length) }).map_err(|_| 87);
		drop(allocation);
		result
	}

	fn information(handle: HANDLE) -> Result<BY_HANDLE_FILE_INFORMATION, u32> {
		let mut info = BY_HANDLE_FILE_INFORMATION::default();
		// SAFETY: handle is open and info is a writable structure of the generated Windows type.
		if unsafe { GetFileInformationByHandle(handle, &raw mut info) } == 0 { return Err(last_error()); }
		Ok(info)
	}

	fn identity(info: &BY_HANDLE_FILE_INFORMATION) -> (u32, u32, u32) {
		(info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow)
	}

	fn security_parts(descriptor: PSECURITY_DESCRIPTOR) -> Result<(*mut c_void, *mut ACL), u32> {
		let mut owner = null_mut();
		let mut owner_defaulted = 0;
		let mut dacl = null_mut();
		let mut present = 0;
		let mut defaulted = 0;
		// SAFETY: descriptor is valid from a Windows security API; all outputs have the declared types.
		if unsafe { GetSecurityDescriptorOwner(descriptor, &raw mut owner, &raw mut owner_defaulted) } == 0 { return Err(last_error()); }
		// SAFETY: same valid descriptor and live output pointers.
		if unsafe { GetSecurityDescriptorDacl(descriptor, &raw mut present, &raw mut dacl, &raw mut defaulted) } == 0 { return Err(last_error()); }
		if owner.is_null() || present == 0 || dacl.is_null() { return Err(5); }
		Ok((owner, dacl))
	}

	fn verify_security(handle: HANDLE, expected: &Descriptor) -> Result<(), u32> {
		let mut actual = null_mut();
		// SAFETY: handle is live; only the descriptor output is requested and freed below.
		let code = unsafe { GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
			null_mut(), null_mut(), null_mut(), null_mut(), &raw mut actual) };
		if code != 0 { return Err(code); }
		let _allocation = LocalAllocation(actual);
		let mut control = 0;
		let mut revision = 0;
		// SAFETY: actual is the descriptor returned by GetSecurityInfo and the outputs are live.
		if unsafe { GetSecurityDescriptorControl(actual, &raw mut control, &raw mut revision) } == 0 { return Err(last_error()); }
		if control & PROTECTED == 0 { return Err(5); }
		let (owner, acl) = security_parts(actual)?;
		let (expected_owner, expected_acl) = security_parts(expected.pointer())?;
		// SAFETY: both SIDs and ACLs are inside live, API-validated descriptors.
		unsafe {
			if EqualSid(owner, expected_owner) == 0 || (*acl).AceCount != (*expected_acl).AceCount { return Err(5); }
			for index in 0..u32::from((*acl).AceCount) {
				let mut ace = null_mut();
				let mut expected_ace = null_mut();
				if GetAce(acl, index, &raw mut ace) == 0 { return Err(last_error()); }
				if GetAce(expected_acl, index, &raw mut expected_ace) == 0 { return Err(last_error()); }
				let size = usize::from((*ace.cast::<ACE_HEADER>()).AceSize);
				if size != usize::from((*expected_ace.cast::<ACE_HEADER>()).AceSize) ||
					std::slice::from_raw_parts(ace.cast::<u8>(), size) != std::slice::from_raw_parts(expected_ace.cast::<u8>(), size) { return Err(5); }
			}
		}
		Ok(())
	}

	impl Stage {
		pub fn reserve(directory: &str) -> Result<Self, WinFailure> {
			let fail = |operation, code| WinFailure { code, operation, path: directory.into() };
			let directory = PathBuf::from(directory);
			let name = wide(&directory).map_err(|code| fail("validate staging directory", code))?;
			let sid = current_sid().map_err(|code| fail("query staging owner", code))?;
			let directory_security = Descriptor::from_sddl(&format!("O:{sid}D:P(A;OICI;FA;;;{sid})(A;OICI;FA;;;SY)"))
				.map_err(|code| fail("build private directory security", code))?;
			let file_security = Descriptor::from_sddl(&format!("O:{sid}D:P(A;;FA;;;{sid})(A;;FA;;;SY)"))
				.map_err(|code| fail("build private file security", code))?;
			let attributes = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
				lpSecurityDescriptor: directory_security.pointer(), bInheritHandle: 0 };
			// SAFETY: the terminated path and explicit private descriptor stay alive through directory creation.
			if unsafe { CreateDirectoryW(name.as_ptr(), &raw const attributes) } == 0 { return Err(fail("reserve private staging directory", last_error())); }
			// No payload bytes exist yet. Any failure from here retains only a private/empty reservation.
			// SAFETY: path is valid; excluding FILE_SHARE_DELETE pins this directory until its owned handle closes.
			let handle = unsafe { CreateFileW(name.as_ptr(), DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES,
				FILE_SHARE_READ | FILE_SHARE_WRITE, null(), OPEN_EXISTING,
				FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) };
			if handle == INVALID_HANDLE_VALUE { return Err(fail("pin private staging directory", last_error())); }
			let handle = Handle(handle);
			let info = information(handle.0).map_err(|code| fail("inspect private staging directory", code))?;
			if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
				return Err(fail("reject non-directory/reparse staging reservation", 87));
			}
			let mut flags = 0;
			// SAFETY: this is the pinned directory handle; only the filesystem-flags output is requested.
			if unsafe { GetVolumeInformationByHandleW(handle.0, null_mut(), 0, null_mut(), null_mut(), &raw mut flags, null_mut(), 0) } == 0 {
				return Err(fail("verify persistent filesystem ACL support", last_error()));
			}
			if flags & FS_PERSISTENT_ACLS == 0 { return Err(fail("filesystem does not enforce persistent ACLs", 50)); }
			verify_security(handle.0, &directory_security).map_err(|code| fail("verify private staging directory security", code))?;
			let payload = directory.join(PAYLOAD);
			let payload_name = wide(&payload).map_err(|code| fail("validate staging payload path", code))?;
			let attributes = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
				lpSecurityDescriptor: file_security.pointer(), bInheritHandle: 0 };
			// SAFETY: CREATE_NEW exclusively creates an empty file with its private DACL before any writer receives it.
			let file = unsafe { CreateFileW(payload_name.as_ptr(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
				FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, &raw const attributes,
				CREATE_NEW, FILE_ATTRIBUTE_NORMAL, null_mut()) };
			if file == INVALID_HANDLE_VALUE { return Err(fail("reserve private staging payload", last_error())); }
			let file = Handle(file);
			verify_security(file.0, &file_security).map_err(|code| fail("verify private staging payload security", code))?;
			Ok(Self { backup: directory.join(BACKUP), directory, payload, handle: Some(handle), backup_handle: None, identity: identity(&info),
				directory_security, file_security, phase: Phase::Staging, recovery_code: 0, recovery_error: None })
		}

		pub fn payload_path(&self) -> String { self.payload.to_string_lossy().into_owned() }

		fn verify_directory(&self) -> Result<(), u32> {
			let owned = self.handle.as_ref().ok_or(5023_u32)?;
			let name = wide(&self.directory)?;
			// SAFETY: read-only reopen shares the original handle's DELETE access but requests no DELETE access itself.
			let reopened = unsafe { CreateFileW(name.as_ptr(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
				null(), OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) };
			if reopened == INVALID_HANDLE_VALUE { return Err(last_error()); }
			let reopened = Handle(reopened);
			let info = information(reopened.0)?;
			if identity(&info) != self.identity || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 { return Err(87); }
			verify_security(owned.0, &self.directory_security)
		}

		fn prepare_payload(&self) -> Result<(), u32> {
			let name = wide(&self.payload)?;
			// SAFETY: OPEN_REPARSE_POINT inspects the entry itself before any descriptor mutation.
			let file = unsafe { CreateFileW(name.as_ptr(), READ_CONTROL | WRITE_DAC | WRITE_OWNER | FILE_READ_ATTRIBUTES,
				FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, null(), OPEN_EXISTING,
				FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) };
			if file == INVALID_HANDLE_VALUE { return Err(last_error()); }
			let file = Handle(file);
			let info = information(file.0)?;
			if info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) != 0 || info.nNumberOfLinks != 1 || info.dwVolumeSerialNumber != self.identity.0 { return Err(87); }
			let (owner, dacl) = security_parts(self.file_security.pointer())?;
			// SAFETY: the file handle pins the regular entry; owner/DACL point into the live expected descriptor.
			let code = unsafe { SetSecurityInfo(file.0, SE_FILE_OBJECT,
				OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
				owner, null_mut(), dacl, null()) };
			if code != 0 { return Err(code); }
			verify_security(file.0, &self.file_security)
		}

		fn outcome(&self, code: u32, operation: &str) -> WindowsAtomicOutcome {
			let state = match self.phase { Phase::Staging => "unpublished", Phase::Published => "published", Phase::Recovery => "recovery-required", Phase::Closed => "closed" };
			let mut result = WindowsAtomicOutcome::new(state, code, operation);
			result.recovery_error_code = self.recovery_error;
			result
		}

		fn retain(&mut self, code: u32, operation: &str) -> WindowsAtomicOutcome {
			if self.phase != Phase::Published { self.phase = Phase::Recovery; }
			self.recovery_code = code;
			self.outcome(code, operation)
		}

		fn published(&mut self, has_backup: bool, operation: &str) -> WindowsAtomicOutcome {
			self.phase = Phase::Published;
			if has_backup {
				let name = match wide(&self.backup) { Ok(name) => name, Err(code) => return self.retain(code, "retain published original backup: invalid path") };
				// SAFETY: a successful ReplaceFileW created this original-file backup. Pin its exact object
				// before cleanup; a caller cannot swap a different file into its name while this handle lives.
				let file = unsafe { CreateFileW(name.as_ptr(), DELETE | FILE_READ_ATTRIBUTES,
					FILE_SHARE_READ | FILE_SHARE_WRITE, null(), OPEN_EXISTING,
					FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) };
				if file == INVALID_HANDLE_VALUE { return self.retain(last_error(), "replacement published; cannot pin original backup for cleanup"); }
				let file = Handle(file);
				let info = match information(file.0) { Ok(info) => info, Err(code) => return self.retain(code, "replacement published; cannot identify original backup") };
				if info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) != 0 || info.dwVolumeSerialNumber != self.identity.0 {
					return self.retain(87, "replacement published; unexpected original backup entry retained");
				}
				self.backup_handle = Some(file);
			}
			self.outcome(0, operation)
		}

		pub fn publish(&mut self, target: &str) -> WindowsAtomicOutcome {
			if self.phase != Phase::Staging { return self.outcome(5023, "stage is not available for publication"); }
			if let Err(code) = self.verify_directory() { return self.retain(code, "staging directory identity/security changed"); }
			match fs::symlink_metadata(&self.backup) {
				Ok(_) => return self.retain(183, "replacement backup collision"),
				Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
				Err(error) => return self.retain(error.raw_os_error().map_or(5, |code| code as u32), "cannot verify replacement backup absence"),
			}
			if let Err(code) = self.prepare_payload() { return self.outcome(code, "prepare private staging payload"); }
			let target = match wide(Path::new(target)) { Ok(value) => value, Err(code) => return self.outcome(code, "validate destination path") };
			let payload = match wide(&self.payload) { Ok(value) => value, Err(code) => return self.outcome(code, "validate payload path") };
			let backup = match wide(&self.backup) { Ok(value) => value, Err(code) => return self.outcome(code, "validate backup path") };
			// SAFETY: the terminated target is inspected without mutation; missing targets are handled below.
			let attributes = unsafe { GetFileAttributesW(target.as_ptr()) };
			if attributes != u32::MAX && attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) != 0 { return self.outcome(87, "reject non-regular destination"); }
			if attributes == u32::MAX {
				let code = last_error();
				if code != 2 && code != 3 { return self.outcome(code, "inspect destination"); }
			}
			// A panic/unknown outcome after this point must never enable cleanup of recovery candidates.
			self.phase = Phase::Recovery;
			// SAFETY: all paths are terminated; flags 0 preserve ACL/merge errors and supply a same-volume backup.
			if unsafe { ReplaceFileW(target.as_ptr(), payload.as_ptr(), backup.as_ptr(), 0, null(), null()) } != 0 {
				return self.published(true, "ReplaceFileW");
			}
			let mut code = last_error();
			if code == 2 || code == 3 {
				// SAFETY: flags 0 prohibit clobber and cross-volume copy for genuinely absent destinations.
				if unsafe { MoveFileExW(payload.as_ptr(), target.as_ptr(), 0) } != 0 {
					return self.published(false, "MoveFileExW");
				}
				code = last_error();
				if code == 80 || code == 183 {
					// SAFETY: one concurrent creator is handled with the same ACL-preserving primitive, never rename clobber.
					if unsafe { ReplaceFileW(target.as_ptr(), payload.as_ptr(), backup.as_ptr(), 0, null(), null()) } != 0 {
						return self.published(true, "ReplaceFileW after creation collision");
					}
					code = last_error();
				}
			}
			self.settle_failure(code, &target, &backup)
		}

		fn settle_failure(&mut self, code: u32, target: &[u16], backup: &[u16]) -> WindowsAtomicOutcome {
			if code == 1177 {
				// SAFETY: restore is non-clobbering; a new concurrent destination is never overwritten.
				if unsafe { MoveFileExW(backup.as_ptr(), target.as_ptr(), 0) } == 0 {
					self.recovery_error = Some(last_error());
					return self.retain(code, "ReplaceFileW partially moved the original; retain recovery directory");
				}
			}
			self.phase = Phase::Staging;
			self.outcome(code, "native publication failed without a committed replacement")
		}

		pub fn cleanup(&mut self) -> WindowsAtomicOutcome {
			if self.phase == Phase::Closed { return self.outcome(0, "stage already closed"); }
			if self.phase == Phase::Recovery { return self.outcome(self.recovery_code.max(1), "manual recovery required; cleanup refused"); }
			if self.phase == Phase::Published && self.recovery_code != 0 { return self.outcome(self.recovery_code, "replacement published; retain recovery directory"); }
			if let Err(code) = self.verify_directory() { return self.retain(code, "cannot prove staging directory ownership for cleanup"); }
			if self.backup_handle.is_none() {
				match fs::symlink_metadata(&self.backup) {
					Ok(_) => return self.retain(183, "unowned backup retained; cleanup refused"),
					Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
					Err(error) => return self.retain(error.raw_os_error().map_or(5, |code| code as u32), "cannot prove backup absence; cleanup refused"),
				}
			}
			let entries = match fs::read_dir(&self.directory) { Ok(entries) => entries, Err(error) => return self.outcome(error.raw_os_error().map_or(5, |code| code as u32), "enumerate owned staging directory") };
			for entry in entries {
				let entry = match entry { Ok(entry) => entry, Err(error) => return self.outcome(error.raw_os_error().map_or(5, |code| code as u32), "read owned staging entry") };
				if entry.path() == self.backup { continue; }
				if let Err(error) = remove_owned_entry(&entry.path()) { return self.outcome(error.raw_os_error().map_or(5, |code| code as u32), "remove owned staging entry"); }
			}
			if let Some(backup) = self.backup_handle.as_ref() {
				let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
				// SAFETY: this is the pinned original backup object, not whichever entry now occupies a path.
				if unsafe { SetFileInformationByHandle(backup.0, FileDispositionInfo,
					(&raw const disposition).cast(), size_of::<FILE_DISPOSITION_INFO>() as u32) } == 0 {
					return self.outcome(last_error(), "remove published original backup by handle");
				}
				self.backup_handle.take();
			}
			let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
			// SAFETY: DELETE access belongs to the still-open owned directory handle. Delete-pending removes this
			// exact object on close, avoiding a string-path deletion after releasing the no-share-delete pin.
			if unsafe { SetFileInformationByHandle(self.handle.as_ref().expect("verified open handle").0, FileDispositionInfo,
				(&raw const disposition).cast(), size_of::<FILE_DISPOSITION_INFO>() as u32) } == 0 {
				return self.outcome(last_error(), "remove empty owned staging directory by handle");
			}
			self.handle.take();
			self.phase = Phase::Closed;
			self.outcome(0, "owned staging directory removed")
		}
	}

	fn remove_owned_entry(path: &Path) -> std::io::Result<()> {
		use std::os::windows::fs::MetadataExt;
		let metadata = fs::symlink_metadata(path)?;
		if metadata.file_attributes() & FILE_ATTRIBUTE_DIRECTORY != 0 {
			if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 { fs::remove_dir(path) } else { fs::remove_dir_all(path) }
		} else {
			fs::remove_file(path)
		}
	}

	#[cfg(test)]
	mod tests {
		use super::*;
		use std::sync::atomic::{AtomicU64, Ordering};

		static NEXT: AtomicU64 = AtomicU64::new(0);

		struct Fixture {
			stage: Stage,
			root: PathBuf,
		}

		impl Fixture {
			fn new() -> Self {
				let serial = NEXT.fetch_add(1, Ordering::Relaxed);
				let root = std::env::temp_dir().join(format!("veyyon-private-stage-{}-{serial}", std::process::id()));
				fs::create_dir(&root).expect("exclusively create synthetic test root");
				let directory = root.join("stage-ä-雲");
				let stage = Stage::reserve(directory.to_str().expect("synthetic Unicode path")).unwrap_or_else(|error| {
					panic!("reserve synthetic stage: {} (Win32 {})", error.operation, error.code);
				});
				Self { stage, root }
			}
		}

		impl Drop for Fixture {
			fn drop(&mut self) {
				self.stage.backup_handle.take();
				self.stage.handle.take();
				// This fixture owns every byte below root, including intentionally retained recovery data.
				fs::remove_dir_all(&self.root).expect("remove synthetic test root after closing native handles");
			}
		}

		#[test]
		fn backup_collision_retains_original_payload_and_caller_backup() {
			let mut fixture = Fixture::new();
			let target = fixture.root.join("target");
			fs::write(&target, b"original").unwrap();
			fs::write(&fixture.stage.payload, b"replacement").unwrap();
			fs::write(&fixture.stage.backup, b"caller-owned").unwrap();
			let result = fixture.stage.publish(target.to_str().unwrap());
			assert_eq!(result.state, "recovery-required");
			assert_eq!(result.error_code, 183);
			assert_eq!(fixture.stage.cleanup().state, "recovery-required");
			assert_eq!(fs::read(&target).unwrap(), b"original");
			assert_eq!(fs::read(&fixture.stage.payload).unwrap(), b"replacement");
			assert_eq!(fs::read(&fixture.stage.backup).unwrap(), b"caller-owned");
		}

		#[test]
		fn partial_1177_state_restores_original_before_staging_cleanup() {
			let mut fixture = Fixture::new();
			let target = fixture.root.join("target");
			fs::write(&fixture.stage.backup, b"original").unwrap();
			fs::write(&fixture.stage.payload, b"replacement").unwrap();
			fixture.stage.phase = Phase::Recovery;
			let target_name = wide(&target).unwrap();
			let backup_name = wide(&fixture.stage.backup).unwrap();
			// Recreate the documented 1177 names; the restore itself calls the real non-clobbering Win32 API.
			let result = fixture.stage.settle_failure(1177, &target_name, &backup_name);
			assert_eq!(result.state, "unpublished");
			assert_eq!(result.error_code, 1177);
			assert_eq!(fs::read(&target).unwrap(), b"original");
			assert_eq!(fs::read(&fixture.stage.payload).unwrap(), b"replacement");
			assert_eq!(fixture.stage.cleanup().state, "closed");
			assert_eq!(fs::read(&target).unwrap(), b"original");
			assert!(!fixture.stage.directory.exists());
		}

		#[test]
		fn partial_1177_state_does_not_clobber_a_concurrent_destination() {
			let mut fixture = Fixture::new();
			let target = fixture.root.join("target");
			fs::write(&target, b"concurrent-writer").unwrap();
			fs::write(&fixture.stage.backup, b"original").unwrap();
			fs::write(&fixture.stage.payload, b"replacement").unwrap();
			fixture.stage.phase = Phase::Recovery;
			let target_name = wide(&target).unwrap();
			let backup_name = wide(&fixture.stage.backup).unwrap();
			let result = fixture.stage.settle_failure(1177, &target_name, &backup_name);
			assert_eq!(result.state, "recovery-required");
			assert_eq!(result.error_code, 1177);
			assert!(matches!(result.recovery_error_code, Some(80 | 183)));
			assert_eq!(fixture.stage.cleanup().state, "recovery-required");
			assert_eq!(fs::read(&target).unwrap(), b"concurrent-writer");
			assert_eq!(fs::read(&fixture.stage.backup).unwrap(), b"original");
			assert_eq!(fs::read(&fixture.stage.payload).unwrap(), b"replacement");
		}

		#[test]
		fn successful_replacement_pins_and_removes_only_its_original_backup() {
			let mut fixture = Fixture::new();
			let target = fixture.root.join("target");
			fs::write(&target, b"original").unwrap();
			fs::write(&fixture.stage.payload, b"replacement").unwrap();
			let result = fixture.stage.publish(target.to_str().unwrap());
			assert_eq!((result.state.as_str(), result.error_code), ("published", 0));
			assert_eq!(fs::read(&fixture.stage.backup).unwrap(), b"original");
			assert!(fs::rename(&fixture.stage.backup, fixture.root.join("swapped-backup")).is_err());
			assert_eq!(fixture.stage.cleanup().state, "closed");
			assert_eq!(fs::read(&target).unwrap(), b"replacement");
			assert!(!fixture.stage.directory.exists());
		}

		#[test]
		fn new_destination_never_deletes_an_unowned_late_backup() {
			let mut fixture = Fixture::new();
			let target = fixture.root.join("target");
			fs::write(&fixture.stage.payload, b"replacement").unwrap();
			let result = fixture.stage.publish(target.to_str().unwrap());
			assert_eq!((result.state.as_str(), result.error_code), ("published", 0));
			fs::write(&fixture.stage.backup, b"caller-owned").unwrap();
			let result = fixture.stage.cleanup();
			assert_eq!((result.state.as_str(), result.error_code), ("published", 183));
			assert_eq!(fs::read(&fixture.stage.backup).unwrap(), b"caller-owned");
			assert_eq!(fs::read(&target).unwrap(), b"replacement");
			assert_eq!(fixture.stage.publish(target.to_str().unwrap()).state, "published");
		}

		#[test]
		fn prepared_payload_rejects_a_hard_link_without_mutating_external_data() {
			let mut fixture = Fixture::new();
			let target = fixture.root.join("target");
			let outside = fixture.root.join("outside-stage");
			fs::write(&outside, b"external").unwrap();
			fs::remove_file(&fixture.stage.payload).unwrap();
			fs::hard_link(&outside, &fixture.stage.payload).unwrap();
			let result = fixture.stage.publish(target.to_str().unwrap());
			assert_eq!((result.state.as_str(), result.error_code), ("unpublished", 87));
			assert!(!target.exists());
			assert_eq!(fs::read(&outside).unwrap(), b"external");
			assert_eq!(fixture.stage.cleanup().state, "closed");
			assert_eq!(fs::read(&outside).unwrap(), b"external");
		}

		#[test]
		fn empty_stage_and_payload_already_have_protected_two_entry_dacls() {
			fn assert_private(handle: HANDLE) {
				let mut descriptor = null_mut();
				// SAFETY: GetSecurityInfo owns the returned allocation; this independent check reads its DACL.
				assert_eq!(unsafe { GetSecurityInfo(handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
					null_mut(), null_mut(), null_mut(), null_mut(), &raw mut descriptor) }, 0);
				let descriptor = LocalAllocation(descriptor);
				let mut control = 0;
				let mut revision = 0;
				// SAFETY: the live descriptor and writable control outputs satisfy the Win32 contract.
				assert_ne!(unsafe { GetSecurityDescriptorControl(descriptor.0, &raw mut control, &raw mut revision) }, 0);
				assert_ne!(control & 0x1000, 0, "DACL protection must precede every producer byte");
				let mut present = 0;
				let mut defaulted = 0;
				let mut dacl = null_mut();
				// SAFETY: the ACL points inside the live descriptor allocation.
				assert_ne!(unsafe { GetSecurityDescriptorDacl(descriptor.0, &raw mut present, &raw mut dacl, &raw mut defaulted) }, 0);
				assert_ne!(present, 0);
				assert!(!dacl.is_null());
				// SAFETY: GetSecurityDescriptorDacl returned a non-null ACL from a valid descriptor.
				assert_eq!(unsafe { (*dacl).AceCount }, 2);
			}
			let fixture = Fixture::new();
			assert_private(fixture.stage.handle.as_ref().unwrap().0);
			let name = wide(&fixture.stage.payload).unwrap();
			// SAFETY: open only this fixture's reserved empty payload for security inspection.
			let payload = unsafe { CreateFileW(name.as_ptr(), READ_CONTROL,
				FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, null(), OPEN_EXISTING,
				FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) };
			assert_ne!(payload, INVALID_HANDLE_VALUE);
			let payload = Handle(payload);
			assert_private(payload.0);
			assert_eq!(fs::read(&fixture.stage.payload).unwrap(), b"");
		}

		#[test]
		fn postcommit_backup_pin_failure_reports_published_and_retains_original() {
			let mut fixture = Fixture::new();
			let target = fixture.root.join("target");
			fs::write(&target, b"original").unwrap();
			fs::write(&fixture.stage.payload, b"replacement").unwrap();
			let name = wide(&target).unwrap();
			// SAFETY: DELETE plus share-all permits ReplaceFileW, but forbids a later no-share-delete pin.
			let held = unsafe { CreateFileW(name.as_ptr(), DELETE,
				FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, null(), OPEN_EXISTING,
				FILE_ATTRIBUTE_NORMAL, null_mut()) };
			assert_ne!(held, INVALID_HANDLE_VALUE);
			let held = Handle(held);
			let result = fixture.stage.publish(target.to_str().unwrap());
			assert_eq!((result.state.as_str(), result.error_code), ("published", 32));
			assert_eq!(fs::read(&target).unwrap(), b"replacement");
			assert_eq!(fs::read(&fixture.stage.backup).unwrap(), b"original");
			drop(held);
			let result = fixture.stage.cleanup();
			assert_eq!((result.state.as_str(), result.error_code), ("published", 32));
			assert_eq!(fs::read(&fixture.stage.backup).unwrap(), b"original");
		}

		#[test]
		fn cleanup_security_failure_cannot_turn_a_committed_write_into_unpublished() {
			let mut fixture = Fixture::new();
			let target = fixture.root.join("target");
			fs::write(&fixture.stage.payload, b"replacement").unwrap();
			assert_eq!(fixture.stage.publish(target.to_str().unwrap()).error_code, 0);
			let sid = current_sid().unwrap();
			let descriptor = Descriptor::from_sddl(&format!("O:{sid}D:P(A;OICI;FA;;;{sid})")).unwrap();
			let (_, dacl) = security_parts(descriptor.pointer()).unwrap();
			let name = wide(&fixture.stage.directory).unwrap();
			// SAFETY: this fixture owns the directory; remove only SYSTEM's ACE while retaining the test user's full access.
			let security = unsafe { CreateFileW(name.as_ptr(), WRITE_DAC,
				FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, null(), OPEN_EXISTING,
				FILE_FLAG_BACKUP_SEMANTICS, null_mut()) };
			assert_ne!(security, INVALID_HANDLE_VALUE);
			let security = Handle(security);
			// SAFETY: the live descriptor provides the replacement DACL for this synthetic directory.
			assert_eq!(unsafe { SetSecurityInfo(security.0, SE_FILE_OBJECT,
				DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
				null_mut(), null_mut(), dacl, null()) }, 0);
			drop(security);
			let result = fixture.stage.cleanup();
			assert_eq!(result.state, "published");
			assert_ne!(result.error_code, 0);
			assert_eq!(fs::read(&target).unwrap(), b"replacement");
			assert!(fixture.stage.directory.exists());
		}
	}
}
