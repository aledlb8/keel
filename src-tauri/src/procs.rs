//! Process-tree snapshot used to tell whether a typed-in agent is still running.
//!
//! Keel launches the user's shell and types the agent command into it, so the
//! shell PID is not enough: the agent is a descendant. One snapshot of pid→ppid
//! for the whole machine is cheap, and every watched pane is checked against it.

use std::collections::HashMap;

/// pid → parent pid.
pub fn process_parents() -> HashMap<u32, u32> {
    platform_parents()
}

/// True when `root` still has at least one descendant. The root itself does not
/// count — that is the shell, which is supposed to outlive the agent.
pub fn has_descendants(parents: &HashMap<u32, u32>, root: u32) -> bool {
    for (&pid, &ppid) in parents {
        if pid == root {
            continue;
        }
        let mut current = ppid;
        // A corrupted snapshot (or a PID reuse cycle) must not hang the watcher.
        for _ in 0..64 {
            if current == 0 {
                break;
            }
            if current == root {
                return true;
            }
            current = match parents.get(&current) {
                Some(&parent) => parent,
                None => break,
            };
        }
    }
    false
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
fn platform_parents() -> HashMap<u32, u32> {
    windows_parents()
}

#[cfg(target_os = "linux")]
fn platform_parents() -> HashMap<u32, u32> {
    linux_parents()
}

#[cfg(all(unix, not(target_os = "linux")))]
fn platform_parents() -> HashMap<u32, u32> {
    ps_parents()
}

#[cfg(windows)]
fn windows_parents() -> HashMap<u32, u32> {
    use std::mem::{size_of, zeroed};

    use winapi::um::handleapi::{CloseHandle, INVALID_HANDLE_VALUE};
    use winapi::um::tlhelp32::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let mut map = HashMap::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap.is_null() || snap == INVALID_HANDLE_VALUE {
            return map;
        }
        let mut entry: PROCESSENTRY32W = zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                map.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }
    map
}

#[cfg(target_os = "linux")]
fn linux_parents() -> HashMap<u32, u32> {
    let mut map = HashMap::new();
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return map;
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
        if let Some(ppid) = parse_stat_ppid(&stat) {
            map.insert(pid, ppid);
        }
    }
    map
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
fn ps_parents() -> HashMap<u32, u32> {
    let mut map = HashMap::new();
    let Ok(output) = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid="])
        .output()
    else {
        return map;
    };
    if !output.status.success() {
        return map;
    }
    let Ok(text) = std::str::from_utf8(&output.stdout) else {
        return map;
    };
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(pid) = parts.next().and_then(|value| value.parse().ok()) else {
            continue;
        };
        let Some(ppid) = parts.next().and_then(|value| value.parse().ok()) else {
            continue;
        };
        map.insert(pid, ppid);
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_alone_is_not_an_agent() {
        let mut parents = HashMap::new();
        parents.insert(10, 1);
        assert!(!has_descendants(&parents, 10));
    }

    #[test]
    fn finds_a_direct_child() {
        let mut parents = HashMap::new();
        parents.insert(10, 1);
        parents.insert(20, 10);
        assert!(has_descendants(&parents, 10));
        assert!(!has_descendants(&parents, 20));
    }

    #[test]
    fn finds_a_grandchild() {
        let mut parents = HashMap::new();
        parents.insert(10, 1);
        parents.insert(20, 10);
        parents.insert(21, 20);
        assert!(has_descendants(&parents, 10));
    }

    #[test]
    fn missing_root_is_not_running() {
        let mut parents = HashMap::new();
        parents.insert(20, 10);
        assert!(!has_descendants(&parents, 99));
    }

    #[test]
    fn parse_proc_stat_ppid() {
        let line = "1234 (cat) S 1233 1234 1234 0 -1 4194304 0";
        assert_eq!(parse_stat_ppid(line), Some(1233));
        let weird = "9 (a) b) c) S 1 9 9 0 -1";
        assert_eq!(parse_stat_ppid(weird), Some(1));
    }
}
