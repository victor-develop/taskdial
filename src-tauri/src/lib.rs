mod insights;
mod server;

use std::sync::Arc;

use server::Shared;
use tauri::{Manager, PhysicalPosition, State};
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

// ── 前端 ↔ server 的桥 ──────────────────────────────────────────────
// 状态的唯一真相在前端 reducer 手里；Rust 只保存快照 + 落盘，
// 好让只读端点在窗口关着时也有东西可读。

/// 前端每次状态变化都推一份过来。
#[tauri::command]
fn sync_state(state: String, shared: State<'_, Arc<Shared>>) -> Result<(), String> {
    let value: serde_json::Value =
        serde_json::from_str(&state).map_err(|e| format!("state 不是合法 JSON：{e}"))?;
    shared.set_snapshot(value);
    Ok(())
}

/// 启动时前端来要 Rust 管的存档文件；没有就返回 None，前端自己从
/// localStorage 迁移（老版本的存档在那儿）。
#[tauri::command]
fn load_saved_state(shared: State<'_, Arc<Shared>>) -> Option<String> {
    shared.snapshot_text()
}

/// 前端跑完 reducer 后对某个 intent 回话：成功，带新状态。
#[tauri::command]
fn intent_done(id: u64, state: String, shared: State<'_, Arc<Shared>>) -> Result<(), String> {
    let value: serde_json::Value =
        serde_json::from_str(&state).map_err(|e| format!("state 不是合法 JSON：{e}"))?;
    shared.set_snapshot(value.clone());
    shared.resolve(id, Ok(value));
    Ok(())
}

/// 前端跑完 reducer 后对某个 intent 回话：被规则挡住了，带原因。
#[tauri::command]
fn intent_failed(id: u64, error: String, shared: State<'_, Arc<Shared>>) {
    shared.resolve(id, Err(error));
}

/// app 里那个 ▤ 按钮：开系统浏览器看 /insights，不再占窗口。
#[tauri::command]
fn open_insights(shared: State<'_, Arc<Shared>>) -> Result<(), String> {
    if !shared.config.enabled {
        return Err("server 没启用（配置目录 server.json 里 enabled=false）".into());
    }
    let url = format!("http://127.0.0.1:{}/insights", shared.config.port);
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
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

            let dir = app.path().app_config_dir()?;
            let config = server::load_config(&dir);
            let shared = Arc::new(Shared::new(
                config.clone(),
                app.package_info().version.to_string(),
                dir.join("state.json"),
            ));
            app.manage(shared.clone());
            if config.enabled {
                // 端口被占时 bind 里直接报错退出，不静默顺延
                let listener = server::bind(&config);
                server::spawn(app.handle().clone(), shared, listener);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sync_state,
            load_saved_state,
            intent_done,
            intent_failed,
            open_insights,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    app.run(|_app, event| {
        // 窗口关了进程不退：/health、/insights 这些只读端点还得活着。
        // code 是 Some 的那种是显式退出（比如 macOS 菜单里的 Quit），照常放行。
        if let tauri::RunEvent::ExitRequested { code: None, api, .. } = event {
            api.prevent_exit();
        }
    });
}
