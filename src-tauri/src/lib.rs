use tauri::{Manager, PhysicalPosition};
use tauri_plugin_window_state::StateFlags;

/// 首次启动时把窗口摆到右上角。屏幕正中间挡视线。
/// window-state 一旦存过位置就以存档为准，这里只管第一次。
fn place_top_right(app: &tauri::AppHandle) -> tauri::Result<()> {
    let saved = app
        .path()
        .app_config_dir()
        .map(|dir| dir.join(".window-state.json").exists())
        .unwrap_or(false);
    if saved {
        return Ok(());
    }

    let Some(win) = app.get_webview_window("main") else {
        return Ok(());
    };
    let Some(monitor) = win.current_monitor()? else {
        return Ok(());
    };

    let screen = monitor.size();
    let size = win.outer_size()?;
    let margin = (24.0 * monitor.scale_factor()) as u32;
    let x = screen.width.saturating_sub(size.width + margin);
    win.set_position(PhysicalPosition::new(x as i32, margin as i32))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // 只记位置，不记尺寸 —— 高度由前端按内容算，存下来会把它顶掉，
                // 内容比窗口高的那部分会被 overflow:hidden 直接切掉。
                .with_state_flags(StateFlags::POSITION)
                .build(),
        )
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            place_top_right(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
