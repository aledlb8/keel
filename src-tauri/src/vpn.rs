//! Per-app OpenVPN for Keel.
//!
//! OpenVPN Connect cannot put one process on the VPN and leave the rest of the
//! PC off it — connecting that app installs a default route. Keel instead:
//!
//! 1. Reads a profile already imported into OpenVPN Connect
//! 2. Writes an isolated copy (`route-nopull`, no redirect-gateway, no system DNS)
//! 3. Brings that copy up with the community `openvpn.exe` (the engine Connect
//!    does not expose for this)
//! 4. Runs a local HTTP CONNECT proxy pinned to the tunnel interface
//! 5. Points Keel and every pane at that proxy
//!
//! The PC's normal route remains preferred. Closing Keel tears the private tunnel
//! down.

use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
#[cfg(not(windows))]
use std::process::Child;
#[cfg(not(windows))]
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::vpn_profile::{self, DiscoveredProfile};
use crate::vpn_proxy::{self, ProxyHandle};
use crate::vpn_service;

// One budget for service startup and both adapter attempts, not 45s per driver.
const CONNECT_WAIT: Duration = Duration::from_secs(30);
const LOG_POLL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VpnProfileInfo {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VpnSnapshot {
    pub phase: String,
    pub connect_installed: bool,
    pub openvpn_path: Option<String>,
    pub profiles: Vec<VpnProfileInfo>,
    pub profile_id: Option<String>,
    pub profile_name: Option<String>,
    pub adapter: Option<String>,
    pub tunnel_ip: Option<String>,
    pub if_index: Option<u32>,
    pub proxy_port: Option<u16>,
    pub isolated: bool,
    pub error: Option<String>,
}

impl VpnSnapshot {
    fn idle() -> Self {
        let profiles = vpn_profile::discover_profiles();
        Self {
            phase: "idle".into(),
            connect_installed: openvpn_connect_exe().is_some(),
            openvpn_path: find_openvpn().map(|path| path.to_string_lossy().into_owned()),
            profiles: profiles.iter().map(profile_info).collect(),
            profile_id: None,
            profile_name: None,
            adapter: None,
            tunnel_ip: None,
            if_index: None,
            proxy_port: None,
            isolated: true,
            error: None,
        }
    }
}

enum OpenVpnProc {
    #[cfg(not(windows))]
    Child(Child),
    Service {
        pid: u32,
    },
}

impl OpenVpnProc {
    fn is_running(&mut self) -> bool {
        match self {
            #[cfg(not(windows))]
            Self::Child(child) => matches!(child.try_wait(), Ok(None)),
            Self::Service { pid } => vpn_service::pid_running(*pid),
        }
    }

    fn terminate(&mut self) {
        match self {
            #[cfg(not(windows))]
            Self::Child(child) => {
                let _ = child.kill();
                let _ = child.wait();
            }
            Self::Service { pid } => vpn_service::kill_pid(*pid),
        }
    }
}

impl Drop for OpenVpnProc {
    fn drop(&mut self) {
        self.terminate();
    }
}

struct LiveTunnel {
    process: OpenVpnProc,
    proxy: ProxyHandle,
}

struct VpnState {
    snapshot: VpnSnapshot,
    live: Option<LiveTunnel>,
}

impl Default for VpnState {
    fn default() -> Self {
        Self {
            snapshot: VpnSnapshot::idle(),
            live: None,
        }
    }
}

pub struct VpnManager {
    inner: Arc<Mutex<VpnState>>,
    connecting: Mutex<()>,
    /// Members die with this process, including abort and Task Manager kills.
    #[cfg(windows)]
    job: Option<vpn_service::TunnelJob>,
}

impl Default for VpnManager {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(VpnState::default())),
            connecting: Mutex::new(()),
            #[cfg(windows)]
            job: vpn_service::TunnelJob::new(),
        }
    }
}

impl VpnManager {
    pub fn snapshot(&self) -> VpnSnapshot {
        match self.inner.lock() {
            Ok(guard) => guard.snapshot.clone(),
            Err(poisoned) => poisoned.into_inner().snapshot.clone(),
        }
    }

    pub fn http_proxy_url(&self) -> Option<String> {
        let port = self.snapshot().proxy_port?;
        Some(format!("http://127.0.0.1:{port}"))
    }

    pub fn proxy_env(&self) -> Vec<(String, String)> {
        match self.http_proxy_url() {
            Some(url) => proxy_env_vars(&url),
            None => Vec::new(),
        }
    }

    pub fn shutdown(&self) {
        let _ = self.disconnect();
    }

    fn disconnect(&self) -> Result<VpnSnapshot, String> {
        let live = {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| "vpn state is poisoned".to_string())?;
            guard.live.take()
        };
        if let Some(mut live) = live {
            live.proxy.stop();
            live.process.terminate();
        }
        vpn_service::kill_keel_tunnels();
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "vpn state is poisoned".to_string())?;
        guard.snapshot = VpnSnapshot::idle();
        Ok(guard.snapshot.clone())
    }
}

fn proxy_env_vars(url: &str) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "WS_PROXY",
        "WSS_PROXY",
        "ws_proxy",
        "wss_proxy",
    ]
    .into_iter()
    .map(|key| (key.to_string(), url.to_string()))
    .collect();
    env.push(("NO_PROXY".into(), "localhost,127.0.0.1,::1".into()));
    env.push(("no_proxy".into(), "localhost,127.0.0.1,::1".into()));
    // Claude Code resolves DNS itself by default and may CONNECT to an IPv6
    // literal; the tunnel is IPv4-only. Opt into hostname CONNECT.
    env.push(("CLAUDE_CODE_PROXY_RESOLVES_HOSTS".into(), "1".into()));
    // Node MCP / npx children: undici fetch ignores HTTP_PROXY unless this is set.
    env.push(("NODE_USE_ENV_PROXY".into(), "1".into()));
    env
}

fn profile_info(profile: &DiscoveredProfile) -> VpnProfileInfo {
    VpnProfileInfo {
        id: profile.id.clone(),
        name: profile.name.clone(),
        path: profile.path.to_string_lossy().into_owned(),
    }
}

fn openvpn_connect_exe() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(program_files) = std::env::var("ProgramFiles") {
        candidates.push(
            PathBuf::from(program_files)
                .join("OpenVPN Connect")
                .join("OpenVPNConnect.exe"),
        );
    }
    if let Ok(program_files) = std::env::var("ProgramFiles(x86)") {
        candidates.push(
            PathBuf::from(program_files)
                .join("OpenVPN Connect")
                .join("OpenVPNConnect.exe"),
        );
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local)
                .join("Programs")
                .join("OpenVPN Connect")
                .join("OpenVPNConnect.exe"),
        );
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn find_openvpn() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(program_files) = std::env::var("ProgramFiles") {
        candidates.push(
            PathBuf::from(&program_files)
                .join("OpenVPN")
                .join("bin")
                .join("openvpn.exe"),
        );
        // Connect does not ship this engine; still look in case a bundle does.
        candidates.push(
            PathBuf::from(program_files)
                .join("OpenVPN Connect")
                .join("openvpn.exe"),
        );
    }
    if let Ok(program_files) = std::env::var("ProgramFiles(x86)") {
        candidates.push(
            PathBuf::from(program_files)
                .join("OpenVPN")
                .join("bin")
                .join("openvpn.exe"),
        );
    }
    if let Some(found) = crate::pty::which("openvpn.exe") {
        candidates.push(PathBuf::from(found));
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn work_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("no config directory: {err}"))?
        .join("vpn");
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn set_phase(
    manager: &VpnManager,
    mut change: impl FnMut(&mut VpnSnapshot),
) -> Result<VpnSnapshot, String> {
    let mut guard = manager
        .inner
        .lock()
        .map_err(|_| "vpn state is poisoned".to_string())?;
    change(&mut guard.snapshot);
    Ok(guard.snapshot.clone())
}

#[tauri::command]
pub async fn vpn_snapshot(app: AppHandle) -> Result<VpnSnapshot, String> {
    crate::blocking::run(move || Ok(refresh_snapshot(app.state::<VpnManager>().inner()))).await
}

fn refresh_snapshot(manager: &VpnManager) -> VpnSnapshot {
    let mut snap = manager.snapshot();
    // Refresh discovery each time the UI asks — profiles appear after import.
    let profiles = vpn_profile::discover_profiles();
    snap.connect_installed = openvpn_connect_exe().is_some();
    snap.openvpn_path = find_openvpn().map(|path| path.to_string_lossy().into_owned());
    snap.profiles = profiles.iter().map(profile_info).collect();
    if let Ok(mut guard) = manager.inner.lock() {
        guard.snapshot.connect_installed = snap.connect_installed;
        guard.snapshot.openvpn_path = snap.openvpn_path.clone();
        guard.snapshot.profiles = snap.profiles.clone();
    }
    snap
}

#[tauri::command]
pub async fn vpn_connect(
    app: AppHandle,
    profile_id: Option<String>,
) -> Result<VpnSnapshot, String> {
    crate::blocking::run(move || {
        let state = app.state::<VpnManager>();
        let manager = state.inner();
        let _connecting = manager
            .connecting
            .try_lock()
            .map_err(|_| "A VPN connection attempt is already running.".to_string())?;
        let result = connect_inner(&app, profile_id.as_deref());
        if let Err(error) = &result {
            // Discovery/config/service failures must settle the backend too.
            let _ = set_phase(manager, |snap| {
                snap.phase = "error".into();
                snap.error = Some(error.clone());
            });
        }
        result
    })
    .await
}

#[tauri::command]
pub async fn vpn_disconnect(app: AppHandle) -> Result<VpnSnapshot, String> {
    crate::blocking::run(move || {
        let manager = app.state::<VpnManager>();
        let _connecting = manager.connecting.try_lock().map_err(|_| {
            "The VPN is still connecting. Wait for this attempt to finish.".to_string()
        })?;
        manager.disconnect()
    })
    .await
}

fn connect_inner(app: &AppHandle, wanted: Option<&str>) -> Result<VpnSnapshot, String> {
    let state = app.state::<VpnManager>();
    let manager = state.inner();
    let already = manager.snapshot();
    if already.phase == "connected" && already.proxy_port.is_some() {
        if wanted.is_none()
            || wanted == already.profile_id.as_deref()
            || wanted == already.profile_name.as_deref()
        {
            return Ok(already);
        }
        manager.disconnect()?;
    }

    let profiles = vpn_profile::discover_profiles();
    if profiles.is_empty() {
        return Err(
            "No OpenVPN profile found. Import one in OpenVPN Connect first, then come back.".into(),
        );
    }
    let chosen = vpn_profile::find_profile(&profiles, wanted)
        .or_else(|| profiles.first())
        .ok_or_else(|| "No OpenVPN profile found.".to_string())?;
    let source = std::fs::read_to_string(&chosen.path)
        .map_err(|err| format!("Could not read {}: {err}", chosen.path.display()))?;
    if vpn_profile::needs_interactive_auth(&source) {
        return Err(
            "This profile asks for a username and password on connect. Save the password in the profile (or use an autologin profile) so Keel can bring the tunnel up without a prompt."
                .into(),
        );
    }
    let Some(openvpn) = find_openvpn() else {
        return Err(
            "OpenVPN Connect cannot isolate one app. Install the OpenVPN community client (openvpn.exe) so Keel can bring up a private tunnel that does not take over this PC."
                .into(),
        );
    };

    let _ = set_phase(manager, |snap| {
        snap.phase = "connecting".into();
        snap.error = None;
        snap.profile_id = Some(chosen.id.clone());
        snap.profile_name = Some(chosen.name.clone());
        snap.openvpn_path = Some(openvpn.to_string_lossy().into_owned());
    })?;
    vpn_service::kill_keel_tunnels();

    let log_path = work_dir(app)?.join("openvpn.log");
    let config_path = openvpn_config_path()?;
    let deadline = Instant::now() + CONNECT_WAIT;
    let drivers: [Option<&str>; 2] = [None, Some("tap-windows6")];
    let mut last_err: Option<String> = None;

    for (attempt, driver) in drivers.iter().enumerate() {
        if Instant::now() >= deadline {
            last_err = Some("The VPN connection attempt timed out after 30 seconds.".into());
            break;
        }
        let isolated = match *driver {
            Some(driver) => vpn_profile::isolate_profile_with(&source, Some(driver)),
            None => vpn_profile::isolate_profile(&source),
        };
        if let Some(parent) = config_path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        std::fs::write(&config_path, &isolated).map_err(|err| err.to_string())?;
        let _ = std::fs::write(&log_path, b"");

        let mut process = match start_openvpn(&openvpn, &config_path, &log_path, deadline) {
            Ok(process) => process,
            Err(err) => {
                last_err = Some(err);
                break;
            }
        };
        #[cfg(windows)]
        {
            let OpenVpnProc::Service { pid } = &process;
            if let Some(job) = &manager.job {
                job.adopt(*pid);
            }
        }

        match wait_for_tunnel(&log_path, deadline, || process.is_running()) {
            Ok(up) => match finish_connect(manager, process, chosen, up) {
                Ok(snap) => return Ok(snap),
                Err(err) => {
                    last_err = Some(err);
                    break;
                }
            },
            Err(err) => {
                process.terminate();
                last_err = Some(err.clone());
                if attempt == 0 && is_adapter_ip_failure(&err) {
                    continue;
                }
                break;
            }
        }
    }

    let err = last_err.unwrap_or_else(|| "The private tunnel did not come up.".into());
    let _ = set_phase(manager, |snap| {
        snap.phase = "error".into();
        snap.error = Some(err.clone());
    });
    Err(err)
}

fn is_adapter_ip_failure(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    (lower.contains("netsh")
        || lower.contains("tunnel ip")
        || lower.contains("adapter ip")
        || lower.contains("dco adapter"))
        && !lower.contains("could not reach")
        && !lower.contains("could not talk")
}

fn openvpn_config_path() -> Result<PathBuf, String> {
    let dir = crate::pty::home_dir()
        .ok_or_else(|| "no home directory".to_string())?
        .join("OpenVPN")
        .join("config");
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir.join(vpn_service::KEEL_CONFIG_FILE))
}

struct TunnelUp {
    adapter: String,
    tunnel_ip: String,
    if_index: u32,
    isolated: bool,
}

fn start_openvpn(
    exe: &Path,
    config: &Path,
    log: &Path,
    deadline: Instant,
) -> Result<OpenVpnProc, String> {
    #[cfg(windows)]
    {
        let _ = exe;
        let pid = vpn_service::start_openvpn(config, log, deadline)?;
        Ok(OpenVpnProc::Service { pid })
    }
    #[cfg(not(windows))]
    {
        let _ = deadline;
        spawn_openvpn_direct(exe, config, log)
    }
}

#[cfg(not(windows))]
fn spawn_openvpn_direct(exe: &Path, config: &Path, log: &Path) -> Result<OpenVpnProc, String> {
    let workdir = config.parent().unwrap_or(Path::new("."));
    let mut cmd = Command::new(exe);
    cmd.arg("--config")
        .arg(config)
        .arg("--log")
        .arg(log)
        .arg("--verb")
        .arg("3")
        .current_dir(workdir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd.spawn()
        .map(OpenVpnProc::Child)
        .map_err(|err| format!("Could not start openvpn.exe: {err}"))
}

fn wait_for_tunnel(
    log: &Path,
    deadline: Instant,
    mut is_running: impl FnMut() -> bool,
) -> Result<TunnelUp, String> {
    loop {
        let text = std::fs::read_to_string(log).unwrap_or_default();
        if let Some(msg) = vpn_service::diagnose_log(&text) {
            return Err(msg);
        }
        if !is_running() {
            return Err(
                "OpenVPN stopped before the tunnel was ready. Check the profile and try again."
                    .into(),
            );
        }
        if Instant::now() > deadline {
            if let Some(msg) = vpn_service::diagnose_log(&text) {
                return Err(msg);
            }
            return Err(
                "The VPN server did not establish a tunnel within 30 seconds. Check your connection or try another profile."
                    .into(),
            );
        }
        if let Some(up) = inspect_tunnel_text(&text) {
            return Ok(up);
        }
        std::thread::sleep(LOG_POLL);
    }
}

fn inspect_tunnel_text(text: &str) -> Option<TunnelUp> {
    if !text.contains("Initialization Sequence Completed") {
        return None;
    }
    #[cfg(windows)]
    {
        windows_tunnel_from_log(text)
    }
    #[cfg(not(windows))]
    {
        let _ = text;
        None
    }
}

#[cfg(windows)]
fn windows_tunnel_from_log(log: &str) -> Option<TunnelUp> {
    let adapters = ipconfig::get_adapters().ok()?;
    let log_ip = log_ifconfig_ip(log);
    let mut best: Option<TunnelUp> = None;
    for adapter in adapters {
        if !is_openvpn_adapter(adapter.description(), adapter.friendly_name()) {
            continue;
        }
        let ip = adapter.ip_addresses().iter().find_map(|addr| match addr {
            std::net::IpAddr::V4(ip)
                if !ip.is_link_local() && !ip.is_loopback() && !ip.is_unspecified() =>
            {
                Some(*ip)
            }
            _ => None,
        });
        let Some(ip) = ip else {
            continue;
        };
        if let Some(want) = log_ip {
            if ip != want {
                continue;
            }
        }
        // OpenVPN DCO is IPv4-only: Ipv6IfIndex is 0. IP_UNICAST_IF with 0
        // does not pin, so CONNECT traffic would use the default route.
        let Some(if_index) = ipv4_if_index(ip) else {
            continue;
        };
        let isolated = default_route_if_index().is_some_and(|index| index != if_index);
        let candidate = TunnelUp {
            adapter: adapter.friendly_name().to_string(),
            tunnel_ip: ip.to_string(),
            if_index,
            isolated,
        };
        best = Some(candidate);
        if log_ip.is_some() {
            break;
        }
    }
    best
}

#[cfg(windows)]
fn is_openvpn_adapter(description: &str, friendly: &str) -> bool {
    let hay = format!("{description} {friendly}").to_ascii_lowercase();
    hay.contains("openvpn")
        || hay.contains("tap-windows")
        || hay.contains("wintun")
        || hay.contains("ovpn-dco")
        || hay.contains("data channel offload")
}

#[cfg(windows)]
fn default_route_if_index() -> Option<u32> {
    use std::mem::zeroed;
    use winapi::shared::winerror::NO_ERROR;
    use winapi::um::iphlpapi::GetBestRoute;

    unsafe {
        let mut row: winapi::shared::ipmib::MIB_IPFORWARDROW = zeroed();
        // 8.8.8.8 in network byte order — any public address to resolve the default route.
        let dest = u32::from_be_bytes([8, 8, 8, 8]);
        if GetBestRoute(dest, 0, &mut row) == NO_ERROR {
            Some(row.dwForwardIfIndex)
        } else {
            None
        }
    }
}

/// IPv4 interface index that owns `ip`. `ipconfig` only exposes IPv6 ifIndex,
/// which is 0 on IPv4-only OpenVPN DCO adapters.
#[cfg(windows)]
fn ipv4_if_index(ip: Ipv4Addr) -> Option<u32> {
    use winapi::shared::winerror::NO_ERROR;
    use winapi::um::iphlpapi::GetBestInterface;

    unsafe {
        let mut index = 0u32;
        // Windows IPAddr is network-order bytes stored in a little-endian DWORD.
        let dest = u32::from_le_bytes(ip.octets());
        if GetBestInterface(dest, &mut index) == NO_ERROR && index != 0 {
            Some(index)
        } else {
            None
        }
    }
}

fn log_ifconfig_ip(log: &str) -> Option<std::net::Ipv4Addr> {
    let lower = log.to_ascii_lowercase().replace(',', " ");
    let mut words = lower.split_whitespace().peekable();
    while let Some(word) = words.next() {
        if word != "ifconfig" {
            continue;
        }
        if let Some(next) = words.peek() {
            if let Ok(ip) = next.parse::<std::net::Ipv4Addr>() {
                if !ip.is_unspecified() && !ip.is_loopback() {
                    return Some(ip);
                }
            }
        }
    }
    None
}

fn finish_connect(
    manager: &VpnManager,
    mut process: OpenVpnProc,
    chosen: &DiscoveredProfile,
    up: TunnelUp,
) -> Result<VpnSnapshot, String> {
    let isolated = {
        #[cfg(windows)]
        {
            up.isolated && default_route_if_index().is_some_and(|index| index != up.if_index)
        }
        #[cfg(not(windows))]
        {
            up.isolated
        }
    };
    if !isolated {
        process.terminate();
        return Err(
            "The tunnel came up but also became this PC's default route. Isolation failed — not connecting, so the rest of the machine stays off the VPN."
                .into(),
        );
    }

    let bind_ip: Ipv4Addr = match up.tunnel_ip.parse() {
        Ok(ip) => ip,
        Err(_) => {
            process.terminate();
            return Err(format!(
                "Tunnel address {} is not a valid IPv4 address.",
                up.tunnel_ip
            ));
        }
    };
    let proxy = match vpn_proxy::start(up.if_index, bind_ip) {
        Ok(proxy) => proxy,
        Err(err) => {
            process.terminate();
            return Err(format!(
                "Tunnel is up, but the private proxy could not start: {err}"
            ));
        }
    };
    #[cfg(windows)]
    if let Err(err) = verify_pinned_egress(proxy.port) {
        proxy.stop();
        process.terminate();
        return Err(err);
    }

    let mut guard = manager
        .inner
        .lock()
        .map_err(|_| "vpn state is poisoned".to_string())?;
    #[cfg(windows)]
    if let Err(err) = watch_normal_route(manager, proxy.port, up.if_index) {
        proxy.stop();
        process.terminate();
        return Err(format!("Could not monitor the normal network route: {err}"));
    }
    guard.snapshot.phase = "connected".into();
    guard.snapshot.error = None;
    guard.snapshot.profile_id = Some(chosen.id.clone());
    guard.snapshot.profile_name = Some(chosen.name.clone());
    guard.snapshot.adapter = Some(up.adapter);
    guard.snapshot.tunnel_ip = Some(up.tunnel_ip);
    guard.snapshot.if_index = Some(up.if_index);
    guard.snapshot.proxy_port = Some(proxy.port);
    guard.snapshot.isolated = true;
    guard.live = Some(LiveTunnel { process, proxy });
    Ok(guard.snapshot.clone())
}

/// CONNECT can succeed while still using the default route (interface index 0
/// is a silent no-op for `IP_UNICAST_IF`). Refuse to expose the proxy unless
/// the public address actually changed.
#[cfg(windows)]
fn verify_pinned_egress(port: u16) -> Result<(), String> {
    let via_vpn = public_ipv4(Some(&format!("http://127.0.0.1:{port}")))?;
    let via_normal = public_ipv4(None)?;
    if via_vpn == via_normal {
        return Err(format!(
            "The tunnel is up, but Keel's traffic is still leaving from {via_normal} (your normal connection) instead of the VPN. Claude and Codex need the VPN address. Try reconnecting."
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn public_ipv4(proxy: Option<&str>) -> Result<Ipv4Addr, String> {
    let urls = [
        "https://api.ipify.org",
        "https://ifconfig.me/ip",
        "https://icanhazip.com",
    ];
    let mut last = "no public-IP endpoint responded".to_string();
    for url in urls {
        match public_ipv4_from(url, proxy) {
            Ok(ip) => return Ok(ip),
            Err(err) => last = err,
        }
    }
    Err(last)
}

#[cfg(windows)]
fn public_ipv4_from(url: &str, proxy: Option<&str>) -> Result<Ipv4Addr, String> {
    let mut builder = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("keel-vpn-check")
        .no_proxy();
    if let Some(proxy) = proxy {
        builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|err| err.to_string())?);
    }
    let client = builder.build().map_err(|err| err.to_string())?;
    let text = client
        .get(url)
        .send()
        .map_err(|err| err.to_string())?
        .error_for_status()
        .map_err(|err| err.to_string())?
        .text()
        .map_err(|err| err.to_string())?;
    text.trim()
        .parse()
        .map_err(|_| format!("unexpected public IP response from {url}"))
}

#[cfg(windows)]
fn watch_normal_route(manager: &VpnManager, port: u16, if_index: u32) -> std::io::Result<()> {
    let state = Arc::downgrade(&manager.inner);
    std::thread::Builder::new().name("keel-vpn-route".into()).spawn(move || loop {
        std::thread::sleep(Duration::from_millis(250));
        let Some(state) = state.upgrade() else { return; };
        let Ok(mut guard) = state.lock() else { return; };
        if guard.snapshot.proxy_port != Some(port) { return; }
        let process_running = guard.live.as_mut().is_some_and(|live| live.process.is_running());
        let error = if !process_running {
            "The VPN process stopped. Reconnect before starting new terminals with the VPN."
        } else if default_route_if_index().is_some_and(|index| index != if_index) {
            continue;
        } else {
            "Your normal network route is no longer available. Keel closed its tunnel to avoid using it as this PC's default connection. Restore your normal connection and try again."
        };
        if let Some(mut live) = guard.live.take() {
            live.proxy.stop();
            live.process.terminate();
        }
        guard.snapshot.phase = "error".into();
        guard.snapshot.error = Some(error.into());
        guard.snapshot.proxy_port = None;
        guard.snapshot.isolated = false;
        return;
    }).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::log_ifconfig_ip;
    use crate::vpn_service::diagnose_log;

    struct TempLog(std::path::PathBuf);

    impl TempLog {
        fn new(text: &str) -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir()
                .join(format!("keel-vpn-test-{}-{nonce}.log", std::process::id()));
            std::fs::write(&path, text).unwrap();
            Self(path)
        }
    }

    impl Drop for TempLog {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    #[test]
    fn denied_dco_adapter_triggers_fallback_without_waiting_for_timeout() {
        let log = TempLog::new("dco connect error: Access is denied. (errno=5)\nSIGUSR1[soft,dco-connect-error] received, process restarting\n");
        let error = super::wait_for_tunnel(
            &log.0,
            std::time::Instant::now() + super::CONNECT_WAIT,
            || true,
        )
        .err()
        .expect("adapter failure");
        assert!(super::is_adapter_ip_failure(&error));
        assert!(!super::is_adapter_ip_failure(
            "The VPN server rejected the login."
        ));
    }

    #[test]
    fn exited_process_fails_without_waiting_for_timeout() {
        let log = TempLog::new("");
        let error = super::wait_for_tunnel(
            &log.0,
            std::time::Instant::now() + super::CONNECT_WAIT,
            || false,
        )
        .err()
        .expect("process exited");
        assert!(error.contains("stopped before"));
    }

    #[test]
    fn exhausted_connection_budget_does_not_start_another_wait() {
        let log = TempLog::new("Server poll timeout, restarting\n");
        let error = super::wait_for_tunnel(
            &log.0,
            std::time::Instant::now() - std::time::Duration::from_millis(1),
            || true,
        )
        .err()
        .expect("deadline elapsed");
        assert!(error.contains("30 seconds"));
    }

    /// Opt-in: connects the profile named by KEEL_VPN_SMOKE_PROFILE and checks
    /// an HTTPS request through Keel's proxy. Never runs in the regular suite.
    #[cfg(windows)]
    #[test]
    #[ignore = "requires an installed service and KEEL_VPN_SMOKE_PROFILE"]
    fn live_private_tunnel() {
        use super::*;

        struct Cleanup {
            process: Option<OpenVpnProc>,
            manager: VpnManager,
            config: PathBuf,
            log: PathBuf,
        }
        impl Drop for Cleanup {
            fn drop(&mut self) {
                self.manager.shutdown();
                if let Some(process) = &mut self.process {
                    process.terminate();
                }
                let _ = std::fs::remove_file(&self.config);
                let _ = std::fs::remove_file(&self.log);
            }
        }

        let profile = std::env::var_os("KEEL_VPN_SMOKE_PROFILE")
            .expect("set KEEL_VPN_SMOKE_PROFILE to a local autologin .ovpn file");
        let source = std::fs::read_to_string(profile).unwrap();
        assert!(!vpn_profile::needs_interactive_auth(&source));
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let name = format!("keel-smoke-{}-{nonce}", std::process::id());
        let config = openvpn_config_path()
            .unwrap()
            .with_file_name(format!("{name}.ovpn"));
        let log = std::env::temp_dir().join(format!("{name}.log"));
        let mut cleanup = Cleanup {
            process: None,
            manager: VpnManager::default(),
            config,
            log,
        };
        let before = default_route_if_index().expect("normal route is available");
        std::fs::write(&cleanup.config, vpn_profile::isolate_profile(&source)).unwrap();
        let deadline = Instant::now() + CONNECT_WAIT;
        cleanup.process = Some(
            start_openvpn(
                &find_openvpn().unwrap(),
                &cleanup.config,
                &cleanup.log,
                deadline,
            )
            .unwrap(),
        );
        let up = wait_for_tunnel(&cleanup.log, deadline, || {
            cleanup.process.as_mut().unwrap().is_running()
        })
        .unwrap_or_else(|err| {
            let log = std::fs::read_to_string(&cleanup.log).unwrap_or_default();
            for line in log.lines().filter(|line| line.contains("AUTH_FAILED")) {
                eprintln!("{line}");
            }
            panic!("{err}");
        });
        assert!(up.isolated, "tunnel must not become the normal route");
        assert_eq!(default_route_if_index(), Some(before));
        let text = std::fs::read_to_string(&cleanup.log).unwrap();
        assert!(
            !text.contains("msg_channel=0"),
            "privileged channel must be attached"
        );
        let chosen = DiscoveredProfile {
            id: "smoke".into(),
            name: "Smoke test".into(),
            path: cleanup.config.clone(),
        };
        let snapshot = finish_connect(
            &cleanup.manager,
            cleanup.process.take().unwrap(),
            &chosen,
            up,
        )
        .unwrap();
        let port = snapshot.proxy_port.unwrap();
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).unwrap())
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap();
        let response = client.get("https://example.com").send().unwrap();
        assert!(response.status().is_success());
        assert_eq!(default_route_if_index(), Some(before));
        assert_eq!(cleanup.manager.snapshot().phase, "connected");
        println!("Private tunnel established; HTTPS proxy request passed; normal route unchanged.");
        if std::env::var_os("KEEL_VPN_SMOKE_PROVIDERS").is_some() {
            // No credentials or prompts: an authentication error proves the
            // request reached the provider instead of a network block page.
            for (name, url, expected) in [
                ("OpenAI", "https://api.openai.com/v1/models", 401),
                ("Anthropic", "https://api.anthropic.com/v1/messages", 405),
                (
                    "Codex",
                    "https://chatgpt.com/backend-api/codex/models?client_version=0.154.0",
                    401,
                ),
            ] {
                let response = client.get(url).send().unwrap();
                let status = response.status();
                let json = response.json::<serde_json::Value>().ok();
                let error_type = json
                    .as_ref()
                    .and_then(|v| v.pointer("/error/type"))
                    .and_then(|v| v.as_str());
                println!(
                    "{name}: HTTP {status}; JSON error type: {}",
                    error_type.unwrap_or("none")
                );
                assert_eq!(status.as_u16(), expected, "{name} reachability");
                assert!(json.is_some(), "{name} must return its API response");
            }
        }
        if std::env::var_os("KEEL_VPN_SMOKE_USAGE").is_some() {
            crate::usage::tests::live_usage_through_proxy(Some(&format!(
                "http://127.0.0.1:{port}"
            )));
        }
        cleanup
            .manager
            .inner
            .lock()
            .unwrap()
            .live
            .as_mut()
            .unwrap()
            .process
            .terminate();
        let stopped_by = Instant::now() + Duration::from_secs(3);
        while cleanup.manager.snapshot().phase == "connected" && Instant::now() < stopped_by {
            std::thread::sleep(LOG_POLL);
        }
        let stopped = cleanup.manager.snapshot();
        assert_eq!(stopped.phase, "error");
        assert_eq!(stopped.proxy_port, None);
        println!("Exited VPN process detected and stale proxy closed.");
    }

    #[cfg(windows)]
    #[test]
    fn ipv4_if_index_of_loopback_is_nonzero() {
        let index = super::ipv4_if_index(std::net::Ipv4Addr::LOCALHOST).expect("loopback");
        // Loopback is interface 1 on Windows. A byte-order bug would not land here.
        assert_eq!(index, 1);
    }

    #[test]
    fn proxy_env_covers_websocket_claude_dns_and_node_fetch() {
        let env: std::collections::HashMap<_, _> = super::proxy_env_vars("http://127.0.0.1:9")
            .into_iter()
            .collect();
        assert_eq!(env["HTTPS_PROXY"], "http://127.0.0.1:9");
        assert_eq!(env["WSS_PROXY"], "http://127.0.0.1:9");
        assert_eq!(env["wss_proxy"], "http://127.0.0.1:9");
        assert_eq!(env["NO_PROXY"], "localhost,127.0.0.1,::1");
        assert_eq!(env["CLAUDE_CODE_PROXY_RESOLVES_HOSTS"], "1");
        assert_eq!(env["NODE_USE_ENV_PROXY"], "1");
    }

    #[test]
    fn reads_ifconfig_from_openvpn_log() {
        let log = "PUSH: Received control message: 'PUSH_REPLY,ifconfig 10.8.0.6 10.8.0.5,peer 1.2.3.4'\nInitialization Sequence Completed\n";
        assert_eq!(log_ifconfig_ip(log), Some("10.8.0.6".parse().unwrap()));
    }

    #[test]
    fn netsh_log_does_not_become_a_wall_of_text() {
        let log = include_str_netsh();
        let msg = diagnose_log(log).expect("short diagnosis");
        assert!(msg.len() < 500, "{msg}");
        assert!(!msg.contains("TLS_AES"));
        assert!(!msg.contains("PUSH_REPLY"));
    }

    fn include_str_netsh() -> &'static str {
        "interactive service msg_channel=0\n\
         ovpn-dco device [OpenVPN Data Channel Offload] opened\n\
         NETSH: C:\\WINDOWS\\system32\\netsh.exe interface ip set address 44 static 172.27.237.53 255.255.254.0 store=active\n\
         ERROR: command failed: returned error code 1\n"
    }
}
