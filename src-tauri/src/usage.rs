//! Subscription usage for the agent CLIs Keel launches.
//!
//! Keel does not mint credentials. Each vendor's own CLI already wrote an auth
//! file; we read it and call the same quota endpoint that CLI uses for `/usage`
//! or `/status`. Agents with no reachable quota API are omitted from the snapshot.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::pty::home_dir;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_REFRESH_URL: &str = "https://console.anthropic.com/v1/oauth/token";
const CLAUDE_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_REFRESH_URL: &str = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CfXlEnXFCNko";

const GEMINI_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GEMINI_LOAD_URL: &str = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const GEMINI_QUOTA_URL: &str = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
// Public installed-app client shipped by Gemini CLI. Not a secret.
const GEMINI_CLIENT_ID: &str =
    "681255809395-oo8ft2oprdrnp8qvt5l3j5pl19ae17ez.apps.googleusercontent.com";
const GEMINI_CLIENT_SECRET: &str = "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";

const GROK_CREDITS_URL: &str = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const GROK_MONTHLY_URL: &str = "https://cli-chat-proxy.grok.com/v1/billing";
const GROK_REFRESH_URL: &str = "https://auth.x.ai/oauth2/token";
const GROK_CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";

const OPENCODE_GO_USAGE_URL: &str = "https://opencode.ai/zen/go/v1/usage";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAgentQuery {
    pub id: String,
    pub short: String,
    pub name: String,
    pub accent: String,
    #[serde(default)]
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub used_percent: f64,
    pub window_minutes: u32,
    pub resets_at: Option<u64>,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    pub agent_id: String,
    pub account_id: Option<String>,
    pub short: String,
    pub name: String,
    pub accent: String,
    pub plan: Option<String>,
    pub windows: Vec<UsageWindow>,
    pub status: String,
    pub error: Option<String>,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub agents: Vec<AgentUsage>,
    pub fetched_at: u64,
}

struct Creds {
    access: String,
    refresh: Option<String>,
    extra: HeaderMap,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn clamp_percent(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    value.clamp(0.0, 100.0)
}

fn window_label(minutes: u32) -> &'static str {
    if minutes <= 360 {
        "5h"
    } else if minutes <= 1_560 {
        "1d"
    } else if minutes <= 10_800 {
        "wk"
    } else {
        "mo"
    }
}

fn usage_window(used_percent: f64, window_minutes: u32, resets_at: Option<u64>) -> UsageWindow {
    UsageWindow {
        used_percent: clamp_percent(used_percent),
        window_minutes,
        resets_at,
        label: window_label(window_minutes).to_string(),
    }
}

fn parse_iso_ms(raw: &str) -> Option<u64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    OffsetDateTime::parse(trimmed, &Rfc3339).ok().map(|stamp| {
        let seconds = stamp.unix_timestamp().max(0) as u64;
        seconds * 1000 + u64::from(stamp.nanosecond()) / 1_000_000
    })
}

fn json_time_ms(value: Option<&Value>) -> Option<u64> {
    match value? {
        Value::Number(number) => {
            let n = number.as_f64()?;
            if !n.is_finite() || n <= 0.0 {
                return None;
            }
            Some(if n > 10_000_000_000.0 {
                n as u64
            } else {
                (n * 1000.0) as u64
            })
        }
        Value::String(text) => {
            if let Ok(n) = text.parse::<f64>() {
                if n.is_finite() && n > 0.0 {
                    return Some(if n > 10_000_000_000.0 {
                        n as u64
                    } else {
                        (n * 1000.0) as u64
                    });
                }
            }
            parse_iso_ms(text)
        }
        _ => None,
    }
}

fn json_f64(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.parse().ok(),
        _ => None,
    }
}

fn url_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn form_body(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(key, value)| format!("{key}={}", url_encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn account_dir(app: &AppHandle, account_id: &str) -> Option<PathBuf> {
    let valid = account_id
        .chars()
        .all(|ch| ch == '_' || ch == '-' || ch.is_ascii_alphanumeric());
    if !valid || account_id.is_empty() {
        return None;
    }
    Some(
        app.path()
            .app_config_dir()
            .ok()?
            .join("accounts")
            .join(account_id),
    )
}

fn data_home() -> Option<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
        return Some(PathBuf::from(xdg));
    }
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .or_else(|| home_dir().map(|home| home.join("AppData").join("Roaming")))
    }
    #[cfg(not(windows))]
    {
        home_dir().map(|home| home.join(".local").join("share"))
    }
}

fn default_home(agent_id: &str) -> Option<PathBuf> {
    let home = home_dir()?;
    match agent_id {
        "claude" => Some(home.join(".claude")),
        "codex" => Some(home.join(".codex")),
        "gemini" => Some(home.join(".gemini")),
        "grok" => Some(home.join(".grok")),
        "opencode" => data_home().map(|base| base.join("opencode")),
        _ => None,
    }
}

fn config_home(app: &AppHandle, agent_id: &str, account_id: Option<&str>) -> Option<PathBuf> {
    if let Some(account_id) = account_id.filter(|id| !id.is_empty()) {
        let dir = account_dir(app, account_id)?;
        if agent_id == "opencode" {
            let nested = dir.join("opencode");
            if nested.is_dir() || nested.join("auth.json").is_file() {
                return Some(nested);
            }
        }
        return Some(dir);
    }
    default_home(agent_id)
}

fn http_client(proxy: Option<&str>) -> Result<Client, String> {
    let mut builder = Client::builder().timeout(REQUEST_TIMEOUT);
    if let Some(proxy) = proxy.filter(|url| !url.is_empty()) {
        builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|err| err.to_string())?);
    }
    builder.build().map_err(|err| err.to_string())
}

fn header_map(pairs: &[(&str, &str)]) -> HeaderMap {
    let mut headers = HeaderMap::new();
    for (key, value) in pairs {
        if let (Ok(name), Ok(val)) = (
            HeaderName::from_bytes(key.as_bytes()),
            HeaderValue::from_str(value),
        ) {
            headers.insert(name, val);
        }
    }
    headers
}

fn send_json(
    client: &Client,
    method: reqwest::Method,
    url: &str,
    headers: &HeaderMap,
    body: Option<&Value>,
) -> Result<(u16, Value), String> {
    let mut request = client.request(method, url).headers(headers.clone());
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request.send().map_err(|err| err.to_string())?;
    let status = response.status().as_u16();
    let value = response.json::<Value>().unwrap_or(Value::Null);
    Ok((status, value))
}

fn post_form(client: &Client, url: &str, pairs: &[(&str, &str)]) -> Result<Value, String> {
    let response = client
        .post(url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json")
        .body(form_body(pairs))
        .send()
        .map_err(|err| err.to_string())?;
    if !response.status().is_success() {
        return Err(format!("http {}", response.status()));
    }
    response.json().map_err(|err| err.to_string())
}

fn json_access_token(value: &Value) -> Option<String> {
    value
        .get("access_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
}

fn failed(query: &UsageAgentQuery, error: impl Into<String>) -> AgentUsage {
    AgentUsage {
        agent_id: query.id.clone(),
        account_id: query.account_id.clone(),
        short: query.short.clone(),
        name: query.name.clone(),
        accent: query.accent.clone(),
        plan: None,
        windows: Vec::new(),
        status: "error".into(),
        error: Some(error.into()),
        updated_at: now_ms(),
    }
}

fn ok(
    query: &UsageAgentQuery,
    plan: Option<String>,
    windows: Vec<UsageWindow>,
) -> Option<AgentUsage> {
    if windows.is_empty() {
        return None;
    }
    Some(AgentUsage {
        agent_id: query.id.clone(),
        account_id: query.account_id.clone(),
        short: query.short.clone(),
        name: query.name.clone(),
        accent: query.accent.clone(),
        plan,
        windows,
        status: "ok".into(),
        error: None,
        updated_at: now_ms(),
    })
}

fn parse_claude_usage(data: &Value) -> Vec<UsageWindow> {
    let mut windows = Vec::new();
    if let Some(window) = claude_window(data.get("five_hour"), 300) {
        windows.push(window);
    }
    if let Some(window) = claude_window(data.get("seven_day"), 10_080) {
        windows.push(window);
    }
    let fable = data
        .get("fable_weekly")
        .or_else(|| data.get("fable_seven_day"))
        .or_else(|| data.get("seven_day_fable"))
        .or_else(|| data.get("seven_day_opus"));
    if let Some(mut window) = claude_window(fable, 10_080) {
        let is_fable = data.get("fable_weekly").is_some()
            || data.get("fable_seven_day").is_some()
            || data.get("seven_day_fable").is_some();
        if is_fable {
            window.label = "Fable".into();
        } else {
            window.label = "Opus".into();
        }
        windows.push(window);
    }
    if let Some(Value::Array(limits)) = data.get("limits") {
        for limit in limits {
            let kind = limit.get("kind").and_then(Value::as_str).unwrap_or("");
            let name = limit
                .pointer("/scope/model/display_name")
                .and_then(Value::as_str)
                .unwrap_or("");
            if kind == "weekly_scoped" && name.eq_ignore_ascii_case("fable") {
                if let Some(percent) = json_f64(limit.get("percent")) {
                    let mut window =
                        usage_window(percent, 10_080, json_time_ms(limit.get("resets_at")));
                    window.label = "Fable".into();
                    if !windows.iter().any(|item| item.label == "Fable") {
                        windows.push(window);
                    }
                }
            }
        }
    }
    windows
}

fn claude_window(raw: Option<&Value>, minutes: u32) -> Option<UsageWindow> {
    let object = raw?;
    let used = json_f64(object.get("utilization"))
        .or_else(|| json_f64(object.get("used_percentage")))
        .or_else(|| json_f64(object.get("used_percent")))?;
    Some(usage_window(
        used,
        minutes,
        json_time_ms(object.get("resets_at")),
    ))
}

fn parse_codex_usage(data: &Value) -> (Option<String>, Vec<UsageWindow>) {
    let plan = data
        .get("plan_type")
        .and_then(Value::as_str)
        .map(str::to_string);
    let rate = data.get("rate_limit").unwrap_or(&Value::Null);
    let mut classified: Vec<(u32, f64, Option<u64>)> = Vec::new();
    for key in ["primary_window", "secondary_window"] {
        if let Some(window) = rate.get(key) {
            if let Some(parsed) = codex_raw_window(window) {
                classified.push(parsed);
            }
        }
    }
    if let Some(Value::Array(extra)) = rate.get("additional_rate_limits") {
        for window in extra {
            if let Some(parsed) = codex_raw_window(window) {
                classified.push(parsed);
            }
        }
    }
    let windows = classified
        .into_iter()
        .map(|(minutes, used, reset)| usage_window(used, minutes, reset))
        .collect();
    (plan, windows)
}

fn codex_raw_window(raw: &Value) -> Option<(u32, f64, Option<u64>)> {
    let used = json_f64(raw.get("used_percent"))?;
    let seconds = json_f64(raw.get("limit_window_seconds")).unwrap_or(0.0);
    let minutes = if seconds > 0.0 {
        (seconds / 60.0).ceil().max(1.0) as u32
    } else {
        300
    };
    Some((minutes, used, json_time_ms(raw.get("reset_at"))))
}

fn parse_gemini_quota(data: &Value) -> Vec<UsageWindow> {
    let buckets = data
        .get("buckets")
        .or_else(|| data.get("quotaBuckets"))
        .and_then(Value::as_array);
    let Some(buckets) = buckets else {
        return Vec::new();
    };
    let mut best: Vec<(String, UsageWindow)> = Vec::new();
    for bucket in buckets {
        let token_type = bucket
            .get("tokenType")
            .or_else(|| bucket.get("token_type"))
            .and_then(Value::as_str)
            .unwrap_or("REQUESTS");
        if !token_type.eq_ignore_ascii_case("REQUESTS") {
            continue;
        }
        let Some(remaining) = json_f64(bucket.get("remainingFraction"))
            .or_else(|| json_f64(bucket.get("remaining_fraction")))
        else {
            continue;
        };
        let used = (1.0 - remaining) * 100.0;
        let reset = json_time_ms(bucket.get("resetTime"))
            .or_else(|| json_time_ms(bucket.get("reset_time")));
        let model = bucket
            .get("modelId")
            .or_else(|| bucket.get("model_id"))
            .and_then(Value::as_str)
            .unwrap_or("Gemini");
        let label = gemini_bucket_label(model);
        let mut window = usage_window(used, 1_440, reset);
        window.label = label.clone();
        if let Some(existing) = best.iter_mut().find(|(name, _)| *name == label) {
            if window.used_percent > existing.1.used_percent {
                existing.1 = window;
            }
        } else {
            best.push((label, window));
        }
    }
    best.into_iter().map(|(_, window)| window).collect()
}

fn gemini_bucket_label(model: &str) -> String {
    let lower = model.to_ascii_lowercase();
    if lower.contains("flash") {
        "Flash".into()
    } else if lower.contains("pro") {
        "Pro".into()
    } else {
        "1d".into()
    }
}

fn parse_grok_credits(data: &Value) -> Option<UsageWindow> {
    let config = data.get("config")?;
    let used = json_f64(config.get("creditUsagePercent")).or_else(|| {
        let cap = config.pointer("/onDemandCap/val").and_then(Value::as_f64)?;
        let spent = config
            .pointer("/onDemandUsed/val")
            .and_then(Value::as_f64)?;
        if cap > 0.0 {
            Some(spent / cap * 100.0)
        } else {
            Some(0.0)
        }
    })?;
    let period = config.get("currentPeriod");
    let start = period
        .and_then(|p| p.get("start"))
        .and_then(Value::as_str)
        .and_then(parse_iso_ms);
    let end = period
        .and_then(|p| p.get("end"))
        .and_then(Value::as_str)
        .and_then(parse_iso_ms)
        .or_else(|| {
            config
                .get("billingPeriodEnd")
                .and_then(Value::as_str)
                .and_then(parse_iso_ms)
        });
    let minutes = minutes_between(start, end).unwrap_or(10_080);
    Some(usage_window(used, minutes, end))
}

fn parse_grok_monthly(data: &Value) -> Option<UsageWindow> {
    let config = data.get("config")?;
    let limit = config
        .pointer("/monthlyLimit/val")
        .and_then(Value::as_f64)?;
    if limit <= 0.0 {
        return None;
    }
    let used = config.pointer("/used/val").and_then(Value::as_f64)?;
    let start = config
        .get("billingPeriodStart")
        .and_then(Value::as_str)
        .and_then(parse_iso_ms);
    let end = config
        .get("billingPeriodEnd")
        .and_then(Value::as_str)
        .and_then(parse_iso_ms);
    let minutes = minutes_between(start, end).unwrap_or(43_200);
    Some(usage_window(used / limit * 100.0, minutes, end))
}

fn minutes_between(start: Option<u64>, end: Option<u64>) -> Option<u32> {
    let start = start?;
    let end = end?;
    if end <= start {
        return None;
    }
    Some(((end - start) / 60_000).max(1) as u32)
}

fn parse_opencode_go(data: &Value) -> Vec<UsageWindow> {
    let usage = data.get("usage").unwrap_or(data);
    let mut windows = Vec::new();
    for (key, minutes) in [("rolling", 300), ("weekly", 10_080), ("monthly", 43_200)] {
        if let Some(entry) = usage.get(key) {
            if let Some(percent) = json_f64(entry.get("percent"))
                .or_else(|| json_f64(entry.get("usagePercent")))
                .or_else(|| json_f64(entry.get("usage_percent")))
            {
                windows.push(usage_window(
                    percent,
                    minutes,
                    json_time_ms(entry.get("resetsAt"))
                        .or_else(|| json_time_ms(entry.get("resets_at"))),
                ));
            }
        }
    }
    windows
}

fn claude_creds(home: &Path) -> Option<Creds> {
    let file = read_json(&home.join(".credentials.json"));
    let oauth = file.as_ref().and_then(|value| {
        value
            .get("claudeAiOauth")
            .or_else(|| value.get("claude_ai_oauth"))
    });
    let access = oauth
        .and_then(|value| {
            value
                .get("accessToken")
                .or_else(|| value.get("access_token"))
        })
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
        .or_else(claude_keychain_token)?;
    let refresh = oauth
        .and_then(|value| {
            value
                .get("refreshToken")
                .or_else(|| value.get("refresh_token"))
        })
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string);
    Some(Creds {
        access,
        refresh,
        extra: HeaderMap::new(),
    })
}

fn claude_keychain_token() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("security")
            .args([
                "find-generic-password",
                "-s",
                "Claude Code-credentials",
                "-w",
            ])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let raw = String::from_utf8(output.stdout).ok()?;
        let parsed: Value = serde_json::from_str(raw.trim()).ok()?;
        return parsed
            .pointer("/claudeAiOauth/accessToken")
            .and_then(Value::as_str)
            .map(str::to_string);
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

fn claude_last_limits(home: &Path) -> Vec<UsageWindow> {
    let path = home.join("last_rate_limits.json");
    read_json(&path)
        .map(|value| parse_claude_usage(&value))
        .unwrap_or_default()
}

fn refresh_claude(client: &Client, refresh: &str) -> Option<String> {
    let body = json!({
        "grant_type": "refresh_token",
        "refresh_token": refresh,
        "client_id": CLAUDE_CLIENT_ID,
    });
    let mut headers = HeaderMap::new();
    headers.insert("Content-Type", HeaderValue::from_static("application/json"));
    headers.insert("Accept", HeaderValue::from_static("application/json"));
    let (status, value) = send_json(
        client,
        reqwest::Method::POST,
        CLAUDE_REFRESH_URL,
        &headers,
        Some(&body),
    )
    .ok()?;
    if status >= 400 {
        return None;
    }
    json_access_token(&value)
}

fn fetch_claude(client: &Client, home: &Path, query: &UsageAgentQuery) -> Option<AgentUsage> {
    let creds = claude_creds(home);
    if let Some(ref creds) = creds {
        let mut token = creds.access.clone();
        for _ in 0..2 {
            let headers = header_map(&[
                ("Authorization", &format!("Bearer {token}")),
                ("anthropic-beta", "oauth-2025-04-20"),
                ("User-Agent", "claude-code/2.1.0"),
                ("Accept", "application/json"),
            ]);
            match send_json(
                client,
                reqwest::Method::GET,
                CLAUDE_USAGE_URL,
                &headers,
                None,
            ) {
                Ok((200, value)) => {
                    let windows = parse_claude_usage(&value);
                    if let Some(usage) = ok(query, None, windows) {
                        return Some(usage);
                    }
                    break;
                }
                Ok((401, _)) => {
                    if let Some(refresh) = creds.refresh.as_deref() {
                        if let Some(next) = refresh_claude(client, refresh) {
                            token = next;
                            continue;
                        }
                    }
                    break;
                }
                _ => break,
            }
        }
    }
    let cached = claude_last_limits(home);
    if cached.is_empty() {
        creds.map(|_| failed(query, "could not read Claude usage"))
    } else {
        ok(query, None, cached)
    }
}

fn codex_creds(home: &Path) -> Option<Creds> {
    let auth = read_json(&home.join("auth.json"))?;
    let tokens = auth.get("tokens").unwrap_or(&auth);
    let access = tokens
        .get("access_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|token| !token.is_empty())?
        .to_string();
    let refresh = tokens
        .get("refresh_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string);
    let mut extra = HeaderMap::new();
    if let Some(account) = tokens.get("account_id").and_then(Value::as_str) {
        if let Ok(value) = HeaderValue::from_str(account) {
            extra.insert("ChatGPT-Account-Id", value);
        }
    }
    Some(Creds {
        access,
        refresh,
        extra,
    })
}

fn refresh_codex(client: &Client, refresh: &str) -> Option<String> {
    let value = post_form(
        client,
        CODEX_REFRESH_URL,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", CODEX_CLIENT_ID),
            ("refresh_token", refresh),
        ],
    )
    .ok()?;
    json_access_token(&value)
}

fn fetch_codex(client: &Client, home: &Path, query: &UsageAgentQuery) -> Option<AgentUsage> {
    let creds = codex_creds(home)?;
    let mut token = creds.access.clone();
    for _ in 0..2 {
        let mut headers = header_map(&[
            ("Authorization", &format!("Bearer {token}")),
            ("User-Agent", "codex-cli"),
            ("OpenAI-Beta", "codex-1"),
            ("originator", "Codex Desktop"),
            ("Accept", "application/json"),
        ]);
        headers.extend(creds.extra.clone());
        match send_json(
            client,
            reqwest::Method::GET,
            CODEX_USAGE_URL,
            &headers,
            None,
        ) {
            Ok((200, value)) => {
                let (plan, windows) = parse_codex_usage(&value);
                return ok(query, plan, windows)
                    .or_else(|| Some(failed(query, "Codex returned no rate-limit windows")));
            }
            Ok((401, _)) => {
                if let Some(refresh) = creds.refresh.as_deref() {
                    if let Some(next) = refresh_codex(client, refresh) {
                        token = next;
                        continue;
                    }
                }
                return Some(failed(query, "Codex login expired"));
            }
            Ok((status, _)) => return Some(failed(query, format!("Codex usage HTTP {status}"))),
            Err(err) => return Some(failed(query, err)),
        }
    }
    Some(failed(query, "Codex login expired"))
}

fn gemini_creds(home: &Path) -> Option<Creds> {
    let auth = read_json(&home.join("oauth_creds.json"))?;
    let access = auth
        .get("access_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string);
    let refresh = auth
        .get("refresh_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string);
    if access.is_none() && refresh.is_none() {
        return None;
    }
    Some(Creds {
        access: access.unwrap_or_default(),
        refresh,
        extra: HeaderMap::new(),
    })
}

fn refresh_gemini(client: &Client, refresh: &str) -> Option<String> {
    let value = post_form(
        client,
        GEMINI_TOKEN_URL,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", GEMINI_CLIENT_ID),
            ("client_secret", GEMINI_CLIENT_SECRET),
            ("refresh_token", refresh),
        ],
    )
    .ok()?;
    json_access_token(&value)
}

fn fetch_gemini(client: &Client, home: &Path, query: &UsageAgentQuery) -> Option<AgentUsage> {
    let creds = gemini_creds(home)?;
    let mut token = creds.access.clone();
    if token.is_empty() {
        let Some(refresh) = creds.refresh.as_deref() else {
            return Some(failed(query, "Gemini login expired"));
        };
        match refresh_gemini(client, refresh) {
            Some(next) => token = next,
            None => return Some(failed(query, "Gemini login expired")),
        }
    }
    for _ in 0..2 {
        let headers = header_map(&[
            ("Authorization", &format!("Bearer {token}")),
            ("Content-Type", "application/json"),
            ("Accept", "application/json"),
        ]);
        let load_body = json!({
            "metadata": { "ideType": "GEMINI_CLI", "pluginType": "GEMINI" }
        });
        match send_json(
            client,
            reqwest::Method::POST,
            GEMINI_LOAD_URL,
            &headers,
            Some(&load_body),
        ) {
            Ok((200, value)) => {
                let project = value
                    .get("cloudaicompanionProject")
                    .or_else(|| value.get("cloudAiCompanionProject"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let plan = value
                    .pointer("/currentTier/id")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let quota_body = if project.is_empty() {
                    json!({})
                } else {
                    json!({ "project": project })
                };
                match send_json(
                    client,
                    reqwest::Method::POST,
                    GEMINI_QUOTA_URL,
                    &headers,
                    Some(&quota_body),
                ) {
                    Ok((200, quota)) => {
                        return ok(query, plan, parse_gemini_quota(&quota))
                            .or_else(|| Some(failed(query, "Gemini returned no quota buckets")));
                    }
                    Ok((401, _)) | Ok((403, _))
                        if creds.refresh.is_some() && token == creds.access =>
                    {
                        if let Some(next) = refresh_gemini(client, creds.refresh.as_deref()?) {
                            token = next;
                            continue;
                        }
                    }
                    Ok((qstatus, _)) => {
                        return Some(failed(query, format!("Gemini quota HTTP {qstatus}")));
                    }
                    Err(err) => return Some(failed(query, err)),
                }
            }
            Ok((401, _)) if creds.refresh.is_some() => {
                if let Some(next) = refresh_gemini(client, creds.refresh.as_deref()?) {
                    token = next;
                    continue;
                }
                return Some(failed(query, "Gemini login expired"));
            }
            Ok((status, _)) => return Some(failed(query, format!("Gemini usage HTTP {status}"))),
            Err(err) => return Some(failed(query, err)),
        }
    }
    Some(failed(query, "Gemini login expired"))
}

fn grok_creds(home: &Path) -> Option<Creds> {
    let auth = read_json(&home.join("auth.json"))?;
    if let Some(access) = auth
        .get("access_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|token| !token.is_empty())
    {
        let refresh = auth
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::to_string);
        return Some(Creds {
            access: access.to_string(),
            refresh,
            extra: HeaderMap::new(),
        });
    }
    let object = auth.as_object()?;
    for value in object.values() {
        let access = value
            .get("key")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|token| !token.is_empty());
        if let Some(access) = access {
            let refresh = value
                .get("refresh_token")
                .and_then(Value::as_str)
                .map(str::to_string);
            return Some(Creds {
                access: access.to_string(),
                refresh,
                extra: HeaderMap::new(),
            });
        }
    }
    None
}

fn refresh_grok(client: &Client, refresh: &str) -> Option<String> {
    let value = post_form(
        client,
        GROK_REFRESH_URL,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", GROK_CLIENT_ID),
            ("refresh_token", refresh),
        ],
    )
    .ok()?;
    json_access_token(&value)
}

fn grok_headers(token: &str) -> HeaderMap {
    header_map(&[
        ("Authorization", &format!("Bearer {token}")),
        ("X-XAI-Token-Auth", "xai-grok-cli"),
        ("x-grok-client-identifier", "grok-cli"),
        ("x-grok-client-version", "0.2.93"),
        ("Accept", "application/json"),
        ("User-Agent", "xai-grok-cli"),
    ])
}

fn fetch_grok(client: &Client, home: &Path, query: &UsageAgentQuery) -> Option<AgentUsage> {
    let creds = grok_creds(home)?;
    let mut token = creds.access.clone();
    for _ in 0..2 {
        let headers = grok_headers(&token);
        let credits = send_json(
            client,
            reqwest::Method::GET,
            GROK_CREDITS_URL,
            &headers,
            None,
        );
        match credits {
            Ok((200, value)) => {
                let mut windows = Vec::new();
                if let Some(window) = parse_grok_credits(&value) {
                    windows.push(window);
                }
                if let Ok((200, monthly)) = send_json(
                    client,
                    reqwest::Method::GET,
                    GROK_MONTHLY_URL,
                    &headers,
                    None,
                ) {
                    if let Some(window) = parse_grok_monthly(&monthly) {
                        windows.push(window);
                    }
                }
                let plan = value
                    .pointer("/config/subscriptionTier")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                return ok(query, plan, windows)
                    .or_else(|| Some(failed(query, "Grok returned no billing windows")));
            }
            Ok((401, _)) | Ok((403, _)) => {
                if let Some(refresh) = creds.refresh.as_deref() {
                    if let Some(next) = refresh_grok(client, refresh) {
                        token = next;
                        continue;
                    }
                }
                return Some(failed(query, "Grok login expired"));
            }
            Ok((status, _)) => return Some(failed(query, format!("Grok billing HTTP {status}"))),
            Err(err) => return Some(failed(query, err)),
        }
    }
    Some(failed(query, "Grok login expired"))
}

fn opencode_key(home: &Path) -> Option<String> {
    let mut candidates = vec![home.join("auth.json")];
    if let Some(root) = data_home() {
        candidates.push(root.join("opencode").join("auth.json"));
    }
    if let Some(user) = home_dir() {
        candidates.push(
            user.join(".local")
                .join("share")
                .join("opencode")
                .join("auth.json"),
        );
        candidates.push(user.join(".opencode").join("auth.json"));
    }
    for path in candidates {
        let Some(auth) = read_json(&path) else {
            continue;
        };
        for key in ["opencode-go", "opencode", "zen"] {
            if let Some(entry) = auth.get(key) {
                let token = entry
                    .get("key")
                    .or_else(|| entry.get("apiKey"))
                    .or_else(|| entry.get("api_key"))
                    .or_else(|| entry.get("token"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|token| !token.is_empty());
                if let Some(token) = token {
                    return Some(token.to_string());
                }
            }
        }
    }
    None
}

fn fetch_opencode(client: &Client, home: &Path, query: &UsageAgentQuery) -> Option<AgentUsage> {
    let key = opencode_key(home)?;
    let headers = header_map(&[
        ("Authorization", &format!("Bearer {key}")),
        ("Accept", "application/json"),
    ]);
    match send_json(
        client,
        reqwest::Method::GET,
        OPENCODE_GO_USAGE_URL,
        &headers,
        None,
    ) {
        Ok((200, value)) => ok(query, Some("Go".into()), parse_opencode_go(&value))
            .or_else(|| Some(failed(query, "OpenCode Go returned no usage windows"))),
        Ok((403, _)) => Some(failed(query, "OpenCode Go subscription required")),
        Ok((status, _)) => Some(failed(query, format!("OpenCode Go HTTP {status}"))),
        Err(err) => Some(failed(query, err)),
    }
}

fn fetch_one(client: &Client, app: &AppHandle, query: &UsageAgentQuery) -> Option<AgentUsage> {
    let home = config_home(app, &query.id, query.account_id.as_deref());
    let home = home?;
    match query.id.as_str() {
        "claude" => fetch_claude(client, &home, query),
        "codex" => fetch_codex(client, &home, query),
        "gemini" => fetch_gemini(client, &home, query),
        "grok" => fetch_grok(client, &home, query),
        "opencode" => fetch_opencode(client, &home, query),
        _ => None,
    }
}

#[tauri::command]
pub fn usage_fetch(app: AppHandle, agents: Vec<UsageAgentQuery>) -> UsageSnapshot {
    let fetched_at = now_ms();
    let proxy = app
        .try_state::<crate::vpn::VpnManager>()
        .and_then(|vpn| vpn.http_proxy_url());
    let Ok(client) = http_client(proxy.as_deref()) else {
        return UsageSnapshot {
            agents: Vec::new(),
            fetched_at,
        };
    };

    let mut snapshot = Vec::new();
    std::thread::scope(|scope| {
        let mut joins = Vec::new();
        for query in &agents {
            if !matches!(
                query.id.as_str(),
                "claude" | "codex" | "gemini" | "grok" | "opencode"
            ) {
                continue;
            }
            let app = app.clone();
            let client = client.clone();
            joins.push(scope.spawn(move || fetch_one(&client, &app, query)));
        }
        for join in joins {
            if let Ok(Some(usage)) = join.join() {
                snapshot.push(usage);
            }
        }
    });

    UsageSnapshot {
        agents: snapshot,
        fetched_at,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn claude_oauth_windows() {
        let data = json!({
            "five_hour": { "utilization": 6.0, "resets_at": "2025-11-04T04:59:59Z" },
            "seven_day": { "used_percentage": 35.0, "resets_at": 1762230000 },
            "seven_day_opus": { "utilization": 0.0, "resets_at": null }
        });
        let windows = parse_claude_usage(&data);
        assert_eq!(windows[0].used_percent, 6.0);
        assert_eq!(windows[0].label, "5h");
        assert_eq!(windows[1].used_percent, 35.0);
        assert_eq!(windows[1].label, "wk");
        assert_eq!(windows[2].label, "Opus");
    }

    #[test]
    fn claude_fable_from_limits_array() {
        let data = json!({
            "five_hour": { "utilization": 32.0 },
            "seven_day": { "utilization": 15.0 },
            "limits": [{
                "kind": "weekly_scoped",
                "percent": 3.0,
                "resets_at": "2026-09-16T00:00:00Z",
                "scope": { "model": { "display_name": "Fable" } }
            }]
        });
        let windows = parse_claude_usage(&data);
        assert!(windows
            .iter()
            .any(|window| window.label == "Fable" && window.used_percent == 3.0));
    }

    #[test]
    fn codex_classifies_by_duration_not_position() {
        let data = json!({
            "plan_type": "plus",
            "rate_limit": {
                "primary_window": {
                    "used_percent": 37.0,
                    "limit_window_seconds": 604800,
                    "reset_at": 1780840800
                },
                "secondary_window": null
            }
        });
        let (plan, windows) = parse_codex_usage(&data);
        assert_eq!(plan.as_deref(), Some("plus"));
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].label, "wk");
        assert_eq!(windows[0].used_percent, 37.0);
    }

    #[test]
    fn gemini_buckets_group_by_family() {
        let data = json!({
            "buckets": [
                { "modelId": "gemini-3-flash", "tokenType": "REQUESTS", "remainingFraction": 0.93, "resetTime": "2026-09-15T00:00:00Z" },
                { "modelId": "gemini-3-pro", "tokenType": "REQUESTS", "remainingFraction": 0.90, "resetTime": "2026-09-15T00:00:00Z" },
                { "modelId": "gemini-3-flash-lite", "tokenType": "REQUESTS", "remainingFraction": 0.50, "resetTime": "2026-09-15T00:00:00Z" }
            ]
        });
        let windows = parse_gemini_quota(&data);
        let flash = windows
            .iter()
            .find(|window| window.label == "Flash")
            .unwrap();
        assert!((flash.used_percent - 50.0).abs() < 0.01);
        let pro = windows.iter().find(|window| window.label == "Pro").unwrap();
        assert!((pro.used_percent - 10.0).abs() < 0.01);
    }

    #[test]
    fn grok_credits_and_monthly() {
        let weekly = json!({
            "config": {
                "currentPeriod": {
                    "start": "2026-07-09T09:46:16Z",
                    "end": "2026-07-16T09:46:16Z"
                },
                "creditUsagePercent": 42.5
            }
        });
        let monthly = json!({
            "config": {
                "monthlyLimit": { "val": 16500 },
                "used": { "val": 5092 },
                "billingPeriodStart": "2026-07-01T00:00:00Z",
                "billingPeriodEnd": "2026-08-01T00:00:00Z"
            }
        });
        let week = parse_grok_credits(&weekly).unwrap();
        assert!((week.used_percent - 42.5).abs() < 0.01);
        assert_eq!(week.label, "wk");
        let month = parse_grok_monthly(&monthly).unwrap();
        assert!((month.used_percent - (5092.0 / 16500.0 * 100.0)).abs() < 0.01);
        assert_eq!(month.label, "mo");
    }

    #[test]
    fn opencode_go_three_windows() {
        let data = json!({
            "usage": {
                "rolling": { "percent": 12.0, "resetsAt": "2026-09-14T18:00:00Z" },
                "weekly": { "percent": 40.0, "resetsAt": "2026-09-20T00:00:00Z" },
                "monthly": { "percent": 8.0, "resetsAt": "2026-10-01T00:00:00Z" }
            }
        });
        let windows = parse_opencode_go(&data);
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].label, "5h");
        assert_eq!(windows[1].label, "wk");
        assert_eq!(windows[2].label, "mo");
    }

    #[test]
    fn iso_timestamp_parses() {
        let ms = parse_iso_ms("2026-07-16T09:46:16Z").unwrap();
        assert!(ms > 1_700_000_000_000);
        assert_eq!(ms % 1000, 0);
    }

    fn sample_query(id: &str) -> UsageAgentQuery {
        UsageAgentQuery {
            id: id.into(),
            short: id.chars().take(2).collect::<String>().to_uppercase(),
            name: id.into(),
            accent: String::new(),
            account_id: None,
        }
    }

    #[test]
    #[ignore]
    fn live_provider_smoke() {
        let proxy = std::env::var("KEEL_USAGE_SMOKE_PROXY").ok();
        live_usage_through_proxy(proxy.as_deref());
    }

    pub(crate) fn live_usage_through_proxy(proxy: Option<&str>) {
        let client = http_client(proxy).expect("http client");
        let home = home_dir().expect("home");
        let providers = [
            (
                "claude",
                fetch_claude(&client, &home.join(".claude"), &sample_query("claude")),
            ),
            (
                "codex",
                fetch_codex(&client, &home.join(".codex"), &sample_query("codex")),
            ),
            (
                "gemini",
                fetch_gemini(&client, &home.join(".gemini"), &sample_query("gemini")),
            ),
            (
                "grok",
                fetch_grok(&client, &home.join(".grok"), &sample_query("grok")),
            ),
        ];
        for (id, result) in providers {
            match result {
                Some(usage) => {
                    eprintln!(
                        "{id}: status={} windows={} plan={:?} error={:?}",
                        usage.status,
                        usage.windows.len(),
                        usage.plan,
                        usage.error
                    );
                    for window in &usage.windows {
                        eprintln!("  {} {}%", window.label, window.used_percent as i32);
                    }
                }
                None => eprintln!("{id}: skipped (no credentials)"),
            }
        }
    }
}
