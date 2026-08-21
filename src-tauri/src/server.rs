//! 本地 HTTP API（issue #1，方案 B）。
//!
//! 只读端点（`/`、`/insights`、`/health`、`/skills`、`/control/state`）直接读
//! Rust 侧的状态快照，窗口关着也能用；写端点（`/control/*` 的增删改）不在
//! Rust 里复刻状态机，而是把请求包成 intent 通过 Tauri event 发给前端，由
//! 唯一那份 `model.reducer` 处理后回写 —— reducer 只有一份，代价是写操作
//! 依赖窗口活着，不在时返回 503。

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tiny_http::{Header, Method, Request, Response, Server};

/// 等前端跑完 reducer 的最长时间。窗口活着但卡死时，别让 HTTP 请求陪着挂。
const INTENT_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_BODY: usize = 64 * 1024;

pub const INTENT_EVENT: &str = "server://intent";

// ── 配置 ────────────────────────────────────────────────────────────

/// 放在 app 配置目录的 `server.json`。首次启动会写出默认值，方便发现和修改。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct ServerConfig {
    pub enabled: bool,
    /// 默认只绑 loopback。改成 `0.0.0.0` = 同网段任何人都能**改**状态（没有
    /// token），所以放开必须是显式改配置，代码里永远不放开。
    pub bind: String,
    pub port: u16,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self { enabled: true, bind: "127.0.0.1".into(), port: 7717 }
    }
}

pub fn load_config(dir: &Path) -> ServerConfig {
    let path = dir.join("server.json");
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            // 配置烂了落回默认（loopback）——往安全的方向错，不往放开的方向错
            eprintln!("[server] {} 解析失败（{e}），使用默认配置", path.display());
            ServerConfig::default()
        }),
        Err(_) => {
            let config = ServerConfig::default();
            let _ = std::fs::create_dir_all(dir);
            if let Ok(text) = serde_json::to_string_pretty(&config) {
                let _ = std::fs::write(&path, text + "\n");
            }
            config
        }
    }
}

// ── 共享状态 ────────────────────────────────────────────────────────

/// HTTP 线程和 Tauri 命令共用的一切：状态快照、落盘路径、等待回话的 intent。
pub struct Shared {
    pub config: ServerConfig,
    pub version: String,
    started: Instant,
    state_path: PathBuf,
    snapshot: Mutex<Option<Value>>,
    pending: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
}

impl Shared {
    pub fn new(config: ServerConfig, version: String, state_path: PathBuf) -> Self {
        let snapshot = std::fs::read_to_string(&state_path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok());
        Self {
            config,
            version,
            started: Instant::now(),
            state_path,
            snapshot: Mutex::new(snapshot),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }

    /// 更新内存快照并落盘。先写临时文件再改名，进程死在半路也不会留半个存档。
    pub fn set_snapshot(&self, state: Value) {
        if let Ok(text) = serde_json::to_string(&state) {
            let tmp = self.state_path.with_extension("json.tmp");
            if let Some(dir) = self.state_path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            if std::fs::write(&tmp, &text).is_ok() {
                let _ = std::fs::rename(&tmp, &self.state_path);
            }
        }
        *self.snapshot.lock().unwrap() = Some(state);
    }

    pub fn snapshot_text(&self) -> Option<String> {
        self.snapshot.lock().unwrap().as_ref().map(|v| v.to_string())
    }

    fn snapshot_value(&self) -> Option<Value> {
        self.snapshot.lock().unwrap().clone()
    }

    /// 前端对某个 intent 回话（成功带新 state，失败带原因）。
    pub fn resolve(&self, id: u64, result: Result<Value, String>) {
        if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
            let _ = tx.send(result);
        }
    }
}

// ── 安全检查 ────────────────────────────────────────────────────────

fn is_loopback_bind(bind: &str) -> bool {
    bind.parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(bind == "localhost")
}

/// 绑在 loopback 时校验 Host 头，挡 DNS rebinding：浏览器里任意网页可以把
/// 某个域名解析到 127.0.0.1，然后拿"同源"的名义打这里的写接口。
/// 绑定放开时合法 Host 没法枚举（本机 IP 随网络变），跳过检查 ——
/// 放开本来就是"整个网段都可信"的显式决定。
pub fn host_allowed(config: &ServerConfig, host: Option<&str>) -> bool {
    if !is_loopback_bind(&config.bind) {
        return true;
    }
    let Some(host) = host else { return false };
    let port = config.port;
    host == format!("127.0.0.1:{port}")
        || host == format!("localhost:{port}")
        || host == format!("[::1]:{port}")
}

#[derive(PartialEq, Debug)]
enum Format {
    Html,
    Json,
    Markdown,
}

/// `?format=md|markdown|json`，或者 Accept 头。默认 HTML。
fn wants(req: &Request, query: &str) -> Format {
    let q = |k: &str| query.split('&').any(|p| p == format!("format={k}"));
    if q("md") || q("markdown") {
        return Format::Markdown;
    }
    if q("json") {
        return Format::Json;
    }
    match header_value(req, "accept") {
        Some(a) if a.contains("text/markdown") => Format::Markdown,
        Some(a) if a.contains("application/json") && !a.contains("text/html") => Format::Json,
        _ => Format::Html,
    }
}

/// 墙上时间（毫秒）
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn is_write(method: &Method) -> bool {
    matches!(method, Method::Post | Method::Patch | Method::Delete | Method::Put)
}

// ── HTTP ────────────────────────────────────────────────────────────

/// 绑定端口。被占直接报错退出，不静默顺延 —— 悄悄换端口会让 agent 打空
/// （跟 vite.config.ts 里 strictPort 是同一个道理）。
pub fn bind(config: &ServerConfig) -> Server {
    let addr = format!("{}:{}", config.bind, config.port);
    match Server::http(&addr) {
        Ok(server) => server,
        Err(e) => {
            eprintln!("[server] 绑定 {addr} 失败：{e}");
            eprintln!("[server] 端口被占不换端口（换了 agent 会打空）。释放端口，或改 app 配置目录下 server.json 里的 port。");
            std::process::exit(1);
        }
    }
}

pub fn spawn(app: AppHandle, shared: Arc<Shared>, server: Server) {
    std::thread::spawn(move || {
        // 本地 API，串行处理就够了；一个 intent 最多占 3 秒
        for request in server.incoming_requests() {
            handle(request, &app, &shared);
        }
    });
}

fn header_value(req: &Request, name: &str) -> Option<String> {
    req.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_string())
}

fn respond(req: Request, code: u16, content_type: &str, body: String) {
    let ct = Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes())
        .expect("content type 是静态字符串");
    // 故意不发任何 CORS 头：跨源网页读不到响应，也别想预检通过
    let _ = req.respond(Response::from_string(body).with_status_code(code).with_header(ct));
}

fn respond_json(req: Request, code: u16, value: &Value) {
    respond(req, code, "application/json; charset=utf-8", value.to_string());
}

fn respond_err(req: Request, code: u16, msg: &str) {
    respond_json(req, code, &json!({ "ok": false, "error": msg }));
}

fn respond_html(req: Request, html: &str) {
    respond(req, 200, "text/html; charset=utf-8", html.to_string());
}

/// 读请求体并解析成 JSON 对象。空体当 `{}`，别逼调用方为 resume 造个空对象。
fn read_body(req: &mut Request) -> Result<serde_json::Map<String, Value>, (u16, String)> {
    if req.body_length().unwrap_or(0) > MAX_BODY {
        return Err((413, "请求体太大".into()));
    }
    let mut text = String::new();
    req.as_reader()
        .take(MAX_BODY as u64 + 1)
        .read_to_string(&mut text)
        .map_err(|_| (400, "请求体读不了（不是合法 UTF-8？）".to_string()))?;
    if text.len() > MAX_BODY {
        return Err((413, "请求体太大".into()));
    }
    if text.trim().is_empty() {
        return Ok(serde_json::Map::new());
    }
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err((400, "请求体得是一个 JSON 对象".into())),
        Err(e) => Err((400, format!("JSON 解析失败：{e}"))),
    }
}

/// 把 intent 发给前端窗口，等 reducer 跑完回话。
fn run_intent(app: &AppHandle, shared: &Shared, intent: Value) -> Result<Value, (u16, String)> {
    let Some(window) = app.get_webview_window("main") else {
        return Err((
            503,
            "app 窗口不在。写操作要走前端唯一那份 reducer，窗口关着改不了；只读端点（/insights /health /control/state）不受影响".into(),
        ));
    };
    let id = shared.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    shared.pending.lock().unwrap().insert(id, tx);

    if window.emit(INTENT_EVENT, json!({ "id": id, "intent": intent })).is_err() {
        shared.pending.lock().unwrap().remove(&id);
        return Err((503, "事件发不进 app 窗口".into()));
    }
    match rx.recv_timeout(INTENT_TIMEOUT) {
        Ok(Ok(state)) => Ok(state),
        Ok(Err(msg)) => Err((422, msg)),
        Err(_) => {
            shared.pending.lock().unwrap().remove(&id);
            Err((503, "app 窗口没在规定时间内回话（前端卡住或还没加载完）".into()))
        }
    }
}

fn handle(mut req: Request, app: &AppHandle, shared: &Shared) {
    let method = req.method().clone();
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or("/").to_string();
    let query = url.splitn(2, '?').nth(1).unwrap_or("").to_string();

    if !host_allowed(&shared.config, header_value(&req, "host").as_deref()) {
        return respond_err(
            req,
            403,
            "Host 头不是 127.0.0.1/localhost —— 像是 DNS rebinding，拒绝",
        );
    }
    // 带 Origin 的写请求 = 从浏览器网页发起的跨源调用，一律拒绝。
    // agent 用 curl/fetch(node) 不带 Origin，不受影响。
    if is_write(&method) && header_value(&req, "origin").is_some() {
        return respond_err(req, 403, "写接口不接受来自浏览器网页的跨源请求（带 Origin）");
    }

    match (&method, path.as_str()) {
        (Method::Get, "/") => respond_html(req, include_str!("../web/landing.html")),
        (Method::Get, "/insights") => {
            // 网页、markdown、结构化 JSON 三种形态，聚合是同一份（insights.rs）
            let report =
                || crate::insights::build_report(shared.snapshot_value().as_ref(), now_ms());
            match wants(&req, &query) {
                Format::Markdown => {
                    respond(req, 200, "text/markdown; charset=utf-8", crate::insights::to_markdown(&report()))
                }
                Format::Json => {
                    let value = serde_json::to_value(report()).unwrap_or(Value::Null);
                    respond_json(req, 200, &value)
                }
                Format::Html => respond_html(req, include_str!("../web/insights.html")),
            }
        }

        (Method::Get, "/health") => {
            let phase = shared
                .snapshot_value()
                .and_then(|s| s.get("phase").cloned())
                .unwrap_or(Value::Null);
            respond_json(
                req,
                200,
                &json!({
                    "ok": true,
                    "version": shared.version,
                    "phase": phase,
                    "uptime": shared.started.elapsed().as_secs(),
                    "window": app.get_webview_window("main").is_some(),
                }),
            );
        }

        (Method::Get, "/skills") => {
            if wants(&req, &query) == Format::Markdown {
                respond(req, 200, "text/markdown; charset=utf-8", skills_markdown(shared));
            } else {
                respond_json(req, 200, &skills_json(shared));
            }
        }

        (Method::Get, "/control/state") => match shared.snapshot_value() {
            Some(state) => respond_json(req, 200, &state),
            None => respond_err(req, 404, "还没有状态：app 窗口至少打开过一次才有存档"),
        },

        (Method::Post, "/control/slices") => match read_body(&mut req) {
            Ok(mut body) => {
                body.insert("op".into(), "addSlice".into());
                finish_intent(req, app, shared, Value::Object(body));
            }
            Err((code, msg)) => respond_err(req, code, &msg),
        },

        (Method::Post, "/control/pause") => match read_body(&mut req) {
            Ok(mut body) => {
                body.insert("op".into(), "pause".into());
                finish_intent(req, app, shared, Value::Object(body));
            }
            Err((code, msg)) => respond_err(req, code, &msg),
        },

        (Method::Post, "/control/resume") => {
            finish_intent(req, app, shared, json!({ "op": "resume" }))
        }

        (m, p) if p.starts_with("/control/slices/") => {
            let id = p["/control/slices/".len()..].to_string();
            if id.is_empty() || id.contains('/') {
                return respond_err(req, 404, "没有这个路径");
            }
            match m {
                Method::Patch => match read_body(&mut req) {
                    Ok(mut body) => {
                        body.insert("op".into(), "updateSlice".into());
                        body.insert("id".into(), Value::String(id));
                        finish_intent(req, app, shared, Value::Object(body));
                    }
                    Err((code, msg)) => respond_err(req, code, &msg),
                },
                Method::Delete => {
                    finish_intent(req, app, shared, json!({ "op": "removeSlice", "id": id }))
                }
                _ => respond_err(req, 405, "这个路径只接受 PATCH / DELETE"),
            }
        }

        _ => respond_err(req, 404, "没有这个路径。GET /skills 有完整的能力清单"),
    }
}

fn finish_intent(req: Request, app: &AppHandle, shared: &Shared, intent: Value) {
    match run_intent(app, shared, intent) {
        Ok(state) => respond_json(req, 200, &json!({ "ok": true, "state": state })),
        Err((code, msg)) => respond_err(req, code, &msg),
    }
}

// ── /skills ─────────────────────────────────────────────────────────

fn skills_json(shared: &Shared) -> Value {
    let base = format!("http://127.0.0.1:{}", shared.config.port);
    json!({
        "name": "taskdial",
        "version": shared.version,
        "base": base,
        "description": "常驻置顶的任务轮盘。这套 API 让 agent 读状态、改任务片、暂停/继续计时。",
        "constraints": {
            "slices": "3–8 片：少于 3 片删不掉，已有 8 片加不了",
            "lenMin": "片长 1–180 分钟，越界会被夹住而不是报错",
            "pauseReason": "暂停原因最长 40 字",
            "writes": "写端点依赖 app 窗口活着（intent 走前端 reducer），窗口不在返回 503"
        },
        "endpoints": [
            { "method": "GET",    "path": "/",                   "desc": "landing page（HTML）" },
            { "method": "GET",    "path": "/insights",           "desc": "暂停报告网页（HTML）；?format=md 出 markdown 方便 AI 分析，?format=json 出结构化聚合" },
            { "method": "GET",    "path": "/health",             "desc": "{ok, version, phase, uptime, window}" },
            { "method": "GET",    "path": "/skills",             "desc": "本清单。?format=md 或 Accept: text/markdown 拿 markdown 版" },
            { "method": "GET",    "path": "/control/state",      "desc": "当前完整状态（JSON）" },
            { "method": "POST",   "path": "/control/slices",     "body": { "name": "string?", "lenMin": "number?" }, "desc": "加一片。省略字段用默认值" },
            { "method": "PATCH",  "path": "/control/slices/:id", "body": { "name": "string?", "lenMin": "number?" }, "desc": "改名 / 改片长，至少给一个字段" },
            { "method": "DELETE", "path": "/control/slices/:id", "desc": "删一片" },
            { "method": "POST",   "path": "/control/pause",      "body": { "reason": "string?" }, "desc": "暂停计时（只有 running 时有效）" },
            { "method": "POST",   "path": "/control/resume",     "desc": "继续计时（只有 paused 时有效）" }
        ],
        "responses": {
            "write_ok": "{ok: true, state: <新的完整状态>}",
            "write_rejected": "422 {ok: false, error} —— 被 reducer 的边界规则挡住",
            "window_gone": "503 {ok: false, error} —— app 窗口不在或没响应",
            "example": format!("curl -X POST {base}/control/slices -d '{{\"name\":\"写文档\",\"lenMin\":25}}'")
        }
    })
}

fn skills_markdown(shared: &Shared) -> String {
    let base = format!("http://127.0.0.1:{}", shared.config.port);
    format!(
        r#"# taskdial 本地 API（v{version}）

常驻置顶的任务轮盘。这套 API 让 agent 读状态、改任务片、暂停/继续计时。
Base URL：`{base}`

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | landing page（HTML） |
| GET | `/insights` | 暂停报告网页（HTML） |
| GET | `/health` | `{{ok, version, phase, uptime, window}}` |
| GET | `/skills` | 本清单。`?format=md` 拿 markdown 版 |
| GET | `/control/state` | 当前完整状态（JSON） |
| POST | `/control/slices` | 加一片，body `{{"name"?, "lenMin"?}}` |
| PATCH | `/control/slices/:id` | 改名 / 改片长，至少给一个字段 |
| DELETE | `/control/slices/:id` | 删一片 |
| POST | `/control/pause` | 暂停，body `{{"reason"?}}`（只有 running 时有效） |
| POST | `/control/resume` | 继续（只有 paused 时有效） |

## 规则

- 片数 3–8：少于 3 片删不掉，已有 8 片加不了
- 片长 1–180 分钟，越界会被夹住而不是报错
- 暂停原因最长 40 字
- 写端点依赖 app 窗口活着（intent 走前端 reducer），窗口不在返回 503
- 写成功返回 `{{ok: true, state}}`；被规则挡住返回 422；窗口不在返回 503

## 例子

```sh
curl {base}/control/state
curl -X POST {base}/control/slices -d '{{"name":"写文档","lenMin":25}}'
curl -X POST {base}/control/pause -d '{{"reason":"会议"}}'
curl -X POST {base}/control/resume
```
"#,
        version = shared.version,
        base = base,
    )
}

// ── 测试 ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(bind: &str, port: u16) -> ServerConfig {
        ServerConfig { enabled: true, bind: bind.into(), port }
    }

    #[test]
    fn loopback_时校验_host_头() {
        let c = cfg("127.0.0.1", 7717);
        assert!(host_allowed(&c, Some("127.0.0.1:7717")));
        assert!(host_allowed(&c, Some("localhost:7717")));
        assert!(host_allowed(&c, Some("[::1]:7717")));
        // DNS rebinding：域名解析到 127.0.0.1，Host 头带的还是那个域名
        assert!(!host_allowed(&c, Some("evil.example:7717")));
        assert!(!host_allowed(&c, Some("127.0.0.1:9999"))); // 端口都得对上
        assert!(!host_allowed(&c, Some("127.0.0.1"))); // 非 80 端口的 Host 必带端口
        assert!(!host_allowed(&c, None));
    }

    #[test]
    fn 放开绑定时不检查_host() {
        let c = cfg("0.0.0.0", 7717);
        assert!(host_allowed(&c, Some("192.168.1.5:7717")));
        assert!(host_allowed(&c, None));
    }

    #[test]
    fn localhost_和_v6_loopback_也算_loopback_绑定() {
        assert!(is_loopback_bind("localhost"));
        assert!(is_loopback_bind("::1"));
        assert!(is_loopback_bind("127.0.0.1"));
        assert!(!is_loopback_bind("0.0.0.0"));
        assert!(!is_loopback_bind("192.168.1.5"));
    }

    #[test]
    fn 默认配置是_loopback_7717() {
        let c = ServerConfig::default();
        assert!(c.enabled);
        assert_eq!(c.bind, "127.0.0.1");
        assert_eq!(c.port, 7717);
    }

    #[test]
    fn 配置缺字段用默认值补齐() {
        let c: ServerConfig = serde_json::from_str(r#"{ "port": 8000 }"#).unwrap();
        assert_eq!(c.port, 8000);
        assert_eq!(c.bind, "127.0.0.1");
        assert!(c.enabled);
    }

    #[test]
    fn 写方法的判定() {
        assert!(is_write(&Method::Post));
        assert!(is_write(&Method::Patch));
        assert!(is_write(&Method::Delete));
        assert!(!is_write(&Method::Get));
        assert!(!is_write(&Method::Head));
    }

    #[test]
    fn 快照落盘后能读回来() {
        let dir = std::env::temp_dir().join(format!("taskdial-test-{}", std::process::id()));
        let path = dir.join("state.json");
        let shared = Shared::new(ServerConfig::default(), "0.0.0".into(), path.clone());
        assert!(shared.snapshot_text().is_none());

        shared.set_snapshot(json!({ "phase": "running", "slices": [] }));
        let back = Shared::new(ServerConfig::default(), "0.0.0".into(), path);
        assert_eq!(
            back.snapshot_value().unwrap().get("phase").unwrap(),
            &json!("running")
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 回话只认还在等的_intent() {
        let shared = Shared::new(
            ServerConfig::default(),
            "0.0.0".into(),
            std::env::temp_dir().join("taskdial-test-unused.json"),
        );
        let (tx, rx) = mpsc::channel();
        shared.pending.lock().unwrap().insert(7, tx);

        shared.resolve(99, Ok(json!({}))); // 没人等的 id，安静忽略
        assert!(rx.try_recv().is_err());

        shared.resolve(7, Err("不行".into()));
        assert_eq!(rx.try_recv().unwrap(), Err("不行".to_string()));
        assert!(shared.pending.lock().unwrap().is_empty());
    }
}
