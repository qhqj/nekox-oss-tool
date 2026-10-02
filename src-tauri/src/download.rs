//! Narrow commands: only a native save dialog can grant a download destination.
use crate::download_sink::{valid_filename, Downloads, FileSink, CHUNK_BYTES};
use std::sync::Arc;
use tauri::{ipc::{InvokeBody, Request}, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

fn owner(window: &WebviewWindow) -> Result<String, String> {
    if window.label() != "main" { return Err("当前窗口不能保存下载文件。".into()); }
    Ok(window.label().into())
}

#[tauri::command]
pub async fn begin_download(window: WebviewWindow, state: State<'_, Arc<Downloads>>, filename: String) -> Result<Option<String>, String> {
    let owner = owner(&window)?;
    if !valid_filename(&filename) { return Err("下载文件名无效。".into()); }
    let id = state.reserve(&owner)?;
    let cleanup_id = id.clone(); let cleanup_owner = owner.clone();
    let downloads = Arc::clone(state.inner());
    let result = tauri::async_runtime::spawn_blocking(move || {
        let selected = window.dialog().file().set_parent(&window).set_title("保存下载（请选择新文件名）")
            .set_file_name(filename).blocking_save_file();
        let Some(selected) = selected else { return Ok(None); };
        let path = selected.into_path().map_err(|_| "保存位置无效。")?;
        downloads.attach(&owner, &id, FileSink::create(&path)?)?;
        Ok(Some(id))
    }).await.map_err(|_| "无法打开保存对话框。".to_string()).and_then(|result| result);
    if !matches!(&result, Ok(Some(_))) { state.cancel(&cleanup_owner, &cleanup_id)?; }
    result
}

#[tauri::command]
pub async fn write_download_chunk(window: WebviewWindow, state: State<'_, Arc<Downloads>>, request: Request<'_>) -> Result<(), String> {
    let owner = owner(&window)?;
    let id = request.headers().get("x-nekox-download").and_then(|header| header.to_str().ok())
        .filter(|id| !id.is_empty() && id.len() <= 128).ok_or("下载任务编号无效。")?.to_owned();
    let InvokeBody::Raw(bytes) = request.body() else { return Err("下载分块必须使用二进制传输。".into()); };
    if bytes.is_empty() || bytes.len() > CHUNK_BYTES { return Err("下载分块大小无效。".into()); }
    let bytes = bytes.clone(); let downloads = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || downloads.write(&owner, &id, &bytes))
        .await.map_err(|_| "写入下载文件失败。".to_string())?
}

#[tauri::command]
pub async fn finish_download(window: WebviewWindow, state: State<'_, Arc<Downloads>>, id: String) -> Result<String, String> {
    let owner = owner(&window)?; let downloads = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || downloads.finish(&owner, &id))
        .await.map_err(|_| "完成下载文件保存失败。".to_string())?
}

#[tauri::command]
pub async fn cancel_download(window: WebviewWindow, state: State<'_, Arc<Downloads>>, id: String) -> Result<(), String> {
    let owner = owner(&window)?; let downloads = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || downloads.cancel(&owner, &id))
        .await.map_err(|_| "清理下载任务失败。".to_string())?
}
