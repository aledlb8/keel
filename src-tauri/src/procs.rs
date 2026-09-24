//! Process-tree snapshot used to tell which agent CLI, if any, a shell is running.
//!
//! Keel launches the user's shell and types an agent command into it, and the
//! user can also type one later. The shell PID is not the agent: the CLI is a
//! descendant. One snapshot for the whole machine is cheap, and every watched
//! pane is checked against it.

use std::collections::{HashMap, HashSet};

/// One process in a machine-wide snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessRow {
    pub pid: u32,
    pub parent: u32,
    /// File name only, such as `claude.exe` or `node`.
    pub image: String,
}

pub fn process_snapshot() -> Vec<ProcessRow> {
    platform_snapshot()
}

/// Catalogue id plus the process that identified it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunningAgent {
    pub id: String,
    /// `None` when the id came from the launcher's expected command rather than
    /// an executable name. The caller then has no process-start time.
    pub pid: Option<u32>,
}

/// Executable names that mean one catalogue agent. Names are lowercase stems
/// with no path and no `.exe` / `.cmd` / `.js` suffix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentNeedle {
    pub id: String,
    pub names: Vec<String>,
}

/// How far below the shell we look. The CLI the user launched is a direct
/// child, or one shim deeper. Tool processes the CLI itself starts are further
/// down and must not steal the pane.
const MAX_AGENT_DEPTH: usize = 6;

const SCRIPT_EXTENSIONS: &[&str] = &[".exe", ".cmd", ".bat", ".ps1", ".js", ".mjs", ".cjs", ".py"];

/// Interpreters whose own file name is not the agent. The script they were
/// handed is.
const INTERPRETERS: &[&str] = &[
    "node",
    "nodejs",
    "pwsh",
    "powershell",
    "cmd",
    "python",
    "python3",
    "pythonw",
    "bun",
    "deno",
    "ruby",
    "perl",
];

/// Console hosts that sit beside a shell and are not a command the user ran.
const NOISE: &[&str] = &["conhost", "openconsole", "dllhost", "sihost"];

/// `C:\bin\claude.exe` and `claude` both become `claude`.
pub fn executable_stem(name: &str) -> String {
    let file = name.rsplit(['\\', '/', ':']).next().unwrap_or(name).trim();
    let lower = file.to_ascii_lowercase();
    if let Some(dot) = lower.rfind('.') {
        let ext = &lower[dot..];
        if SCRIPT_EXTENSIONS.contains(&ext) && dot > 0 {
            return lower[..dot].to_string();
        }
    }
    lower
}

pub fn needle_for(id: &str, bins: &[String], command: &str) -> Option<AgentNeedle> {
    let id = id.trim();
    if id.is_empty() {
        return None;
    }
    let source: Vec<&str> = if bins.iter().any(|bin| !bin.trim().is_empty()) {
        bins.iter().map(String::as_str).collect()
    } else {
        command.split_whitespace().take(1).collect()
    };
    let mut names = Vec::new();
    for raw in source {
        let stem = executable_stem(raw);
        if stem.is_empty() || stem.len() > 64 || names.iter().any(|existing| existing == &stem) {
            continue;
        }
        names.push(stem);
    }
    if names.is_empty() {
        return None;
    }
    Some(AgentNeedle {
        id: id.to_string(),
        names,
    })
}

/// The catalogue CLI running in `shell_pid`, if one is.
///
/// A direct child named `claude.exe` wins over a grandchild `node.exe` running
/// some other script: that grandchild is a tool the CLI started. Image names
/// are checked before command lines, and a command line is read only for an
/// interpreter (`node`, `pwsh`, `cmd`, …) whose file name is not itself an
/// agent. On that command line only the first script argument counts, so
/// `node app.js gemini.js` is not Gemini.
///
/// `expected` is the agent Keel typed at launch. It is used only when some
/// real child is running and none of them match a catalogue name, so an
/// unusual wrapper still counts until it exits. `conhost.exe` does not.
pub fn attribute_agent(
    rows: &[ProcessRow],
    shell_pid: u32,
    agents: &[AgentNeedle],
    previous: Option<&str>,
    expected: Option<&str>,
    command_args: impl FnMut(u32) -> Option<Vec<String>>,
) -> Option<RunningAgent> {
    if let Some(named) = detect_named(rows, shell_pid, agents, previous, command_args) {
        return Some(named);
    }
    let expected = expected?;
    if !agents.iter().any(|agent| agent.id == expected) {
        return None;
    }
    if !has_substantive_descendant(rows, shell_pid) {
        return None;
    }
    Some(RunningAgent {
        id: expected.to_string(),
        pid: None,
    })
}

fn detect_named(
    rows: &[ProcessRow],
    shell_pid: u32,
    agents: &[AgentNeedle],
    previous: Option<&str>,
    mut command_args: impl FnMut(u32) -> Option<Vec<String>>,
) -> Option<RunningAgent> {
    if shell_pid == 0 || agents.is_empty() {
        return None;
    }
    let mut children: HashMap<u32, Vec<usize>> = HashMap::new();
    for (index, row) in rows.iter().enumerate() {
        if row.pid == 0 || row.pid == row.parent {
            continue;
        }
        children.entry(row.parent).or_default().push(index);
    }
    for kids in children.values_mut() {
        kids.sort_by_key(|index| rows[*index].pid);
    }

    let mut frontier = vec![shell_pid];
    let mut seen = HashSet::from([shell_pid]);
    for _depth in 0..MAX_AGENT_DEPTH {
        let mut next = Vec::new();
        let mut matches: Vec<(usize, u32)> = Vec::new();
        let mut interpreters: Vec<u32> = Vec::new();
        for pid in frontier {
            let Some(kids) = children.get(&pid) else {
                continue;
            };
            for &index in kids {
                let row = &rows[index];
                if !seen.insert(row.pid) {
                    continue;
                }
                next.push(row.pid);
                if let Some(agent_index) = match_stem(&executable_stem(&row.image), agents) {
                    matches.push((agent_index, row.pid));
                } else if is_interpreter(&row.image) {
                    interpreters.push(row.pid);
                }
            }
        }
        if matches.is_empty() {
            for pid in interpreters {
                let Some(args) = command_args(pid) else {
                    continue;
                };
                if let Some(agent_index) = match_script_args(&args, agents) {
                    matches.push((agent_index, pid));
                }
            }
        }
        if !matches.is_empty() {
            return Some(choose_match(matches, agents, previous));
        }
        if next.is_empty() {
            break;
        }
        frontier = next;
    }
    None
}

fn choose_match(
    matches: Vec<(usize, u32)>,
    agents: &[AgentNeedle],
    previous: Option<&str>,
) -> RunningAgent {
    if let Some(prev) = previous {
        if let Some((index, pid)) = matches
            .iter()
            .copied()
            .find(|(index, _)| agents[*index].id == prev)
        {
            return RunningAgent {
                id: agents[index].id.clone(),
                pid: Some(pid),
            };
        }
    }
    let (index, pid) = matches
        .into_iter()
        .min_by_key(|(index, pid)| (*index, *pid))
        .expect("matches is non-empty");
    RunningAgent {
        id: agents[index].id.clone(),
        pid: Some(pid),
    }
}

fn match_stem(stem: &str, agents: &[AgentNeedle]) -> Option<usize> {
    if stem.is_empty() {
        return None;
    }
    agents
        .iter()
        .position(|agent| agent.names.iter().any(|name| name == stem))
}

fn is_interpreter(image: &str) -> bool {
    let stem = executable_stem(image);
    INTERPRETERS.contains(&stem.as_str())
}

fn is_noise_image(image: &str) -> bool {
    let stem = executable_stem(image);
    NOISE.contains(&stem.as_str())
}

/// True when the shell has a descendant that is a command, not only a console host.
pub fn has_substantive_descendant(rows: &[ProcessRow], shell_pid: u32) -> bool {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut images: HashMap<u32, &str> = HashMap::new();
    for row in rows {
        images.insert(row.pid, row.image.as_str());
        if row.pid != 0 && row.pid != row.parent {
            children.entry(row.parent).or_default().push(row.pid);
        }
    }
    let mut stack = children.get(&shell_pid).cloned().unwrap_or_default();
    let mut seen = HashSet::from([shell_pid]);
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        if !is_noise_image(images.get(&pid).copied().unwrap_or("")) {
            return true;
        }
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids.iter().copied());
        }
    }
    false
}

/// First script on an interpreter command line, matched to a catalogue stem.
///
/// Flags (`-e`, `/c`) are skipped. The first remaining token that looks like a
/// script decides the process: a later `gemini.js` is an argument, not the program.
fn match_script_args(args: &[String], agents: &[AgentNeedle]) -> Option<usize> {
    for arg in args.iter().skip(1) {
        let token = arg.trim().trim_matches('"');
        if token.is_empty() || is_flag(token) {
            continue;
        }
        let Some(stem) = script_stem(token) else {
            continue;
        };
        return match_stem(&stem, agents);
    }
    None
}

fn is_flag(token: &str) -> bool {
    if token.starts_with('-') {
        return true;
    }
    let mut chars = token.chars();
    if chars.next() != Some('/') {
        return false;
    }
    // `/c` is cmd's flag. `/usr/bin/gemini.js` is a path.
    let rest: String = chars.collect();
    !rest.contains('/') && !rest.contains('\\')
}

fn script_stem(token: &str) -> Option<String> {
    let file = token.rsplit(['\\', '/']).next().unwrap_or(token);
    let lower = file.to_ascii_lowercase();
    let dot = lower.rfind('.')?;
    if dot == 0 || !SCRIPT_EXTENSIONS.contains(&&lower[dot..]) {
        return None;
    }
    Some(lower[..dot].to_string())
}

/// Job handle whose members are killed when the handle is dropped.
///
/// Empty on non-Windows. Assignment is best-effort: a process already in a
/// non-nested job, or a vanished PID, leaves the PTY running without a job.
pub struct KillOnCloseJob {
    #[cfg(windows)]
    _handle: JobHandle,
}

#[cfg(windows)]
struct JobHandle(winapi::shared::ntdef::HANDLE);

#[cfg(windows)]
unsafe impl Send for KillOnCloseJob {}
#[cfg(windows)]
unsafe impl Sync for KillOnCloseJob {}

#[cfg(windows)]
impl Drop for JobHandle {
    fn drop(&mut self) {
        unsafe {
            winapi::um::handleapi::CloseHandle(self.0);
        }
    }
}

/// Assign `pid` to a kill-on-close job. `None` if the platform cannot, or
/// assignment failed — the caller still owns the process.
pub fn adopt_kill_on_close(pid: u32) -> Option<KillOnCloseJob> {
    #[cfg(windows)]
    {
        windows_adopt_job(pid)
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        None
    }
}

#[cfg(windows)]
fn windows_adopt_job(pid: u32) -> Option<KillOnCloseJob> {
    use std::ptr::null_mut;

    use winapi::um::handleapi::CloseHandle;
    use winapi::um::jobapi2::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
    };
    use winapi::um::processthreadsapi::OpenProcess;
    use winapi::um::winnt::{
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    if pid == 0 {
        return None;
    }

    unsafe {
        let handle = CreateJobObjectW(null_mut(), null_mut());
        if handle.is_null() {
            return None;
        }
        let job = KillOnCloseJob {
            _handle: JobHandle(handle),
        };
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let sized = SetInformationJobObject(
            job._handle.0,
            JobObjectExtendedLimitInformation,
            std::ptr::addr_of_mut!(info).cast(),
            std::mem::size_of_val(&info) as u32,
        );
        if sized == 0 {
            return None;
        }
        let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        if process.is_null() {
            return None;
        }
        let ok = AssignProcessToJobObject(job._handle.0, process) != 0;
        CloseHandle(process);
        if ok {
            Some(job)
        } else {
            None
        }
    }
}

#[cfg(windows)]
fn platform_snapshot() -> Vec<ProcessRow> {
    windows_snapshot()
}

#[cfg(target_os = "linux")]
fn platform_snapshot() -> Vec<ProcessRow> {
    linux_snapshot()
}

#[cfg(all(unix, not(target_os = "linux")))]
fn platform_snapshot() -> Vec<ProcessRow> {
    ps_snapshot()
}

#[cfg(not(any(windows, unix)))]
fn platform_snapshot() -> Vec<ProcessRow> {
    Vec::new()
}

#[cfg(windows)]
fn windows_snapshot() -> Vec<ProcessRow> {
    use std::mem::{size_of, zeroed};

    use winapi::um::handleapi::{CloseHandle, INVALID_HANDLE_VALUE};
    use winapi::um::tlhelp32::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let mut rows = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap.is_null() || snap == INVALID_HANDLE_VALUE {
            return rows;
        }
        let mut entry: PROCESSENTRY32W = zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                rows.push(ProcessRow {
                    pid: entry.th32ProcessID,
                    parent: entry.th32ParentProcessID,
                    image: utf16_z(&entry.szExeFile),
                });
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }
    rows
}

#[cfg(windows)]
fn utf16_z(buf: &[u16]) -> String {
    let len = buf.iter().position(|&unit| unit == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

#[cfg(target_os = "linux")]
fn linux_snapshot() -> Vec<ProcessRow> {
    let mut rows = Vec::new();
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return rows;
    };
    for entry in dir.flatten() {
        let pid: u32 = match entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse().ok())
        {
            Some(pid) => pid,
            None => continue,
        };
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        let Some(parent) = parse_stat_ppid(&stat) else {
            continue;
        };
        rows.push(ProcessRow {
            pid,
            parent,
            image: linux_image(pid),
        });
    }
    rows
}

#[cfg(target_os = "linux")]
fn linux_image(pid: u32) -> String {
    if let Ok(path) = std::fs::read_link(format!("/proc/{pid}/exe")) {
        if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
            if !name.is_empty() {
                return name.to_string();
            }
        }
    }
    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// `/proc/<pid>/stat` is `pid (comm) state ppid ...`. `comm` can contain spaces
/// and parentheses, so the ppid is the second field after the last `)`.
#[cfg(any(target_os = "linux", test))]
fn parse_stat_ppid(stat: &str) -> Option<u32> {
    let close = stat.rfind(')')?;
    let mut rest = stat[close + 1..].split_whitespace();
    rest.next()?; // state
    rest.next()?.parse().ok()
}

#[cfg(all(unix, not(target_os = "linux")))]
fn ps_snapshot() -> Vec<ProcessRow> {
    let mut rows = Vec::new();
    let Ok(output) = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,comm="])
        .output()
    else {
        return rows;
    };
    if !output.status.success() {
        return rows;
    }
    let Ok(text) = std::str::from_utf8(&output.stdout) else {
        return rows;
    };
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(pid) = parts.next().and_then(|value| value.parse().ok()) else {
            continue;
        };
        let Some(parent) = parts.next().and_then(|value| value.parse().ok()) else {
            continue;
        };
        let image = parts.next().unwrap_or("").to_string();
        rows.push(ProcessRow { pid, parent, image });
    }
    rows
}

/// Arguments of `pid`, for matching a script an interpreter was started with.
///
/// The raw command line stays in this process. Callers only learn which
/// catalogue id matched.
pub fn command_args(pid: u32) -> Option<Vec<String>> {
    #[cfg(windows)]
    {
        windows_command_line(pid).and_then(|line| split_command_line(&line))
    }
    #[cfg(target_os = "linux")]
    {
        linux_command_args(pid)
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = pid;
        None
    }
}

/// The process command line. Windows-only; other platforms use [`command_args`].
#[cfg(windows)]
pub fn command_line(pid: u32) -> Option<String> {
    windows_command_line(pid)
}

/// Unix milliseconds when `pid` was created, if the OS will say.
pub fn process_started_ms(pid: u32) -> Option<u64> {
    if pid == 0 {
        return None;
    }
    #[cfg(windows)]
    {
        windows_started_ms(pid)
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[cfg(windows)]
fn windows_command_line(pid: u32) -> Option<String> {
    use std::ptr::null_mut;

    use winapi::shared::ntdef::UNICODE_STRING;
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::processthreadsapi::OpenProcess;
    use winapi::um::winnt::PROCESS_QUERY_LIMITED_INFORMATION;

    const PROCESS_COMMAND_LINE_INFORMATION: u32 = 60;

    #[link(name = "ntdll")]
    extern "system" {
        fn NtQueryInformationProcess(
            process: winapi::shared::ntdef::HANDLE,
            class: u32,
            info: *mut std::ffi::c_void,
            length: u32,
            returned: *mut u32,
        ) -> i32;
    }

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut needed = 0u32;
        let _ = NtQueryInformationProcess(
            handle,
            PROCESS_COMMAND_LINE_INFORMATION,
            null_mut(),
            0,
            &mut needed,
        );
        if needed == 0 {
            let mut probe = [0u8; 16];
            let _ = NtQueryInformationProcess(
                handle,
                PROCESS_COMMAND_LINE_INFORMATION,
                probe.as_mut_ptr().cast(),
                probe.len() as u32,
                &mut needed,
            );
        }
        if needed == 0 {
            CloseHandle(handle);
            return None;
        }
        let mut buf = vec![0u8; needed as usize];
        let status = NtQueryInformationProcess(
            handle,
            PROCESS_COMMAND_LINE_INFORMATION,
            buf.as_mut_ptr().cast(),
            needed,
            &mut needed,
        );
        CloseHandle(handle);
        if status != 0 || (needed as usize) < std::mem::size_of::<UNICODE_STRING>() {
            return None;
        }
        let header = std::mem::size_of::<UNICODE_STRING>();
        let unicode = buf.as_ptr().cast::<UNICODE_STRING>().read_unaligned();
        if unicode.Length == 0 {
            return None;
        }
        let bytes = unicode.Length as usize;
        if !bytes.is_multiple_of(2) {
            return None;
        }
        let start = unicode.Buffer as usize;
        let base = buf.as_ptr() as usize;
        let offset =
            if !unicode.Buffer.is_null() && start >= base && start + bytes <= base + buf.len() {
                start - base
            } else if buf.len() >= header + bytes {
                header
            } else {
                return None;
            };
        if offset + bytes > buf.len() {
            return None;
        }
        let raw = std::slice::from_raw_parts(buf[offset..].as_ptr().cast::<u16>(), bytes / 2);
        Some(String::from_utf16_lossy(raw))
    }
}

#[cfg(windows)]
fn split_command_line(command: &str) -> Option<Vec<String>> {
    use winapi::um::shellapi::CommandLineToArgvW;
    use winapi::um::winbase::LocalFree;

    if command.is_empty() {
        return None;
    }
    let wide: Vec<u16> = command.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let mut argc = 0i32;
        let argv = CommandLineToArgvW(wide.as_ptr(), &mut argc);
        if argv.is_null() || argc <= 0 {
            return None;
        }
        let mut args = Vec::with_capacity(argc as usize);
        for index in 0..argc as isize {
            let ptr = *argv.offset(index);
            if ptr.is_null() {
                continue;
            }
            let mut len = 0usize;
            while *ptr.add(len) != 0 {
                len += 1;
            }
            args.push(String::from_utf16_lossy(std::slice::from_raw_parts(
                ptr, len,
            )));
        }
        LocalFree(argv.cast());
        if args.is_empty() {
            None
        } else {
            Some(args)
        }
    }
}

#[cfg(windows)]
fn zeroed_filetime() -> winapi::shared::minwindef::FILETIME {
    winapi::shared::minwindef::FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    }
}

#[cfg(windows)]
fn windows_started_ms(pid: u32) -> Option<u64> {
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::processthreadsapi::{GetProcessTimes, OpenProcess};
    use winapi::um::winnt::PROCESS_QUERY_LIMITED_INFORMATION;

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut created = zeroed_filetime();
        let mut exited = zeroed_filetime();
        let mut kernel = zeroed_filetime();
        let mut user = zeroed_filetime();
        let ok = GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user);
        CloseHandle(handle);
        if ok == 0 {
            return None;
        }
        filetime_unix_ms(created.dwLowDateTime, created.dwHighDateTime)
    }
}

#[cfg(windows)]
fn filetime_unix_ms(low: u32, high: u32) -> Option<u64> {
    let ticks = ((high as u64) << 32) | low as u64;
    // 100-nanosecond intervals between 1601-01-01 and 1970-01-01.
    const UNIX_EPOCH_TICKS: u64 = 116_444_736_000_000_000;
    ticks
        .checked_sub(UNIX_EPOCH_TICKS)
        .map(|delta| delta / 10_000)
}

#[cfg(target_os = "linux")]
fn linux_command_args(pid: u32) -> Option<Vec<String>> {
    let bytes = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let args: Vec<String> = bytes
        .split(|byte| *byte == 0)
        .filter(|chunk| !chunk.is_empty())
        .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
        .collect();
    if args.is_empty() {
        None
    } else {
        Some(args)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_proc_stat_ppid() {
        let line = "1234 (cat) S 1233 1234 1234 0 -1 4194304 0";
        assert_eq!(parse_stat_ppid(line), Some(1233));
        let weird = "9 (a) b) c) S 1 9 9 0 -1";
        assert_eq!(parse_stat_ppid(weird), Some(1));
    }

    fn claude() -> AgentNeedle {
        needle_for("claude", &["claude".to_string()], "claude").unwrap()
    }

    fn gemini() -> AgentNeedle {
        needle_for("gemini", &["gemini".to_string()], "gemini").unwrap()
    }

    fn row(pid: u32, parent: u32, image: &str) -> ProcessRow {
        ProcessRow {
            pid,
            parent,
            image: image.to_string(),
        }
    }

    #[test]
    fn stem_strips_a_windows_path_and_extension() {
        assert_eq!(
            executable_stem(r"C:\Users\a\.local\bin\claude.exe"),
            "claude"
        );
        assert_eq!(executable_stem("GEMINI.JS"), "gemini");
        assert_eq!(executable_stem("opencode"), "opencode");
        assert_eq!(executable_stem(".exe"), ".exe");
    }

    #[test]
    fn needle_uses_bins_and_ignores_a_wrapper_command() {
        let needle =
            needle_for("gemini", &["gemini".to_string()], "pwsh -File gemini.ps1").unwrap();
        assert_eq!(needle.names, vec!["gemini".to_string()]);
        let custom = needle_for("mine", &[], r"C:\tools\mine.cmd --flag").unwrap();
        assert_eq!(custom.names, vec!["mine".to_string()]);
    }

    #[test]
    fn direct_child_image_is_the_agent() {
        let rows = vec![
            row(10, 1, "pwsh.exe"),
            row(20, 10, "claude.exe"),
            row(21, 20, "node.exe"),
        ];
        let found = attribute_agent(&rows, 10, &[claude(), gemini()], None, None, |_| {
            panic!("image match must not read a command line");
        });
        assert_eq!(
            found,
            Some(RunningAgent {
                id: "claude".into(),
                pid: Some(20),
            })
        );
    }

    #[test]
    fn interpreter_script_names_gemini_and_ignores_a_later_argument() {
        let agents = [claude(), gemini()];
        let rows = vec![row(10, 1, "pwsh.exe"), row(30, 10, "node.exe")];
        let found = attribute_agent(&rows, 10, &agents, None, None, |_| {
            Some(vec![
                r"C:\pnpm\node.exe".into(),
                r"C:\pnpm\global\gemini.js".into(),
            ])
        });
        assert_eq!(found.unwrap().id, "gemini");

        let not_gemini = attribute_agent(&rows, 10, &agents, None, None, |_| {
            Some(vec![
                "node.exe".into(),
                r"C:\app\server.js".into(),
                r"C:\app\gemini.js".into(),
            ])
        });
        assert_eq!(not_gemini, None);
    }

    #[test]
    fn closest_agent_wins_over_a_deeper_one() {
        let rows = vec![
            row(10, 1, "pwsh.exe"),
            row(20, 10, "claude.exe"),
            row(30, 20, "node.exe"),
        ];
        let found = attribute_agent(&rows, 10, &[gemini(), claude()], None, None, |_| {
            Some(vec!["node.exe".into(), "gemini.js".into()])
        });
        assert_eq!(found.unwrap().id, "claude");
    }

    #[test]
    fn git_and_conhost_are_not_agents() {
        let rows = vec![
            row(10, 1, "pwsh.exe"),
            row(11, 10, "conhost.exe"),
            row(12, 10, "git.exe"),
        ];
        assert_eq!(
            attribute_agent(&rows, 10, &[claude()], None, None, |_| None),
            None
        );
        assert!(has_substantive_descendant(&rows, 10));
        let only_host = vec![row(10, 1, "pwsh.exe"), row(11, 10, "conhost.exe")];
        assert!(!has_substantive_descendant(&only_host, 10));
        assert_eq!(
            attribute_agent(&only_host, 10, &[claude()], None, Some("claude"), |_| None),
            None
        );
    }

    #[test]
    fn expected_agent_covers_an_unnamed_wrapper_only() {
        let rows = vec![row(10, 1, "pwsh.exe"), row(40, 10, "my-wrapper.exe")];
        let found = attribute_agent(&rows, 10, &[claude()], None, Some("claude"), |_| None);
        assert_eq!(
            found,
            Some(RunningAgent {
                id: "claude".into(),
                pid: None,
            })
        );
        let named = attribute_agent(
            &[row(10, 1, "pwsh.exe"), row(20, 10, "claude.exe")],
            10,
            &[claude()],
            None,
            Some("grok"),
            |_| None,
        );
        assert_eq!(named.unwrap().id, "claude");
        assert_eq!(
            attribute_agent(&rows, 10, &[claude()], None, None, |_| None),
            None
        );
    }

    #[test]
    fn previous_agent_stays_when_two_match_at_the_same_depth() {
        let rows = vec![
            row(10, 1, "pwsh.exe"),
            row(21, 10, "gemini.exe"),
            row(20, 10, "claude.exe"),
        ];
        let found = attribute_agent(
            &rows,
            10,
            &[claude(), gemini()],
            Some("gemini"),
            None,
            |_| None,
        );
        assert_eq!(found.unwrap().pid, Some(21));
    }

    #[test]
    fn cmd_shim_matches_the_script_it_launches() {
        let rows = vec![row(10, 1, "pwsh.exe"), row(50, 10, "cmd.exe")];
        let found = attribute_agent(&rows, 10, &[gemini()], None, None, |_| {
            Some(vec![
                r"C:\Windows\System32\cmd.exe".into(),
                "/c".into(),
                r"C:\pnpm\gemini.cmd".into(),
            ])
        });
        assert_eq!(found.unwrap().id, "gemini");
    }

    #[cfg(windows)]
    #[test]
    fn command_line_reads_this_process() {
        let line = command_line(std::process::id()).expect("own command line");
        assert!(!line.is_empty());
        let args = command_args(std::process::id()).expect("own args");
        assert!(!args.is_empty());
        let started = process_started_ms(std::process::id()).expect("start time");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        assert!(started <= now);
        assert!(now - started < 24 * 60 * 60 * 1000);
    }

    #[cfg(windows)]
    #[test]
    fn quoted_script_path_survives_argv_splitting() {
        let args = split_command_line(r#"node.exe "C:\pnpm\gemini.js" --foo"#).unwrap();
        assert_eq!(args[1], r"C:\pnpm\gemini.js");
    }
}
