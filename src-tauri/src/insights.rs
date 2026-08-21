//! 暂停报告的聚合。
//!
//! 只有这一份实现：`/insights` 的网页、`?format=md` 的 markdown、
//! `?format=json` 的结构化输出全都吃它。网页曾经在浏览器里自己算一遍，
//! 那样两边会漂 —— 跟「规则只有一份」是同一个道理。
//!
//! 时区用本机时区（chrono::Local）。按小时分桶必须用本地时间，
//! 不然「什么时候容易被打断」会整体偏移。

use chrono::{Local, TimeZone, Timelike};
use serde::Serialize;
use serde_json::Value;

const MS_MIN: i64 = 60_000;
const DAY: i64 = 86_400_000;
pub const WINDOW_DAYS: i64 = 7;
const MAX_RECENT: usize = 100;
const MAX_REASONS: usize = 8;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub at: i64,
    /// 预先格式化好，网页和 markdown 就不会各自格式化出两种样子
    pub day: String,
    pub clock: String,
    pub duration_ms: i64,
    pub duration: String,
    /// 还停着（endedAt 是 null）
    pub open: bool,
    pub reason: Option<String>,
    pub slice_name: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct HourBucket {
    pub hour: u32,
    pub count: u32,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub window_days: i64,
    pub generated_at: i64,
    pub generated_local: String,
    pub count: usize,
    pub today_count: usize,
    pub total_ms: i64,
    pub total: String,
    pub open_count: usize,
    pub hours: Vec<HourBucket>,
    pub reasons: Vec<(String, u32)>,
    pub recent: Vec<Row>,
}

pub fn fmt_dur(ms: i64) -> String {
    let m = (ms as f64 / MS_MIN as f64).round() as i64;
    if m < 60 {
        format!("{m}m")
    } else if m % 60 == 0 {
        format!("{}h", m / 60)
    } else {
        format!("{}h{}m", m / 60, m % 60)
    }
}

fn local_of(ms: i64) -> Option<chrono::DateTime<Local>> {
    Local.timestamp_millis_opt(ms).single()
}

/// 今天 0 点的时间戳（本地时区）
fn start_of_day(now: i64) -> i64 {
    local_of(now)
        .and_then(|t| t.date_naive().and_hms_opt(0, 0, 0))
        .and_then(|naive| Local.from_local_datetime(&naive).single())
        .map(|t| t.timestamp_millis())
        .unwrap_or(now - now.rem_euclid(DAY))
}

fn day_label(at: i64, now: i64) -> String {
    let d0 = start_of_day(now);
    if at >= d0 {
        "今天".into()
    } else if at >= d0 - DAY {
        "昨天".into()
    } else {
        local_of(at).map(|t| t.format("%-m/%-d").to_string()).unwrap_or_default()
    }
}

fn clock_label(at: i64) -> String {
    local_of(at).map(|t| t.format("%H:%M").to_string()).unwrap_or_default()
}

/// 还停着的那条按「到现在」算时长
fn length_of(at: i64, ended: Option<i64>, now: i64) -> i64 {
    (ended.unwrap_or(now) - at).max(0)
}

fn as_i64(v: Option<&Value>) -> Option<i64> {
    v.and_then(|x| x.as_f64()).map(|x| x as i64)
}

pub fn build_report(snapshot: Option<&Value>, now: i64) -> Report {
    let cutoff = now - WINDOW_DAYS * DAY;
    let mut rows: Vec<Row> = Vec::new();

    if let Some(list) = snapshot.and_then(|s| s.get("pauses")).and_then(|p| p.as_array()) {
        for p in list {
            let Some(at) = as_i64(p.get("at")) else { continue };
            if at <= cutoff {
                continue;
            }
            let ended = as_i64(p.get("endedAt"));
            let duration_ms = length_of(at, ended, now);
            rows.push(Row {
                at,
                day: day_label(at, now),
                clock: clock_label(at),
                duration_ms,
                duration: fmt_dur(duration_ms),
                open: ended.is_none(),
                reason: p
                    .get("reason")
                    .and_then(|r| r.as_str())
                    .map(|r| r.to_string())
                    .filter(|r| !r.trim().is_empty()),
                slice_name: p.get("sliceName").and_then(|n| n.as_str()).unwrap_or("").to_string(),
            });
        }
    }

    // 存档里一般是新的在前，但导入的存档不保证 —— 自己排，别信来路
    rows.sort_by(|a, b| b.at.cmp(&a.at));

    let d0 = start_of_day(now);
    let today_count = rows.iter().filter(|r| r.at >= d0).count();
    let total_ms: i64 = rows.iter().map(|r| r.duration_ms).sum();
    let open_count = rows.iter().filter(|r| r.open).count();

    let mut counts = [0u32; 24];
    for r in &rows {
        if let Some(t) = local_of(r.at) {
            counts[t.hour() as usize] += 1;
        }
    }

    let mut by_reason: Vec<(String, u32)> = Vec::new();
    for r in &rows {
        if let Some(reason) = &r.reason {
            match by_reason.iter_mut().find(|(k, _)| k == reason) {
                Some((_, n)) => *n += 1,
                None => by_reason.push((reason.clone(), 1)),
            }
        }
    }
    // 次数降序；同次数的按名字定序，免得输出每次都变
    by_reason.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    by_reason.truncate(MAX_REASONS);

    Report {
        window_days: WINDOW_DAYS,
        generated_at: now,
        generated_local: local_of(now)
            .map(|t| t.format("%Y-%m-%d %H:%M").to_string())
            .unwrap_or_default(),
        count: rows.len(),
        today_count,
        total_ms,
        total: fmt_dur(total_ms),
        open_count,
        hours: counts
            .iter()
            .enumerate()
            .map(|(hour, &count)| HourBucket { hour: hour as u32, count })
            .collect(),
        reasons: by_reason,
        recent: rows.into_iter().take(MAX_RECENT).collect(),
    }
}

/// 给 AI 看的版本。只列非零的时段，省得几十行零把有用的信息冲淡。
pub fn to_markdown(r: &Report) -> String {
    let mut out = String::from("# 暂停报告\n\n");

    if r.count == 0 {
        out.push_str(&format!("近 {} 天没有暂停过。\n", r.window_days));
        out.push_str(&format!("\n生成于 {}（本机时区）\n", r.generated_local));
        return out;
    }

    out.push_str(&format!(
        "近 {} 天 **{} 次**，共 {}；今天 {} 次。\n",
        r.window_days, r.count, r.total, r.today_count
    ));
    if r.open_count > 0 {
        out.push_str(&format!(
            "\n其中 {} 条还没结束（时长按「到现在」算）。\n",
            r.open_count
        ));
    }
    out.push_str(&format!("\n生成于 {}（本机时区）\n", r.generated_local));

    let peak = r.hours.iter().max_by_key(|h| h.count);
    out.push_str("\n## 按时段分布\n\n");
    out.push_str("| 时段 | 次数 |\n|---|---|\n");
    for h in r.hours.iter().filter(|h| h.count > 0) {
        out.push_str(&format!("| {:02}:00–{:02}:00 | {} |\n", h.hour, h.hour + 1, h.count));
    }
    if let Some(p) = peak.filter(|p| p.count > 0) {
        out.push_str(&format!(
            "\n峰值时段 **{:02}:00–{:02}:00**（{} 次）。\n",
            p.hour,
            p.hour + 1,
            p.count
        ));
    }

    if !r.reasons.is_empty() {
        out.push_str("\n## 最常见原因\n\n| 原因 | 次数 |\n|---|---|\n");
        for (reason, n) in &r.reasons {
            out.push_str(&format!("| {reason} | {n} |\n"));
        }
        let unlabeled = r.count - r.recent.iter().filter(|x| x.reason.is_some()).count();
        if unlabeled > 0 {
            out.push_str(&format!("\n另有 {unlabeled} 次没写原因。\n"));
        }
    }

    out.push_str("\n## 最近记录\n\n| 开始 | 时长 | 原因 | 任务 |\n|---|---|---|---|\n");
    for row in &r.recent {
        out.push_str(&format!(
            "| {} {} | {}{} | {} | {} |\n",
            row.day,
            row.clock,
            row.duration,
            if row.open { " ⏸" } else { "" },
            row.reason.as_deref().unwrap_or("—"),
            if row.slice_name.is_empty() { "—" } else { &row.slice_name },
        ));
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const H: i64 = 3_600_000;

    fn snapshot(pauses: Value) -> Value {
        json!({ "pauses": pauses })
    }

    /// 用本地时间构造一个「今天 hour 点」的时间戳，测试才不会因为跑在哪个时区而挂
    fn today_at(now: i64, hour: u32, min: u32) -> i64 {
        start_of_day(now) + (hour as i64) * H + (min as i64) * MS_MIN
    }

    fn now() -> i64 {
        // 固定在本地时间某天 20:00，避免用 0 点边界值
        let base = 1_787_000_000_000i64;
        today_at(base, 20, 0)
    }

    #[test]
    fn 空存档不报错() {
        let r = build_report(None, now());
        assert_eq!(r.count, 0);
        assert!(to_markdown(&r).contains("没有暂停过"));
    }

    #[test]
    fn 只算窗口内的记录() {
        let n = now();
        let s = snapshot(json!([
            { "at": today_at(n, 9, 0), "endedAt": today_at(n, 9, 5), "sliceName": "甲" },
            { "at": n - 30 * DAY, "endedAt": n - 30 * DAY + 5 * MS_MIN, "sliceName": "老的" },
        ]));
        let r = build_report(Some(&s), n);
        assert_eq!(r.count, 1);
        assert_eq!(r.today_count, 1);
        assert_eq!(r.recent[0].slice_name, "甲");
    }

    #[test]
    fn 按本地小时分桶() {
        let n = now();
        let s = snapshot(json!([
            { "at": today_at(n, 14, 10), "endedAt": today_at(n, 14, 18), "sliceName": "甲" },
            { "at": today_at(n, 14, 40), "endedAt": today_at(n, 14, 45), "sliceName": "甲" },
            { "at": today_at(n, 9, 0), "endedAt": today_at(n, 9, 2), "sliceName": "乙" },
        ]));
        let r = build_report(Some(&s), n);
        assert_eq!(r.hours[14].count, 2);
        assert_eq!(r.hours[9].count, 1);
        assert_eq!(r.hours[3].count, 0);
        assert!(to_markdown(&r).contains("峰值时段 **14:00–15:00**（2 次）"));
    }

    #[test]
    fn 还没结束的那条按到现在算() {
        let n = now();
        let s = snapshot(json!([{ "at": n - 10 * MS_MIN, "endedAt": null, "sliceName": "甲" }]));
        let r = build_report(Some(&s), n);
        assert_eq!(r.open_count, 1);
        assert_eq!(r.recent[0].duration_ms, 10 * MS_MIN);
        assert!(to_markdown(&r).contains("还没结束"));
    }

    #[test]
    fn 原因按次数降序且同次数定序() {
        let n = now();
        let mk = |min: u32, reason: &str| {
            json!({ "at": today_at(n, 10, min), "endedAt": today_at(n, 10, min + 1),
                    "reason": reason, "sliceName": "甲" })
        };
        let s = snapshot(json!([mk(1, "会议"), mk(3, "会议"), mk(5, "打断"), mk(7, "休息")]));
        let r = build_report(Some(&s), n);
        assert_eq!(r.reasons, vec![("会议".into(), 2), ("休息".into(), 1), ("打断".into(), 1)]);
    }

    #[test]
    fn 乱序的存档自己排好() {
        let n = now();
        let s = snapshot(json!([
            { "at": today_at(n, 9, 0), "endedAt": today_at(n, 9, 1), "sliceName": "早" },
            { "at": today_at(n, 15, 0), "endedAt": today_at(n, 15, 1), "sliceName": "晚" },
        ]));
        let r = build_report(Some(&s), n);
        assert_eq!(r.recent[0].slice_name, "晚"); // 新的在前
    }

    #[test]
    fn 空白原因当没写() {
        let n = now();
        let s = snapshot(json!([
            { "at": today_at(n, 10, 0), "endedAt": today_at(n, 10, 1), "reason": "   ", "sliceName": "甲" },
        ]));
        let r = build_report(Some(&s), n);
        assert!(r.recent[0].reason.is_none());
        assert!(r.reasons.is_empty());
    }

    #[test]
    fn 坏记录被跳过而不是崩掉() {
        let n = now();
        let s = snapshot(json!([
            { "at": "nope" },
            { "endedAt": 5 },
            Value::Null,
            { "at": today_at(n, 11, 0), "endedAt": today_at(n, 11, 2), "sliceName": "甲" },
        ]));
        let r = build_report(Some(&s), n);
        assert_eq!(r.count, 1);
    }

    #[test]
    fn json_字段名全是驼峰_网页按这个读() {
        let n = now();
        let s = snapshot(json!([
            { "at": today_at(n, 10, 0), "endedAt": today_at(n, 10, 5),
              "reason": "会议", "sliceName": "甲" },
        ]));
        let v = serde_json::to_value(build_report(Some(&s), n)).unwrap();
        for key in ["windowDays", "todayCount", "totalMs", "openCount", "generatedLocal"] {
            assert!(v.get(key).is_some(), "顶层缺 {key}");
        }
        let row = &v["recent"][0];
        for key in ["durationMs", "sliceName"] {
            assert!(row.get(key).is_some(), "recent[0] 缺 {key}");
        }
        // 漏 rename 时会留下蛇形字段，网页读驼峰就拿到 undefined
        assert!(row.get("slice_name").is_none());
        assert!(row.get("duration_ms").is_none());
    }

    #[test]
    fn 时长格式() {
        assert_eq!(fmt_dur(0), "0m");
        assert_eq!(fmt_dur(59_000), "1m");
        assert_eq!(fmt_dur(60 * MS_MIN), "1h");
        assert_eq!(fmt_dur(68 * MS_MIN), "1h8m");
    }

    #[test]
    fn markdown_只列非零时段() {
        let n = now();
        let s = snapshot(json!([
            { "at": today_at(n, 14, 0), "endedAt": today_at(n, 14, 5), "sliceName": "甲" },
        ]));
        let md = to_markdown(&build_report(Some(&s), n));
        assert!(md.contains("| 14:00–15:00 | 1 |"));
        assert!(!md.contains("| 03:00–04:00 |"));
    }
}
