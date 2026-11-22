use base64::{engine::general_purpose::STANDARD, Engine as _};
use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
};

fn blob_from_bytes(bytes: &mut [u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_mut_ptr(),
    }
}

unsafe fn copy_and_free(blob: CRYPT_INTEGER_BLOB) -> Result<Vec<u8>, String> {
    let slice = std::slice::from_raw_parts(blob.pbData, blob.cbData as usize);
    let value = slice.to_vec();
    if !blob.pbData.is_null() {
        let result = LocalFree(Some(HLOCAL(blob.pbData.cast())));
        if !result.is_invalid() {
            return Err("Windows DPAPI returned memory that could not be released.".into());
        }
    }
    Ok(value)
}

pub fn protect_string(value: &str) -> Result<String, String> {
    if value.is_empty() || value.len() > 4096 || value.contains(['\r', '\n', '\0']) {
        return Err("Secret value is invalid.".into());
    }
    let mut input = value.as_bytes().to_vec();
    let input_blob = blob_from_bytes(&mut input);
    let mut output_blob = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input_blob,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output_blob,
        )
        .map_err(|error| format!("Windows DPAPI protect failed: {error}"))?;
        let encrypted = copy_and_free(output_blob)?;
        Ok(STANDARD.encode(encrypted))
    }
}

pub fn unprotect_string(encoded: &str) -> Result<String, String> {
    if encoded.is_empty() || encoded.len() > 16384 {
        return Err("Protected secret ciphertext is invalid.".into());
    }
    let mut encrypted = STANDARD
        .decode(encoded)
        .map_err(|_| "Protected secret ciphertext is not valid base64.".to_string())?;
    let input_blob = blob_from_bytes(&mut encrypted);
    let mut output_blob = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input_blob,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output_blob,
        )
        .map_err(|error| format!("Windows DPAPI restore failed: {error}"))?;
        let plaintext = copy_and_free(output_blob)?;
        let value = String::from_utf8(plaintext)
            .map_err(|_| "Windows DPAPI restored non-UTF-8 secret data.".to_string())?;
        if value.len() < 16 || value.len() > 4096 || value.contains(['\r', '\n', '\0']) {
            return Err("Windows DPAPI restored an invalid runtime key.".into());
        }
        Ok(value)
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::{protect_string, unprotect_string};

    #[test]
    fn short_gemini_subject_envelope_roundtrips_with_exact_value() {
        let payload = serde_json::json!({
            "schemaVersion": "scr.gemini-protected-value/v1",
            "purpose": "ownerSubject",
            "value": " user-1 "
        })
        .to_string();

        let encrypted = protect_string(&payload).expect("protect test envelope");
        let restored = unprotect_string(&encrypted).expect("restore test envelope");
        assert_eq!(restored, payload);
        let envelope: serde_json::Value =
            serde_json::from_str(&restored).expect("parse test envelope");
        assert_eq!(envelope["schemaVersion"], "scr.gemini-protected-value/v1");
        assert_eq!(envelope["purpose"], "ownerSubject");
        assert_eq!(envelope["value"], " user-1 ");
    }

    #[test]
    fn short_plain_runtime_key_remains_rejected_after_decryption() {
        let encrypted = protect_string("short").expect("protect short test value");
        assert_eq!(
            unprotect_string(&encrypted),
            Err("Windows DPAPI restored an invalid runtime key.".to_string())
        );
    }
}
