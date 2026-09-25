#[cfg(windows)]
use std::{ffi::c_void, mem::size_of};

#[cfg(windows)]
use windows::Win32::{
    Foundation::{CloseHandle, HANDLE},
    Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY},
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

#[cfg(windows)]
struct OwnedHandle(HANDLE);

#[cfg(windows)]
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
pub fn is_process_elevated() -> Result<bool, String> {
    unsafe {
        let mut raw_token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw_token)
            .map_err(|error| format!("Could not open the current Windows process token: {error}"))?;
        let token = OwnedHandle(raw_token);
        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned_bytes = 0_u32;
        GetTokenInformation(
            token.0,
            TokenElevation,
            Some((&mut elevation as *mut TOKEN_ELEVATION).cast::<c_void>()),
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned_bytes,
        )
        .map_err(|error| format!("Could not read the current Windows token elevation: {error}"))?;
        if returned_bytes < size_of::<TOKEN_ELEVATION>() as u32 {
            return Err("Windows returned an incomplete token-elevation record.".into());
        }
        Ok(elevation.TokenIsElevated != 0)
    }
}

#[cfg(not(windows))]
pub fn is_process_elevated() -> Result<bool, String> {
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::is_process_elevated;

    #[test]
    fn current_process_elevation_can_be_queried() {
        assert!(is_process_elevated().is_ok());
    }
}
