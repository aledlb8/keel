//! Files the editor shows rather than edits: images, audio, video, PDFs and
//! fonts, and the raw bytes of anything else.
//!
//! Media reaches the webview through the `keel-file` scheme, so a video seeks
//! by asking for the bytes it needs instead of being read whole. A request
//! names an open project and a path inside it, and passes the same checks as
//! `workspace_read`: an allowlisted root, no `..` out of it, nothing in `.git`.

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Runtime, UriSchemeContext, UriSchemeResponder};

use crate::paths::{normalize_rel, rejects_git_open, resolve_existing};

pub const SCHEME: &str = "keel-file";

/// The most one open-ended range request returns. A video asks for `bytes=0-`
/// and then for what it needs next; it does not need the whole file at once.
const RANGE_CHUNK: u64 = 4 * 1024 * 1024;
/// A response is one buffer in memory. Whole-file reads stop here.
const MAX_WHOLE: u64 = 512 * 1024 * 1024;
/// The most `workspace_read_bytes` returns per call.
const MAX_BYTES: u64 = 256 * 1024;

/// What a file is, from its first bytes. Only consulted for files that are
/// already binary, so a text file that happens to start with `BM` stays text.
pub fn sniff(head: &[u8]) -> Option<&'static str> {
    let starts = |magic: &[u8]| head.starts_with(magic);
    let at = |offset: usize, magic: &[u8]| {
        head.get(offset..offset + magic.len())
            .is_some_and(|bytes| bytes == magic)
    };
    if starts(b"SQLite format 3\0") {
        return Some("sqlite");
    }
    if starts(b"%PDF-") {
        return Some("pdf");
    }
    if starts(b"\x89PNG\r\n\x1a\n")
        || starts(b"\xFF\xD8\xFF")
        || starts(b"GIF87a")
        || starts(b"GIF89a")
        || starts(b"BM")
        || starts(b"\0\0\x01\0")
        || (starts(b"RIFF") && at(8, b"WEBP"))
    {
        return Some("image");
    }
    if starts(b"RIFF") && at(8, b"WAVE") {
        return Some("audio");
    }
    if starts(b"RIFF") && at(8, b"AVI ") {
        return Some("video");
    }
    if at(4, b"ftyp") {
        let brand = head.get(8..12).unwrap_or_default();
        return Some(match brand {
            b"avif" | b"avis" | b"heic" | b"heix" | b"mif1" | b"msf1" => "image",
            b"M4A " | b"M4B " | b"M4P " => "audio",
            _ => "video",
        });
    }
    if starts(b"\x1A\x45\xDF\xA3") {
        return Some("video");
    }
    if starts(b"OggS")
        || starts(b"ID3")
        || starts(b"fLaC")
        || (head.len() >= 2 && head[0] == 0xFF && (head[1] & 0xF6) == 0xF0)
        || (head.len() >= 2 && head[0] == 0xFF && (head[1] & 0xE6) == 0xE2)
    {
        return Some("audio");
    }
    if starts(b"wOFF") || starts(b"wOF2") || starts(b"OTTO") || starts(b"\0\x01\0\0") {
        return Some("font");
    }
    None
}

fn mime_for(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" | "apng" => "image/png",
        "jpg" | "jpeg" | "jfif" | "pjpeg" | "pjp" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" | "cur" => "image/x-icon",
        "svg" => "image/svg+xml",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "weba" => "audio/webm",
        "pdf" => "application/pdf",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

/// A file inside an open project that the webview may read.
fn resolve_file(root: &str, rel: &str) -> Result<PathBuf, String> {
    let root = crate::roots::require(root)?;
    rejects_git_open(&normalize_rel(rel)?)?;
    let path = resolve_existing(&root, rel)?;
    if path.is_dir() {
        return Err(format!("{} is a folder", path.display()));
    }
    Ok(path)
}

fn read_at(path: &Path, offset: u64, length: u64) -> Result<Vec<u8>, String> {
    let mut file = File::open(path).map_err(|err| err.to_string())?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|err| err.to_string())?;
    let mut buf = Vec::with_capacity(length as usize);
    file.take(length)
        .read_to_end(&mut buf)
        .map_err(|err| err.to_string())?;
    Ok(buf)
}

/// Up to `length` bytes from `offset`, for the byte view. Raw, not JSON.
#[tauri::command]
pub async fn workspace_read_bytes(
    root: String,
    rel: String,
    offset: u64,
    length: u64,
) -> Result<tauri::ipc::Response, String> {
    let bytes = crate::blocking::run(move || {
        let path = resolve_file(&root, &rel)?;
        read_at(&path, offset, length.min(MAX_BYTES))
    })
    .await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// The first range of a `Range` header, as inclusive offsets clamped to the
/// file. `Err` means the range cannot be served (416); `Ok(None)`, no usable
/// range — serve the whole file.
fn parse_range(header: &str, size: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(spec) = header.trim().strip_prefix("bytes=") else {
        return Ok(None);
    };
    let first = spec.split(',').next().unwrap_or("").trim();
    let Some((start, end)) = first.split_once('-') else {
        return Ok(None);
    };
    let (start, end) = (start.trim(), end.trim());
    if start.is_empty() {
        // `bytes=-500`: the last 500 bytes.
        let suffix: u64 = end.parse().map_err(|_| ())?;
        if suffix == 0 || size == 0 {
            return Err(());
        }
        return Ok(Some((size.saturating_sub(suffix), size - 1)));
    }
    let start: u64 = start.parse().map_err(|_| ())?;
    if start >= size {
        return Err(());
    }
    let end = if end.is_empty() {
        (start + RANGE_CHUNK - 1).min(size - 1)
    } else {
        let end: u64 = end.parse().map_err(|_| ())?;
        if end < start {
            return Err(());
        }
        end.min(size - 1)
    };
    Ok(Some((start, end)))
}

fn query_param(query: &str, key: &str) -> Option<String> {
    url::form_urlencoded::parse(query.as_bytes())
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.into_owned())
}

fn plain(status: StatusCode, message: impl Into<String>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(message.into().into_bytes())
        .unwrap_or_default()
}

fn serve(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let query = request.uri().query().unwrap_or("");
    let (Some(root), Some(rel)) = (query_param(query, "root"), query_param(query, "rel")) else {
        return plain(StatusCode::BAD_REQUEST, "Name a project and a file.");
    };
    let path = match resolve_file(&root, &rel) {
        Ok(path) => path,
        Err(err) => return plain(StatusCode::NOT_FOUND, err),
    };
    let size = match fs::metadata(&path) {
        Ok(meta) => meta.len(),
        Err(err) => return plain(StatusCode::NOT_FOUND, err.to_string()),
    };
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(|value| parse_range(value, size))
        .unwrap_or(Ok(None));
    let builder = Response::builder()
        .header(header::CONTENT_TYPE, mime_for(&path))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    let response = match range {
        Err(()) => builder
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{size}"))
            .body(Vec::new()),
        Ok(Some((start, end))) => match read_at(&path, start, end - start + 1) {
            Ok(bytes) => builder
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"))
                .body(bytes),
            Err(err) => return plain(StatusCode::INTERNAL_SERVER_ERROR, err),
        },
        Ok(None) if size > MAX_WHOLE => {
            return plain(
                StatusCode::PAYLOAD_TOO_LARGE,
                "This file is too large to show.",
            )
        }
        Ok(None) => match fs::read(&path) {
            Ok(bytes) => builder.status(StatusCode::OK).body(bytes),
            Err(err) => return plain(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
        },
    };
    response.unwrap_or_else(|err| plain(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()))
}

/// The `keel-file` handler. Disk reads happen off the webview's thread.
pub fn protocol<R: Runtime>(
    _context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    tauri::async_runtime::spawn_blocking(move || responder.respond(serve(&request)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_common_formats() {
        assert_eq!(sniff(b"SQLite format 3\0\x10\0"), Some("sqlite"));
        assert_eq!(sniff(b"%PDF-1.7\n"), Some("pdf"));
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR"), Some("image"));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some("image"));
        assert_eq!(sniff(b"RIFF\0\0\0\0WAVEfmt "), Some("audio"));
        assert_eq!(sniff(b"\0\0\0\x20ftypisom\0\0\x02\0"), Some("video"));
        assert_eq!(sniff(b"\0\0\0\x1cftypavif\0\0\0\0"), Some("image"));
        assert_eq!(sniff(b"\0\0\0\x20ftypM4A \0\0\0\0"), Some("audio"));
        assert_eq!(sniff(b"\x1A\x45\xDF\xA3\x9f"), Some("video"));
        assert_eq!(sniff(b"ID3\x03\0\0\0"), Some("audio"));
        assert_eq!(sniff(b"wOF2\0\x01\0\0"), Some("font"));
        assert_eq!(sniff(b"MZ\x90\0\x03\0"), None);
        assert_eq!(sniff(b""), None);
    }

    #[test]
    fn parses_ranges() {
        assert_eq!(parse_range("bytes=0-99", 1000), Ok(Some((0, 99))));
        assert_eq!(parse_range("bytes=900-", 1000), Ok(Some((900, 999))));
        assert_eq!(parse_range("bytes=-100", 1000), Ok(Some((900, 999))));
        assert_eq!(parse_range("bytes=-5000", 1000), Ok(Some((0, 999))));
        assert_eq!(parse_range("bytes=0-5000", 1000), Ok(Some((0, 999))));
        assert_eq!(
            parse_range("bytes=0-", 100 * 1024 * 1024),
            Ok(Some((0, RANGE_CHUNK - 1)))
        );
        assert_eq!(parse_range("bytes=1000-", 1000), Err(()));
        assert_eq!(parse_range("bytes=50-10", 1000), Err(()));
        assert_eq!(parse_range("bytes=0-0", 0), Err(()));
        assert_eq!(parse_range("items=0-10", 1000), Ok(None));
    }

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "keel-preview-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        crate::roots::register(&dir).unwrap();
        dir
    }

    fn request(root: &Path, rel: &str, range: Option<&str>) -> Request<Vec<u8>> {
        let query: String = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("root", &root.to_string_lossy())
            .append_pair("rel", rel)
            .finish();
        let mut builder = Request::builder().uri(format!("http://keel-file.localhost/?{query}"));
        if let Some(range) = range {
            builder = builder.header(header::RANGE, range);
        }
        builder.body(Vec::new()).unwrap()
    }

    #[test]
    fn serves_whole_files_and_ranges() {
        let dir = scratch("serve");
        fs::write(dir.join("clip.mp4"), b"0123456789").unwrap();

        let whole = serve(&request(&dir, "clip.mp4", None));
        assert_eq!(whole.status(), StatusCode::OK);
        assert_eq!(whole.headers()[header::CONTENT_TYPE], "video/mp4");
        assert_eq!(whole.body(), b"0123456789");

        let part = serve(&request(&dir, "clip.mp4", Some("bytes=2-4")));
        assert_eq!(part.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(part.headers()[header::CONTENT_RANGE], "bytes 2-4/10");
        assert_eq!(part.body(), b"234");

        let past = serve(&request(&dir, "clip.mp4", Some("bytes=20-")));
        assert_eq!(past.status(), StatusCode::RANGE_NOT_SATISFIABLE);

        crate::roots::unregister(&dir);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_what_workspace_read_refuses() {
        let dir = scratch("refuse");
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join(".git/config"), "x").unwrap();
        assert_eq!(
            serve(&request(&dir, ".git/config", None)).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            serve(&request(&dir, "../outside.png", None)).status(),
            StatusCode::NOT_FOUND
        );
        let unopened = std::env::temp_dir();
        assert_eq!(
            serve(&request(&unopened, "anything.png", None)).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            serve(
                &Request::builder()
                    .uri("http://keel-file.localhost/")
                    .body(Vec::new())
                    .unwrap()
            )
            .status(),
            StatusCode::BAD_REQUEST
        );
        crate::roots::unregister(&dir);
        fs::remove_dir_all(&dir).ok();
    }
}
