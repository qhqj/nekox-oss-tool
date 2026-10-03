// A separate, Windows-only cargo test executable; never linked into the shipped app.
#![cfg(windows)]
#[path = "../../src-tauri/src/download_sink.rs"] mod download_sink;
#[path = "../../src-tauri/src/download.rs"] mod download;
#[path = "../../src-tauri/src/vault.rs"] mod vault;
use std::{fs, path::PathBuf, sync::{Arc, Mutex}};
use tauri::{ipc::{InvokeBody, Request}, Manager, State, WebviewWindow};
struct TestState { root: PathBuf, chunks: Mutex<Vec<usize>> }

#[tauri::command(rename = "load_account_vault")]
fn test_load_account_vault(state: State<'_, TestState>) -> Result<Option<String>, String> {
    vault::load_test_vault(&state.root.join("vault"))
}
#[tauri::command(rename = "save_account_vault")]
fn test_save_account_vault(state: State<'_, TestState>, data: String) -> Result<(), String> {
    vault::save_test_vault(&state.root.join("vault"), &data)
}
#[tauri::command]
fn stage(window: WebviewWindow, state: State<'_, TestState>, name: String) -> Result<(), String> {
    if !["upload-view", "cancel-save", "stream-save", "stream-fail", "stream-cancel", "existing", "raced", "reload", "done", "failed"].contains(&name.as_str()) {
        return Err("Unknown test stage".into());
    }
    if name == "upload-view" { window.show().map_err(|_| "Test window failed")?; }
    fs::write(state.root.join("stage.json"), serde_json::to_vec(&serde_json::json!({"name":name})).unwrap()).map_err(|_| "Stage write failed".into())
}
#[tauri::command]
fn report(state: State<'_, TestState>, name: String, passed: bool) -> Result<(), String> {
    if name.len() > 100 || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { return Err("Invalid case".into()); }
    use std::io::Write;
    let mut file = fs::OpenOptions::new().create(true).append(true).open(state.root.join("results.jsonl")).map_err(|_| "Report failed")?;
    writeln!(file, "{}", serde_json::json!({"case":name,"passed":passed})).map_err(|_| "Report failed".into())
}
#[tauri::command]
fn get_test_state(state: State<'_, TestState>) -> serde_json::Value {
    serde_json::json!({"reloaded":state.root.join("reload.marker").exists(), "chunks":*state.chunks.lock().unwrap()})
}
#[tauri::command]
fn mark_reload(state: State<'_, TestState>) -> Result<(), String> {
    fs::write(state.root.join("reload.marker"), b"reload").map_err(|_| "Marker failed".into())
}
#[tauri::command]
fn race_target(state: State<'_, TestState>) -> Result<(), String> {
    use std::io::Write;
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(state.root.join("downloads/raced.bin")).map_err(|_| "Fixture failed")?;
    file.write_all(b"keep-existing").map_err(|_| "Fixture failed".into())
}
#[tauri::command]
fn verify_files(state: State<'_, TestState>) -> serde_json::Value {
    let directory = state.root.join("downloads");
    let parts = fs::read_dir(&directory).unwrap().filter_map(Result::ok).filter(|entry| entry.file_name().to_string_lossy().ends_with(".part")).count();
    let bytes = fs::read(directory.join("stream-save.bin")).unwrap_or_default();
    serde_json::json!({"parts":parts, "savedLength":bytes.len(), "savedPattern":bytes.iter().enumerate().all(|(i,b)| *b == (i % 251) as u8),
      "failedAbsent":!directory.join("stream-fail.bin").exists(), "cancelAbsent":!directory.join("stream-cancel.bin").exists(),
      "existingKept":fs::read(directory.join("existing.bin")).unwrap_or_default()==b"keep-existing",
      "racedKept":fs::read(directory.join("raced.bin")).unwrap_or_default()==b"keep-existing"})
}
#[tauri::command(rename = "write_download_chunk")]
async fn test_write_download_chunk(window: WebviewWindow, state: State<'_, Arc<download_sink::Downloads>>, test: State<'_, TestState>, request: Request<'_>) -> Result<(), String> {
    if let InvokeBody::Raw(bytes) = request.body() { test.chunks.lock().unwrap().push(bytes.len()); }
    download::write_download_chunk(window, state, request).await
}
#[tauri::command]
fn finish_test(app: tauri::AppHandle) { app.exit(0); }

fn main() {
    assert!(cfg!(test) && cfg!(debug_assertions), "Test executable only");
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().canonicalize().unwrap();
    let root = PathBuf::from(std::env::var_os("NEKOX_DESKTOP_TEST_ROOT").expect("Explicit test root required")).canonicalize().unwrap();
    let on_d = matches!(root.components().next(), Some(std::path::Component::Prefix(prefix))
        if matches!(prefix.kind(), std::path::Prefix::Disk(letter) | std::path::Prefix::VerbatimDisk(letter) if letter.eq_ignore_ascii_case(&b'D')));
    assert!(root.starts_with(workspace.join("test-results")) && on_d, "D-drive isolated root required");
    assert!(!root.join("results.jsonl").exists(), "Use a fresh test root");
    fs::create_dir_all(root.join("downloads")).unwrap();
    fs::write(root.join("downloads/existing.bin"), b"keep-existing").unwrap();
    let profile = root.join("webview");
    tauri::Builder::default()
      .manage(TestState { root, chunks: Mutex::new(Vec::new()) })
      .manage(Arc::new(download_sink::Downloads::default()))
      .plugin(tauri_plugin_dialog::init())
      .invoke_handler(tauri::generate_handler![test_load_account_vault, test_save_account_vault, stage, report, get_test_state, mark_reload,
        race_target, verify_files, test_write_download_chunk, download::begin_download, download::finish_download, download::cancel_download, finish_test])
      .on_window_event(|window,event| { if matches!(event,tauri::WindowEvent::Destroyed) { window.state::<Arc<download_sink::Downloads>>().cancel_owner(window.label()); } })
      .setup(move |app| {
          tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
            .initialization_script("window.addEventListener('error',()=>{window.__TAURI_INTERNALS__.invoke('report',{name:'page-script-error',passed:false})});")
            .on_page_load(|window, payload| {
                let state = window.state::<TestState>();
                let _ = fs::write(state.root.join("page.json"), serde_json::json!({"url":payload.url().as_str()}).to_string());
            })
            .title("Nekox Offline Desktop Test").inner_size(1100.0,750.0).visible(false).data_directory(profile.clone()).build()?;
          Ok(())
      })
      .run(tauri::generate_context!("../tests/desktop/tauri.conf.json"))
      .expect("Offline desktop test runtime failed");
}
