//! Windows-only sink. Paths come from the native save dialog, never from IPC.
//! Cleanup and non-replacing rename operate on our exclusive file handle.

use std::{
    collections::HashMap,
    ffi::c_void,
    fs::{self, File, OpenOptions},
    io::Write,
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle},
    path::{Path, PathBuf},
    sync::{atomic::{AtomicU64, Ordering}, Mutex},
};

pub const CHUNK_BYTES: usize = 128 * 1024;
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[link(name = "kernel32")]
extern "system" {
    fn SetFileInformationByHandle(handle: *mut c_void, class: i32, data: *const c_void, size: u32) -> i32;
}

#[repr(C)]
struct RenameInfo {
    flags: u32,
    root_directory: *mut c_void,
    file_name_length: u32,
    file_name: [u16; 1],
}

pub fn valid_filename(name: &str) -> bool {
    if name.is_empty() || name == "." || name == ".." || name.ends_with(['.', ' '])
        || name.encode_utf16().count() > 255
        || name.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c)) {
        return false;
    }
    let stem = name.split('.').next().unwrap_or("").to_uppercase();
    if ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str()) { return false; }
    !((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.chars().count() == 4
        && stem.chars().last().is_some_and(|c| "123456789¹²³".contains(c)))
}

pub struct FileSink {
    file: File,
    _directories: Vec<File>,
    target: PathBuf,
    committed: bool,
}

impl FileSink {
    pub fn create(selected: &Path) -> Result<Self, String> {
        let name = selected.file_name().and_then(|name| name.to_str()).ok_or("保存文件名无效。")?;
        if !selected.is_absolute() || !valid_filename(name) { return Err("请选择有效的新文件保存位置。".into()); }
        let parent = fs::canonicalize(selected.parent().ok_or("保存目录无效。")?)
            .map_err(|_| "无法打开保存目录，请检查目录是否存在及写入权限。")?;
        if !parent.is_dir() { return Err("保存目录无效。".into()); }
        // Lock directory names along the canonical path without delete sharing.
        // Request no data/attribute access, only keep names stable. This keeps the absolute
        // rename destination stable for the transfer, including ancestor moves.
        let mut directories = Vec::new();
        for ancestor in parent.ancestors() {
            directories.push(OpenOptions::new().access_mode(0).share_mode(3)
                .custom_flags(0x0200_0000).open(ancestor) // FILE_FLAG_BACKUP_SEMANTICS
                .map_err(|_| "无法锁定保存目录，请选择其他位置。")?);
        }
        let target = parent.join(name);
        match fs::symlink_metadata(&target) {
            Ok(_) => return Err("目标文件已存在，请选择新的文件名；下载不会覆盖本地文件。".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(_) => return Err("无法检查目标文件，请选择其他保存位置。".into()),
        }
        for _ in 0..32 {
            let unique = SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let temporary = parent.join(format!(".nekox-download-{}-{unique}.part", std::process::id()));
            let file = match OpenOptions::new().write(true).create_new(true)
                // GENERIC_WRITE | DELETE. No sharing: only our handle can alter this file.
                .access_mode(0x4000_0000 | 0x0001_0000).share_mode(0).open(&temporary) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return Err("无法创建下载临时文件，请检查保存目录权限。".into()),
            };
            let sink = Self { file, _directories: directories, target, committed: false };
            // Unlike FILE_FLAG_DELETE_ON_CLOSE this disposition can be cleared for commit.
            sink.delete_on_close(true)?;
            return Ok(sink);
        }
        Err("无法创建独占下载临时文件，请稍后重试。".into())
    }

    fn delete_on_close(&self, delete: bool) -> Result<(), String> {
        let disposition = u8::from(delete); // FILE_DISPOSITION_INFO uses a BOOLEAN.
        let result = unsafe { SetFileInformationByHandle(self.file.as_raw_handle(), 4,
            (&disposition as *const u8).cast(), 1) };
        if result == 0 { Err("无法设置下载临时文件清理状态。".into()) } else { Ok(()) }
    }

    fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        if bytes.is_empty() || bytes.len() > CHUNK_BYTES { return Err("下载分块大小无效。".into()); }
        self.file.write_all(bytes).map_err(|_| "写入下载文件失败，请检查可用磁盘空间及保存目录权限。".into())
    }

    fn finish(mut self) -> Result<String, String> {
        self.file.sync_all().map_err(|_| "无法完成下载文件写入，请检查磁盘空间。")?;
        let name: Vec<u16> = self.target.as_os_str().encode_wide().collect();
        let offset = std::mem::offset_of!(RenameInfo, file_name);
        let size = offset + (name.len() + 1) * 2;
        // usize storage gives the native struct pointer its required alignment.
        let mut buffer = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
        let info = buffer.as_mut_ptr().cast::<RenameInfo>();
        unsafe {
            // Zero flags means ReplaceIfExists = FALSE; a raced destination must survive.
            (*info).flags = 0;
            (*info).root_directory = std::ptr::null_mut();
            (*info).file_name_length = (name.len() * 2) as u32;
            std::ptr::copy_nonoverlapping(name.as_ptr(), buffer.as_mut_ptr().cast::<u8>().add(offset).cast(), name.len());
        }
        self.delete_on_close(false)?;
        let result = unsafe { SetFileInformationByHandle(self.file.as_raw_handle(), 3, info.cast(), size as u32) };
        if result == 0 { return Err("无法完成保存：目标可能已存在或目录不可写。已有文件未覆盖。".into()); }
        self.committed = true;
        Ok(self.target.to_string_lossy().into_owned())
    }

    fn cancel(self) -> Result<(), String> { self.delete_on_close(true) }
}

impl Drop for FileSink {
    fn drop(&mut self) {
        if !self.committed { let _ = self.delete_on_close(true); }
        // Closing the owned handle deletes only our pending temporary file.
        // Never remove_file(target), enumerate old parts, or delete an IPC-supplied path.
    }
}

struct Download { id: String, sink: Option<FileSink> }

#[derive(Default)]
pub struct Downloads { slots: Mutex<HashMap<String, Download>> }

impl Downloads {
    pub fn reserve(&self, owner: &str) -> Result<String, String> {
        let mut slots = self.slots.lock().map_err(|_| "下载状态不可用，请重启应用。")?;
        if slots.contains_key(owner) { return Err("已有下载正在准备或传输，请先完成或取消。".into()); }
        let id = format!("{}-{}", std::process::id(), SEQUENCE.fetch_add(1, Ordering::Relaxed));
        slots.insert(owner.into(), Download { id: id.clone(), sink: None });
        Ok(id)
    }

    pub fn attach(&self, owner: &str, id: &str, sink: FileSink) -> Result<(), String> {
        let mut slots = self.slots.lock().map_err(|_| "下载状态不可用。")?;
        let slot = slots.get_mut(owner).filter(|slot| slot.id == id && slot.sink.is_none())
            .ok_or("下载已取消。")?;
        slot.sink = Some(sink);
        Ok(())
    }

    pub fn write(&self, owner: &str, id: &str, bytes: &[u8]) -> Result<(), String> {
        let mut slots = self.slots.lock().map_err(|_| "下载状态不可用。")?;
        slots.get_mut(owner).filter(|slot| slot.id == id).and_then(|slot| slot.sink.as_mut())
            .ok_or("下载任务无效或已取消。")?.write(bytes)
    }

    pub fn finish(&self, owner: &str, id: &str) -> Result<String, String> {
        let download = {
            let mut slots = self.slots.lock().map_err(|_| "下载状态不可用。")?;
            if !slots.get(owner).is_some_and(|slot| slot.id == id && slot.sink.is_some()) {
                return Err("下载任务无效或未准备好。".into());
            }
            slots.remove(owner).ok_or("下载任务无效。")?
        };
        download.sink.ok_or("下载任务未准备好。")?.finish()
    }

    pub fn cancel(&self, owner: &str, id: &str) -> Result<(), String> {
        let mut slots = self.slots.lock().map_err(|_| "下载状态不可用。")?;
        if slots.get(owner).is_some_and(|slot| slot.id == id) {
            if let Some(sink) = slots.remove(owner).and_then(|slot| slot.sink) { sink.cancel()?; }
        }
        Ok(())
    }

    pub fn cancel_owner(&self, owner: &str) {
        if let Ok(mut slots) = self.slots.lock() { slots.remove(owner); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("nekox-download-test-{}-{}", std::process::id(), SEQUENCE.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir(&path).unwrap(); Self(path)
        }
        fn files(&self) -> usize { fs::read_dir(&self.0).unwrap().count() }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            // These tests create only flat, synthetic files in their unique temp directory.
            for entry in fs::read_dir(&self.0).unwrap() { fs::remove_file(entry.unwrap().path()).unwrap(); }
            fs::remove_dir(&self.0).unwrap();
        }
    }

    #[test]
    fn writes_multiple_chunks_and_commits_without_leaving_parts() {
        let directory = TestDirectory::new(); let target = directory.0.join("合成数据.bin");
        let mut sink = FileSink::create(&target).unwrap();
        sink.write(&vec![42; CHUNK_BYTES]).unwrap(); sink.write(b"end").unwrap();
        assert!(!target.exists()); sink.finish().unwrap();
        let bytes = fs::read(&target).unwrap(); assert_eq!(bytes.len(), CHUNK_BYTES + 3);
        assert_eq!(&bytes[CHUNK_BYTES..], b"end"); assert_eq!(directory.files(), 1);
    }

    #[test]
    fn existing_file_and_raced_destination_are_never_overwritten() {
        let directory = TestDirectory::new(); let target = directory.0.join("existing.bin");
        fs::write(&target, b"original").unwrap(); assert!(FileSink::create(&target).is_err());
        fs::remove_file(&target).unwrap(); let mut sink = FileSink::create(&target).unwrap();
        sink.write(b"download").unwrap(); fs::write(&target, b"raced").unwrap();
        assert!(sink.finish().is_err()); assert_eq!(fs::read(&target).unwrap(), b"raced");
        assert_eq!(directory.files(), 1);
    }

    #[test]
    fn cancellation_only_removes_its_own_file() {
        let directory = TestDirectory::new(); let unrelated = directory.0.join(".nekox-download-other.part");
        fs::write(&unrelated, b"unrelated").unwrap();
        let mut sink = FileSink::create(&directory.0.join("cancelled.bin")).unwrap();
        sink.write(b"partial").unwrap(); drop(sink);
        assert_eq!(directory.files(), 1); assert_eq!(fs::read(unrelated).unwrap(), b"unrelated");
    }

    #[test]
    fn invalid_names_paths_and_chunk_sizes_are_rejected() {
        for name in ["", ".", "..", "CON.txt", "lpt¹.bin", "a/b", "a\\b", "a:b", "a.", "a ", "a\n"] { assert!(!valid_filename(name), "{name:?}"); }
        assert!(valid_filename("合成 文件.txt")); assert!(!valid_filename(&"a".repeat(256)));
        assert!(FileSink::create(Path::new("relative.bin")).is_err());
        let directory = TestDirectory::new(); let mut sink = FileSink::create(&directory.0.join("valid.bin")).unwrap();
        assert!(sink.write(&[]).is_err()); assert!(sink.write(&vec![0; CHUNK_BYTES + 1]).is_err());
        drop(sink); assert_eq!(directory.files(), 0);
    }

    #[test]
    fn stale_or_other_window_ids_cannot_touch_another_download() {
        let directory = TestDirectory::new(); let downloads = Downloads::default();
        let id = downloads.reserve("main").unwrap(); assert!(downloads.reserve("main").is_err());
        downloads.attach("main", &id, FileSink::create(&directory.0.join("owned.bin")).unwrap()).unwrap();
        assert!(downloads.write("other", &id, b"bad").is_err());
        assert!(downloads.finish("other", &id).is_err()); downloads.cancel("other", &id).unwrap();
        downloads.cancel("main", "stale").unwrap(); downloads.write("main", &id, b"owned").unwrap();
        downloads.finish("main", &id).unwrap(); assert_eq!(fs::read(directory.0.join("owned.bin")).unwrap(), b"owned");
        let next = downloads.reserve("main").unwrap(); downloads.cancel("main", &id).unwrap();
        assert!(downloads.reserve("main").is_err()); downloads.cancel("main", &next).unwrap();
    }

    #[test]
    fn window_destruction_cleans_attached_and_pending_tasks() {
        let directory = TestDirectory::new(); let downloads = Downloads::default();
        let pending = downloads.reserve("main").unwrap(); downloads.cancel_owner("main");
        assert!(downloads.attach("main", &pending, FileSink::create(&directory.0.join("late.bin")).unwrap()).is_err());
        assert_eq!(directory.files(), 0);
        let id = downloads.reserve("main").unwrap();
        downloads.attach("main", &id, FileSink::create(&directory.0.join("closed.bin")).unwrap()).unwrap();
        downloads.cancel_owner("main"); assert_eq!(directory.files(), 0);
    }

    #[test]
    fn chosen_directory_cannot_be_moved_during_transfer() {
        let directory = TestDirectory::new();
        let parent = directory.0.join("parent"); let child = parent.join("child");
        fs::create_dir(&parent).unwrap(); fs::create_dir(&child).unwrap();
        let sink = FileSink::create(&child.join("saved.bin")).unwrap();
        let moved = directory.0.join("moved");
        assert!(fs::rename(&parent, &moved).is_err());
        assert!(fs::rename(&child, parent.join("other")).is_err());
        drop(sink);
        fs::remove_dir(&child).unwrap(); fs::remove_dir(&parent).unwrap();
    }
}
