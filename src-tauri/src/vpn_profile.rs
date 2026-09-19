//! Turn an OpenVPN Connect profile into a *private* tunnel config.
//!
//! OpenVPN Connect has no per-app mode on Windows: connecting it installs a
//! default route and the whole PC goes through the VPN. The documented way to
//! keep the PC off the VPN is a client-side override:
//!
//! - keep only an allowlist of client-tunnel directives (scripts, plugins,
//!   management, and unknown verbs are dropped)
//! - strip routing/DNS even when those verbs are on the allowlist
//! - `route-nopull` so pushed routes/DNS never hit the routing table
//! - `pull-filter ignore "redirect-gateway"` as a belt (OpenVPN 2.4+)
//!
//! The TUN/TAP still gets an address. Keel then binds *its* traffic to that
//! interface. Everyone else keeps using the normal default route.

use std::path::PathBuf;

/// Inline PEM/key/auth blobs. Unknown tags (including `<http-proxy>`) are skipped.
const INLINE_FILE_TAGS: &[&str] = &[
    "ca",
    "cert",
    "key",
    "tls-auth",
    "tls-crypt",
    "tls-crypt-v2",
    "auth-user-pass",
];

fn directive_verb(trimmed: &str) -> &str {
    trimmed.split_whitespace().next().unwrap_or("")
}

fn eq_verb(verb: &str, expected: &str) -> bool {
    verb.eq_ignore_ascii_case(expected)
}

/// Client-tunnel verbs plus what `isolate_profile_with` appends. Host takeover
/// verbs sit on this list only so the strip check can name them explicitly.
fn is_allowed_directive(verb: &str) -> bool {
    is_client_tunnel_directive(verb) || is_stripped_host_directive(verb)
}

fn is_client_tunnel_directive(verb: &str) -> bool {
    matches!(
        verb.to_ascii_lowercase().as_str(),
        "client"
            | "dev"
            | "dev-type"
            | "proto"
            | "remote"
            | "remote-random"
            | "resolv-retry"
            | "nobind"
            | "persist-key"
            | "persist-tun"
            | "auth-user-pass"
            | "auth"
            | "cipher"
            | "data-ciphers"
            | "data-ciphers-fallback"
            | "tls-client"
            | "tls-version-min"
            | "remote-cert-tls"
            | "ca"
            | "cert"
            | "key"
            | "tls-auth"
            | "tls-crypt"
            | "tls-crypt-v2"
            | "key-direction"
            | "verb"
            | "mute"
            | "keepalive"
            | "ping"
            | "ping-restart"
            | "reneg-sec"
            | "sndbuf"
            | "rcvbuf"
            | "tun-mtu"
            | "mssfix"
            | "fast-io"
            | "user"
            | "group"
            | "compress"
            | "comp-lzo"
            | "auth-nocache"
            | "pull"
            | "ncp-ciphers"
            | "engine"
            | "providers"
            | "remote-cert-eku"
            | "verify-x509-name"
            | "tls-cipher"
            | "tls-ciphersuites"
            | "ns-cert-type"
            | "key-method"
            | "secret"
    )
}

/// Routing/DNS that would take over the PC, and isolation lines we re-append.
fn is_stripped_host_directive(verb: &str) -> bool {
    matches!(
        verb.to_ascii_lowercase().as_str(),
        "redirect-gateway"
            | "redirect-gateway-ipv6"
            | "dhcp-option"
            | "route"
            | "route-ipv6"
            | "redirect-private"
            | "block-outside-dns"
            | "register-dns"
            | "route-nopull"
            | "route-noexec"
            | "pull-filter"
            | "ip-win32"
            | "windows-driver"
            | "explicit-exit-notify"
    )
}

fn is_external_material_directive(verb: &str) -> bool {
    matches!(
        verb.to_ascii_lowercase().as_str(),
        "ca" | "cert" | "key" | "tls-auth" | "tls-crypt" | "tls-crypt-v2" | "secret"
    )
}

fn has_directive_args(trimmed: &str) -> bool {
    let mut parts = trimmed.split_whitespace();
    parts.next();
    parts.next().is_some()
}

fn is_inline_arg(arg: &str) -> bool {
    arg.eq_ignore_ascii_case("[inline]")
}

/// Drop filesystem forms of key material. `ca [inline]` is not a path; the
/// matching `<ca>` block (if any) is kept separately.
fn is_external_material_path(verb: &str, trimmed: &str) -> bool {
    if !is_external_material_directive(verb) {
        return false;
    }
    let mut parts = trimmed.split_whitespace();
    parts.next();
    match parts.next() {
        None => false,
        Some(arg) => !is_inline_arg(arg),
    }
}

fn is_keep_inline_tag(name: &str) -> bool {
    INLINE_FILE_TAGS.iter().any(|tag| eq_verb(name, tag))
}

/// `(tag, closing)` for a line that is an OpenVPN inline `<tag>` / `</tag>`.
fn parse_inline_tag(trimmed: &str) -> Option<(String, bool)> {
    if !trimmed.starts_with('<') {
        return None;
    }
    let end = trimmed.find('>')?;
    let inner = trimmed[1..end].trim();
    if inner.is_empty() {
        return None;
    }
    let (name, closing) = match inner.strip_prefix('/') {
        Some(rest) => (rest.trim(), true),
        None => (inner, false),
    };
    let name = name.split_whitespace().next()?.to_ascii_lowercase();
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    Some((name, closing))
}

/// Rewrite a `.ovpn` so bringing it up does not take over the PC.
pub fn isolate_profile(source: &str) -> String {
    isolate_profile_with(source, None)
}

/// `windows_driver` is an OpenVPN `--windows-driver` value, e.g. `tap-windows6`.
pub fn isolate_profile_with(source: &str, windows_driver: Option<&str>) -> String {
    let mut body = String::with_capacity(source.len() + 512);
    // Some(tag) while inside an allowed PEM/auth block; skipped tags use `skip`.
    let mut keep_block: Option<String> = None;
    let mut skip_block: Option<String> = None;
    for line in source.lines() {
        let trimmed = line.trim();
        if keep_block.is_some() {
            body.push_str(line);
            body.push('\n');
            if let Some((name, true)) = parse_inline_tag(trimmed) {
                if keep_block.as_deref() == Some(name.as_str()) {
                    keep_block = None;
                }
            }
            continue;
        }
        if skip_block.is_some() {
            if let Some((name, true)) = parse_inline_tag(trimmed) {
                if skip_block.as_deref() == Some(name.as_str()) {
                    skip_block = None;
                }
            }
            continue;
        }
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
            body.push_str(line);
            body.push('\n');
            continue;
        }
        if let Some((name, closing)) = parse_inline_tag(trimmed) {
            if closing {
                continue;
            }
            if is_keep_inline_tag(&name) {
                body.push_str(line);
                body.push('\n');
                keep_block = Some(name);
                continue;
            }
            // `<connection>` groups remotes; drop the tags, allowlist the body.
            if name == "connection" {
                continue;
            }
            skip_block = Some(name);
            continue;
        }
        let verb = directive_verb(trimmed);
        if !is_allowed_directive(verb) || is_stripped_host_directive(verb) {
            continue;
        }
        if is_external_material_path(verb, trimmed) {
            continue;
        }
        if eq_verb(verb, "auth-user-pass") && has_directive_args(trimmed) {
            body.push_str("auth-user-pass\n");
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
    // SIGTERM / --service exit tells the Access Server to drop this
    // session immediately. TerminateProcess cannot send that notify, so
    // the licensed slot stays occupied until ping-restart (~50s here).
    // OpenVPN 2.7 + DCO uses the control channel (`cc-exit`) for this.
    // TCP ignores the option; UDP needs it.
    body.push_str("explicit-exit-notify 2\n");
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
        let verb = directive_verb(trimmed);
        if verb.eq_ignore_ascii_case("auth-user-pass") {
            // Isolation strips any credentials-file argument, so OpenVPN would
            // block on stdin unless the profile also has an inline block.
            return true;
        }
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
            // Isolated working copy, not a user-selected Connect profile.
            if is_generated_working_copy(stem) {
                continue;
            }
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

fn is_generated_working_copy(stem: &str) -> bool {
    stem.eq_ignore_ascii_case("keel-app")
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
        assert!(isolated.contains("explicit-exit-notify 2"));
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
        assert_eq!(twice.matches("explicit-exit-notify").count(), 1);
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
    fn generated_working_copy_is_not_a_user_profile() {
        assert!(is_generated_working_copy("keel-app"));
        assert!(is_generated_working_copy("Keel-App"));
        assert!(!is_generated_working_copy("office"));
        assert!(!is_generated_working_copy("keel-app-backup"));
    }

    #[test]
    fn autologin_profile_does_not_need_stdin() {
        assert!(!needs_interactive_auth(SAMPLE));
        assert!(needs_interactive_auth("client\nauth-user-pass\n"));
        assert!(needs_interactive_auth(
            "client\nauth-user-pass /tmp/creds.txt\n"
        ));
        assert!(!needs_interactive_auth(
            "client\n<auth-user-pass>\nuser\npass\n</auth-user-pass>\n"
        ));
    }

    fn has_directive(config: &str, verb: &str) -> bool {
        config.lines().any(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
                return false;
            }
            trimmed
                .split_whitespace()
                .next()
                .is_some_and(|first| first.eq_ignore_ascii_case(verb))
        })
    }

    #[test]
    fn isolate_drops_scripts_plugins_and_passthrough() {
        let source = r#"
client
dev tun
proto udp
remote vpn.example.com 1194
up /bin/true
plugin /tmp/evil.so
management 127.0.0.1 9999
setenv FOO BAR
dhcp-option  DNS 10.0.0.1
<ca>
-----BEGIN CERTIFICATE-----
MIIB
-----END CERTIFICATE-----
</ca>
"#;
        let isolated = isolate_profile(source);
        assert!(isolated.contains("remote vpn.example.com 1194"));
        assert!(isolated.contains("<ca>"));
        assert!(isolated.contains("MIIB"));
        assert!(isolated.contains("</ca>"));
        assert!(!has_directive(&isolated, "up"));
        assert!(!has_directive(&isolated, "plugin"));
        assert!(!has_directive(&isolated, "management"));
        assert!(!has_directive(&isolated, "setenv"));
        assert!(!has_directive(&isolated, "dhcp-option"));
        assert!(!isolated.contains("/bin/true"));
        assert!(!isolated.contains("/tmp/evil.so"));
        assert!(!isolated.contains("127.0.0.1 9999"));
        assert!(!isolated.contains("FOO BAR"));
        assert!(!isolated.contains("10.0.0.1"));
    }

    #[test]
    fn isolate_strips_credential_and_key_file_paths() {
        let source = "client\nauth-user-pass /tmp/creds.txt\nca /tmp/ca.crt\ncert /tmp/client.crt\nkey /tmp/client.key\nsecret /tmp/static.key\n";
        let isolated = isolate_profile(source);
        assert!(has_directive(&isolated, "auth-user-pass"));
        assert!(!isolated.contains("/tmp/creds.txt"));
        assert!(!has_directive(&isolated, "ca"));
        assert!(!has_directive(&isolated, "cert"));
        assert!(!has_directive(&isolated, "key"));
        assert!(!has_directive(&isolated, "secret"));
        assert!(!isolated.contains("/tmp/"));
    }

    #[test]
    fn isolate_skips_unknown_inline_blocks_and_keeps_connection_remotes() {
        let source = r#"
client
<http-proxy>
remote evil.example 1194
up /bin/true
</http-proxy>
<connection>
remote vpn.example.com 1194
</connection>
"#;
        let isolated = isolate_profile(source);
        assert!(isolated.contains("remote vpn.example.com 1194"));
        assert!(!isolated.contains("evil.example"));
        assert!(!isolated.contains("/bin/true"));
        assert!(!isolated.contains("<http-proxy>"));
        assert!(!isolated.contains("<connection>"));
    }
}
