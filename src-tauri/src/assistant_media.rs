//! What the main agent gets from attachments: images as files it can look at,
//! voice messages as text.
//!
//! Voice is transcribed on this PC with OpenAI's Whisper (`pip install
//! openai-whisper`, which also needs ffmpeg) when it is installed. Nothing is
//! sent anywhere else. Whisper guesses the language from the first seconds,
//! and on a two-second "sí, dale" it guesses wrong; given the languages the
//! user speaks, `whisper_transcribe.py` chooses among those instead.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime};

use serde::Deserialize;

const SCRIPT: &str = include_str!("whisper_transcribe.py");
const TRANSCRIBE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Attachments older than this are cleared out of the inbox.
const INBOX_DAYS: u64 = 7;

/// Multilingual models, preferred first. English-only `.en` models would turn
/// Spanish into English, so they are never picked.
const MODELS: &[(&str, &str)] = &[
    ("turbo", "large-v3-turbo.pt"),
    ("small", "small.pt"),
    ("medium", "medium.pt"),
    ("base", "base.pt"),
    ("large-v3", "large-v3.pt"),
    ("tiny", "tiny.pt"),
];

#[derive(Debug, Clone, PartialEq)]
pub struct Whisper {
    pub python: PathBuf,
    pub model: String,
    pub ffmpeg: bool,
}

impl Whisper {
    pub fn describe(&self) -> String {
        if self.ffmpeg {
            format!("Whisper ({})", self.model)
        } else {
            format!("Whisper ({}), but ffmpeg is missing", self.model)
        }
    }
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// The Python that has Whisper installed: next to the `whisper` command it
/// put on PATH, in a venv or a normal install.
pub fn find() -> Option<Whisper> {
    let mut scripts: Vec<PathBuf> = crate::pty::which(&exe("whisper"))
        .map(|path| PathBuf::from(path).parent().map(Path::to_path_buf))
        .into_iter()
        .flatten()
        .collect();
    #[cfg(windows)]
    for base in [
        std::env::var_os("LOCALAPPDATA")
            .map(|dir| PathBuf::from(dir).join("Programs").join("Python")),
        std::env::var_os("APPDATA").map(|dir| PathBuf::from(dir).join("Python")),
    ]
    .into_iter()
    .flatten()
    {
        if let Ok(entries) = std::fs::read_dir(base) {
            for entry in entries.flatten() {
                scripts.push(entry.path().join("Scripts"));
            }
        }
    }
    let python = scripts.iter().find_map(|dir| {
        if !dir.join(exe("whisper")).is_file() {
            return None;
        }
        let names: &[&str] = if cfg!(windows) {
            &["python.exe"]
        } else {
            &["python3", "python"]
        };
        // A venv keeps python beside its scripts; an install one folder up.
        [Some(dir.as_path()), dir.parent()]
            .into_iter()
            .flatten()
            .flat_map(|folder| names.iter().map(move |name| folder.join(name)))
            .find(|candidate| candidate.is_file())
    })?;
    Some(Whisper {
        python,
        model: cached_model().unwrap_or_else(|| "small".into()),
        ffmpeg: crate::pty::which(&exe("ffmpeg")).is_some(),
    })
}

/// The best model already downloaded, so the first voice message does not wait
/// for a download.
fn cached_model() -> Option<String> {
    let cache = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| crate::pty::home_dir().map(|home| home.join(".cache")))?
        .join("whisper");
    MODELS
        .iter()
        .find(|(_, file)| cache.join(file).is_file())
        .map(|(name, _)| (*name).to_string())
}

#[derive(Debug, Deserialize)]
pub struct Transcript {
    pub language: String,
    pub text: String,
}

/// The `KEEL-TRANSCRIPT {json}` line the script prints last.
fn parse_output(stdout: &str) -> Option<Transcript> {
    stdout
        .lines()
        .rev()
        .find_map(|line| line.trim().strip_prefix("KEEL-TRANSCRIPT "))
        .and_then(|json| serde_json::from_str(json).ok())
}

/// Language codes Keel passes to Whisper: lowercase, two or three letters.
pub fn clean_languages(codes: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for code in codes {
        let code = code.trim().to_ascii_lowercase();
        if (2..=3).contains(&code.len())
            && code.chars().all(|ch| ch.is_ascii_lowercase())
            && !out.contains(&code)
        {
            out.push(code);
        }
    }
    out.truncate(8);
    out
}

pub fn transcribe(
    whisper: &Whisper,
    audio: &Path,
    languages: &[String],
    vocabulary: &str,
    home: &Path,
) -> Result<Transcript, String> {
    if !whisper.ffmpeg {
        return Err("Whisper needs ffmpeg to read voice messages, and it isn't on PATH.".into());
    }
    let script = home.join(".keel").join("whisper_transcribe.py");
    if let Some(parent) = script.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    crate::store::write_atomic(&script, SCRIPT)?;

    let mut command = Command::new(&whisper.python);
    command
        .arg(&script)
        .arg(audio)
        .arg(&whisper.model)
        .arg(clean_languages(languages).join(","))
        .arg(vocabulary)
        .current_dir(home)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .spawn()
        .map_err(|err| format!("Couldn't start Whisper: {err}"))?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let out = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(stdout) = stdout.as_mut() {
            let _ = stdout.read_to_string(&mut text);
        }
        text
    });
    let err = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(stderr) = stderr.as_mut() {
            let _ = stderr.read_to_string(&mut text);
        }
        text
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > TRANSCRIBE_TIMEOUT => {
                let _ = child.kill();
                return Err("Whisper took more than five minutes.".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(error) => return Err(error.to_string()),
        }
    };
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    match parse_output(&stdout) {
        Some(transcript) if status.success() => Ok(transcript),
        _ => {
            let reason = stderr
                .lines()
                .rev()
                .find(|line| !line.trim().is_empty())
                .unwrap_or("it stopped without a transcript")
                .trim()
                .to_string();
            Err(format!("Whisper couldn't transcribe it: {reason}"))
        }
    }
}

/// Where attachments are saved: inside the main agent's folder, so every CLI
/// may open them. Old ones are cleared out first.
pub fn inbox(home: &Path) -> Result<PathBuf, String> {
    let dir = home.join("inbox");
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let cutoff = SystemTime::now() - Duration::from_secs(INBOX_DAYS * 24 * 60 * 60);
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let old = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .is_ok_and(|modified| modified < cutoff);
            if old {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Ok(dir)
}

/// A file name for an attachment: a timestamp, then its own extension.
pub fn file_name(
    index: usize,
    original: Option<&str>,
    mime: Option<&str>,
    fallback: &str,
) -> String {
    let from_name = original
        .and_then(|name| Path::new(name).extension())
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase);
    let from_mime = mime
        .and_then(|mime| mime.split('/').nth(1))
        .map(|sub| match sub {
            "jpeg" => "jpg".to_string(),
            "mpeg" => "mp3".to_string(),
            "x-m4a" | "mp4" => "m4a".to_string(),
            other => other.to_string(),
        });
    let ext = from_name
        .or(from_mime)
        .filter(|ext| ext.len() <= 5 && ext.chars().all(|ch| ch.is_ascii_alphanumeric()))
        .unwrap_or_else(|| fallback.to_string());
    let stamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{stamp}-{index}.{ext}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_transcript_line() {
        let out = "Detecting language...\nKEEL-TRANSCRIPT {\"language\": \"es\", \"seconds\": 2.0, \"text\": \"Sí, dale\"}\n";
        let transcript = parse_output(out).unwrap();
        assert_eq!(transcript.language, "es");
        assert_eq!(transcript.text, "Sí, dale");
        assert!(parse_output("Traceback (most recent call last):").is_none());
    }

    #[test]
    fn languages_are_short_lowercase_codes() {
        let codes = ["EN", " es", "es", "spanish", "e1", "pt"].map(String::from);
        assert_eq!(clean_languages(&codes), ["en", "es", "pt"]);
    }

    #[test]
    fn attachment_names_keep_a_safe_extension() {
        assert!(file_name(0, Some("Screen Shot.PNG"), None, "bin").ends_with("-0.png"));
        assert!(file_name(1, None, Some("image/jpeg"), "bin").ends_with("-1.jpg"));
        assert!(file_name(2, None, Some("audio/ogg"), "bin").ends_with("-2.ogg"));
        assert!(file_name(3, Some("../../evil.exe/../x"), None, "jpg").ends_with("-3.jpg"));
        assert!(file_name(4, None, None, "ogg").ends_with("-4.ogg"));
    }
}
