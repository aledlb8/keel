//! Turn an OpenVPN Connect profile into a *private* tunnel config.
//!
//! OpenVPN Connect has no per-app mode on Windows: connecting it installs a
//! default route and the whole PC goes through the VPN. The documented way to
//! keep the PC off the VPN is a client-side override:
//!
//! - strip any `redirect-gateway` already in the file
//! - `route-nopull` so pushed routes/DNS never hit the routing table
//! - `pull-filter ignore "redirect-gateway"` as a belt (OpenVPN 2.4+)
//!
//! The TUN/TAP still gets an address. Keel then binds *its* traffic to that
//! interface. Everyone else keeps using the normal default route.

use std::path::{Path, PathBuf};

/// Directives that would steal the PC's default route, DNS, or leak-block the
/// rest of the machine. Dropped from the copy Keel actually runs.
fn is_system_wide_line(trimmed: &str) -> bool {
    let lower = trimmed.to_ascii_lowercase();
    let first = lower.split_whitespace().next().unwrap_or("");
    matches!(
        first,
        "redirect-gateway"
            | "redirect-gateway-ipv6"
            | "route-nopull"
            | "route-noexec"
            | "block-outside-dns"
            | "register-dns"
            | "pull-filter"
            | "ip-win32"
            | "windows-driver"
            | "route"
            | "route-ipv6"
            | "redirect-private"
    ) || lower.contains("block-outside-dns")
        || lower.starts_with("dhcp-option dns")
        || lower.starts_with("dhcp-option domain")
}

/// Rewrite a `.ovpn` so bringing it up does not take over the PC.
pub fn isolate_profile(source: &str) -> String {
    isolate_profile_with(source, None)
}

/// `windows_driver` is an OpenVPN `--windows-driver` value, e.g. `tap-windows6`.
pub fn isolate_profile_with(source: &str, windows_driver: Option<&str>) -> String {
    let mut body = String::with_capacity(source.len() + 512);
    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
            body.push_str(line);
            body.push('\n');
            continue;
        }
        if is_system_wide_line(trimmed) {
            continue;
        }
        body.push_str(line);
        body.push('\n');
    }
    if !body.ends_with('\n') {
        body.push('\n');
    }
    body.push('\n');
    body.push_str("# Added by Keel: private tunnel for this app only.\n");
    body.push_str("# Keep the normal connection preferred and leave system DNS unchanged.\n");
    body.push_str("route-nopull\n");
    body.push_str("pull-filter ignore \"redirect-gateway\"\n");
    body.push_str("pull-filter ignore \"dhcp-option DNS\"\n");
    body.push_str("pull-filter ignore \"dhcp-option DOMAIN\"\n");
    body.push_str("pull-filter ignore \"block-outside-dns\"\n");
    body.push_str("pull-filter ignore \"register-dns\"\n");
    body.push_str("pull-filter ignore \"route-ipv6\"\n");
    body.push_str("pull-filter ignore \"ifconfig-ipv6\"\n");
    body.push_str("pull-filter ignore \"redirect-gateway ipv6\"\n");
    // IP Helper API instead of netsh — still needs the Interactive Service,
    // but avoids a class of `netsh error code 1` failures on DCO adapters.
    body.push_str("ip-win32 ipapi\n");
    // IP_UNICAST_IF restricts route selection to this adapter; it does not
    // create a route. Give pinned sockets a route to public destinations,
    // with a metric well above the normal connection. Keel verifies the
    // normal route still wins before exposing the proxy.
    body.push_str("route 0.0.0.0 0.0.0.0 vpn_gateway 9999\n");
    if let Some(driver) = windows_driver {
        body.push_str("windows-driver ");
        body.push_str(driver);
        body.push('\n');
    }
    body
}

/// True when OpenVPN would block waiting for a username/password on stdin.
pub fn needs_interactive_auth(source: &str) -> bool {
    if source.to_ascii_lowercase().contains("<auth-user-pass>") {
        return false;
    }
    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
            continue;
        }
        let mut parts = trimmed.split_whitespace();
        let Some(verb) = parts.next() else {
            continue;
        };
        if !verb.eq_ignore_ascii_case("auth-user-pass") {
            continue;
        }
        return match parts.next() {
            None => true,
            Some(path) => !Path::new(path).is_file(),
        };
    }
    false
}

/// OpenVPN Connect and community-client places a `.ovpn` might already live.
pub fn profile_search_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let appdata = PathBuf::from(appdata);
        roots.push(appdata.join("OpenVPN Connect").join("profiles"));
        roots.push(appdata.join("OpenVPNConnect").join("profiles"));
    }
    if let Some(home) = crate::pty::home_dir() {
        roots.push(home.join("OpenVPN").join("config"));
    }
    if let Ok(program_files) = std::env::var("ProgramFiles") {
        roots.push(PathBuf::from(program_files).join("OpenVPN").join("config"));
    }
    roots
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredProfile {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
}

pub fn discover_profiles() -> Vec<DiscoveredProfile> {
    let mut found = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for root in profile_search_roots() {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let ext = path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.to_ascii_lowercase());
            if ext.as_deref() != Some("ovpn") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            if !seen.insert(stem.to_ascii_lowercase()) {
                continue;
            }
            found.push(DiscoveredProfile {
                id: stem.to_string(),
                name: stem.replace('_', " "),
                path,
            });
        }
    }
    found.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
    });
    found
}

pub fn find_profile<'a>(
    profiles: &'a [DiscoveredProfile],
    wanted: Option<&str>,
) -> Option<&'a DiscoveredProfile> {
    let wanted = wanted.map(str::trim).filter(|id| !id.is_empty())?;
    profiles.iter().find(|profile| {
        profile.id.eq_ignore_ascii_case(wanted) || profile.name.eq_ignore_ascii_case(wanted)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
client
dev tun
proto udp
remote vpn.example.com 1194
resolv-retry infinite
nobind
persist-key
persist-tun
redirect-gateway def1
dhcp-option DNS 10.8.0.1
block-outside-dns
setenv opt block-outside-dns
<ca>
-----BEGIN CERTIFICATE-----
MIIB
-----END CERTIFICATE-----
</ca>
"#;

    #[test]
    fn isolate_drops_system_wide_routing_and_dns() {
        let isolated = isolate_profile(SAMPLE);
        let lower = isolated.to_ascii_lowercase();
        assert!(isolated.contains("remote vpn.example.com 1194"));
        assert!(isolated.contains("<ca>"));
        assert!(!lower.lines().any(|line| {
            let trimmed = line.trim_start();
            !trimmed.starts_with('#')
                && !trimmed.starts_with("pull-filter")
                && (trimmed.starts_with("redirect-gateway")
                    || trimmed.contains("block-outside-dns")
                    || trimmed.starts_with("dhcp-option dns"))
        }));
        assert!(isolated.contains("route-nopull"));
        assert!(isolated.contains("pull-filter ignore \"redirect-gateway\""));
        assert!(isolated.contains("pull-filter ignore \"block-outside-dns\""));
        assert!(isolated.contains("pull-filter ignore \"dhcp-option DNS\""));
        assert!(isolated.contains("ip-win32 ipapi"));
    }

    #[test]
    fn isolate_is_idempotent() {
        let once = isolate_profile(SAMPLE);
        let twice = isolate_profile(&once);
        assert_eq!(
            once.matches("route-nopull").count(),
            twice.matches("route-nopull").count()
        );
        assert_eq!(twice.matches("route-nopull").count(), 1);
    }

    #[test]
    fn pinned_sockets_get_one_low_priority_route_without_inherited_routes() {
        let source = "client\nroute 0.0.0.0 128.0.0.0\nroute 128.0.0.0 128.0.0.0\nroute 10.0.0.0 255.0.0.0\nroute-ipv6 ::/0\nredirect-private\n";
        let isolated = isolate_profile(&isolate_profile(source));
        let routes: Vec<_> = isolated
            .lines()
            .filter(|line| line.starts_with("route "))
            .collect();
        assert_eq!(routes, ["route 0.0.0.0 0.0.0.0 vpn_gateway 9999"]);
        assert!(!isolated
            .lines()
            .any(|line| line.starts_with("route-ipv6 ") || line == "redirect-private"));
    }

    #[test]
    fn autologin_profile_does_not_need_stdin() {
        assert!(!needs_interactive_auth(SAMPLE));
        assert!(needs_interactive_auth("client\nauth-user-pass\n"));
        assert!(!needs_interactive_auth(
            "client\n<auth-user-pass>\nuser\npass\n</auth-user-pass>\n"
        ));
    }
}
