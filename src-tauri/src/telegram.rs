//! Telegram Bot API, the transport for Keel's main agent.
//!
//! Long polling only: no webhook, no open port, so it works behind any router.
//! Every call is blocking and runs on the assistant's own threads.
//!
//! Errors never carry the request URL — the bot token is part of it.

use std::time::Duration;

use reqwest::blocking::Client;
use serde_json::{json, Value};

/// Telegram rejects a message over 4096 characters. Markdown grows a little on
/// its way to HTML, so a chunk is cut well under that.
const CHUNK_CHARS: usize = 3500;
const MESSAGE_LIMIT: usize = 4096;

#[derive(Debug, Clone)]
pub struct ApiError {
    pub code: Option<u16>,
    pub description: String,
    pub retry_after: Option<u64>,
}

impl ApiError {
    fn local(description: impl Into<String>) -> Self {
        Self {
            code: None,
            description: description.into(),
            retry_after: None,
        }
    }

    /// Another client is polling this bot, or a webhook is set.
    pub fn is_conflict(&self) -> bool {
        self.code == Some(409)
    }

    pub fn is_unauthorized(&self) -> bool {
        self.code == Some(401) || self.code == Some(404)
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.description)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    pub update_id: i64,
    pub message_id: i64,
    pub chat_id: i64,
    pub private: bool,
    pub from_id: i64,
    pub from_name: String,
    /// The text, or the caption of a photo or file. Empty for a bare voice note.
    pub text: String,
    /// Unix seconds when it was sent.
    pub date: i64,
    pub media: Option<Media>,
    /// Photos sent together arrive as separate messages sharing this.
    pub media_group: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Photo,
    Voice,
    Audio,
    /// A video, round video message or GIF. Not passed on.
    Video,
    Document,
}

/// Something attached to a message, still on Telegram's servers.
#[derive(Debug, Clone, PartialEq)]
pub struct Media {
    pub kind: MediaKind,
    pub file_id: String,
    pub file_name: Option<String>,
    pub mime: Option<String>,
    /// Bytes, when Telegram says.
    pub size: Option<u64>,
    /// Seconds, for audio.
    pub duration: Option<u64>,
}

impl Media {
    /// A photo, or an image sent as a file to keep its quality.
    pub fn is_image(&self) -> bool {
        self.kind == MediaKind::Photo
            || (self.kind == MediaKind::Document
                && self
                    .mime
                    .as_deref()
                    .is_some_and(|mime| mime.starts_with("image/")))
    }

    /// A voice note, or an audio file (sent as audio or as a file).
    pub fn is_audio(&self) -> bool {
        matches!(self.kind, MediaKind::Voice | MediaKind::Audio)
            || (self.kind == MediaKind::Document
                && self
                    .mime
                    .as_deref()
                    .is_some_and(|mime| mime.starts_with("audio/")))
    }
}

/// Bots may download files up to this size.
pub const DOWNLOAD_LIMIT: u64 = 20 * 1024 * 1024;
/// And send them up to this one.
const UPLOAD_LIMIT: u64 = 50 * 1024 * 1024;
/// Over this, a picture has to go as a document.
const PHOTO_LIMIT: u64 = 10 * 1024 * 1024;
const CAPTION_LIMIT: usize = 1024;

/// How Telegram can show a file in the chat, if it can: the method and its
/// file field. Pictures as photos; mp4, the one format Telegram documents for
/// videos, as a video that plays in place instead of a file to download.
fn shown_inline(path: &std::path::Path, size: u64) -> Option<(&'static str, &'static str)> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" | "png" | "webp" if size <= PHOTO_LIMIT => Some(("sendPhoto", "photo")),
        "mp4" => Some(("sendVideo", "video")),
        _ => None,
    }
}

/// Digits, a colon, then the secret. Anything else could escape the URL path.
pub fn valid_token(token: &str) -> bool {
    let Some((id, secret)) = token.split_once(':') else {
        return false;
    };
    !id.is_empty()
        && id.chars().all(|ch| ch.is_ascii_digit())
        && secret.len() >= 20
        && secret
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

pub struct Bot {
    client: Client,
    base: String,
    files: String,
}

impl Bot {
    pub fn new(token: &str, proxy: Option<String>) -> Result<Self, ApiError> {
        if !valid_token(token) {
            return Err(ApiError::local("That doesn't look like a bot token."));
        }
        // Long polls hold the request open for up to 25 seconds.
        let mut builder = Client::builder().timeout(Duration::from_secs(40));
        if let Some(url) = proxy.filter(|url| !url.is_empty()) {
            let proxy = reqwest::Proxy::all(url).map_err(|err| ApiError::local(err.to_string()))?;
            builder = builder.proxy(proxy);
        }
        let client = builder
            .build()
            .map_err(|err| ApiError::local(err.without_url().to_string()))?;
        // Debug builds can talk to a stand-in server, so the whole loop can be
        // exercised without a real bot. Release builds always use Telegram.
        #[cfg(debug_assertions)]
        let api = std::env::var("KEEL_TELEGRAM_API")
            .unwrap_or_else(|_| "https://api.telegram.org".into());
        #[cfg(not(debug_assertions))]
        let api = "https://api.telegram.org";
        Ok(Self {
            client,
            base: format!("{}/bot{token}", api.trim_end_matches('/')),
            files: format!("{}/file/bot{token}", api.trim_end_matches('/')),
        })
    }

    fn call(&self, method: &str, body: Value) -> Result<Value, ApiError> {
        let response = self
            .client
            .post(format!("{}/{method}", self.base))
            .json(&body)
            .send()
            .map_err(|err| ApiError::local(describe_transport(err)))?;
        Self::result(response)
    }

    fn result(response: reqwest::blocking::Response) -> Result<Value, ApiError> {
        let status = response.status().as_u16();
        let value: Value = response
            .json()
            .map_err(|err| ApiError::local(err.without_url().to_string()))?;
        if value.get("ok").and_then(Value::as_bool) == Some(true) {
            return Ok(value.get("result").cloned().unwrap_or(Value::Null));
        }
        Err(ApiError {
            code: value
                .get("error_code")
                .and_then(Value::as_u64)
                .and_then(|code| u16::try_from(code).ok())
                .or(Some(status)),
            description: value
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("Telegram refused the request.")
                .to_string(),
            retry_after: value
                .pointer("/parameters/retry_after")
                .and_then(Value::as_u64),
        })
    }

    /// The bot's @username.
    pub fn get_me(&self) -> Result<String, ApiError> {
        let me = self.call("getMe", json!({}))?;
        Ok(me
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string())
    }

    /// Text messages after `offset`, waiting up to `timeout` seconds for one.
    /// Returns the next offset alongside, so updates without text are skipped too.
    pub fn get_updates(&self, offset: i64, timeout: u64) -> Result<(Vec<Message>, i64), ApiError> {
        let result = self.call(
            "getUpdates",
            json!({ "offset": offset, "timeout": timeout, "allowed_updates": ["message"] }),
        )?;
        let mut next = offset;
        let mut messages = Vec::new();
        for update in result.as_array().into_iter().flatten() {
            let Some(id) = update.get("update_id").and_then(Value::as_i64) else {
                continue;
            };
            next = next.max(id + 1);
            if let Some(message) = parse_message(id, update) {
                messages.push(message);
            }
        }
        Ok((messages, next))
    }

    pub fn send(&self, chat_id: i64, text: &str, html: bool) -> Result<i64, ApiError> {
        let mut body = json!({
            "chat_id": chat_id,
            "text": text,
            "link_preview_options": { "is_disabled": true },
        });
        if html {
            body["parse_mode"] = json!("HTML");
        }
        let sent = self.call("sendMessage", body)?;
        Ok(sent.get("message_id").and_then(Value::as_i64).unwrap_or(0))
    }

    /// Agent Markdown, split to fit and formatted for Telegram. A chunk Telegram
    /// cannot parse goes again as plain text rather than not at all.
    pub fn send_markdown(&self, chat_id: i64, markdown: &str) -> Result<(), ApiError> {
        for chunk in chunk_markdown(markdown, CHUNK_CHARS) {
            let html = markdown_to_html(&chunk);
            let sent = if html.chars().count() <= MESSAGE_LIMIT {
                self.send(chat_id, &html, true)
            } else {
                Err(ApiError::local("too long once formatted"))
            };
            match sent {
                Ok(_) => {}
                Err(err) if err.code == Some(429) => return Err(err),
                Err(_) => {
                    self.send(chat_id, &chunk, false)?;
                }
            }
        }
        Ok(())
    }

    /// Upload a file from this PC. Pictures go as photos and mp4s as videos,
    /// shown in the chat, unless a picture is over Telegram's photo limit or
    /// Telegram turns the file down as one (odd dimensions, a codec it can't
    /// play); then, like everything else, as a document.
    pub fn send_file(
        &self,
        chat_id: i64,
        path: &std::path::Path,
        caption: Option<&str>,
    ) -> Result<(), ApiError> {
        let size = std::fs::metadata(path)
            .map_err(|err| ApiError::local(err.to_string()))?
            .len();
        if size > UPLOAD_LIMIT {
            return Err(ApiError::local(
                "The file is over Telegram's 50 MB limit for bots.",
            ));
        }
        if let Some((method, field)) = shown_inline(path, size) {
            match self.upload(chat_id, method, field, path, caption) {
                Err(err) if err.code == Some(400) => {}
                other => return other,
            }
        }
        self.upload(chat_id, "sendDocument", "document", path, caption)
    }

    fn upload(
        &self,
        chat_id: i64,
        method: &str,
        field: &str,
        path: &std::path::Path,
        caption: Option<&str>,
    ) -> Result<(), ApiError> {
        let part = reqwest::blocking::multipart::Part::file(path)
            .map_err(|err| ApiError::local(err.to_string()))?;
        let mut form = reqwest::blocking::multipart::Form::new()
            .text("chat_id", chat_id.to_string())
            .part(field.to_string(), part);
        if let Some(caption) = caption.map(str::trim).filter(|text| !text.is_empty()) {
            form = form.text(
                "caption",
                caption.chars().take(CAPTION_LIMIT).collect::<String>(),
            );
        }
        if field == "video" {
            // Plays while it downloads, instead of after.
            form = form.text("supports_streaming", "true");
        }
        let response = self
            .client
            .post(format!("{}/{method}", self.base))
            .multipart(form)
            .timeout(Duration::from_secs(300))
            .send()
            .map_err(|err| ApiError::local(describe_transport(err)))?;
        Self::result(response).map(|_| ())
    }

    /// "typing…" under the bot's name, for about five seconds.
    pub fn typing(&self, chat_id: i64) {
        let _ = self.call(
            "sendChatAction",
            json!({ "chat_id": chat_id, "action": "typing" }),
        );
    }

    /// Download an attachment to `dest`. Telegram serves bots files up to 20 MB.
    pub fn download(&self, file_id: &str, dest: &std::path::Path) -> Result<u64, ApiError> {
        let file = self.call("getFile", json!({ "file_id": file_id }))?;
        let path = file
            .get("file_path")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::local("Telegram didn't say where the file is."))?;
        if path.contains("..") {
            return Err(ApiError::local("Telegram gave an odd file path."));
        }
        let mut response = self
            .client
            .get(format!("{}/{path}", self.files))
            .timeout(Duration::from_secs(120))
            .send()
            .map_err(|err| ApiError::local(describe_transport(err)))?;
        if !response.status().is_success() {
            return Err(ApiError::local(format!(
                "Couldn't download the file ({}).",
                response.status().as_u16()
            )));
        }
        let mut out =
            std::fs::File::create(dest).map_err(|err| ApiError::local(err.to_string()))?;
        let copied = std::io::copy(
            &mut std::io::Read::take(&mut response, DOWNLOAD_LIMIT + 1),
            &mut out,
        )
        .map_err(|err| ApiError::local(err.to_string()))?;
        if copied > DOWNLOAD_LIMIT {
            drop(out);
            let _ = std::fs::remove_file(dest);
            return Err(ApiError::local(
                "The file is over Telegram's 20 MB limit for bots.",
            ));
        }
        Ok(copied)
    }

    pub fn set_commands(&self, commands: &[(&str, &str)]) {
        let commands: Vec<Value> = commands
            .iter()
            .map(|(command, description)| json!({ "command": command, "description": description }))
            .collect();
        let _ = self.call("setMyCommands", json!({ "commands": commands }));
    }
}

fn describe_transport(err: reqwest::Error) -> String {
    if err.is_timeout() {
        "Telegram didn't answer in time.".into()
    } else if err.is_connect() {
        "Couldn't reach Telegram.".into()
    } else {
        err.without_url().to_string()
    }
}

fn parse_message(update_id: i64, update: &Value) -> Option<Message> {
    let message = update.get("message")?;
    let chat = message.get("chat")?;
    let from = message.get("from")?;
    let first = from.get("first_name").and_then(Value::as_str).unwrap_or("");
    let username = from.get("username").and_then(Value::as_str).unwrap_or("");
    let text = message
        .get("text")
        .or_else(|| message.get("caption"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let media = parse_media(message);
    if text.is_empty() && media.is_none() {
        return None;
    }
    Some(Message {
        update_id,
        message_id: message.get("message_id")?.as_i64()?,
        chat_id: chat.get("id")?.as_i64()?,
        private: chat.get("type").and_then(Value::as_str) == Some("private"),
        from_id: from.get("id")?.as_i64()?,
        from_name: if first.is_empty() { username } else { first }.to_string(),
        text,
        date: message.get("date").and_then(Value::as_i64).unwrap_or(0),
        media,
        media_group: message
            .get("media_group_id")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

fn parse_media(message: &Value) -> Option<Media> {
    let field =
        |value: &Value, key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    let number = |value: &Value, key: &str| value.get(key).and_then(Value::as_u64);
    let attached = |kind: MediaKind, value: &Value| {
        Some(Media {
            kind,
            file_id: field(value, "file_id")?,
            file_name: field(value, "file_name"),
            mime: field(value, "mime_type"),
            size: number(value, "file_size"),
            duration: number(value, "duration"),
        })
    };
    // Telegram sends every size of a photo; the last is the largest.
    if let Some(photo) = message
        .get("photo")
        .and_then(Value::as_array)
        .and_then(|sizes| sizes.last())
    {
        return attached(MediaKind::Photo, photo);
    }
    // A GIF also carries a `document`; it has to be seen as a video first.
    for (key, kind) in [
        ("voice", MediaKind::Voice),
        ("audio", MediaKind::Audio),
        ("video_note", MediaKind::Video),
        ("animation", MediaKind::Video),
        ("video", MediaKind::Video),
        ("document", MediaKind::Document),
    ] {
        if let Some(value) = message.get(key) {
            return attached(kind, value);
        }
    }
    None
}

/// Split Markdown into pieces of at most `max` characters, on line breaks where
/// it can. A code fence cut in two is closed and reopened so both halves render.
pub fn chunk_markdown(markdown: &str, max: usize) -> Vec<String> {
    let max = max.max(64);
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut fence: Option<String> = None;

    let flush = |current: &mut String, chunks: &mut Vec<String>, fence: &Option<String>| {
        if current.trim().is_empty() {
            current.clear();
            return;
        }
        if fence.is_some() {
            current.push_str("```");
        }
        chunks.push(std::mem::take(current).trim_end().to_string());
        if let Some(open) = fence {
            current.push_str(open);
            current.push('\n');
        }
    };

    for line in markdown.lines() {
        let mut line = line;
        // A single line longer than a whole chunk is cut by characters.
        while line.chars().count() > max - 8 {
            let cut = line
                .char_indices()
                .nth(max - 8)
                .map(|(index, _)| index)
                .unwrap_or(line.len());
            flush(&mut current, &mut chunks, &fence);
            current.push_str(&line[..cut]);
            current.push('\n');
            line = &line[cut..];
        }
        if current.chars().count() + line.chars().count() + 4 > max {
            flush(&mut current, &mut chunks, &fence);
        }
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            fence = match fence {
                Some(_) => None,
                None => Some(trimmed.to_string()),
            };
        }
        current.push_str(line);
        current.push('\n');
    }
    if !current.trim().is_empty() {
        chunks.push(current.trim_end().to_string());
    }
    if chunks.is_empty() {
        chunks.push(String::new());
    }
    chunks
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The Markdown agents write, as the HTML subset Telegram renders: bold, italic,
/// strikethrough, code, fenced blocks, links, headings and quotes. Every tag it
/// opens it closes; anything it does not recognise is escaped text.
pub fn markdown_to_html(markdown: &str) -> String {
    let mut out = String::new();
    let mut lines = markdown.lines().peekable();
    let mut first = true;

    while let Some(line) = lines.next() {
        if !first {
            out.push('\n');
        }
        first = false;
        let trimmed = line.trim_start();

        if let Some(info) = trimmed.strip_prefix("```") {
            let lang: String = info
                .trim()
                .chars()
                .take_while(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '+' | '#' | '_'))
                .collect();
            if lang.is_empty() {
                out.push_str("<pre>");
            } else {
                out.push_str(&format!("<pre><code class=\"language-{lang}\">"));
            }
            let mut body = Vec::new();
            for inner in lines.by_ref() {
                if inner.trim_start().starts_with("```") {
                    break;
                }
                body.push(escape(inner));
            }
            out.push_str(&body.join("\n"));
            out.push_str(if lang.is_empty() {
                "</pre>"
            } else {
                "</code></pre>"
            });
            continue;
        }

        if trimmed.starts_with('>') {
            let mut quoted = vec![inline(trimmed.trim_start_matches('>').trim_start())];
            while let Some(next) = lines.peek() {
                let next = next.trim_start();
                if !next.starts_with('>') {
                    break;
                }
                quoted.push(inline(next.trim_start_matches('>').trim_start()));
                lines.next();
            }
            out.push_str("<blockquote>");
            out.push_str(&quoted.join("\n"));
            out.push_str("</blockquote>");
            continue;
        }

        let hashes = trimmed.chars().take_while(|ch| *ch == '#').count();
        if (1..=6).contains(&hashes) && trimmed[hashes..].starts_with(' ') {
            out.push_str("<b>");
            out.push_str(&inline(trimmed[hashes..].trim()));
            out.push_str("</b>");
            continue;
        }

        if is_rule(trimmed) {
            out.push_str("──────────");
            continue;
        }

        let indent = &line[..line.len() - trimmed.len()];
        if let Some(rest) = ["- ", "* ", "+ "]
            .iter()
            .find_map(|bullet| trimmed.strip_prefix(bullet))
        {
            out.push_str(indent);
            out.push_str("• ");
            out.push_str(&inline(rest));
            continue;
        }

        out.push_str(&inline(line));
    }
    out
}

fn is_rule(line: &str) -> bool {
    let compact: String = line.chars().filter(|ch| !ch.is_whitespace()).collect();
    compact.len() >= 3
        && ['-', '*', '_']
            .iter()
            .any(|mark| compact.chars().all(|ch| ch == *mark))
}

/// Inline spans within one line.
fn inline(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut i = 0;

    while i < chars.len() {
        let ch = chars[i];

        if ch == '`' {
            if let Some(end) = find(&chars, i + 1, &['`']) {
                let code: String = chars[i + 1..end].iter().collect();
                out.push_str("<code>");
                out.push_str(&escape(&code));
                out.push_str("</code>");
                i = end + 1;
                continue;
            }
        }

        let double = [
            (&['*', '*'][..], "b"),
            (&['_', '_'][..], "b"),
            (&['~', '~'][..], "s"),
        ]
        .into_iter()
        .find_map(|(mark, tag)| {
            if !chars[i..].starts_with(mark) || !opens(&chars, i + 2) {
                return None;
            }
            find_closing(&chars, i + 2, mark).map(|end| (tag, end))
        });
        if let Some((tag, end)) = double {
            let inner: String = chars[i + 2..end].iter().collect();
            out.push_str(&format!("<{tag}>{}</{tag}>", inline(&inner)));
            i = end + 2;
            continue;
        }

        if (ch == '*' || ch == '_')
            && opens(&chars, i + 1)
            && (ch == '*' || boundary(&chars, i, -1))
        {
            if let Some(end) = find_closing(&chars, i + 1, &[ch]) {
                if ch == '*' || boundary(&chars, end, 1) {
                    let inner: String = chars[i + 1..end].iter().collect();
                    out.push_str(&format!("<i>{}</i>", inline(&inner)));
                    i = end + 1;
                    continue;
                }
            }
        }

        if ch == '[' {
            if let Some((label, url, end)) = link(&chars, i) {
                out.push_str(&format!(
                    "<a href=\"{}\">{}</a>",
                    escape(&url).replace('"', "&quot;"),
                    inline(&label)
                ));
                i = end;
                continue;
            }
        }

        out.push_str(&escape(&ch.to_string()));
        i += 1;
    }
    out
}

/// An opening marker must be followed by something other than a space.
fn opens(chars: &[char], at: usize) -> bool {
    chars.get(at).is_some_and(|ch| !ch.is_whitespace())
}

/// `_` only counts at a word edge, so snake_case stays snake_case.
fn boundary(chars: &[char], at: usize, step: isize) -> bool {
    let index = at as isize + step;
    if index < 0 {
        return true;
    }
    chars
        .get(index as usize)
        .is_none_or(|ch| !ch.is_alphanumeric())
}

fn find(chars: &[char], from: usize, mark: &[char]) -> Option<usize> {
    (from..chars.len()).find(|&index| chars[index..].starts_with(mark))
}

/// A closing marker follows something other than a space, and is not empty.
fn find_closing(chars: &[char], from: usize, mark: &[char]) -> Option<usize> {
    (from + 1..chars.len())
        .find(|&index| chars[index..].starts_with(mark) && !chars[index - 1].is_whitespace())
}

fn link(chars: &[char], at: usize) -> Option<(String, String, usize)> {
    let close = find(chars, at + 1, &[']'])?;
    if chars.get(close + 1) != Some(&'(') {
        return None;
    }
    let end = find(chars, close + 2, &[')'])?;
    let url: String = chars[close + 2..end].iter().collect();
    if !(url.starts_with("https://") || url.starts_with("http://"))
        || url.contains(char::is_whitespace)
    {
        return None;
    }
    Some((chars[at + 1..close].iter().collect(), url, end + 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_checked_before_they_reach_a_url() {
        assert!(valid_token("123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"));
        assert!(!valid_token("123456789:short"));
        assert!(!valid_token("abc:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"));
        assert!(!valid_token("123:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/../x"));
        assert!(!valid_token("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"));
    }

    #[test]
    fn formats_the_markdown_agents_write() {
        assert_eq!(
            markdown_to_html("**Done.** Ran `pnpm test` & it <passed>."),
            "<b>Done.</b> Ran <code>pnpm test</code> &amp; it &lt;passed&gt;."
        );
        assert_eq!(markdown_to_html("## Summary"), "<b>Summary</b>");
        assert_eq!(markdown_to_html("- one\n  * two"), "• one\n  • two");
        assert_eq!(
            markdown_to_html("see [docs](https://x.dev/a?b=1&c=2)"),
            "see <a href=\"https://x.dev/a?b=1&amp;c=2\">docs</a>"
        );
        assert_eq!(
            markdown_to_html("an *aside* and ~~old~~"),
            "an <i>aside</i> and <s>old</s>"
        );
    }

    #[test]
    fn leaves_identifiers_and_loose_marks_alone() {
        assert_eq!(markdown_to_html("snake_case_name"), "snake_case_name");
        assert_eq!(markdown_to_html("2 * 3 * 4"), "2 * 3 * 4");
        assert_eq!(markdown_to_html("a ** b"), "a ** b");
        assert_eq!(
            markdown_to_html("[x](javascript:alert(1))"),
            "[x](javascript:alert(1))"
        );
    }

    #[test]
    fn code_blocks_are_escaped_and_closed() {
        assert_eq!(
            markdown_to_html("```rust\nlet a = b < c;\n```"),
            "<pre><code class=\"language-rust\">let a = b &lt; c;</code></pre>"
        );
        assert_eq!(
            markdown_to_html("```\n**not bold**"),
            "<pre>**not bold**</pre>"
        );
        assert_eq!(
            markdown_to_html("> quoted\n> twice"),
            "<blockquote>quoted\ntwice</blockquote>"
        );
    }

    #[test]
    fn chunks_fit_and_reopen_a_split_fence() {
        let body: String = (0..200).map(|n| format!("line {n}\n")).collect();
        let markdown = format!("intro\n```\n{body}```\nafter");
        let chunks = chunk_markdown(&markdown, 300);
        assert!(chunks.len() > 1);
        for chunk in &chunks {
            assert!(chunk.chars().count() <= 300, "{}", chunk.len());
            assert_eq!(chunk.matches("```").count() % 2, 0, "{chunk}");
        }
        assert!(chunks.last().unwrap().ends_with("after"));
    }

    #[test]
    fn a_single_huge_line_is_cut() {
        let line = "x".repeat(1000);
        let chunks = chunk_markdown(&line, 300);
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 300));
        assert_eq!(chunks.concat().len(), 1000);
    }

    #[test]
    fn reads_text_messages_from_updates() {
        let update = json!({
            "update_id": 7,
            "message": {
                "message_id": 3,
                "chat": { "id": 42, "type": "private" },
                "from": { "id": 42, "first_name": "Ale", "username": "ale" },
                "text": "hi"
            }
        });
        let message = parse_message(7, &update).unwrap();
        assert_eq!(message.chat_id, 42);
        assert!(message.private);
        assert_eq!(message.from_name, "Ale");
        assert!(parse_message(8, &json!({ "update_id": 8, "edited_message": {} })).is_none());
    }

    fn with(extra: Value) -> Value {
        let mut message = json!({
            "message_id": 3,
            "chat": { "id": 42, "type": "private" },
            "from": { "id": 42, "first_name": "Ale" },
        });
        for (key, value) in extra.as_object().unwrap() {
            message[key] = value.clone();
        }
        json!({ "update_id": 9, "message": message })
    }

    #[test]
    fn reads_attachments() {
        let voice = parse_message(9, &with(json!({
            "voice": { "file_id": "v1", "duration": 7, "mime_type": "audio/ogg", "file_size": 17831 }
        })))
        .unwrap();
        assert_eq!(voice.text, "");
        let media = voice.media.unwrap();
        assert!(media.is_audio());
        assert_eq!(media.duration, Some(7));

        let photo = parse_message(
            9,
            &with(json!({
                "caption": "what's wrong here?",
                "media_group_id": "g1",
                "photo": [
                    { "file_id": "small", "width": 90, "height": 90 },
                    { "file_id": "large", "width": 1280, "height": 1280, "file_size": 120000 }
                ]
            })),
        )
        .unwrap();
        assert_eq!(photo.text, "what's wrong here?");
        assert_eq!(photo.media_group.as_deref(), Some("g1"));
        let media = photo.media.unwrap();
        assert_eq!(media.file_id, "large");
        assert!(media.is_image());

        let screenshot = parse_message(
            9,
            &with(json!({
                "document": { "file_id": "d1", "file_name": "shot.png", "mime_type": "image/png" }
            })),
        )
        .unwrap();
        assert!(screenshot.media.unwrap().is_image());

        let gif = parse_message(
            9,
            &with(json!({
                "animation": { "file_id": "a1", "duration": 2 },
                "document": { "file_id": "a1", "file_name": "x.mp4", "mime_type": "video/mp4" }
            })),
        )
        .unwrap();
        let media = gif.media.unwrap();
        assert_eq!(media.kind, MediaKind::Video);
        assert!(!media.is_image() && !media.is_audio());

        assert!(parse_message(9, &with(json!({ "sticker": { "file_id": "s" } }))).is_none());
    }

    /// A stand-in Bot API that answers one request and hands back what it got.
    fn stand_in(reply: &'static str) -> (Bot, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_millis(500)))
                .unwrap();
            let mut got = Vec::new();
            let mut buffer = [0u8; 8192];
            while let Ok(read) = stream.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                got.extend_from_slice(&buffer[..read]);
            }
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
            String::from_utf8_lossy(&got).into_owned()
        });
        let bot = Bot {
            client: Client::new(),
            base: format!("http://127.0.0.1:{port}/botTEST"),
            files: String::new(),
        };
        (bot, server)
    }

    #[test]
    fn pictures_and_videos_show_in_the_chat_and_the_rest_go_as_documents() {
        let dir = std::env::temp_dir().join(format!("keel-tg-upload-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let shot = dir.join("shot.png");
        std::fs::write(&shot, b"not really a png").unwrap();

        let (bot, server) = stand_in(r#"{"ok":true,"result":{"message_id":5}}"#);
        bot.send_file(42, &shot, Some("the bug")).unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /botTEST/sendPhoto "), "{request}");
        assert!(request.contains("name=\"chat_id\"\r\n\r\n42"));
        assert!(request.contains("name=\"caption\"\r\n\r\nthe bug"));
        assert!(request.contains("name=\"photo\"; filename=\"shot.png\""));
        assert!(request.contains("not really a png"));

        let log = dir.join("build.log");
        std::fs::write(&log, b"ok").unwrap();
        let (bot, server) = stand_in(r#"{"ok":true,"result":{"message_id":6}}"#);
        bot.send_file(42, &log, None).unwrap();
        let request = server.join().unwrap();
        assert!(
            request.starts_with("POST /botTEST/sendDocument "),
            "{request}"
        );
        assert!(request.contains("name=\"document\"; filename=\"build.log\""));
        assert!(!request.contains("name=\"caption\""));

        // A recording plays in the chat rather than arriving as a download.
        let clip = dir.join("chaff-preview.mp4");
        std::fs::write(&clip, b"not really a video").unwrap();
        let (bot, server) = stand_in(r#"{"ok":true,"result":{"message_id":7}}"#);
        bot.send_file(42, &clip, Some("the chaff")).unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /botTEST/sendVideo "), "{request}");
        assert!(request.contains("name=\"video\"; filename=\"chaff-preview.mp4\""));
        assert!(request.contains("name=\"supports_streaming\"\r\n\r\ntrue"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
