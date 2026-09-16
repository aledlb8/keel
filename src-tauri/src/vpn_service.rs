//! Talk to the OpenVPN Interactive Service on Windows.
//!
//! Spawning `openvpn.exe` ourselves leaves `msg_channel=0`, so `netsh
//! interface ip set address` runs without privileges and returns error code 1.
//! The documented client (OpenVPN GUI) instead asks
//! `\\.\pipe\openvpn\service` to start openvpn.exe and keep a privileged
//! channel to it. That is what assigns the tunnel IP.

/// Named event OpenVPN waits on when started with `--service`. Signaling it
/// is a SIGTERM, which sends `explicit-exit-notify` so Access Server drops
/// the licensed slot instead of waiting for ping-restart.
pub const KEEL_EXIT_EVENT: &str = r"Local\keel-openvpn-exit";

pub fn engine_startup_options(config: &std::path::Path, log: &std::path::Path) -> String {
    let mut options = format!(
        "--config \"{}\" --log \"{}\" --verb 3 --script-security 0",
        config.display(),
        log.display()
    );
    if cfg!(windows) {
        options.push_str(&format!(" --service \"{KEEL_EXIT_EVENT}\" 0"));
    }
    options
}

/// UTF-16 startup payload: workingdir \0 options \0 stdin \0
pub fn encode_startup(workdir: &str, options: &str, stdin: &str) -> Vec<u16> {
    let mut msg = Vec::with_capacity(workdir.len() + options.len() + stdin.len() + 3);
    msg.extend(workdir.encode_utf16());
    msg.push(0);
    msg.extend(options.encode_utf16());
    msg.push(0);
    msg.extend(stdin.encode_utf16());
    msg.push(0);
    msg
}

/// Parse the Interactive Service's UTF-16 reply (already decoded).
///
/// Success: `0x00000000\n0x<pid>\nProcess ID`
/// Error:   `0x<err>\n<func>\n<message>`
pub fn parse_service_reply(text: &str) -> Result<u32, String> {
    let mut lines = text
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty());
    let code = lines.next().unwrap_or("");
    let second = lines.next().unwrap_or("");
    let rest: Vec<&str> = lines.collect();
    let ok = code.eq_ignore_ascii_case("0x00000000") || code == "0x0" || code == "0";
    if ok {
        let hex = second.trim_start_matches("0x").trim_start_matches("0X");
        return u32::from_str_radix(hex, 16)
            .ok()
            .filter(|pid| *pid != 0)
            .ok_or_else(|| {
                format!("OpenVPN Interactive Service returned a bad process id ({second})")
            });
    }
    let detail = std::iter::once(second)
        .chain(rest)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" — ");
    Err(if detail.is_empty() {
        format!("OpenVPN Interactive Service refused to start the tunnel ({code}).")
    } else {
        format!("OpenVPN Interactive Service refused to start the tunnel ({code}): {detail}")
    })
}

/// Turn an OpenVPN log into one sentence the UI can show.
pub fn diagnose_log(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    if lower.contains("dco connect error:") && lower.contains("access is denied") {
        return Some("Windows denied access to the OpenVPN DCO adapter. Trying the TAP adapter may resolve this.".into());
    }
    if lower.contains("auth_failed") || lower.contains("auth-failure") {
        if lower.contains("license") && lower.contains("connection") {
            return Some("The VPN server has reached its licensed connection limit. A previous session can keep its slot for about a minute after a hard close. Wait, then try again.".into());
        }
        return Some(
            "The VPN server rejected the login. Save the username and password in the profile, or use an autologin profile."
                .into(),
        );
    }
    if lower.contains("error code 1") && lower.contains("netsh") {
        if lower.contains("msg_channel=0") {
            return Some(
                "OpenVPN reached the server but Windows refused to set the tunnel IP (netsh error 1). The privileged OpenVPN Interactive Service was not attached (msg_channel=0). Keel will start openvpn through that service so the adapter can get an address."
                    .into(),
            );
        }
        return Some(
            "OpenVPN reached the server but could not assign an IP to the tunnel adapter (netsh error 1). Start the “OpenVPN Interactive Service” in Windows Services and try again."
                .into(),
        );
    }
    if lower.contains("exiting due to fatal error") {
        return Some(
            last_meaningful_line(text)
                .unwrap_or("OpenVPN exited with a fatal error.")
                .to_string(),
        );
    }
    None
}

fn last_meaningful_line(text: &str) -> Option<&str> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .rev()
        .find(|line| {
            let lower = line.to_ascii_lowercase();
            lower.contains("error") || lower.contains("fatal") || lower.contains("failed")
        })
}

#[cfg(windows)]
pub fn start_openvpn(
    config: &std::path::Path,
    log: &std::path::Path,
    deadline: std::time::Instant,
) -> Result<u32, String> {
    start_openvpn_windows(config, log, deadline)
}

#[cfg(not(windows))]
pub fn start_openvpn(
    config: &std::path::Path,
    log: &std::path::Path,
    deadline: std::time::Instant,
) -> Result<u32, String> {
    let _ = (config, log, deadline);
    Err("The OpenVPN Interactive Service exists only on Windows.".into())
}

#[cfg(windows)]
fn start_openvpn_windows(
    config: &std::path::Path,
    log: &std::path::Path,
    deadline: std::time::Instant,
) -> Result<u32, String> {
    use winapi::shared::winerror::ERROR_FILE_NOT_FOUND;

    const PIPE_WAIT: std::time::Duration = std::time::Duration::from_secs(5);
    const STARTUP_WAIT: std::time::Duration = std::time::Duration::from_secs(15);

    let pipe = match open_service_pipe(
        false,
        PIPE_WAIT.min(deadline.saturating_duration_since(std::time::Instant::now())),
    ) {
        Ok(pipe) => pipe,
        Err(err) if err.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32) => {
            try_start_interactive_service(deadline)?;
            open_service_pipe(
                true,
                STARTUP_WAIT.min(deadline.saturating_duration_since(std::time::Instant::now())),
            )
            .map_err(describe_pipe_open_error)?
        }
        Err(err) => return Err(describe_pipe_open_error(err)),
    };

    send_startup(
        pipe,
        config,
        log,
        deadline.min(std::time::Instant::now() + std::time::Duration::from_secs(10)),
    )
}

#[cfg(windows)]
fn try_start_interactive_service(deadline: std::time::Instant) -> Result<(), String> {
    recover_service_start(start_service_if_stopped(), || {
        start_service_elevated(deadline)
    })
}

/// Only an access-rights failure warrants UAC. Missing/disabled services and
/// startup failures need their own diagnosis, not another privileged attempt.
#[cfg(windows)]
fn recover_service_start(
    result: Result<(), std::io::Error>,
    elevate: impl FnOnce() -> Result<(), std::io::Error>,
) -> Result<(), String> {
    use winapi::shared::winerror::{ERROR_ACCESS_DENIED, ERROR_SERVICE_ALREADY_RUNNING};
    match result {
        Ok(()) => Ok(()),
        Err(err) if err.raw_os_error() == Some(ERROR_SERVICE_ALREADY_RUNNING as i32) => Ok(()),
        Err(err) if err.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) => elevate()
            .or_else(|err| {
                if err.raw_os_error() == Some(ERROR_SERVICE_ALREADY_RUNNING as i32) {
                    Ok(())
                } else {
                    Err(err)
                }
            })
            .map_err(describe_service_start_error),
        Err(err) => Err(describe_service_start_error(err)),
    }
}

#[cfg(windows)]
fn describe_service_start_error(err: std::io::Error) -> String {
    use winapi::shared::winerror::{
        ERROR_ACCESS_DENIED, ERROR_CANCELLED, ERROR_SERVICE_DISABLED, ERROR_SERVICE_DOES_NOT_EXIST,
    };
    let advice = match err.raw_os_error().map(|code| code as u32) {
        Some(ERROR_CANCELLED) => "Windows administrator approval was canceled. Try again and approve starting the OpenVPN Interactive Service.",
        Some(ERROR_ACCESS_DENIED) => "Windows denied permission to start the OpenVPN Interactive Service. An administrator must start this service before Keel can connect.",
        Some(ERROR_SERVICE_DOES_NOT_EXIST) => "The OpenVPN Interactive Service is not installed. Repair the OpenVPN community client installation and include its Interactive Service.",
        Some(ERROR_SERVICE_DISABLED) => "The OpenVPN Interactive Service is disabled. Enable it in Windows Services, then try again.",
        _ => "Windows could not start the OpenVPN Interactive Service. Check its status in Windows Services, then try again.",
    };
    format!("{advice} ({err})")
}

#[cfg(windows)]
struct ServiceHandle(winapi::um::winsvc::SC_HANDLE);

#[cfg(windows)]
impl Drop for ServiceHandle {
    fn drop(&mut self) {
        unsafe {
            winapi::um::winsvc::CloseServiceHandle(self.0);
        }
    }
}

#[cfg(windows)]
fn start_service_if_stopped() -> Result<(), std::io::Error> {
    use std::ptr::{null, null_mut};
    use winapi::um::winsvc::{
        OpenSCManagerW, OpenServiceW, QueryServiceStatus, StartServiceW, SC_MANAGER_CONNECT,
        SERVICE_QUERY_STATUS, SERVICE_RUNNING, SERVICE_START, SERVICE_START_PENDING,
    };

    let scm = unsafe { OpenSCManagerW(null(), null(), SC_MANAGER_CONNECT) };
    if scm.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    let scm = ServiceHandle(scm);
    let name: Vec<u16> = "OpenVPNServiceInteractive\0".encode_utf16().collect();
    // Query separately: a normal user can inspect an already-running service
    // without SERVICE_START rights, and must not get a needless UAC prompt.
    let service = unsafe { OpenServiceW(scm.0, name.as_ptr(), SERVICE_QUERY_STATUS) };
    if service.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    let service = ServiceHandle(service);
    let mut status = unsafe { std::mem::zeroed() };
    if unsafe { QueryServiceStatus(service.0, &mut status) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    if matches!(
        status.dwCurrentState,
        SERVICE_RUNNING | SERVICE_START_PENDING
    ) {
        return Ok(());
    }
    let starter = unsafe { OpenServiceW(scm.0, name.as_ptr(), SERVICE_START) };
    if starter.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    let starter = ServiceHandle(starter);
    if unsafe { StartServiceW(starter.0, 0, null_mut()) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// Elevate only Windows' service-control utility with fixed arguments. Keel,
/// terminals, profile contents, and the VPN engine retain the user's token.
#[cfg(windows)]
fn start_service_elevated(deadline: std::time::Instant) -> Result<(), std::io::Error> {
    use winapi::shared::winerror::ERROR_TIMEOUT;
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::processthreadsapi::GetExitCodeProcess;
    use winapi::um::shellapi::{
        ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS,
        SHELLEXECUTEINFOW,
    };
    use winapi::um::synchapi::WaitForSingleObject;
    use winapi::um::sysinfoapi::GetSystemDirectoryW;
    use winapi::um::winbase::WAIT_OBJECT_0;
    use winapi::um::winuser::SW_HIDE;

    // Resolve sc.exe from the Windows system directory, never PATH or a
    // profile-controlled path, because this executable will run elevated.
    let mut system_dir = vec![0u16; 32768];
    let len = unsafe { GetSystemDirectoryW(system_dir.as_mut_ptr(), system_dir.len() as u32) };
    if len == 0 {
        return Err(std::io::Error::last_os_error());
    }
    if len as usize >= system_dir.len() {
        return Err(std::io::Error::other(
            "Windows system directory is too long",
        ));
    }
    system_dir.truncate(len as usize);
    system_dir.extend("\\sc.exe\0".encode_utf16());
    let verb: Vec<u16> = "runas\0".encode_utf16().collect();
    let args: Vec<u16> = "start OpenVPNServiceInteractive\0".encode_utf16().collect();
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI;
    info.lpVerb = verb.as_ptr();
    info.lpFile = system_dir.as_ptr();
    info.lpParameters = args.as_ptr();
    info.nShow = SW_HIDE;
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    if info.hProcess.is_null() {
        return Err(std::io::Error::other(
            "Windows did not return the service starter process",
        ));
    }
    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
    let wait_ms = remaining.as_millis().min(u32::MAX as u128) as u32;
    let wait = unsafe { WaitForSingleObject(info.hProcess, wait_ms) };
    let result = if wait == WAIT_OBJECT_0 {
        let mut code = 0;
        if unsafe { GetExitCodeProcess(info.hProcess, &mut code) } == 0 {
            Err(std::io::Error::last_os_error())
        } else if code == 0 {
            Ok(())
        } else {
            Err(std::io::Error::from_raw_os_error(code as i32))
        }
    } else {
        Err(std::io::Error::from_raw_os_error(ERROR_TIMEOUT as i32))
    };
    unsafe {
        CloseHandle(info.hProcess);
    }
    result
}

#[cfg(windows)]
struct OwnedHandle(winapi::shared::ntdef::HANDLE);

#[cfg(windows)]
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            winapi::um::handleapi::CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
fn service_pipe_name() -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    std::ffi::OsStr::new(r"\\.\pipe\openvpn\service")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Open one service-pipe instance and keep that exact instance for the request.
///
/// `ERROR_PIPE_BUSY` is a normal transient state while the service hands a
/// connection to a worker and creates its next listener. Windows explicitly
/// requires clients to wait and retry in that case. `wait_for_creation` is used
/// after starting the service, when the pipe may not exist yet.
#[cfg(windows)]
fn open_service_pipe(
    wait_for_creation: bool,
    timeout: std::time::Duration,
) -> Result<OwnedHandle, std::io::Error> {
    use std::ptr::null_mut;

    use winapi::shared::winerror::{ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY, ERROR_SEM_TIMEOUT};
    use winapi::um::fileapi::{CreateFileW, OPEN_EXISTING};
    use winapi::um::handleapi::INVALID_HANDLE_VALUE;
    use winapi::um::namedpipeapi::WaitNamedPipeW;
    use winapi::um::winbase::FILE_FLAG_OVERLAPPED;
    use winapi::um::winnt::{GENERIC_READ, GENERIC_WRITE};

    const CREATION_POLL: std::time::Duration = std::time::Duration::from_millis(50);

    let name = service_pipe_name();
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                null_mut(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED,
                null_mut(),
            )
        };
        if handle != INVALID_HANDLE_VALUE {
            return Ok(OwnedHandle(handle));
        }

        let open_error = std::io::Error::last_os_error();
        let code = open_error.raw_os_error();
        let now = std::time::Instant::now();
        if now >= deadline {
            return Err(open_error);
        }

        if code == Some(ERROR_PIPE_BUSY as i32) {
            let remaining = deadline.saturating_duration_since(now);
            let wait_ms = remaining.as_millis().clamp(1, u32::MAX as u128) as u32;
            let available = unsafe { WaitNamedPipeW(name.as_ptr(), wait_ms) };
            if available == 0 {
                let wait_error = std::io::Error::last_os_error();
                if wait_error.raw_os_error() == Some(ERROR_SEM_TIMEOUT as i32) {
                    return Err(open_error);
                }
                if wait_for_creation
                    && wait_error.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32)
                {
                    std::thread::sleep(CREATION_POLL.min(remaining));
                    continue;
                }
                return Err(wait_error);
            }
            // Availability is only a snapshot; another client may win the
            // instance before CreateFileW, so always retry in the loop.
            continue;
        }

        if wait_for_creation && code == Some(ERROR_FILE_NOT_FOUND as i32) {
            std::thread::sleep(CREATION_POLL.min(deadline.saturating_duration_since(now)));
            continue;
        }

        return Err(open_error);
    }
}

#[cfg(windows)]
fn describe_pipe_open_error(err: std::io::Error) -> String {
    use winapi::shared::winerror::{ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY};

    match err.raw_os_error() {
        Some(code) if code == ERROR_PIPE_BUSY as i32 => format!(
            "The OpenVPN Interactive Service is busy and did not accept the connection in time ({err}). Try again after any other OpenVPN connection attempt has finished."
        ),
        Some(code) if code == ERROR_FILE_NOT_FOUND as i32 => format!(
            "The OpenVPN Interactive Service did not make its connection pipe available within 15 seconds ({err}). Check the service's status in Windows Services, then try again."
        ),
        _ => format!(
            "Could not connect to the OpenVPN Interactive Service ({err}). Open Services (services.msc), verify that “OpenVPN Interactive Service” is running, then try again."
        ),
    }
}

#[cfg(windows)]
fn send_startup(
    pipe: OwnedHandle,
    config: &std::path::Path,
    log: &std::path::Path,
    deadline: std::time::Instant,
) -> Result<u32, String> {
    use std::ptr::null_mut;

    use winapi::shared::minwindef::DWORD;
    use winapi::um::fileapi::{ReadFile, WriteFile};
    use winapi::um::namedpipeapi::SetNamedPipeHandleState;
    use winapi::um::winbase::PIPE_READMODE_MESSAGE;

    let mut mode: DWORD = PIPE_READMODE_MESSAGE;
    let mode_ok = unsafe { SetNamedPipeHandleState(pipe.0, &mut mode, null_mut(), null_mut()) };
    if mode_ok == 0 {
        return Err(format!(
            "Could not configure the OpenVPN Interactive Service pipe: {}",
            std::io::Error::last_os_error()
        ));
    }

    let workdir = config
        .parent()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| ".".into());
    reset_exit_event();
    let options = engine_startup_options(config, log);
    let msg = encode_startup(&workdir, &options, "");
    let bytes = unsafe {
        std::slice::from_raw_parts(
            msg.as_ptr().cast::<u8>(),
            msg.len() * std::mem::size_of::<u16>(),
        )
    };
    let written = pipe_io(pipe.0, deadline, |overlapped, transferred| unsafe {
        WriteFile(
            pipe.0,
            bytes.as_ptr().cast(),
            bytes.len() as DWORD,
            transferred,
            overlapped,
        )
    })
    .map_err(|err| {
        format!("Could not send the start request to the OpenVPN Interactive Service: {err}")
    })?;
    if written as usize != bytes.len() {
        return Err(format!(
            "Could not send the complete start request to the OpenVPN Interactive Service (wrote {written} of {} bytes).",
            bytes.len()
        ));
    }

    let mut buf = vec![0u8; 4096];
    let read = pipe_io(pipe.0, deadline, |overlapped, transferred| unsafe {
        ReadFile(
            pipe.0,
            buf.as_mut_ptr().cast(),
            buf.len() as DWORD,
            transferred,
            overlapped,
        )
    })
    .map_err(|err| format!("The OpenVPN Interactive Service did not reply: {err}"))?;
    if read == 0 {
        return Err("The OpenVPN Interactive Service closed without a reply.".into());
    }
    if !read.is_multiple_of(2) {
        return Err("The OpenVPN Interactive Service returned malformed UTF-16 data.".into());
    }

    let utf16: Vec<u16> = buf[..read as usize]
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect();
    let text = String::from_utf16_lossy(&utf16)
        .trim_end_matches('\0')
        .to_string();
    parse_service_reply(&text)
}

/// Bound both service writes and reads. Cancellation must finish before the
/// OVERLAPPED and caller's buffer can leave scope (Windows still owns them).
#[cfg(windows)]
fn pipe_io(
    pipe: winapi::shared::ntdef::HANDLE,
    deadline: std::time::Instant,
    start: impl FnOnce(*mut winapi::um::minwinbase::OVERLAPPED, *mut u32) -> i32,
) -> Result<u32, std::io::Error> {
    use std::ptr::null_mut;
    use winapi::shared::winerror::ERROR_IO_PENDING;
    use winapi::um::ioapiset::{CancelIoEx, GetOverlappedResult};
    use winapi::um::synchapi::{CreateEventW, WaitForSingleObject};
    use winapi::um::winbase::WAIT_OBJECT_0;

    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
    if remaining.is_zero() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "VPN service timed out",
        ));
    }
    let event = unsafe { CreateEventW(null_mut(), 1, 0, null_mut()) };
    if event.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    let event = OwnedHandle(event);
    let mut overlapped: winapi::um::minwinbase::OVERLAPPED = unsafe { std::mem::zeroed() };
    overlapped.hEvent = event.0;
    let mut transferred = 0;
    if start(&mut overlapped, &mut transferred) != 0 {
        return Ok(transferred);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
        return Err(error);
    }
    let wait_ms = remaining.as_millis().clamp(1, u32::MAX as u128) as u32;
    if unsafe { WaitForSingleObject(event.0, wait_ms) } != WAIT_OBJECT_0 {
        unsafe {
            CancelIoEx(pipe, &mut overlapped);
            GetOverlappedResult(pipe, &mut overlapped, &mut transferred, 1);
        }
        return Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "VPN service timed out",
        ));
    }
    if unsafe { GetOverlappedResult(pipe, &mut overlapped, &mut transferred, 0) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(transferred)
}

#[cfg(windows)]
pub fn pid_running(pid: u32) -> bool {
    use winapi::shared::winerror::ERROR_INVALID_PARAMETER;
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::processthreadsapi::OpenProcess;
    use winapi::um::synchapi::WaitForSingleObject;
    use winapi::um::winbase::WAIT_OBJECT_0;
    use winapi::um::winnt::SYNCHRONIZE;

    unsafe {
        let handle = OpenProcess(SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            // Only a missing PID proves exit. Access restrictions or a failed
            // query must leave the log/deadline checks in charge.
            return std::io::Error::last_os_error().raw_os_error()
                != Some(ERROR_INVALID_PARAMETER as i32);
        }
        let running = WaitForSingleObject(handle, 0) != WAIT_OBJECT_0;
        CloseHandle(handle);
        running
    }
}

#[cfg(not(windows))]
pub fn pid_running(_pid: u32) -> bool {
    false
}

pub const KEEL_CONFIG_FILE: &str = "keel-app.ovpn";
const KILL_WAIT: std::time::Duration = std::time::Duration::from_secs(3);
/// Client-side wait for SIGTERM + control-channel exit notify ACK (OpenVPN 2.7
/// `cc-exit` is ~2.5s). After this, TerminateProcess is the fallback.
const GRACEFUL_WAIT: std::time::Duration = std::time::Duration::from_secs(8);
/// Access Server can keep the licensed slot for a few seconds after it ACKs
/// the exit notify (`delayed-exit`). Reconnect waits out the remainder.
const SERVER_SLOT_WAIT: std::time::Duration = std::time::Duration::from_secs(8);

/// True when an `openvpn.exe` command line is Keel's private tunnel, not the
/// user's OpenVPN GUI or another app.
pub fn is_keel_tunnel_command(command_line: &str) -> bool {
    let lower = command_line.to_ascii_lowercase();
    lower.contains(&KEEL_CONFIG_FILE.to_ascii_lowercase())
        || (lower.contains("com.alede.keel") && lower.contains("openvpn.log"))
}

#[cfg(windows)]
fn keel_vpn_dir() -> Option<std::path::PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    Some(
        std::path::PathBuf::from(appdata)
            .join("com.alede.keel")
            .join("vpn"),
    )
}

#[cfg(windows)]
fn keel_pid_file() -> Option<std::path::PathBuf> {
    Some(keel_vpn_dir()?.join("openvpn.pid"))
}

#[cfg(windows)]
fn keel_stop_file() -> Option<std::path::PathBuf> {
    Some(keel_vpn_dir()?.join("openvpn.stopped"))
}

#[cfg(windows)]
pub fn record_keel_pid(pid: u32) {
    if pid == 0 {
        return;
    }
    let Some(path) = keel_pid_file() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, pid.to_string());
}

#[cfg(not(windows))]
pub fn record_keel_pid(_pid: u32) {}

#[cfg(windows)]
fn read_keel_pid() -> Option<u32> {
    let text = std::fs::read_to_string(keel_pid_file()?).ok()?;
    text.trim().parse().ok().filter(|pid| *pid != 0)
}

#[cfg(windows)]
fn clear_keel_pid() {
    if let Some(path) = keel_pid_file() {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(windows)]
fn mark_tunnel_stopped() {
    let Some(path) = keel_stop_file() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let _ = std::fs::write(path, millis.to_string());
}

/// Wait out Access Server's delayed release of a licensed slot after a clean
/// stop. No-op when Keel has not stopped a tunnel recently.
#[cfg(windows)]
pub fn wait_for_server_slot() {
    let Some(path) = keel_stop_file() else {
        return;
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(millis) = text.trim().parse::<u64>() else {
        return;
    };
    let stopped = std::time::UNIX_EPOCH + std::time::Duration::from_millis(millis);
    let Ok(elapsed) = std::time::SystemTime::now().duration_since(stopped) else {
        return;
    };
    if elapsed < SERVER_SLOT_WAIT {
        std::thread::sleep(SERVER_SLOT_WAIT - elapsed);
    }
}

#[cfg(not(windows))]
pub fn wait_for_server_slot() {}

#[cfg(windows)]
fn wide_z(name: &str) -> Vec<u16> {
    name.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Make sure the named exit event exists and is not signaled. OpenVPN treats a
/// signaled event at startup as fatal.
#[cfg(windows)]
fn reset_named_event(name: &str) {
    use std::ptr::null_mut;

    use winapi::um::handleapi::CloseHandle;
    use winapi::um::synchapi::{CreateEventW, ResetEvent};

    let name = wide_z(name);
    unsafe {
        let handle = CreateEventW(null_mut(), 1, 0, name.as_ptr());
        if handle.is_null() {
            return;
        }
        let _ = ResetEvent(handle);
        CloseHandle(handle);
    }
}

#[cfg(windows)]
fn reset_exit_event() {
    reset_named_event(KEEL_EXIT_EVENT);
}

/// SIGTERM equivalent: OpenVPN sends explicit-exit-notify, then exits.
#[cfg(windows)]
fn signal_named_event(name: &str) -> bool {
    use std::ptr::null_mut;

    use winapi::um::handleapi::CloseHandle;
    use winapi::um::synchapi::{CreateEventW, SetEvent};

    let name = wide_z(name);
    unsafe {
        let handle = CreateEventW(null_mut(), 1, 0, name.as_ptr());
        if handle.is_null() {
            return false;
        }
        let ok = SetEvent(handle) != 0;
        CloseHandle(handle);
        ok
    }
}

#[cfg(windows)]
fn signal_exit_event() -> bool {
    signal_named_event(KEEL_EXIT_EVENT)
}

#[cfg(windows)]
fn wait_pid(pid: u32, timeout: std::time::Duration) {
    if pid == 0 {
        return;
    }
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::processthreadsapi::OpenProcess;
    use winapi::um::synchapi::WaitForSingleObject;
    use winapi::um::winnt::SYNCHRONIZE;

    unsafe {
        let handle = OpenProcess(SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return;
        }
        let _ = WaitForSingleObject(handle, timeout.as_millis() as u32);
        CloseHandle(handle);
    }
}

#[cfg(windows)]
pub fn kill_pid(pid: u32) {
    if pid == 0 {
        return;
    }
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::processthreadsapi::{OpenProcess, TerminateProcess};
    use winapi::um::synchapi::WaitForSingleObject;
    use winapi::um::winnt::{PROCESS_TERMINATE, SYNCHRONIZE};

    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return;
        }
        let _ = TerminateProcess(handle, 1);
        let _ = WaitForSingleObject(handle, KILL_WAIT.as_millis() as u32);
        CloseHandle(handle);
    }
}

#[cfg(not(windows))]
pub fn kill_pid(_pid: u32) {}

/// Ask OpenVPN to exit so the server drops the licensed slot, then force-kill
/// if it ignores the event (engines started before `--service`).
#[cfg(windows)]
pub fn stop_pid(pid: u32) {
    if pid == 0 {
        return;
    }
    signal_exit_event();
    wait_pid(pid, GRACEFUL_WAIT);
    if pid_running(pid) {
        kill_pid(pid);
    }
    reset_exit_event();
    mark_tunnel_stopped();
    if read_keel_pid() == Some(pid) {
        clear_keel_pid();
    }
}

#[cfg(not(windows))]
pub fn stop_pid(pid: u32) {
    kill_pid(pid);
}

/// End every `openvpn.exe` that is still running Keel's private config.
///
/// The Interactive Service starts the engine as a sibling, not a child, so a
/// missed PID or a previous crashed Keel leaves a tunnel in the background.
/// Matching the config file name avoids killing the user's OpenVPN GUI.
///
/// Prefer the `--service` exit event (SIGTERM + explicit-exit-notify) so the
/// Access Server releases its licensed slot. TerminateProcess is the fallback
/// and leaves that slot occupied until ping-restart.
#[cfg(windows)]
pub fn kill_keel_tunnels() {
    let mut pids = keel_tunnel_pids();
    if let Some(pid) = read_keel_pid() {
        if !pids.contains(&pid) && pid_is_openvpn(pid) {
            pids.push(pid);
        }
    }
    if !pids.is_empty() {
        signal_exit_event();
        let deadline = std::time::Instant::now() + GRACEFUL_WAIT;
        for pid in &pids {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            wait_pid(*pid, remaining);
        }
        for pid in pids {
            if pid_running(pid) {
                kill_pid(pid);
            }
        }
        mark_tunnel_stopped();
    }
    reset_exit_event();
    clear_keel_pid();
}

#[cfg(not(windows))]
pub fn kill_keel_tunnels() {}

#[cfg(windows)]
fn pid_is_openvpn(pid: u32) -> bool {
    process_image_name(pid).is_some_and(|path| {
        path.rsplit(['\\', '/'])
            .next()
            .is_some_and(|name| name.eq_ignore_ascii_case("openvpn.exe"))
    })
}

#[cfg(windows)]
fn process_image_name(pid: u32) -> Option<String> {
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::processthreadsapi::OpenProcess;
    use winapi::um::winbase::QueryFullProcessImageNameW;
    use winapi::um::winnt::PROCESS_QUERY_LIMITED_INFORMATION;

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut buf = [0u16; 32768];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(handle);
        if ok == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}

/// A job whose members die when this handle is closed (Keel exiting or crashing).
#[cfg(windows)]
pub struct TunnelJob(OwnedHandle);

#[cfg(windows)]
unsafe impl Send for TunnelJob {}
#[cfg(windows)]
unsafe impl Sync for TunnelJob {}

#[cfg(windows)]
impl TunnelJob {
    pub fn new() -> Option<Self> {
        use std::ptr::null_mut;
        use winapi::um::jobapi2::{CreateJobObjectW, SetInformationJobObject};
        use winapi::um::winnt::{
            JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        unsafe {
            let handle = CreateJobObjectW(null_mut(), null_mut());
            if handle.is_null() {
                return None;
            }
            let job = Self(OwnedHandle(handle));
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job.0 .0,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of_mut!(info).cast(),
                std::mem::size_of_val(&info) as u32,
            );
            if ok == 0 {
                return None;
            }
            Some(job)
        }
    }

    pub fn adopt(&self, pid: u32) -> bool {
        if pid == 0 {
            return false;
        }
        use winapi::um::handleapi::CloseHandle;
        use winapi::um::jobapi2::AssignProcessToJobObject;
        use winapi::um::processthreadsapi::OpenProcess;
        use winapi::um::winnt::{PROCESS_SET_QUOTA, PROCESS_TERMINATE};

        unsafe {
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                return false;
            }
            let ok = AssignProcessToJobObject(self.0 .0, process) != 0;
            CloseHandle(process);
            ok
        }
    }
}

#[cfg(windows)]
fn keel_tunnel_pids() -> Vec<u32> {
    use std::mem::{size_of, zeroed};

    use winapi::um::handleapi::{CloseHandle, INVALID_HANDLE_VALUE};
    use winapi::um::tlhelp32::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let mut pids = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap.is_null() || snap == INVALID_HANDLE_VALUE {
            return pids;
        }
        let mut entry: PROCESSENTRY32W = zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                let name = utf16_z(&entry.szExeFile);
                if name.eq_ignore_ascii_case("openvpn.exe") {
                    let pid = entry.th32ProcessID;
                    if process_command_line(pid).is_some_and(|cmd| is_keel_tunnel_command(&cmd)) {
                        pids.push(pid);
                    }
                }
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }
    pids
}

#[cfg(windows)]
fn utf16_z(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

#[cfg(windows)]
fn process_command_line(pid: u32) -> Option<String> {
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
                // Some builds put the string immediately after the header
                // instead of a pointer into this buffer.
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

#[cfg(test)]
mod tests {
    use super::{diagnose_log, encode_startup, is_keel_tunnel_command, parse_service_reply};

    #[cfg(windows)]
    #[test]
    fn service_read_timeout_cancels_io_and_preserves_the_pipe() {
        use std::ptr::null_mut;
        use std::time::{Duration, Instant};
        use winapi::um::fileapi::{CreateFileW, ReadFile, WriteFile, OPEN_EXISTING};
        use winapi::um::handleapi::INVALID_HANDLE_VALUE;
        use winapi::um::namedpipeapi::CreateNamedPipeW;
        use winapi::um::winbase::{
            FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX, PIPE_READMODE_MESSAGE, PIPE_TYPE_MESSAGE,
            PIPE_WAIT,
        };
        use winapi::um::winnt::{GENERIC_READ, GENERIC_WRITE};

        // A private local test pipe: no OpenVPN service or network is involved.
        let name: Vec<u16> = format!(
            "\\\\.\\pipe\\keel-vpn-timeout-test-{}\0",
            std::process::id()
        )
        .encode_utf16()
        .collect();
        let server = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT,
                1,
                4096,
                4096,
                0,
                null_mut(),
            )
        };
        assert_ne!(server, INVALID_HANDLE_VALUE);
        let server = super::OwnedHandle(server);
        let client = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                null_mut(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED,
                null_mut(),
            )
        };
        assert_ne!(client, INVALID_HANDLE_VALUE);
        let client = super::OwnedHandle(client);
        let mut buf = [0u8; 16];
        let started = Instant::now();
        let error = super::pipe_io(
            client.0,
            started + Duration::from_millis(30),
            |overlapped, read| unsafe {
                ReadFile(
                    client.0,
                    buf.as_mut_ptr().cast(),
                    buf.len() as u32,
                    read,
                    overlapped,
                )
            },
        )
        .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(2));

        let mut written = 0;
        assert_ne!(
            unsafe { WriteFile(server.0, b"ok".as_ptr().cast(), 2, &mut written, null_mut()) },
            0
        );
        let read = super::pipe_io(
            client.0,
            Instant::now() + Duration::from_secs(2),
            |overlapped, read| unsafe {
                ReadFile(
                    client.0,
                    buf.as_mut_ptr().cast(),
                    buf.len() as u32,
                    read,
                    overlapped,
                )
            },
        )
        .unwrap();
        assert_eq!(&buf[..read as usize], b"ok");
    }

    #[cfg(windows)]
    #[test]
    fn exhausted_service_budget_does_not_send_a_request() {
        let error = super::pipe_io(std::ptr::null_mut(), std::time::Instant::now(), |_, _| {
            panic!("expired request must not start I/O")
        })
        .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
    }

    #[cfg(windows)]
    #[test]
    fn service_start_elevates_only_access_denied() {
        use super::recover_service_start;
        use std::io::Error;
        use winapi::shared::winerror::*;

        assert!(recover_service_start(Ok(()), || panic!("already started")).is_ok());
        assert!(recover_service_start(
            Err(Error::from_raw_os_error(
                ERROR_SERVICE_ALREADY_RUNNING as i32
            )),
            || panic!("another client started it"),
        )
        .is_ok());
        let mut prompted = false;
        assert!(recover_service_start(
            Err(Error::from_raw_os_error(ERROR_ACCESS_DENIED as i32)),
            || {
                prompted = true;
                Ok(())
            },
        )
        .is_ok());
        assert!(prompted);
        for code in [
            ERROR_SERVICE_DISABLED,
            ERROR_SERVICE_DOES_NOT_EXIST,
            ERROR_SERVICE_LOGON_FAILED,
        ] {
            let err = recover_service_start(Err(Error::from_raw_os_error(code as i32)), || {
                panic!("elevation cannot fix this error")
            })
            .unwrap_err();
            assert!(
                err.contains(&code.to_string()),
                "Windows error must survive: {err}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn service_start_preserves_uac_cancellation_and_handles_start_races() {
        use super::recover_service_start;
        use std::io::Error;
        use winapi::shared::winerror::*;

        let denied = || Err(Error::from_raw_os_error(ERROR_ACCESS_DENIED as i32));
        let err = recover_service_start(denied(), || {
            Err(Error::from_raw_os_error(ERROR_CANCELLED as i32))
        })
        .unwrap_err();
        assert!(err.contains("approval was canceled"));
        assert!(!err.contains("not running"));
        assert!(recover_service_start(denied(), || {
            Err(Error::from_raw_os_error(
                ERROR_SERVICE_ALREADY_RUNNING as i32,
            ))
        })
        .is_ok());
    }

    #[test]
    fn startup_message_is_three_nul_terminated_utf16_fields() {
        let msg = encode_startup(r"C:\ovpn", r#"--config "x.ovpn""#, "");
        let text: String = String::from_utf16_lossy(&msg);
        let parts: Vec<&str> = text.split('\0').collect();
        assert_eq!(parts[0], r"C:\ovpn");
        assert_eq!(parts[1], r#"--config "x.ovpn""#);
        assert_eq!(parts[2], "");
    }

    #[test]
    fn service_success_reply_is_hex_pid() {
        assert_eq!(
            parse_service_reply("0x00000000\n0x00004d2\nProcess ID"),
            Ok(0x4d2)
        );
    }

    #[test]
    fn service_error_reply_is_readable() {
        let err = parse_service_reply("0x00000005\nCreateProcess\nAccess is denied.").unwrap_err();
        assert!(err.contains("0x00000005"));
        assert!(err.contains("Access is denied"));
    }

    #[test]
    fn service_success_reply_rejects_zero_pid() {
        let err = parse_service_reply("0x00000000\n0x00000000\nProcess ID").unwrap_err();
        assert!(err.contains("bad process id"));
    }

    #[test]
    fn netsh_without_interactive_service_is_a_short_sentence() {
        let log = r#"
interactive service msg_channel=0
ovpn-dco device [OpenVPN Data Channel Offload] opened
NETSH: C:\WINDOWS\system32\netsh.exe interface ip set address 44 static 172.27.237.53 255.255.254.0 store=active
ERROR: command failed: returned error code 1
"#;
        let msg = diagnose_log(log).expect("diagnosed");
        assert!(!msg.contains("NETSH:"));
        assert!(msg.contains("Interactive Service") || msg.contains("msg_channel=0"));
        assert!(msg.len() < 500);
    }

    #[test]
    fn server_connection_limit_is_not_reported_as_bad_credentials() {
        let log = "AUTH_FAILED,TEMP[backoff 60]:LICENSE: Access Server license failure: Connection exceeds currently allocated connection to this server (2)";
        let msg = diagnose_log(log).unwrap();
        assert!(msg.contains("connection limit"));
        assert!(!msg.contains("password"));
    }

    #[test]
    fn keel_tunnel_command_matches_private_config_only() {
        assert!(is_keel_tunnel_command(
            r#"openvpn.exe --config "C:\Users\developer\OpenVPN\config\keel-app.ovpn" --log x"#
        ));
        assert!(is_keel_tunnel_command(
            r#"C:\Program Files\OpenVPN\bin\openvpn.exe --config keel-app.ovpn"#
        ));
        assert!(is_keel_tunnel_command(
            r#"openvpn --log "C:\Users\developer\AppData\Roaming\com.alede.keel\vpn\openvpn.log" --verb 3"#
        ));
        assert!(!is_keel_tunnel_command(
            r#"openvpn.exe --config "C:\Users\developer\OpenVPN\config\office.ovpn""#
        ));
        assert!(!is_keel_tunnel_command("openvpn.exe"));
    }

    #[test]
    fn startup_options_ask_openvpn_to_watch_the_exit_event() {
        let options = super::engine_startup_options(
            std::path::Path::new(r"C:\Users\developer\OpenVPN\config\keel-app.ovpn"),
            std::path::Path::new(
                r"C:\Users\developer\AppData\Roaming\com.alede.keel\vpn\openvpn.log",
            ),
        );
        assert!(options.contains("--config"));
        assert!(options.contains("keel-app.ovpn"));
        assert!(options.contains("--verb 3"));
        assert!(options.contains("--script-security 0"));
        if cfg!(windows) {
            assert!(options.contains("--service"));
            assert!(options.contains(super::KEEL_EXIT_EVENT));
        }
    }

    #[cfg(windows)]
    #[test]
    fn process_command_line_reads_this_process() {
        let pid = std::process::id();
        let cmd = super::process_command_line(pid).expect("query own command line");
        assert!(!cmd.is_empty(), "own command line should not be empty");
    }

    #[cfg(windows)]
    #[test]
    fn named_exit_event_can_be_signaled_and_reset() {
        use std::ptr::null_mut;
        use winapi::um::handleapi::CloseHandle;
        use winapi::um::synchapi::{CreateEventW, WaitForSingleObject};
        use winapi::um::winbase::WAIT_OBJECT_0;

        let name = format!(
            r"Local\keel-openvpn-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let wide = super::wide_z(&name);
        let held = unsafe { CreateEventW(null_mut(), 1, 0, wide.as_ptr()) };
        assert!(!held.is_null(), "CreateEventW must create the test event");
        unsafe {
            assert_ne!(WaitForSingleObject(held, 0), WAIT_OBJECT_0);
        }
        assert!(super::signal_named_event(&name));
        unsafe {
            assert_eq!(WaitForSingleObject(held, 0), WAIT_OBJECT_0);
        }
        super::reset_named_event(&name);
        unsafe {
            assert_ne!(WaitForSingleObject(held, 0), WAIT_OBJECT_0);
            CloseHandle(held);
        }
    }

    #[cfg(windows)]
    #[test]
    fn kill_pid_waits_until_the_process_exits() {
        use std::process::{Command, Stdio};

        let mut child = Command::new("ping")
            .args(["-t", "127.0.0.1"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn ping");
        let pid = child.id();
        assert!(super::pid_running(pid));
        super::kill_pid(pid);
        assert!(!super::pid_running(pid));
        let _ = child.wait();
    }

    #[cfg(windows)]
    #[test]
    fn job_object_kills_members_when_closed() {
        use std::process::{Command, Stdio};

        let Some(job) = super::TunnelJob::new() else {
            return;
        };
        let mut child = Command::new("ping")
            .args(["-t", "127.0.0.1"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn ping");
        let pid = child.id();
        if !job.adopt(pid) {
            let _ = child.kill();
            let _ = child.wait();
            return;
        }
        drop(job);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while super::pid_running(pid) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(
            !super::pid_running(pid),
            "closing the job must terminate adopted processes"
        );
        let _ = child.wait();
    }
}
