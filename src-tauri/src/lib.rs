mod vault;
#[cfg(windows)]
mod download;
#[cfg(windows)]
mod download_sink;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(windows)]
    let builder = {
        use std::sync::Arc;
        use tauri::Manager;
        builder.manage(Arc::new(download_sink::Downloads::default()))
            .invoke_handler(tauri::generate_handler![
                vault::load_account_vault, vault::save_account_vault,
                download::begin_download, download::write_download_chunk,
                download::finish_download, download::cancel_download
            ])
            .on_window_event(|window, event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    window.state::<Arc<download_sink::Downloads>>().cancel_owner(window.label());
                }
            })
    };
    #[cfg(not(windows))]
    let builder = builder
        .invoke_handler(tauri::generate_handler![
            vault::load_account_vault,
            vault::save_account_vault
        ]);
    builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
