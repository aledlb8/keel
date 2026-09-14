//! Talk to the OpenVPN Interactive Service on Windows.
//!
//! Spawning `openvpn.exe` ourselves leaves `msg_channel=0`, so `netsh
//! interface ip set address` runs without privileges and returns error code 1.
//! The documented client (OpenVPN GUI) instead asks
//! `\\.\pipe\openvpn\service` to start openvpn.exe and keep a privileged
//! channel to it. That is what assigns the tunnel IP.

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
    if lower.contains("auth_failed") || lower.contains("auth-failure") {
        if lower.contains("license") && lower.contains("connection") {
            return Some("The VPN server has reached its licensed connection limit. Disconnect an unused VPN session or wait for the previous session to expire, then try again.".into());
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
pub fn start_openvpn(config: &std::path::Path, log: &std::path::Path) -> Result<u32, String> {
    start_openvpn_windows(config, log)
}

#[cfg(not(windows))]
pub fn start_openvpn(config: &std::path::Path, log: &std::path::Path) -> Result<u32, String> {
    let _ = (config, log);
    Err("The OpenVPN Interactive Service exists only on Windows.".into())
}

#[cfg(windows)]
fn start_openvpn_windows(config: &std::path::Path, log: &std::path::Path) -> Result<u32, String> {
    use winapi::shared::winerror::ERROR_FILE_NOT_FOUND;

    const PIPE_WAIT: std::time::Duration = std::time::Duration::from_secs(5);
    const STARTUP_WAIT: std::time::Duration = std::time::Duration::from_secs(15);

    let pipe = match open_service_pipe(false, PIPE_WAIT) {
        Ok(pipe) => pipe,
        Err(err) if err.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32) => {
            try_start_interactive_service()?;
            open_service_pipe(true, STARTUP_WAIT).map_err(describe_pipe_open_error)?
        }
        Err(err) => return Err(describe_pipe_open_error(err)),
    };

    send_startup(pipe, config, log)
}

#[cfg(windows)]
fn try_start_interactive_service() -> Result<(), String> {
    recover_service_start(start_service_if_stopped(), start_service_elevated)
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
fn start_service_elevated() -> Result<(), std::io::Error> {
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
    let wait = unsafe { WaitForSingleObject(info.hProcess, 30_000) };
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
struct ServicePipe(winapi::shared::ntdef::HANDLE);

#[cfg(windows)]
impl Drop for ServicePipe {
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
) -> Result<ServicePipe, std::io::Error> {
    use std::ptr::null_mut;

    use winapi::shared::winerror::{ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY, ERROR_SEM_TIMEOUT};
    use winapi::um::fileapi::{CreateFileW, OPEN_EXISTING};
    use winapi::um::handleapi::INVALID_HANDLE_VALUE;
    use winapi::um::namedpipeapi::WaitNamedPipeW;
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
                0,
                null_mut(),
            )
        };
        if handle != INVALID_HANDLE_VALUE {
            return Ok(ServicePipe(handle));
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
    pipe: ServicePipe,
    config: &std::path::Path,
    log: &std::path::Path,
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
    let options = format!(
        "--config \"{}\" --log \"{}\" --verb 3",
        config.display(),
        log.display()
    );
    let msg = encode_startup(&workdir, &options, "");
    let bytes = unsafe {
        std::slice::from_raw_parts(
            msg.as_ptr().cast::<u8>(),
            msg.len() * std::mem::size_of::<u16>(),
        )
    };
    let mut written: DWORD = 0;
    let write_ok = unsafe {
        WriteFile(
            pipe.0,
            bytes.as_ptr().cast(),
            bytes.len() as DWORD,
            &mut written,
            null_mut(),
        )
    };
    if write_ok == 0 {
        return Err(format!(
            "Could not send the start request to the OpenVPN Interactive Service: {}",
            std::io::Error::last_os_error()
        ));
    }
    if written as usize != bytes.len() {
        return Err(format!(
            "Could not send the complete start request to the OpenVPN Interactive Service (wrote {written} of {} bytes).",
            bytes.len()
        ));
    }

    let mut buf = vec![0u8; 4096];
    let mut read: DWORD = 0;
    let read_ok = unsafe {
        ReadFile(
            pipe.0,
            buf.as_mut_ptr().cast(),
            buf.len() as DWORD,
            &mut read,
            null_mut(),
        )
    };
    if read_ok == 0 || read == 0 {
        return Err(format!(
            "The OpenVPN Interactive Service did not reply: {}",
            std::io::Error::last_os_error()
        ));
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

#[cfg(windows)]
pub fn kill_pid(pid: u32) {
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::processthreadsapi::{OpenProcess, TerminateProcess};
    use winapi::um::winnt::PROCESS_TERMINATE;

    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !handle.is_null() {
            let _ = TerminateProcess(handle, 1);
            CloseHandle(handle);
        }
    }
}

#[cfg(not(windows))]
pub fn kill_pid(_pid: u32) {}

#[cfg(test)]
mod tests {
    use super::{diagnose_log, encode_startup, parse_service_reply};

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
}
