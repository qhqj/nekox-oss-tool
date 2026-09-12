//! The webview never chooses a path. Only DPAPI ciphertext reaches disk.
//! This vault belongs to the signed-in Windows user, not the whole machine.

use serde::Deserialize;
use std::collections::HashSet;

const MAX_VAULT_BYTES: usize = 1024 * 1024;
const MAX_ACCOUNTS: usize = 100;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Vault {
    version: u32,
    active_account_id: String,
    accounts: Vec<Account>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Account {
    id: String,
    name: String,
    notes: String,
    config: Config,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    region: String,
    bucket: String,
    access_key_id: String,
    access_key_secret: String,
    sts_token: String,
    endpoint: String,
    public_base_url: String,
}

fn validate(data: &str) -> Result<(), String> {
    if data.is_empty() || data.len() > MAX_VAULT_BYTES {
        return Err("账号库为空或超过 1 MiB 限制。".into());
    }
    // Never return serde errors: their diagnostic text can include input data.
    let vault: Vault = serde_json::from_str(data).map_err(|_| "账号库格式不正确。")?;
    if vault.version != 1 || vault.accounts.len() > MAX_ACCOUNTS {
        return Err("账号库版本不受支持或账号超过 100 个。".into());
    }
    let mut ids = HashSet::new();
    for account in &vault.accounts {
        if account.id.is_empty()
            || account.id.len() > 128
            || account.name.trim().is_empty()
            || account.name.len() > 400
            || account.notes.len() > 8000
            || !ids.insert(account.id.as_str())
        {
            return Err("账号名称、备注或标识不符合要求。".into());
        }
        let config = &account.config;
        if [
            &config.region,
            &config.bucket,
            &config.access_key_id,
            &config.access_key_secret,
            &config.sts_token,
            &config.endpoint,
            &config.public_base_url,
        ]
        .iter()
        .any(|field| field.len() > 16 * 1024)
        {
            return Err("账号配置字段过长。".into());
        }
    }
    if !vault.active_account_id.is_empty() && !ids.contains(vault.active_account_id.as_str()) {
        return Err("当前账号不存在于账号库中。".into());
    }
    Ok(())
}

#[tauri::command]
pub fn load_account_vault(app: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        use tauri::Manager;
        let directory = app
            .path()
            .app_local_data_dir()
            .map_err(|_| "无法定位账号库目录。")?;
        windows::load(&directory)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("本机凭证加密存储目前仅支持 Windows；请使用会话模式。".into())
    }
}

#[tauri::command]
pub fn save_account_vault(app: tauri::AppHandle, data: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use tauri::Manager;
        let directory = app
            .path()
            .app_local_data_dir()
            .map_err(|_| "无法定位账号库目录。")?;
        windows::save(&directory, &data)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, data);
        Err("本机凭证加密存储目前仅支持 Windows；请使用会话模式。".into())
    }
}

#[cfg(windows)]
mod windows {
    use super::{validate, MAX_VAULT_BYTES};
    use std::{
        ffi::c_void,
        fs::{self, File, OpenOptions},
        io::{Read, Write},
        os::windows::ffi::OsStrExt,
        path::Path,
        ptr,
        sync::{
            atomic::{AtomicU64, Ordering},
            Mutex,
        },
    };

    const VAULT_FILE: &str = "accounts-v1.dpapi";
    const MAGIC: &[u8] = b"NEKOXVAULT\x01\0";
    const ENTROPY: &[u8] = b"com.nekox.oss-tool/account-vault/v1";
    const MAX_CIPHERTEXT_BYTES: usize = MAX_VAULT_BYTES + 64 * 1024;
    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 1;
    const MOVEFILE_REPLACE_EXISTING: u32 = 1;
    const MOVEFILE_WRITE_THROUGH: u32 = 8;
    static VAULT_LOCK: Mutex<()> = Mutex::new(());
    static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    #[repr(C)]
    struct DataBlob {
        len: u32,
        data: *mut u8,
    }

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            input: *const DataBlob,
            description: *const u16,
            entropy: *const DataBlob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            output: *mut DataBlob,
        ) -> i32;
        fn CryptUnprotectData(
            input: *const DataBlob,
            description: *mut *mut u16,
            entropy: *const DataBlob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            output: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }

    impl Drop for DataBlob {
        fn drop(&mut self) {
            if !self.data.is_null() {
                // Wipe the OS-allocated plaintext before releasing it. Volatile
                // writes cannot be removed as dead stores by the optimizer.
                unsafe {
                    for index in 0..self.len as usize {
                        ptr::write_volatile(self.data.add(index), 0);
                    }
                    LocalFree(self.data.cast());
                }
            }
        }
    }

    fn crypt(input: &[u8], protect: bool) -> Result<Vec<u8>, String> {
        if input.is_empty() || input.len() > MAX_CIPHERTEXT_BYTES {
            return Err("账号库数据长度无效。".into());
        }
        // These input blobs borrow memory and must not run DataBlob::drop.
        let source = std::mem::ManuallyDrop::new(DataBlob {
            len: input.len() as u32,
            data: input.as_ptr().cast_mut(),
        });
        let entropy = std::mem::ManuallyDrop::new(DataBlob {
            len: ENTROPY.len() as u32,
            data: ENTROPY.as_ptr().cast_mut(),
        });
        let mut output = DataBlob {
            len: 0,
            data: ptr::null_mut(),
        };
        // No LOCAL_MACHINE flag: DPAPI is scoped to the current Windows user.
        let result = unsafe {
            if protect {
                CryptProtectData(
                    &*source,
                    ptr::null(),
                    &*entropy,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            } else {
                CryptUnprotectData(
                    &*source,
                    ptr::null_mut(),
                    &*entropy,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            }
        };
        if result == 0 {
            return Err(if protect {
                "Windows 无法加密账号库。"
            } else {
                "无法解密账号库：文件可能损坏，或不属于当前 Windows 用户。"
            }
            .into());
        }
        if output.data.is_null() || output.len as usize > MAX_CIPHERTEXT_BYTES {
            return Err("Windows 返回了无效的账号库数据。".into());
        }
        // `output` is owned by DPAPI until copied; Drop securely frees its buffer.
        Ok(unsafe { std::slice::from_raw_parts(output.data, output.len as usize) }.to_vec())
    }

    fn encode(data: &str) -> Result<Vec<u8>, String> {
        validate(data)?;
        let ciphertext = crypt(data.as_bytes(), true)?;
        let mut output = Vec::with_capacity(MAGIC.len() + ciphertext.len());
        output.extend_from_slice(MAGIC);
        output.extend_from_slice(&ciphertext);
        Ok(output)
    }

    fn decode(ciphertext: &[u8]) -> Result<String, String> {
        let payload = ciphertext
            .strip_prefix(MAGIC)
            .ok_or("账号库文件格式无效。")?;
        let plaintext = crypt(payload, false)?;
        let data = String::from_utf8(plaintext).map_err(|_| "账号库内容无效。")?;
        validate(&data)?;
        Ok(data)
    }

    pub(super) fn load(directory: &Path) -> Result<Option<String>, String> {
        let _guard = VAULT_LOCK
            .lock()
            .map_err(|_| "账号库暂时不可用，请重启应用。")?;
        let file = match File::open(directory.join(VAULT_FILE)) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("无法读取账号库。".into()),
        };
        let mut ciphertext = Vec::new();
        file.take((MAX_CIPHERTEXT_BYTES + MAGIC.len() + 1) as u64)
            .read_to_end(&mut ciphertext)
            .map_err(|_| "无法读取账号库。")?;
        if ciphertext.len() > MAX_CIPHERTEXT_BYTES + MAGIC.len() {
            return Err("账号库文件过大。".into());
        }
        decode(&ciphertext).map(Some)
    }

    pub(super) fn save(directory: &Path, data: &str) -> Result<(), String> {
        let ciphertext = encode(data)?;
        let _guard = VAULT_LOCK
            .lock()
            .map_err(|_| "账号库暂时不可用，请重启应用。")?;
        fs::create_dir_all(directory).map_err(|_| "无法创建账号库目录。")?;
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "系统时间不可用。")?
            .as_nanos();
        let temporary = directory.join(format!(
            "accounts-{}-{unique}-{sequence}.tmp",
            std::process::id()
        ));
        // The temporary file is ciphertext too. Keep the old vault untouched
        // until the complete new file is flushed, then atomically replace it.
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "无法创建加密账号库临时文件。")?;
        let result = (|| {
            file.write_all(&ciphertext)
                .map_err(|_| "无法写入加密账号库。")?;
            file.sync_all().map_err(|_| "无法保存加密账号库。")?;
            drop(file);
            let source: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
            let destination: Vec<u16> = directory
                .join(VAULT_FILE)
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect();
            if unsafe {
                MoveFileExW(
                    source.as_ptr(),
                    destination.as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            } == 0
            {
                return Err("无法替换加密账号库；原账号库仍保留。".into());
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn dpapi_round_trip_is_encrypted_and_corruption_is_rejected() {
            let data = super::super::tests::sample();
            let encrypted = encode(&data).unwrap();
            assert!(!encrypted
                .windows(b"synthetic-secret".len())
                .any(|v| v == b"synthetic-secret"));
            assert_eq!(decode(&encrypted).unwrap(), data);
            let mut corrupted = encrypted.clone();
            let last = corrupted.len() - 1;
            corrupted[last] ^= 0xff;
            assert!(decode(&corrupted).is_err());
            assert!(decode(b"not an encrypted vault").is_err());
            assert!(decode(&encrypted[..encrypted.len() / 2]).is_err());
        }

        #[test]
        fn save_replaces_existing_file_and_invalid_save_keeps_previous_vault() {
            let directory = std::env::temp_dir().join(format!(
                "nekox-vault-test-{}-{}",
                std::process::id(),
                TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            assert_eq!(load(&directory).unwrap(), None);
            let data = super::super::tests::sample();
            save(&directory, &data).unwrap();
            assert_eq!(load(&directory).unwrap(), Some(data));
            let empty = r#"{"version":1,"activeAccountId":"","accounts":[]}"#;
            save(&directory, empty).unwrap();
            assert_eq!(load(&directory).unwrap(), Some(empty.into()));
            assert!(save(&directory, "invalid").is_err());
            assert_eq!(load(&directory).unwrap(), Some(empty.into()));
            assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
            fs::remove_file(directory.join(VAULT_FILE)).unwrap();
            fs::remove_dir(directory).unwrap();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn sample() -> String {
        serde_json::json!({
            "version": 1, "activeAccountId": "test", "accounts": [{
                "id": "test", "name": "Synthetic test", "notes": "local test only",
                "config": { "region": "oss-cn-test", "bucket": "test-bucket", "accessKeyId": "test-id",
                    "accessKeySecret": "synthetic-secret", "stsToken": "", "endpoint": "", "publicBaseUrl": "" }
            }]
        }).to_string()
    }

    #[test]
    fn rejects_invalid_version_shape_duplicate_ids_and_oversized_data() {
        assert!(validate(&sample()).is_ok());
        assert!(validate(&sample().replace("\"version\":1", "\"version\":2")).is_err());
        assert!(validate(r#"{"version":1,"activeAccountId":"","accounts":[{}]}"#).is_err());
        let mut value: serde_json::Value = serde_json::from_str(&sample()).unwrap();
        let duplicate = value["accounts"][0].clone();
        value["accounts"].as_array_mut().unwrap().push(duplicate);
        assert!(validate(&value.to_string()).is_err());
        assert!(validate(&"x".repeat(MAX_VAULT_BYTES + 1)).is_err());
        assert!(validate(&sample().replace(
            "\"activeAccountId\":\"test\"",
            "\"activeAccountId\":\"missing\""
        ))
        .is_err());
    }
}
