//! The main agent: one coding agent you talk to from Telegram, that can see and
//! drive the rest of Keel.
//!
//! Three threads, all Keel's:
//!
//! - **Poller.** Long-polls the Bot API. Only the paired Telegram account is
//!   listened to; everyone else is ignored without a reply. Commands that need
//!   no model (`/stop`, `/new`, `/status`) are answered here.
//! - **Worker.** Runs one turn at a time: the chosen CLI in headless mode, in
//!   Keel's folder for it, continuing the same conversation each time. Its
//!   events become the activity log here; the phone only sees "typing" until
//!   its final answer, the reply, so a turn is one notification.
//! - **MCP server** (`assistant_mcp`). The agent's tools for seeing and driving
//!   Keel, answered by the window.
//!
//! Images are passed to the agent as files; voice messages are transcribed
//! on this PC first (`assistant_media`). Videos and other files are declined.
//!
//! Settings, including the bot token, live in `assistant.json` beside the
//! layout file but never inside it, and the token never goes back to the
//! window. What runs is the user's own CLI with the user's own login, with
//! permission prompts off — the same way Keel launches agents in panes.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::assistant_agents::{self as agents, Mcp, Reading, Turn};
use crate::assistant_mcp::{McpServer, ToolCall};
use crate::assistant_media::{self as media, Transcript, Whisper};
use crate::telegram::{self, ApiError, Bot, MediaKind};

const PAIRING_TTL: Duration = Duration::from_secs(15 * 60);
/// Messages sent while Keel was closed are dropped once they are this old.
const STALE_SECS: i64 = 10 * 60;
const LOG_LIMIT: usize = 300;
/// Follow-up turns Keel may start on its own before a person speaks again.
const AUTO_TURN_LIMIT: u32 = 8;

/// Set by a running Claude Code for its own children.
const CLAUDE_SESSION_MARKERS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
];

const COMMANDS: &[(&str, &str)] = &[
    ("status", "What's running in Keel"),
    ("stop", "Stop the current task"),
    ("new", "Start a fresh conversation"),
    ("agent", "Which agent is answering"),
    ("help", "What I can do"),
];

const RULES: &str = "\
You are Bob, the user's main agent in Keel, a desktop app where they run many coding agents side by side. \
They are talking to you from Telegram on their phone. \
How you talk is in SOUL.md, and what you know about them is in USER.md; both are below these rules.

Messages can carry images (attached, and saved in your folder) and voice notes, which arrive already transcribed and may contain small transcription mistakes.

Replies:
- One or two short sentences, like a coworker texting their manager. \
No headings, no bullet lists, no emojis, no recaps of what you did step by step. \
\"Done, tests pass.\" or \"Started Codex on the login bug, I'll ping you when it's done.\" is the right size.
- Only go longer when the user asks for detail, e.g. the console output, a diff, a file or a full explanation. \
Then give exactly that, in a code block if it's output. Telegram shows **bold**, `code`, code blocks and links. No tables.
- Your reply ends your turn. If you need a decision, ask for it in one short question at the end.
- Greetings, small talk and questions about you: answer in a line, without tools.

Understanding the user comes first:
- Make sure you know exactly what they want: which project, what to do, and what done looks like. \
Voice notes can be garbled, and short messages can be read more than one way.
- If you're not sure, don't guess and don't start. Reply with one short question about the part you're missing \
(\"Which project, keel or the site?\"), or ask them to say it again if you couldn't make sense of it.
- Transcripts swap small words (two, too and to; one and want). Before starting, stopping or closing agents on a voice note \
that doesn't fit what's running or what they said before, such as one that would put two agents on the same work, \
ask one short question that says what you'd end up with.
- If it's clear and it takes work (tools, edits, commands, starting an agent), first call tell_user with one short line \
saying what you understood and what you're doing now, like \"Got it, fixing the login test in keel now.\" \
or \"On it, starting Codex on the settings page.\" Then do it; your reply is the outcome. \
Call tell_user once per message, never for quick answers, and never for \"[Keel]\" reports.
- A question you asked is answered only by a reply that clearly answers it.

Keel's tools (the `keel` MCP server) let you see and drive the app:
- tell_user: send the user a message right away, without ending your turn.
- send_file: send the user a file or picture from this computer (a screenshot, a log, an output).
- list_projects: projects, their folders, and every terminal pane with its agent and status. Start here.
- read_pane: the end of a terminal's screen.
- start_agent: open a pane in a project with a coding agent and a first prompt. The user can watch it in Keel.
- send_to_pane: type into a pane, e.g. answer an agent that is waiting or give it a follow-up.
- press_key: press escape, ctrl_c, arrows, enter, tab or a number in a pane: interrupt an agent, or pick from a menu.
- remind_me, list_reminders, cancel_reminder: wake yourself up later, once or on repeat.
- check_usage: how much of each agent's plan limits is used, and when they reset.
- focus_pane, open_project, close_pane.

How to work:
- Small things (questions about a project, quick edits, running tests or git commands): do them yourself in the project's folder.
- Bigger coding tasks: delegate with start_agent, using the agent the user names or a sensible one. \
When it finishes, Keel sends you a message starting with \"[Keel]\" with the end of its screen. Check the work if needed, then tell the user the outcome in a sentence. \
Keel also tells you when a pane you passed a request to finishes, so you can finish what the user asked for, \
like sending them the video they asked it to record.
- Choose the pane by the work, not the project. A follow-up to what a pane is doing (answering its question, feedback on its result, \
\"commit it\", \"send me a video of it\") goes to that pane. A new piece of work goes to a new agent with start_agent, even in the same project, \
unless the user names a pane: never add it to an agent that is busy with, or just finished, something else. If you can't tell which, ask.
- send_to_pane pastes text, and a menu doesn't take pasted text as a choice. To pick an option, press_key its number \
(or the arrows, then enter). For an answer that isn't one of the options, pick the option for typing your own first, \
then send_to_pane the user's words. Then read_pane to check it took what you meant.
- Say what agents are doing from their screens (read_pane, list_projects), not from what you meant them to do. \
If something didn't land the way you meant, say so.
- When the user says you mixed something up, tell them in a line what each agent is on now and what you'd change, \
and wait for their go before interrupting, redirecting or closing agents.
- When you hand work to an agent (start_agent's prompt, or send_to_pane), pass on the user's request in their own words, \
as close to what they wrote as you can: fix transcription slips and add only what the agent can't know without it, \
such as the project or something they decided earlier in this chat. Don't expand it, restructure it, add steps, \
requirements or polish, or turn it into a long spec. A one-line request stays one line. \
Rewrite or elaborate only when the user asks you to.
- Don't read the code yourself before handing it off; that agent will.
- To stop an agent in a pane, press_key escape (ctrl_c for a plain command), then read_pane to check it stopped. \
Don't interrupt panes the user started unless they ask.
- When they want to see something that isn't short text (a screenshot, a log file, an image), send it with send_file \
instead of pasting it.
- Send files, and ask agents for videos, screenshots or recordings, only when the user asked for them. \
Don't add \"record a video\" to a request on your own. If one would really help, ask the user first, in one short question.
- \"Remind me in an hour\" or \"keep an eye on Codex\" means remind_me, with a note that says exactly what to do when it fires. \
When a [Keel] reminder fires, do what its note says. If it's a check-in and nothing is worth telling them, \
reply with exactly NO_REPLY and nothing is sent. Cancel a check-in once its job is done.
- Don't push, deploy, publish, or delete things the task didn't call for unless the user asked.
- After changing something, say what changed in a sentence; the details only if asked.

Memory:
- USER.md in your folder is what you know about the user. It's shown to you every turn and is the only thing \
that carries over when the conversation is reset.
- When you learn something lasting about them (how they like things done, which agent they want for what, \
their projects, a correction they gave you), add it to USER.md right away as a short line, like \
\"- Prefers Codex for frontend work.\" Change or remove a line when it stops being true; never keep two that disagree. \
Facts and preferences only, not a log of what happened, and under about 3000 characters.
- Don't mention saving to USER.md unless they asked you to remember something.
- SOUL.md in your folder is your personality. Change it only when they ask you to talk or act differently, and say you did.
";

/// Bob's personality until the user (or Bob, when asked) changes the copy in
/// his folder.
const DEFAULT_SOUL: &str = include_str!("assistant_soul.md");
/// The most of SOUL.md or USER.md that goes into the rules. Some CLIs take the
/// rules on the command line, which Windows caps at 32,767 characters.
const NOTES_CHARS: usize = 4000;

/// The rules, then SOUL.md and USER.md from the agent's folder. SOUL.md is
/// written out the first time so there is a file to edit.
fn standing_rules(home: &std::path::Path) -> String {
    let soul_file = home.join("SOUL.md");
    if !soul_file.exists() {
        let _ = crate::store::write_atomic(&soul_file, DEFAULT_SOUL);
    }
    let soul = std::fs::read_to_string(&soul_file).unwrap_or_else(|_| DEFAULT_SOUL.to_string());
    let user = std::fs::read_to_string(home.join("USER.md")).unwrap_or_default();
    format!(
        "{RULES}\n# SOUL.md (your personality)\n\n{}\n\n# USER.md (what you know about the user)\n\n{}\n",
        notes(&soul, "SOUL.md"),
        if user.trim().is_empty() {
            "(Nothing yet.)".to_string()
        } else {
            notes(&user, "USER.md")
        }
    )
}

/// A notes file as it goes into the rules: trimmed, and cut short with a
/// warning when it has grown past what fits.
fn notes(text: &str, name: &str) -> String {
    let text = text.trim();
    if text.chars().count() <= NOTES_CHARS {
        return text.to_string();
    }
    let cut: String = text.chars().take(NOTES_CHARS).collect();
    format!("{cut}\n\n({name} is too long and was cut here. Tighten it.)")
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Owner {
    id: i64,
    name: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Forward {
    Never,
    /// Only while Keel's window is not focused.
    #[default]
    Background,
    Always,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    bot: Option<String>,
    #[serde(default)]
    owner: Option<Owner>,
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default)]
    account_id: Option<String>,
    /// Conversation per agent and account, as each CLI named it.
    #[serde(default)]
    sessions: HashMap<String, String>,
    #[serde(default)]
    forward: Forward,
    #[serde(default = "enabled_default")]
    enabled: bool,
    /// Languages voice messages may be in, as Whisper codes. Empty: any.
    #[serde(default)]
    languages: Vec<String>,
}

fn enabled_default() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            token: None,
            bot: None,
            owner: None,
            agent_id: Some("claude".into()),
            account_id: None,
            sessions: HashMap::new(),
            forward: Forward::default(),
            enabled: true,
            languages: Vec::new(),
        }
    }
}

impl Settings {
    fn session_key(&self) -> Option<String> {
        let agent = self.agent_id.as_deref()?;
        Some(format!(
            "{agent}:{}",
            self.account_id.as_deref().unwrap_or("default")
        ))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Phase {
    Off,
    Connecting,
    Online,
    Error,
}

struct Live {
    phase: Phase,
    error: Option<String>,
    pairing: Option<(String, Instant)>,
    busy: bool,
    activity: Option<String>,
    started: Option<Instant>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    token_set: bool,
    bot: Option<String>,
    phase: Phase,
    error: Option<String>,
    owner: Option<String>,
    pairing_code: Option<String>,
    pairing_link: Option<String>,
    agent_id: Option<String>,
    account_id: Option<String>,
    forward: Forward,
    enabled: bool,
    busy: bool,
    activity: Option<String>,
    queued: usize,
    has_session: bool,
    tools_ready: bool,
    /// How voice messages get transcribed, or `None` when they can't be.
    voice: Option<String>,
    languages: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    id: u64,
    at: u64,
    /// `in` from the phone, `out` to it, `tool`, `event` or `error`.
    kind: &'static str,
    text: String,
}

/// Something for the worker: what the user said and sent, or Keel reporting
/// on a pane the agent started.
struct Job {
    text: String,
    media: Vec<telegram::Media>,
    /// Photos sent as an album share this and become one job.
    group: Option<String>,
    received: Instant,
    /// Keel's own report (a pane, a reminder), not something the user said.
    from_keel: bool,
}

impl Job {
    /// Typed in Keel's window, as if sent from the phone.
    fn typed(text: String) -> Self {
        Self {
            text,
            media: Vec::new(),
            group: None,
            received: Instant::now(),
            from_keel: false,
        }
    }

    /// A `[Keel]` message: a pane to report on, or a reminder firing.
    fn report(text: String) -> Self {
        Self {
            from_keel: true,
            ..Self::typed(text)
        }
    }
}

/// The turn the worker is running, as `tell_user` needs to know it.
#[derive(Default)]
struct TurnState {
    /// Started by Keel, so there is nothing to acknowledge.
    from_keel: bool,
    /// The user has already had this turn's one acknowledgement.
    told: bool,
}

impl TurnState {
    /// Claim the turn's one `tell_user`: a message from the user gets one
    /// acknowledgement and then the reply, and Keel's own reports get only
    /// the reply. Checked and claimed under one lock, so two calls made at
    /// once can't both go out.
    fn acknowledge(&mut self) -> Result<(), String> {
        if self.from_keel {
            return Err("Not sent: this turn is a [Keel] report, not a message from the user, \
                        so there is nothing to acknowledge. Put what they need to know in your reply."
                .into());
        }
        if self.told {
            return Err("Not sent: the user already heard from you this turn. \
                        Your reply is the next thing they see."
                .into());
        }
        self.told = true;
        Ok(())
    }
}

/// An album's photos arrive as separate messages a moment apart.
const ALBUM_WAIT: Duration = Duration::from_millis(1500);

struct Running {
    child: Arc<Mutex<Option<Child>>>,
    stopped: Arc<AtomicBool>,
    #[allow(dead_code)]
    job: Option<crate::procs::KillOnCloseJob>,
}

struct Inner {
    app: AppHandle,
    mcp: Result<McpServer, String>,
    settings: Mutex<Settings>,
    live: Mutex<Live>,
    /// Woken when the token or enabled flag changes.
    settings_changed: Condvar,
    jobs: Mutex<VecDeque<Job>>,
    jobs_ready: Condvar,
    log: Mutex<VecDeque<LogEntry>>,
    log_id: AtomicU64,
    /// Bumped whenever the poller must reconnect with new settings.
    generation: AtomicU64,
    running: Mutex<Option<Running>>,
    /// Who the running turn answers, for `tell_user`.
    turn: Mutex<TurnState>,
    auto_turns: Mutex<u32>,
    /// Looked for at launch, and again when a voice message needs it.
    whisper: Mutex<Option<Whisper>>,
    /// The phone has been told the agent ran without Keel's tools.
    warned_tools: AtomicBool,
    /// Set by the agent with `remind_me`; kept in memory only.
    reminders: Mutex<Vec<Reminder>>,
    /// Woken when one is added or cancelled, so the next due time is re-read.
    reminders_changed: Condvar,
    reminder_id: AtomicU64,
}

struct Reminder {
    id: u64,
    note: String,
    every: Duration,
    due: Instant,
    set: Instant,
    /// Times it still fires, this one included.
    left: u32,
    times: u32,
}

pub struct AssistantManager {
    inner: Arc<Inner>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn settings_file(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join("assistant.json"))
}

fn home_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("no config directory: {err}"))?
        .join("assistant");
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn load_settings(app: &AppHandle) -> Settings {
    settings_file(app)
        .and_then(|file| std::fs::read(file).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

impl AssistantManager {
    pub fn start(app: AppHandle) -> Self {
        let settings = load_settings(&app);
        let inner = Arc::new(Inner {
            mcp: McpServer::start(app.clone()),
            app,
            settings: Mutex::new(settings),
            live: Mutex::new(Live {
                phase: Phase::Off,
                error: None,
                pairing: None,
                busy: false,
                activity: None,
                started: None,
            }),
            settings_changed: Condvar::new(),
            jobs: Mutex::new(VecDeque::new()),
            jobs_ready: Condvar::new(),
            log: Mutex::new(VecDeque::new()),
            log_id: AtomicU64::new(0),
            generation: AtomicU64::new(0),
            running: Mutex::new(None),
            turn: Mutex::new(TurnState::default()),
            auto_turns: Mutex::new(0),
            whisper: Mutex::new(media::find()),
            warned_tools: AtomicBool::new(false),
            reminders: Mutex::new(Vec::new()),
            reminders_changed: Condvar::new(),
            reminder_id: AtomicU64::new(0),
        });
        if let Ok(mcp) = &inner.mcp {
            // Weak: the server lives inside `inner`.
            let weak = Arc::downgrade(&inner);
            mcp.set_local(Box::new(move |call| {
                let inner = weak.upgrade().ok_or("Keel is closing.")?;
                local_tool(&inner, call)
            }));
        }
        let reminders = inner.clone();
        let _ = std::thread::Builder::new()
            .name("keel-assistant-reminders".into())
            .spawn(move || remind_forever(&reminders));
        let poller = inner.clone();
        let _ = std::thread::Builder::new()
            .name("keel-assistant-poll".into())
            .spawn(move || poll_forever(&poller));
        let worker = inner.clone();
        let _ = std::thread::Builder::new()
            .name("keel-assistant-turns".into())
            .spawn(move || work_forever(&worker));
        Self { inner }
    }

    pub fn shutdown(&self) {
        self.inner.stop_turn();
    }
}

impl Inner {
    fn snapshot(&self) -> Snapshot {
        let settings = self.settings.lock().map(|s| s.clone()).unwrap_or_default();
        let queued = self.jobs.lock().map(|jobs| jobs.len()).unwrap_or(0);
        let live = self.live.lock();
        let (phase, error, pairing, busy, activity) = match &live {
            Ok(live) => (
                live.phase,
                live.error.clone(),
                live.pairing
                    .as_ref()
                    .filter(|(_, at)| at.elapsed() < PAIRING_TTL)
                    .map(|(code, _)| code.clone()),
                live.busy,
                live.activity.clone(),
            ),
            Err(_) => (Phase::Error, None, None, false, None),
        };
        let pairing_link = match (&pairing, &settings.bot) {
            (Some(code), Some(bot)) if !bot.is_empty() => {
                Some(format!("https://t.me/{bot}?start={code}"))
            }
            _ => None,
        };
        Snapshot {
            token_set: settings.token.is_some(),
            bot: settings.bot.clone(),
            phase,
            error: error.or_else(|| self.mcp.as_ref().err().cloned()),
            owner: settings.owner.as_ref().map(|owner| owner.name.clone()),
            pairing_code: pairing,
            pairing_link,
            has_session: settings
                .session_key()
                .is_some_and(|key| settings.sessions.contains_key(&key)),
            agent_id: settings.agent_id,
            account_id: settings.account_id,
            forward: settings.forward,
            enabled: settings.enabled,
            busy,
            activity,
            queued,
            tools_ready: self.mcp.is_ok(),
            voice: self
                .whisper
                .lock()
                .ok()
                .and_then(|whisper| whisper.as_ref().map(Whisper::describe)),
            languages: settings.languages.clone(),
        }
    }

    fn publish(&self) {
        let _ = self.app.emit("assistant:snapshot", self.snapshot());
    }

    fn log(&self, kind: &'static str, text: impl Into<String>) {
        let entry = LogEntry {
            id: self.log_id.fetch_add(1, Ordering::SeqCst) + 1,
            at: now_ms(),
            kind,
            text: text.into(),
        };
        if let Ok(mut log) = self.log.lock() {
            log.push_back(entry.clone());
            while log.len() > LOG_LIMIT {
                log.pop_front();
            }
        }
        let _ = self.app.emit("assistant:log", entry);
    }

    fn save(&self) -> Result<(), String> {
        let file = settings_file(&self.app).ok_or("no config directory")?;
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        let text = {
            let settings = self.settings.lock().map_err(|err| err.to_string())?;
            serde_json::to_string_pretty(&*settings).map_err(|err| err.to_string())?
        };
        crate::store::write_atomic(&file, &text)
    }

    fn update(&self, change: impl FnOnce(&mut Settings)) -> Result<(), String> {
        {
            let mut settings = self.settings.lock().map_err(|err| err.to_string())?;
            change(&mut settings);
        }
        self.save()?;
        self.publish();
        Ok(())
    }

    fn set_phase(&self, phase: Phase, error: Option<String>) {
        if let Ok(mut live) = self.live.lock() {
            if live.phase == phase && live.error == error {
                return;
            }
            live.phase = phase;
            live.error = error;
        }
        self.publish();
    }

    /// Reconnect the poller with whatever the settings now say.
    fn reconnect(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Ok(_guard) = self.settings.lock() {
            self.settings_changed.notify_all();
        }
    }

    /// Paired, with a token, and switched on.
    fn ready(&self) -> bool {
        self.settings
            .lock()
            .map(|s| s.owner.is_some() && s.token.is_some() && s.enabled)
            .unwrap_or(false)
    }

    fn bot(&self) -> Option<(Bot, i64)> {
        let settings = self.settings.lock().ok()?;
        let token = settings.token.clone()?;
        let owner = settings.owner.as_ref()?.id;
        drop(settings);
        Bot::new(&token, self.proxy()).ok().map(|bot| (bot, owner))
    }

    /// Keel's private VPN carries Keel's traffic, this included, when it is up.
    fn proxy(&self) -> Option<String> {
        self.app
            .try_state::<crate::vpn::VpnManager>()
            .and_then(|vpn| vpn.http_proxy_url())
    }

    /// Say something to the paired user outside of a turn.
    fn tell(&self, text: &str) {
        if let Some((bot, chat)) = self.bot() {
            if bot.send_markdown(chat, text).is_ok() {
                self.log("out", text);
            }
        }
    }

    fn enqueue(&self, job: Job) {
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.push_back(job);
            self.jobs_ready.notify_one();
        }
        self.publish();
    }

    fn stop_turn(&self) -> bool {
        let Ok(mut running) = self.running.lock() else {
            return false;
        };
        let Some(current) = running.as_mut() else {
            return false;
        };
        current.stopped.store(true, Ordering::SeqCst);
        // Dropping the job ends the whole tree on Windows; kill covers the rest.
        current.job = None;
        if let Ok(mut child) = current.child.lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.kill();
            }
        }
        true
    }

    fn new_pairing_code(&self) -> String {
        let bytes = uuid::Uuid::new_v4().as_u128();
        let code = format!("{:06}", bytes % 1_000_000);
        if let Ok(mut live) = self.live.lock() {
            live.pairing = Some((code.clone(), Instant::now()));
        }
        self.publish();
        code
    }
}

// ---------------------------------------------------------------- polling

fn poll_forever(inner: &Arc<Inner>) {
    loop {
        // Wait for a token and the switch to be on.
        let ready = |settings: &Settings| match (&settings.token, settings.enabled) {
            (Some(token), true) => Some((inner.generation.load(Ordering::SeqCst), token.clone())),
            _ => None,
        };
        let (generation, token) = loop {
            let Ok(settings) = inner.settings.lock() else {
                return;
            };
            if let Some(found) = ready(&settings) {
                break found;
            }
            drop(settings);
            inner.set_phase(Phase::Off, None);
            let Ok(settings) = inner.settings.lock() else {
                return;
            };
            // Checked again under the lock, so a change in between is not missed.
            if ready(&settings).is_none() && inner.settings_changed.wait(settings).is_err() {
                return;
            }
        };
        poll_session(inner, generation, &token);
    }
}

/// One connected stretch with one token. Returns when the settings change.
fn poll_session(inner: &Arc<Inner>, generation: u64, token: &str) {
    let current = || inner.generation.load(Ordering::SeqCst) == generation;
    let mut backoff = Duration::from_secs(2);
    let mut offset = 0;
    let mut introduced = false;

    while current() {
        let bot = match Bot::new(token, inner.proxy()) {
            Ok(bot) => bot,
            Err(err) => {
                inner.set_phase(Phase::Error, Some(err.description));
                wait_for_change(inner, generation, Duration::from_secs(3600));
                return;
            }
        };
        if !introduced {
            inner.set_phase(Phase::Connecting, None);
            match bot.get_me() {
                Ok(username) => {
                    let changed = inner
                        .settings
                        .lock()
                        .map(|s| s.bot.as_deref() != Some(username.as_str()))
                        .unwrap_or(false);
                    if changed {
                        let _ = inner.update(|s| s.bot = Some(username));
                    }
                    bot.set_commands(COMMANDS);
                    introduced = true;
                    // The token works; the first long poll can take 25 seconds.
                    inner.set_phase(Phase::Online, None);
                }
                Err(err) => {
                    if !handle_poll_error(inner, generation, &err, &mut backoff) {
                        return;
                    }
                    continue;
                }
            }
        }
        match bot.get_updates(offset, 25) {
            Ok((messages, next)) => {
                inner.set_phase(Phase::Online, None);
                backoff = Duration::from_secs(2);
                offset = next;
                for message in messages {
                    if !current() {
                        return;
                    }
                    receive(inner, &bot, message);
                }
            }
            Err(err) => {
                if !handle_poll_error(inner, generation, &err, &mut backoff) {
                    return;
                }
            }
        }
    }
}

/// Show the error and wait before retrying. False when polling should stop.
fn handle_poll_error(
    inner: &Arc<Inner>,
    generation: u64,
    err: &ApiError,
    backoff: &mut Duration,
) -> bool {
    if err.is_unauthorized() {
        inner.set_phase(
            Phase::Error,
            Some("Telegram didn't accept this bot token. Copy it again from @BotFather.".into()),
        );
        wait_for_change(inner, generation, Duration::from_secs(3600));
        return false;
    }
    let message = if err.is_conflict() {
        "Another app is reading this bot's messages (or a webhook is set). Close it, or make a separate bot for Keel.".to_string()
    } else {
        err.description.clone()
    };
    inner.set_phase(Phase::Error, Some(message));
    let wait = err.retry_after.map(Duration::from_secs).unwrap_or(*backoff);
    *backoff = (*backoff * 2).min(Duration::from_secs(60));
    !wait_for_change(inner, generation, wait)
}

/// Sleep up to `wait`. True when the settings changed meanwhile.
fn wait_for_change(inner: &Arc<Inner>, generation: u64, wait: Duration) -> bool {
    let deadline = Instant::now() + wait;
    let Ok(mut settings) = inner.settings.lock() else {
        return true;
    };
    while inner.generation.load(Ordering::SeqCst) == generation {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return false;
        }
        settings = match inner.settings_changed.wait_timeout(settings, left) {
            Ok((guard, _)) => guard,
            Err(_) => return true,
        };
    }
    true
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// The pairing code in "/start 123456", "123456" or a pasted "Code: 123456".
fn pairing_attempt(text: &str) -> Option<&str> {
    let text = text.trim();
    let text = text.strip_prefix("/start").unwrap_or(text).trim();
    let digits = text.trim_start_matches(|ch: char| !ch.is_ascii_digit());
    (digits.len() == 6 && digits.chars().all(|ch| ch.is_ascii_digit())).then_some(digits)
}

/// The command in "/stop" or "/stop@KeelBot", lowercased.
fn command_of(text: &str) -> Option<String> {
    let first = text.split_whitespace().next()?;
    let command = first.strip_prefix('/')?;
    let command = command.split('@').next().unwrap_or(command);
    Some(command.to_ascii_lowercase())
}

fn receive(inner: &Arc<Inner>, bot: &Bot, message: telegram::Message) {
    if !message.private || message.date + STALE_SECS < now_secs() {
        return;
    }
    let owner = inner.settings.lock().ok().and_then(|s| s.owner.clone());
    let Some(owner) = owner else {
        // Not paired yet: the only thing anyone can do is pair.
        let pairing = inner.live.lock().ok().and_then(|live| live.pairing.clone());
        let Some((code, _)) = pairing.filter(|(_, at)| at.elapsed() < PAIRING_TTL) else {
            return;
        };
        if pairing_attempt(&message.text) == Some(code.as_str()) {
            let owner = Owner {
                id: message.from_id,
                name: message.from_name.clone(),
            };
            if let Ok(mut live) = inner.live.lock() {
                live.pairing = None;
            }
            let _ = inner.update(|s| s.owner = Some(owner));
            inner.log("event", format!("Paired with {}", message.from_name));
            let _ = bot.send_markdown(message.chat_id, &help_text(inner, true));
        }
        return;
    };
    if message.from_id != owner.id {
        return;
    }

    if let Some(command) = command_of(&message.text) {
        match command.as_str() {
            "start" | "help" => {
                let _ = bot.send_markdown(message.chat_id, &help_text(inner, false));
                return;
            }
            "stop" => {
                let cleared = inner.jobs.lock().map(|mut jobs| {
                    let count = jobs.len();
                    jobs.clear();
                    count
                });
                let stopped = inner.stop_turn();
                inner.publish();
                let reply = match (stopped, cleared.unwrap_or(0)) {
                    (true, 0) => "Stopped.".to_string(),
                    (true, n) => format!("Stopped, and dropped {n} waiting message(s)."),
                    (false, 0) => "Nothing is running.".to_string(),
                    (false, n) => format!("Dropped {n} waiting message(s)."),
                };
                inner.log("event", reply.clone());
                let _ = bot.send(message.chat_id, &reply, false);
                return;
            }
            "new" => {
                let _ = inner.update(|s| {
                    if let Some(key) = s.session_key() {
                        s.sessions.remove(&key);
                    }
                });
                inner.log("event", "New conversation");
                let _ = bot.send(
                    message.chat_id,
                    "Starting fresh. I'll forget this chat but keep my notes on you.",
                    false,
                );
                return;
            }
            "agent" => {
                let _ = bot.send_markdown(message.chat_id, &agent_line(inner));
                return;
            }
            "status" => {
                let reply = match &inner.mcp {
                    Ok(mcp) => mcp_call(inner, mcp, "list_projects")
                        .unwrap_or_else(|err| format!("Couldn't read Keel: {err}")),
                    Err(err) => err.clone(),
                };
                let _ = bot.send_markdown(message.chat_id, &reply);
                return;
            }
            _ => {}
        }
    }

    let mut attached = Vec::new();
    if let Some(item) = message.media.clone() {
        let declined = if item
            .size
            .is_some_and(|size| size > telegram::DOWNLOAD_LIMIT)
        {
            Some("That file is over Telegram's 20 MB limit for bots.")
        } else if item.is_image() || item.is_audio() {
            attached.push(item);
            None
        } else if item.kind == MediaKind::Video {
            Some("I can't watch videos. Send a screenshot, or tell me what's in it.")
        } else {
            Some("I can read text, images and voice messages, but not other files yet.")
        };
        if let Some(reason) = declined {
            let _ = bot.send(message.chat_id, reason, false);
            if message.text.trim().is_empty() {
                return;
            }
        }
    }

    if let Ok(mut turns) = inner.auto_turns.lock() {
        *turns = 0;
    }
    inner.log("in", incoming_label(&message.text, &attached));
    let busy = inner.live.lock().map(|live| live.busy).unwrap_or(false);
    if busy {
        let _ = bot.send(
            message.chat_id,
            "Got it — I'll get to this when the current task is done. /stop to cancel it.",
            false,
        );
    }
    inner.enqueue(Job {
        text: message.text,
        media: attached,
        group: message.media_group,
        received: Instant::now(),
        from_keel: false,
    });
}

/// How a message reads in the activity log before anything is transcribed.
fn incoming_label(text: &str, attached: &[telegram::Media]) -> String {
    let mut parts: Vec<String> = attached
        .iter()
        .map(|item| match (item.is_audio(), item.duration) {
            (true, Some(seconds)) => {
                format!("🎤 Voice message ({}:{:02})", seconds / 60, seconds % 60)
            }
            (true, None) => "🎤 Voice message".to_string(),
            (false, _) => "🖼 Image".to_string(),
        })
        .collect();
    if !text.trim().is_empty() {
        parts.push(text.to_string());
    }
    parts.join("\n")
}

/// Ask the window for a tool result without going through the agent.
fn mcp_call(inner: &Arc<Inner>, mcp: &McpServer, name: &str) -> Result<String, String> {
    let call = ToolCall {
        call_id: uuid::Uuid::new_v4().to_string(),
        name: name.into(),
        arguments: serde_json::json!({}),
    };
    mcp.ask(&inner.app, call)
}

fn agent_name(inner: &Arc<Inner>, agent_id: &str) -> String {
    crate::agents::executable(&inner.app, agent_id)
        .map(|(spec, _)| spec.name)
        .unwrap_or_else(|| agent_id.to_string())
}

fn agent_line(inner: &Arc<Inner>) -> String {
    let agent = inner.settings.lock().ok().and_then(|s| s.agent_id.clone());
    match agent {
        Some(agent) => format!(
            "**{}** is answering. Change it in Keel → Telegram.",
            agent_name(inner, &agent)
        ),
        None => "No main agent is chosen. Pick one in Keel → Telegram.".into(),
    }
}

fn help_text(inner: &Arc<Inner>, first: bool) -> String {
    let opening = if first {
        "**Paired with Keel.** I'm Bob, and only you can talk to me now.\n\n"
    } else {
        ""
    };
    format!(
        "{opening}{}\n\nTell me what you want done, in any project open in Keel. I can work in a project myself, or start agents in Keel and report back when they finish. You can send screenshots and voice messages too.\n\n/status — what's running\n/stop — stop the current task\n/new — fresh conversation\n/agent — who's answering",
        agent_line(inner)
    )
}

// ---------------------------------------------------------------- turns

fn work_forever(inner: &Arc<Inner>) {
    loop {
        let mut job = {
            let Ok(mut jobs) = inner.jobs.lock() else {
                return;
            };
            loop {
                if let Some(job) = jobs.pop_front() {
                    break job;
                }
                jobs = match inner.jobs_ready.wait(jobs) {
                    Ok(guard) => guard,
                    Err(_) => return,
                };
            }
        };
        if let Some(group) = job.group.clone() {
            std::thread::sleep(ALBUM_WAIT.saturating_sub(job.received.elapsed()));
            if let Ok(mut jobs) = inner.jobs.lock() {
                let (same, rest): (VecDeque<Job>, VecDeque<Job>) = jobs
                    .drain(..)
                    .partition(|other| other.group.as_deref() == Some(group.as_str()));
                *jobs = rest;
                for other in same {
                    if !other.text.trim().is_empty() {
                        job.text = [job.text.as_str(), other.text.as_str()]
                            .into_iter()
                            .filter(|part| !part.trim().is_empty())
                            .collect::<Vec<_>>()
                            .join("\n");
                    }
                    job.media.extend(other.media);
                }
            }
            inner.publish();
        }
        if let Ok(mut turn) = inner.turn.lock() {
            *turn = TurnState {
                from_keel: job.from_keel,
                told: false,
            };
        }
        handle_job(inner, job);
    }
}

fn handle_job(inner: &Arc<Inner>, job: Job) {
    if job.media.is_empty() {
        run_turn(inner, &job.text, &[], true);
        return;
    }
    let Some((bot, chat)) = inner.bot() else {
        return;
    };
    let prepared = attachments(inner, &bot, chat, &job);
    set_busy(inner, false, None);
    match prepared {
        Ok((prompt, images)) => run_turn(inner, &prompt, &images, true),
        Err(error) => {
            inner.log("error", error.clone());
            let _ = bot.send(chat, &error, false);
        }
    }
}

/// Download what came with a message, transcribe voice, and write the prompt.
fn attachments(
    inner: &Arc<Inner>,
    bot: &Bot,
    chat: i64,
    job: &Job,
) -> Result<(String, Vec<PathBuf>), String> {
    let home = home_dir(&inner.app)?;
    let inbox = media::inbox(&home)?;
    set_busy(inner, true, Some("Downloading".into()));
    bot.typing(chat);
    let mut images = Vec::new();
    let mut voices = Vec::new();
    for (index, item) in job.media.iter().enumerate() {
        let fallback = if item.is_audio() { "ogg" } else { "jpg" };
        let path = inbox.join(media::file_name(
            index,
            item.file_name.as_deref(),
            item.mime.as_deref(),
            fallback,
        ));
        bot.download(&item.file_id, &path)
            .map_err(|err| format!("Couldn't download the attachment: {err}"))?;
        if item.is_audio() {
            voices.push(path);
        } else {
            images.push(path);
        }
    }

    let mut transcripts = Vec::new();
    if !voices.is_empty() {
        let whisper = whisper(inner).ok_or(
            "Voice messages need Whisper on this PC. Install it with `pip install openai-whisper` \
             (it also needs ffmpeg), then send it again.",
        )?;
        set_busy(inner, true, Some("Transcribing voice message".into()));
        let languages = inner
            .settings
            .lock()
            .map(|s| s.languages.clone())
            .unwrap_or_default();
        let vocabulary = vocabulary(inner);
        for path in &voices {
            bot.typing(chat);
            let transcript = media::transcribe(&whisper, path, &languages, &vocabulary, &home)?;
            inner.log(
                "event",
                format!("Heard ({}): {}", transcript.language, transcript.text),
            );
            if !transcript.text.is_empty() {
                // So a misheard word is caught before the agent acts on it.
                let _ = bot.send(
                    chat,
                    &format!("Heard: \u{201c}{}\u{201d}", transcript.text),
                    false,
                );
            }
            transcripts.push(transcript);
        }
    }
    Ok((attachment_prompt(&job.text, &transcripts, &images), images))
}

/// Whisper as found at launch, or found now if it was installed since.
fn whisper(inner: &Arc<Inner>) -> Option<Whisper> {
    let mut cached = inner.whisper.lock().ok()?;
    if cached.is_none() {
        *cached = media::find();
    }
    let found = cached.clone();
    drop(cached);
    inner.publish();
    found
}

/// Names Whisper would otherwise hear as ordinary words: the app, the agents,
/// and every project folder.
fn vocabulary(inner: &Arc<Inner>) -> String {
    let mut words: Vec<String> = [
        "Keel",
        "Claude Code",
        "Codex",
        "opencode",
        "Grok",
        "Pi",
        "Telegram",
    ]
    .iter()
    .map(|word| (*word).to_string())
    .collect();
    for root in crate::roots::registered() {
        if let Some(name) = root.file_name().and_then(|name| name.to_str()) {
            if !words.iter().any(|word| word.eq_ignore_ascii_case(name)) {
                words.push(name.to_string());
            }
        }
    }
    let _ = inner;
    words.truncate(40);
    words.join(", ")
}

/// The prompt for a message with attachments: the caption, then each voice
/// note as text, then where the images are.
fn attachment_prompt(text: &str, transcripts: &[Transcript], images: &[PathBuf]) -> String {
    let mut parts = Vec::new();
    if !text.trim().is_empty() {
        parts.push(text.trim().to_string());
    }
    for transcript in transcripts {
        parts.push(if transcript.text.trim().is_empty() {
            "[The user sent a voice message, but it was silent or couldn't be understood.]".to_string()
        } else {
            format!(
                "[Voice message, transcribed automatically ({}); it may contain small mistakes]\n{}",
                transcript.language,
                transcript.text.trim()
            )
        });
    }
    if !images.is_empty() {
        let list: Vec<String> = images
            .iter()
            .map(|path| format!("- {}", path.display()))
            .collect();
        parts.push(format!(
            "[The user sent {} image{}, attached and saved at:]\n{}\n(If you can't see an image, open the file.)",
            images.len(),
            if images.len() == 1 { "" } else { "s" },
            list.join("\n")
        ));
    }
    parts.join("\n\n")
}

fn set_busy(inner: &Arc<Inner>, busy: bool, activity: Option<String>) {
    if let Ok(mut live) = inner.live.lock() {
        live.busy = busy;
        live.activity = activity;
        live.started = busy.then(Instant::now);
    }
    inner.publish();
}

fn run_turn(inner: &Arc<Inner>, prompt: &str, images: &[PathBuf], retry_fresh: bool) {
    let Some((bot, chat)) = inner.bot() else {
        return;
    };
    let settings = match inner.settings.lock() {
        Ok(settings) => settings.clone(),
        Err(_) => return,
    };
    let Some(agent_id) = settings.agent_id.clone() else {
        let _ = bot.send(chat, "Pick a main agent in Keel → Telegram first.", false);
        return;
    };
    let session_key = settings.session_key().unwrap_or_default();
    let session = settings.sessions.get(&session_key).cloned();

    set_busy(inner, true, Some("Starting".into()));
    let outcome = execute(
        inner,
        &bot,
        chat,
        &agent_id,
        &settings,
        Ask {
            prompt,
            images,
            session: session.as_deref(),
        },
    );
    set_busy(inner, false, None);

    match outcome {
        Outcome::Reply {
            reply,
            session: id,
            sent,
        } => {
            if let Some(id) = id.filter(|id| Some(id) != session.as_ref()) {
                let _ = inner.update(|s| {
                    s.sessions.insert(session_key.clone(), id);
                });
            }
            if !sent {
                deliver(inner, &bot, chat, reply);
            }
        }
        // Whoever stopped it already said so.
        Outcome::Stopped => {}
        Outcome::Failed { error, session: id } => {
            // A conversation the CLI no longer has would fail every turn.
            // Start a fresh one once, quietly.
            if retry_fresh && session.is_some() && lost_conversation(&error) {
                inner.log(
                    "event",
                    format!("Couldn't continue the conversation ({error}); starting a new one"),
                );
                let _ = inner.update(|s| {
                    s.sessions.remove(&session_key);
                });
                run_turn(inner, prompt, images, false);
                return;
            }
            if let Some(id) = id.filter(|id| Some(id) != session.as_ref()) {
                let _ = inner.update(|s| {
                    s.sessions.insert(session_key.clone(), id);
                });
            }
            inner.log("error", error.clone());
            let _ = bot.send(chat, &error, false);
        }
    }
}

fn deliver(inner: &Arc<Inner>, bot: &Bot, chat: i64, reply: String) {
    if reply.trim() == QUIET_REPLY {
        inner.log("event", "Nothing to report");
        return;
    }
    let reply = if reply.is_empty() {
        "Done.".to_string()
    } else {
        reply
    };
    inner.log("out", reply.clone());
    if let Err(err) = bot.send_markdown(chat, &reply) {
        inner.log("error", format!("Couldn't send the reply: {err}"));
    }
}

/// The reply, once it can go out before the CLI exits: the CLI said the turn
/// is over, or its output closed on an answer. Never an error, which the turn
/// may still retry in a new conversation.
fn ready_reply(reading: &Reading, closed: bool) -> Option<String> {
    if reading.error.is_some() {
        return None;
    }
    let reply = reading.reply();
    (reading.done || (closed && !reply.is_empty())).then_some(reply)
}

enum Outcome {
    Reply {
        reply: String,
        session: Option<String>,
        /// Already on the phone, sent before the CLI exited.
        sent: bool,
    },
    Stopped,
    Failed {
        error: String,
        session: Option<String>,
    },
}

/// What one turn is asked: the prompt, its images, and the conversation.
struct Ask<'a> {
    prompt: &'a str,
    images: &'a [PathBuf],
    session: Option<&'a str>,
}

fn execute(
    inner: &Arc<Inner>,
    bot: &Bot,
    chat: i64,
    agent_id: &str,
    settings: &Settings,
    ask: Ask,
) -> Outcome {
    let Ask {
        prompt,
        images,
        session,
    } = ask;
    let failed = |error: String| Outcome::Failed {
        error,
        session: None,
    };
    let (mcp, listed_before) = match &inner.mcp {
        Ok(mcp) => (
            Mcp {
                url: mcp.url(),
                token: mcp.token.clone(),
            },
            mcp.listings(),
        ),
        Err(err) => return failed(format!("Keel's tools aren't available: {err}")),
    };
    let Some((spec, program)) = crate::agents::executable(&inner.app, agent_id) else {
        return failed(format!(
            "{} isn't installed where Keel can find it.",
            agent_name(inner, agent_id)
        ));
    };
    let home = match home_dir(&inner.app) {
        Ok(home) => home,
        Err(err) => return failed(err),
    };
    let rules = standing_rules(&home);
    // Codex, opencode and Pi read their standing instructions from here.
    let _ = crate::store::write_atomic(&home.join("AGENTS.md"), &rules);
    let projects = crate::roots::registered();
    let launch = match agents::prepare(
        agent_id,
        &Turn {
            prompt,
            session,
            home: &home,
            mcp: &mcp,
            projects: &projects,
            rules: &rules,
            images,
        },
    ) {
        Ok(launch) => launch,
        Err(err) => return failed(err),
    };

    let mut command = Command::new(&program);
    command
        .args(&launch.args)
        .current_dir(&home)
        .stdin(if launch.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Keel started from inside a Claude Code session carries that session's
    // identity; the main agent must not pass for its child.
    for key in CLAUDE_SESSION_MARKERS {
        command.env_remove(key);
    }
    for (key, value) in &launch.env {
        command.env(key, value);
    }
    if let Some(vpn) = inner.app.try_state::<crate::vpn::VpnManager>() {
        for (key, value) in vpn.proxy_env() {
            command.env(key, value);
        }
    }
    if let (Some(key), Some(account)) = (&spec.account_env, &settings.account_id) {
        let valid = account
            .chars()
            .all(|ch| ch == '_' || ch == '-' || ch.is_ascii_alphanumeric());
        if valid && crate::pty::is_env_name(key) {
            if let Ok(dir) = inner.app.path().app_config_dir() {
                command.env(key, dir.join("accounts").join(account));
            }
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => return failed(format!("Couldn't start {}: {err}", spec.name)),
    };
    let job = crate::procs::adopt_kill_on_close(child.id());
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(Some(child)));
    let stopped = Arc::new(AtomicBool::new(false));
    if let Ok(mut running) = inner.running.lock() {
        *running = Some(Running {
            child: child.clone(),
            stopped: stopped.clone(),
            job,
        });
    }

    if let (Some(mut stdin), Some(text)) = (stdin, launch.stdin.clone()) {
        std::thread::spawn(move || {
            let _ = stdin.write_all(text.as_bytes());
        });
    }
    let stderr_tail = Arc::new(Mutex::new(String::new()));
    if let Some(mut stderr) = stderr {
        let tail = stderr_tail.clone();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            while let Ok(read) = stderr.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                if let Ok(mut tail) = tail.lock() {
                    tail.push_str(&String::from_utf8_lossy(&buffer[..read]));
                    if tail.len() > 8192 {
                        let cut = tail.len() - 4096;
                        let cut = (cut..tail.len())
                            .find(|index| tail.is_char_boundary(*index))
                            .unwrap_or(tail.len());
                        tail.drain(..cut);
                    }
                }
            }
        });
    }
    let typing = Arc::new(AtomicBool::new(true));
    {
        let typing = typing.clone();
        let token = settings.token.clone();
        let proxy = inner.proxy();
        std::thread::spawn(move || {
            let Some(bot) = token.and_then(|token| Bot::new(&token, proxy).ok()) else {
                return;
            };
            while typing.load(Ordering::SeqCst) {
                bot.typing(chat);
                for _ in 0..40 {
                    if !typing.load(Ordering::SeqCst) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        });
    }

    let mut reading = Reading::default();
    let mut sent = false;
    if let Some(stdout) = stdout {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else {
                break;
            };
            if let Some(label) = agents::read_line(agent_id, &line, &mut reading) {
                inner.log("tool", label.clone());
                if let Ok(mut live) = inner.live.lock() {
                    live.activity = Some(label.clone());
                }
                inner.publish();
            }
            // The answer goes out now; some CLIs take seconds more to exit.
            if !sent && reading.done && !stopped.load(Ordering::SeqCst) {
                if let Some(reply) = ready_reply(&reading, false) {
                    typing.store(false, Ordering::SeqCst);
                    deliver(inner, bot, chat, reply);
                    sent = true;
                }
            }
        }
    }
    typing.store(false, Ordering::SeqCst);
    if !sent && !stopped.load(Ordering::SeqCst) {
        if let Some(reply) = ready_reply(&reading, true) {
            deliver(inner, bot, chat, reply);
            sent = true;
        }
    }
    let status = child
        .lock()
        .ok()
        .and_then(|mut child| child.take())
        .and_then(|mut child| child.wait().ok());
    if let Ok(mut running) = inner.running.lock() {
        *running = None;
    }

    let session = reading.session.clone().or(launch.session);
    if stopped.load(Ordering::SeqCst) {
        return Outcome::Stopped;
    }
    let reply = reading.reply();
    let tail = stderr_tail
        .lock()
        .map(|tail| tail.clone())
        .unwrap_or_default();
    let succeeded = status.is_some_and(|status| status.success());
    let failure = if let Some(error) = reading.error.clone() {
        // Some CLIs report only an error kind on stdout and the reason on stderr.
        let detail = last_lines(&tail, 3);
        Some(if detail.is_empty() || error.contains(' ') {
            error
        } else {
            format!("{error}: {detail}")
        })
    } else if !succeeded && reply.is_empty() {
        let detail = last_lines(&tail, 6);
        Some(if detail.is_empty() {
            format!("{} stopped without answering.", spec.name)
        } else {
            format!("{} stopped without answering:\n{detail}", spec.name)
        })
    } else {
        None
    };
    if let Some(error) = failure {
        if !sent {
            return Outcome::Failed { error, session };
        }
        // The phone already has the answer: one reply per message.
        inner.log("error", format!("After the reply: {error}"));
    }
    // Every supported CLI lists the tools as it starts, whether or not the
    // turn uses them. One that never did was cut off from Keel and has to
    // work around it, which makes every message slow.
    let listed = inner.mcp.as_ref().map_or(0, McpServer::listings);
    if listed == listed_before {
        let warning = format!(
            "{} ran without Keel's tools: it never loaded Keel's MCP server, so it can't see or start panes.",
            spec.name
        );
        inner.log("error", warning.clone());
        if !inner.warned_tools.swap(true, Ordering::SeqCst) {
            let _ = bot.send(chat, &warning, false);
        }
    }
    Outcome::Reply {
        reply,
        session,
        sent,
    }
}

/// The CLI could not find the conversation it was asked to continue — deleted,
/// expired, or made under another login. Anything else (limits, auth, a crash)
/// keeps the conversation, so the next message can still pick it up.
fn lost_conversation(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    let about = ["session", "conversation", "thread"]
        .iter()
        .any(|word| error.contains(word));
    let missing = [
        "not found",
        "no such",
        "does not exist",
        "doesn't exist",
        "could not find",
        "couldn't find",
        "no conversation",
        "no session",
        "no rollout",
        "unknown",
    ]
    .iter()
    .any(|phrase| error.contains(phrase));
    about && missing
}

/// The last non-blank lines of a CLI's stderr, without colour codes.
fn last_lines(text: &str, count: usize) -> String {
    let plain = strip_ansi(text);
    let lines: Vec<&str> = plain
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.trim().is_empty())
        .collect();
    lines[lines.len().saturating_sub(count)..].join("\n")
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                // Parameters, then one final byte in @..~.
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(ch);
    }
    out
}

// ---------------------------------------------------------------- local tools

/// A check-in with nothing new answers with this, and the phone hears nothing.
const QUIET_REPLY: &str = "NO_REPLY";
const REMINDER_LIMIT: usize = 20;

/// The tools Keel answers itself: the phone, and reminders.
fn local_tool(inner: &Arc<Inner>, call: &ToolCall) -> Result<String, String> {
    let arg = |key: &str| {
        call.arguments
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .unwrap_or("")
    };
    let number = |key: &str| call.arguments.get(key).and_then(serde_json::Value::as_u64);
    match call.name.as_str() {
        "tell_user" => {
            let text = arg("text");
            if text.is_empty() {
                return Err("Give the message as `text`.".into());
            }
            inner
                .turn
                .lock()
                .map_err(|err| err.to_string())?
                .acknowledge()?;
            let sent = inner
                .bot()
                .ok_or_else(|| "Telegram isn't connected.".to_string())
                .and_then(|(bot, chat)| {
                    bot.send_markdown(chat, text)
                        .map_err(|err| format!("Couldn't send it: {err}"))
                });
            if let Err(err) = sent {
                // Nothing reached the phone, so the next try may still go.
                if let Ok(mut turn) = inner.turn.lock() {
                    turn.told = false;
                }
                return Err(err);
            }
            inner.log("out", text);
            Ok("Sent. Carry on; your final reply still goes to the user.".into())
        }
        "send_file" => {
            let raw = arg("path");
            if raw.is_empty() {
                return Err("Give the file as `path`.".into());
            }
            // An absolute path replaces the folder it is joined to.
            let path = home_dir(&inner.app)?.join(raw);
            if !path.is_file() {
                return Err(format!("There's no file at {}.", path.display()));
            }
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            let (bot, chat) = inner.bot().ok_or("Telegram isn't connected.")?;
            let caption = Some(arg("caption")).filter(|caption| !caption.is_empty());
            bot.send_file(chat, &path, caption)
                .map_err(|err| format!("Couldn't send it: {err}"))?;
            inner.log("out", format!("File: {name}"));
            Ok(format!("Sent {name}."))
        }
        "remind_me" => {
            let minutes = number("minutes")
                .filter(|minutes| (1..=1440).contains(minutes))
                .ok_or("`minutes` has to be 1 to 1440.")?;
            let note = arg("note");
            if note.is_empty() {
                return Err("Say what the reminder is for in `note`.".into());
            }
            let times = number("times").unwrap_or(1).clamp(1, 48) as u32;
            let every = Duration::from_secs(minutes * 60);
            let id = {
                let mut reminders = inner.reminders.lock().map_err(|err| err.to_string())?;
                if reminders.len() >= REMINDER_LIMIT {
                    return Err(format!(
                        "There are already {REMINDER_LIMIT} reminders. Cancel some first."
                    ));
                }
                let id = inner.reminder_id.fetch_add(1, Ordering::SeqCst) + 1;
                let now = Instant::now();
                reminders.push(Reminder {
                    id,
                    note: note.to_string(),
                    every,
                    due: now + every,
                    set: now,
                    left: times,
                    times,
                });
                id
            };
            inner.reminders_changed.notify_all();
            inner.log(
                "event",
                format!("Reminder #{id}: {}, {note}", schedule(minutes, times)),
            );
            Ok(format!(
                "Reminder #{id} set: {}. It doesn't survive Keel closing.",
                schedule(minutes, times)
            ))
        }
        "list_reminders" => {
            let reminders = inner.reminders.lock().map_err(|err| err.to_string())?;
            if reminders.is_empty() {
                return Ok("No reminders.".into());
            }
            let now = Instant::now();
            Ok(reminders
                .iter()
                .map(|reminder| {
                    format!(
                        "#{}: next in {}, {} more time{} after that, every {}. {}",
                        reminder.id,
                        span(reminder.due.saturating_duration_since(now)),
                        reminder.left - 1,
                        if reminder.left == 2 { "" } else { "s" },
                        span(reminder.every),
                        reminder.note
                    )
                })
                .collect::<Vec<_>>()
                .join("\n"))
        }
        "cancel_reminder" => {
            let id = arg("id").trim_start_matches('#');
            let mut reminders = inner.reminders.lock().map_err(|err| err.to_string())?;
            let before = reminders.len();
            if id.eq_ignore_ascii_case("all") {
                reminders.clear();
            } else {
                let id: u64 = id.parse().map_err(|_| "Give an id from list_reminders.")?;
                reminders.retain(|reminder| reminder.id != id);
            }
            let cancelled = before - reminders.len();
            drop(reminders);
            inner.reminders_changed.notify_all();
            if cancelled == 0 {
                return Err("No reminder has that id.".into());
            }
            inner.log("event", format!("Cancelled {cancelled} reminder(s)"));
            Ok(format!(
                "Cancelled {cancelled} reminder{}.",
                if cancelled == 1 { "" } else { "s" }
            ))
        }
        other => Err(format!("Keel doesn't know the tool {other}.")),
    }
}

/// "in 30 minutes", or "every 10 minutes, 6 times".
fn schedule(minutes: u64, times: u32) -> String {
    let every = span(Duration::from_secs(minutes * 60));
    if times == 1 {
        format!("in {every}")
    } else {
        format!("every {every}, {times} times")
    }
}

fn span(duration: Duration) -> String {
    let minutes = duration.as_secs().div_ceil(60);
    match (minutes / 60, minutes % 60) {
        (0, minutes) => format!("{minutes} min"),
        (hours, 0) => format!("{hours} h"),
        (hours, minutes) => format!("{hours} h {minutes} min"),
    }
}

/// What the agent is woken with when a reminder fires.
fn reminder_report(reminder: &Reminder, now: Instant) -> String {
    let round = reminder.times - reminder.left + 1;
    let which = if reminder.times > 1 {
        format!(" (check {round} of {})", reminder.times)
    } else {
        String::new()
    };
    format!(
        "[Keel] Reminder #{} you set {} ago{which}: {}\n\n\
Do what it says. If it's a check-in and there's nothing worth telling the user, \
reply with exactly {QUIET_REPLY} and nothing is sent.",
        reminder.id,
        span(now.saturating_duration_since(reminder.set)),
        reminder.note
    )
}

/// Wait for the next reminder, hand it to the worker, repeat.
fn remind_forever(inner: &Arc<Inner>) {
    let Ok(mut reminders) = inner.reminders.lock() else {
        return;
    };
    loop {
        let now = Instant::now();
        let mut fired = Vec::new();
        for reminder in reminders.iter_mut().filter(|reminder| reminder.due <= now) {
            fired.push(reminder_report(reminder, now));
            reminder.left -= 1;
            // From now, not from when it was due: a PC that slept through
            // several fires gets one, not a burst.
            reminder.due = now + reminder.every;
        }
        reminders.retain(|reminder| reminder.left > 0);
        if !fired.is_empty() {
            drop(reminders);
            if inner.ready() {
                for report in fired {
                    inner.log("event", "Reminder fired");
                    inner.enqueue(Job::report(report));
                }
            }
            reminders = match inner.reminders.lock() {
                Ok(guard) => guard,
                Err(_) => return,
            };
            continue;
        }
        let next = reminders.iter().map(|reminder| reminder.due).min();
        reminders = match next {
            Some(due) => match inner
                .reminders_changed
                .wait_timeout(reminders, due.saturating_duration_since(now))
            {
                Ok((guard, _)) => guard,
                Err(_) => return,
            },
            None => match inner.reminders_changed.wait(reminders) {
                Ok(guard) => guard,
                Err(_) => return,
            },
        };
    }
}

// ---------------------------------------------------------------- panes

/// Whose work a pane is doing, as the window tracks it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Whose {
    /// The agent opened it with `start_agent`.
    Started,
    /// The user opened it, and the agent then passed it the user's request
    /// (`send_to_pane`, or a menu choice), so the agent owes them the outcome.
    Handed,
    /// The user's own, and nothing the agent is waiting on.
    #[default]
    User,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneEvent {
    /// `done`, `waiting` or `exited`.
    kind: String,
    pane_id: String,
    title: String,
    agent: String,
    project: String,
    #[serde(default)]
    whose: Whose,
    #[serde(default)]
    tail: String,
    #[serde(default)]
    window_focused: bool,
}

/// What the agent is told about a pane: one doing work it handed out, to
/// check and report on, or one the user runs, only to sum up for the phone.
fn pane_report(event: &PaneEvent) -> String {
    let what = match event.kind.as_str() {
        "waiting" => "is waiting for input (a question or a permission)",
        "exited" => "has exited",
        _ => "has finished",
    };
    let screen = if event.tail.trim().is_empty() {
        String::new()
    } else {
        format!("\nEnd of its screen:\n```\n{}\n```", event.tail.trim_end())
    };
    let whose = match event.whose {
        Whose::Started => "The agent you started",
        Whose::Handed => "The agent you passed the user's request to",
        Whose::User => "An agent the user started themselves",
    };
    let next = match (event.whose, event.kind.as_str()) {
        (Whose::User, _) => {
            "Tell the user in one short sentence what it did or said, going by its screen, and if it's asking something, what. \
Name the agent and project. Don't act on it or touch the pane unless they ask."
        }
        (_, "waiting") => {
            "If what the user asked for answers it, answer it: press_key for a menu, send_to_pane for text. \
Otherwise ask the user."
        }
        _ => {
            "Tell the user how it went in a sentence or two. If their request still needs a step from you, \
such as sending a file they asked for, do it."
        }
    };
    format!(
        "[Keel] {whose} {what}.\nPane \"{}\" ({}) in project {}, pane id {}.{screen}\n\n{next}",
        event.title, event.agent, event.project, event.pane_id
    )
}

/// The plain line, for the log and for when the agent can't sum it up.
fn pane_notice(event: &PaneEvent) -> String {
    let what = match event.kind.as_str() {
        "waiting" => "needs you",
        "exited" => "exited",
        _ => "finished",
    };
    format!(
        "{} {what} in {} ({}).",
        event.agent, event.project, event.title
    )
}

// ---------------------------------------------------------------- commands

type Assistant<'a> = State<'a, AssistantManager>;

#[tauri::command]
pub fn assistant_snapshot(manager: Assistant<'_>) -> Snapshot {
    manager.inner.snapshot()
}

#[tauri::command]
pub fn assistant_log(manager: Assistant<'_>) -> Vec<LogEntry> {
    manager
        .inner
        .log
        .lock()
        .map(|log| log.iter().cloned().collect())
        .unwrap_or_default()
}

/// Check a token with Telegram and keep it. An empty token disconnects.
#[tauri::command]
pub async fn assistant_set_token(
    manager: Assistant<'_>,
    token: String,
) -> Result<Snapshot, String> {
    let inner = manager.inner.clone();
    crate::blocking::run(move || {
        let token = token.trim().to_string();
        if token.is_empty() {
            inner.update(|s| {
                s.token = None;
                s.bot = None;
            })?;
            inner.reconnect();
            return Ok(inner.snapshot());
        }
        let bot = Bot::new(&token, inner.proxy()).map_err(|err| err.description)?;
        let username = bot.get_me().map_err(|err| {
            if err.is_unauthorized() {
                "Telegram didn't accept that token. Copy it again from @BotFather.".to_string()
            } else {
                err.description
            }
        })?;
        inner.update(|s| {
            s.token = Some(token);
            s.bot = Some(username.clone());
            s.enabled = true;
        })?;
        inner.log("event", format!("Connected to @{username}"));
        // The poller is about to reconnect; the reply must not say "off".
        inner.set_phase(Phase::Connecting, None);
        inner.reconnect();
        if inner
            .settings
            .lock()
            .map(|s| s.owner.is_none())
            .unwrap_or(false)
        {
            inner.new_pairing_code();
        }
        Ok(inner.snapshot())
    })
    .await
}

#[tauri::command]
pub fn assistant_pair(manager: Assistant<'_>) -> Snapshot {
    manager.inner.new_pairing_code();
    manager.inner.snapshot()
}

#[tauri::command]
pub fn assistant_unpair(manager: Assistant<'_>) -> Result<Snapshot, String> {
    manager.inner.update(|s| s.owner = None)?;
    manager.inner.log("event", "Unpaired");
    manager.inner.new_pairing_code();
    Ok(manager.inner.snapshot())
}

/// A field that was sent, even as `null`, so `null` can mean "clear it".
fn present<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Configure {
    #[serde(default, deserialize_with = "present")]
    agent_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    account_id: Option<Option<String>>,
    #[serde(default)]
    forward: Option<Forward>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    languages: Option<Vec<String>>,
}

#[tauri::command]
pub fn assistant_configure(manager: Assistant<'_>, change: Configure) -> Result<Snapshot, String> {
    if let Some(Some(agent)) = &change.agent_id {
        if !agents::supported(agent) {
            return Err(format!("{agent} can't be the main agent yet."));
        }
    }
    let toggled = change.enabled.is_some();
    manager.inner.update(|s| {
        if let Some(agent) = change.agent_id {
            if agent != s.agent_id {
                s.account_id = None;
            }
            s.agent_id = agent;
        }
        if let Some(account) = change.account_id {
            s.account_id = account;
        }
        if let Some(forward) = change.forward {
            s.forward = forward;
        }
        if let Some(enabled) = change.enabled {
            s.enabled = enabled;
        }
        if let Some(languages) = change.languages {
            s.languages = media::clean_languages(&languages);
        }
    })?;
    if toggled {
        manager.inner.reconnect();
    }
    Ok(manager.inner.snapshot())
}

/// Look for Whisper again, after the user installed it.
#[tauri::command]
pub async fn assistant_check_voice(manager: Assistant<'_>) -> Result<Snapshot, String> {
    let inner = manager.inner.clone();
    crate::blocking::run(move || {
        if let Ok(mut whisper) = inner.whisper.lock() {
            *whisper = media::find();
        }
        inner.publish();
        Ok(inner.snapshot())
    })
    .await
}

#[tauri::command]
pub fn assistant_new_conversation(manager: Assistant<'_>) -> Result<Snapshot, String> {
    manager.inner.update(|s| {
        if let Some(key) = s.session_key() {
            s.sessions.remove(&key);
        }
    })?;
    manager.inner.log("event", "New conversation");
    Ok(manager.inner.snapshot())
}

#[tauri::command]
pub fn assistant_stop(manager: Assistant<'_>) -> bool {
    if let Ok(mut jobs) = manager.inner.jobs.lock() {
        jobs.clear();
    }
    let stopped = manager.inner.stop_turn();
    if stopped {
        manager.inner.log("event", "Stopped from Keel");
    }
    manager.inner.publish();
    stopped
}

/// Send a message from the Keel window, as if it came from the phone.
#[tauri::command]
pub fn assistant_send(manager: Assistant<'_>, text: String) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(());
    }
    let paired = manager
        .inner
        .settings
        .lock()
        .map(|s| s.owner.is_some() && s.token.is_some())
        .unwrap_or(false);
    if !paired {
        return Err("Pair your Telegram account first; replies go there.".into());
    }
    manager.inner.log("in", text.clone());
    manager.inner.enqueue(Job::typed(text));
    Ok(())
}

#[tauri::command]
pub fn assistant_tool_result(manager: Assistant<'_>, call_id: String, ok: bool, text: String) {
    if let Ok(mcp) = &manager.inner.mcp {
        mcp.resolve(&call_id, if ok { Ok(text) } else { Err(text) });
    }
}

/// An agent pane finished, stopped to ask something, or exited.
#[tauri::command]
pub fn assistant_pane_event(manager: Assistant<'_>, event: PaneEvent) {
    let inner = &manager.inner;
    if !inner.ready() {
        return;
    }
    if event.whose != Whose::User {
        // Work the agent handed out comes back to it whatever the forwarding
        // setting, or "I'll send you the video when it's done" could not be kept.
        let allowed = inner
            .auto_turns
            .lock()
            .map(|mut turns| {
                *turns += 1;
                *turns <= AUTO_TURN_LIMIT
            })
            .unwrap_or(false);
        if allowed {
            inner.log("event", pane_notice(&event));
            inner.enqueue(Job::report(pane_report(&event)));
        } else {
            // Past the limit on turns Keel starts by itself.
            let inner = inner.clone();
            let notice = pane_notice(&event);
            std::thread::spawn(move || inner.tell(&notice));
        }
        return;
    }
    let forward = inner.settings.lock().map(|s| s.forward).unwrap_or_default();
    let send = match forward {
        Forward::Never => false,
        Forward::Background => !event.window_focused,
        Forward::Always => true,
    };
    if send {
        // The agent reads the screen and sums it up, so the phone gets what
        // happened, not just that something did.
        inner.log("event", pane_notice(&event));
        inner.enqueue(Job::report(pane_report(&event)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_codes_are_found_in_what_people_paste() {
        assert_eq!(pairing_attempt("/start 123456"), Some("123456"));
        assert_eq!(pairing_attempt("  654321 "), Some("654321"));
        assert_eq!(pairing_attempt("Code: 111222"), Some("111222"));
        assert_eq!(pairing_attempt("/start"), None);
        assert_eq!(pairing_attempt("12345"), None);
        assert_eq!(pairing_attempt("1234567"), None);
    }

    #[test]
    fn commands_ignore_the_bot_suffix_and_case() {
        assert_eq!(command_of("/stop").as_deref(), Some("stop"));
        assert_eq!(command_of("/Stop@KeelBot now").as_deref(), Some("stop"));
        assert_eq!(command_of("stop"), None);
        assert_eq!(command_of(""), None);
    }

    #[test]
    fn settings_round_trip_and_default_to_claude() {
        let settings: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings.agent_id, None);
        assert!(settings.enabled);
        assert_eq!(settings.forward, Forward::Background);
        let fresh = Settings::default();
        assert_eq!(fresh.session_key().as_deref(), Some("claude:default"));
        let text = serde_json::to_string(&fresh).unwrap();
        let back: Settings = serde_json::from_str(&text).unwrap();
        assert_eq!(back.agent_id.as_deref(), Some("claude"));
    }

    #[test]
    fn reminders_read_naturally() {
        assert_eq!(schedule(30, 1), "in 30 min");
        assert_eq!(schedule(90, 4), "every 1 h 30 min, 4 times");
        assert_eq!(span(Duration::from_secs(120 * 60)), "2 h");
        assert_eq!(span(Duration::from_secs(61)), "2 min");

        let now = Instant::now();
        let check = Reminder {
            id: 3,
            note: "look at the Codex pane".into(),
            every: Duration::from_secs(600),
            due: now,
            set: now - Duration::from_secs(1200),
            left: 2,
            times: 6,
        };
        let report = reminder_report(&check, now);
        assert!(report.starts_with(
            "[Keel] Reminder #3 you set 20 min ago (check 5 of 6): look at the Codex pane"
        ));
        assert!(report.contains(QUIET_REPLY));
    }

    #[test]
    fn rules_carry_bobs_soul_and_notes() {
        let home = std::env::temp_dir().join(format!("keel-assistant-soul-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();

        let fresh = standing_rules(&home);
        assert!(fresh.starts_with(RULES));
        assert!(fresh.contains("You're Bob."));
        assert!(fresh.ends_with("(Nothing yet.)\n"));
        assert_eq!(
            std::fs::read_to_string(home.join("SOUL.md")).unwrap(),
            DEFAULT_SOUL
        );

        std::fs::write(home.join("SOUL.md"), "Talk like a pirate.").unwrap();
        std::fs::write(home.join("USER.md"), "- Prefers Codex.\n").unwrap();
        let edited = standing_rules(&home);
        assert!(edited.contains("Talk like a pirate."));
        assert!(!edited.contains("You're Bob."));
        assert!(edited.ends_with("- Prefers Codex.\n"));

        std::fs::write(home.join("USER.md"), "x".repeat(NOTES_CHARS + 50)).unwrap();
        assert!(standing_rules(&home).contains("USER.md is too long and was cut here."));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn pane_reports_carry_the_screen_for_the_agent() {
        let event = |whose, kind: &str| PaneEvent {
            kind: kind.into(),
            pane_id: "p1".into(),
            title: "Fix login".into(),
            agent: "Codex".into(),
            project: "keel".into(),
            whose,
            tail: "All tests passed\n".into(),
            window_focused: false,
        };
        let report = pane_report(&event(Whose::Started, "done"));
        assert!(report.starts_with("[Keel] The agent you started has finished."));
        assert!(report.contains("pane id p1"));
        assert!(report.contains("```\nAll tests passed\n```"));
        assert!(report.contains("sending a file they asked for"));

        // Work passed to a pane the user opened is followed up like the agent's own.
        let handed = pane_report(&event(Whose::Handed, "done"));
        assert!(
            handed.starts_with("[Keel] The agent you passed the user's request to has finished.")
        );
        assert!(!handed.contains("Don't act on it"));
        assert!(pane_report(&event(Whose::Handed, "waiting")).contains("press_key for a menu"));

        let theirs = pane_report(&event(Whose::User, "done"));
        assert!(theirs.starts_with("[Keel] An agent the user started themselves has finished."));
        assert!(theirs.contains("Don't act on it"));
        assert_eq!(
            pane_notice(&event(Whose::User, "done")),
            "Codex finished in keel (Fix login)."
        );

        // A window that doesn't say counts the pane as the user's.
        let bare: PaneEvent = serde_json::from_str(
            r#"{"kind":"done","paneId":"p1","title":"t","agent":"Codex","project":"keel"}"#,
        )
        .unwrap();
        assert_eq!(bare.whose, Whose::User);
    }

    #[test]
    fn tell_user_is_one_acknowledgement_and_never_for_keel() {
        assert!(Job::report("[Keel] Reminder #1".into()).from_keel);
        assert!(!Job::typed("hi".into()).from_keel);

        let mut asked = TurnState::default();
        assert!(asked.acknowledge().is_ok());
        assert!(asked
            .acknowledge()
            .unwrap_err()
            .contains("already heard from you"));

        // A finished pane's summary is the reply alone, not "Claude finished"
        // twice on the phone.
        let mut report = TurnState {
            from_keel: true,
            told: false,
        };
        assert!(report.acknowledge().unwrap_err().contains("[Keel] report"));
        assert!(!report.told);
    }

    #[test]
    fn only_a_missing_conversation_starts_a_new_one() {
        assert!(lost_conversation(
            "No conversation found with session ID: 1111"
        ));
        assert!(lost_conversation("Error: session ses_abc not found"));
        assert!(lost_conversation(
            "Codex stopped without answering:\nError: thread/resume failed: no rollout found for thread id 9999"
        ));
        assert!(!lost_conversation("usage limit reached"));
        assert!(!lost_conversation("Not logged in"));
    }

    #[test]
    fn configure_tells_null_from_missing() {
        let change: Configure = serde_json::from_str(r#"{"accountId":null}"#).unwrap();
        assert!(matches!(change.account_id, Some(None)));
        assert!(change.agent_id.is_none());
    }

    #[test]
    fn attachments_become_a_prompt() {
        let heard = Transcript {
            language: "es".into(),
            text: "corre las pruebas en keel".into(),
        };
        let images = [PathBuf::from("C:/inbox/1-0.jpg")];
        let prompt = attachment_prompt("look at this", std::slice::from_ref(&heard), &images);
        assert!(
            prompt.starts_with("look at this\n\n[Voice message, transcribed automatically (es)")
        );
        assert!(prompt.contains("corre las pruebas en keel"));
        assert!(
            prompt.contains("[The user sent 1 image, attached and saved at:]\n- C:/inbox/1-0.jpg")
        );

        let only_voice = attachment_prompt("", &[heard], &[]);
        assert!(only_voice.starts_with("[Voice message"));
    }

    #[test]
    fn labels_what_came_in() {
        let voice = telegram::Media {
            kind: MediaKind::Voice,
            file_id: "v".into(),
            file_name: None,
            mime: Some("audio/ogg".into()),
            size: None,
            duration: Some(67),
        };
        assert_eq!(
            incoming_label("", std::slice::from_ref(&voice)),
            "🎤 Voice message (1:07)"
        );
        assert_eq!(incoming_label("hi", &[]), "hi");
    }

    #[test]
    fn replies_go_out_when_the_turn_ends_never_errors() {
        let read = |agent: &str, lines: &[&str]| {
            let mut reading = Reading::default();
            for line in lines {
                agents::read_line(agent, line, &mut reading);
            }
            reading
        };
        let working = read(
            "codex",
            &[r#"{"type":"item.completed","item":{"type":"agent_message","text":"Done it."}}"#],
        );
        assert_eq!(ready_reply(&working, false), None);
        assert_eq!(ready_reply(&working, true).as_deref(), Some("Done it."));

        let finished = read(
            "codex",
            &[
                r#"{"type":"item.completed","item":{"type":"agent_message","text":"Done it."}}"#,
                r#"{"type":"turn.completed","usage":{}}"#,
            ],
        );
        assert_eq!(ready_reply(&finished, false).as_deref(), Some("Done it."));

        // Run again in a new conversation, so it must not reach the phone yet.
        let lost = read(
            "claude",
            &[
                r#"{"type":"result","is_error":true,"result":"No conversation found with session ID: x"}"#,
            ],
        );
        assert_eq!(ready_reply(&lost, true), None);

        // An empty answer still waits for the exit status.
        let silent = read(
            "opencode",
            &[r#"{"type":"step_start","sessionID":"ses_1"}"#],
        );
        assert_eq!(ready_reply(&silent, true), None);
    }

    #[test]
    fn keeps_the_end_of_stderr() {
        assert_eq!(last_lines("a\n\nb\nc\n", 2), "b\nc");
        assert_eq!(last_lines("", 3), "");
        assert_eq!(
            last_lines("\u{1b}[91m\u{1b}[1mError: \u{1b}[0mSession not found\n", 1),
            "Error: Session not found"
        );
    }
}
