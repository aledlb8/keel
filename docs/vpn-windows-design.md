# Private OpenVPN on Windows

Keel needs a VPN path for its own HTTP traffic without replacing Windows' default route. The implementation therefore separates tunnel establishment from traffic selection:

1. It derives a temporary client configuration from an imported profile.
2. It suppresses server-pushed routes and system DNS changes.
3. It starts the OpenVPN 2.x engine through the privileged Windows Interactive Service.
4. It exposes a loopback HTTP CONNECT proxy whose outbound sockets select the tunnel interface.
5. It supplies that proxy to Keel's HTTP client and child terminals through proxy environment variables.

This design keeps the machine's normal route preferred. It provides a private path for Keel and software that honors the supplied proxy variables. It is not a process-wide Windows firewall or kill switch: a child program that ignores proxy settings can still use the machine's normal route.

## Interactive Service contract

OpenVPN's Windows Interactive Service listens on `\\.\pipe\openvpn\service`. The client opens the duplex named pipe, switches the handle to message-read mode, and writes three NUL-terminated UTF-16 fields: working directory, OpenVPN options, and standard input. OpenVPN GUI follows this contract and keeps the same pipe handle for request and response. The service validates the requested options and config location, starts `openvpn.exe` in the caller's security context, creates a separate privileged message channel for the engine, and returns a three-line UTF-16 response containing an error code and process ID.[^1][^2]

Launching `openvpn.exe` directly is insufficient for non-elevated Keel processes. The engine can establish TLS but privileged adapter operations then fail; the Interactive Service supplies the `--msg-channel` handle used for address, route, DNS, MTU, and related Windows changes.[^1]

## Error 231 root cause

Windows returns `ERROR_PIPE_BUSY` (231) when a named pipe exists but every listening instance is currently connected. Microsoft specifies that a client must call `WaitNamedPipe`, then retry `CreateFile`. Even after a successful wait, another client can acquire the available instance first, so the open must remain in a retry loop.[^3][^4]

The previous Keel client opened the service pipe as an availability probe, immediately closed that handle without sending startup data, and then opened the pipe again for the real request. The first connection forced the service to dispatch a worker and recreate a listening instance. The second `CreateFile` could run during that handoff and fail with error 231. Keel then described the running service as unreachable, which led to the misleading instruction shown in the UI.

The corrected client:

- opens the pipe once and retains that exact handle through mode setup, write, and read;
- treats error 231 as transient, waiting and retrying for up to five seconds;
- checks the service only when the pipe does not exist, starts it if needed, then polls for creation for up to fifteen seconds;
- uses an owning Rust wrapper so every return path closes the Windows handle;
- rejects partial writes, odd-length UTF-16 responses, and zero process IDs;
- distinguishes a busy service from an unavailable service in user-facing errors.

The bounded waits avoid both a startup race and an indefinitely blocked connection command. The implementation deliberately does not restart a service that is already running merely because its pipe is busy.

## Service startup permissions

The next reported failure was separate from error 231: Keel invoked `sc start OpenVPNServiceInteractive` without elevation and discarded its output. On this machine that command returns Windows error 5 (access denied). The service ACL allows an interactive user to query its status but reserves starting it for administrators and SYSTEM. The Windows event log also records the Interactive Service terminating unexpectedly before the reported connection failure.

Keel now queries the service through the Service Control Manager with query-only rights first. A running or starting service only needs time to publish its pipe. For a stopped service, Keel requests start rights and calls `StartServiceW`; an access-denied result invokes Windows' administrator approval dialog for the system-directory `sc.exe` with the fixed arguments `start OpenVPNServiceInteractive`. Keel and its terminals stay unelevated. No service permissions or startup settings are changed. Another client winning the startup race is treated as success.[^7]

Canceled approval, disabled or missing services, and other startup errors retain the underlying Windows error and receive distinct instructions. Successful service startup is followed by a bounded wait for the actual pipe; a missing pipe is no longer presented as proof that the service is stopped. The elevated helper process is hidden and its completion wait is bounded to thirty seconds.

## Route and traffic isolation

`route-nopull` prevents server-pushed routes, DNS settings, and `block-outside-dns` from changing the host. `pull-filter ignore` rules provide explicit filtering for default-route, DNS, and IPv6 directives. OpenVPN still configures the tunnel interface address, which is required before Keel can select it for outbound sockets.[^5]

The local CONNECT proxy applies Windows' `IP_UNICAST_IF` socket option before connecting upstream. Microsoft defines this option as selecting the outgoing interface for IPv4 traffic on multihomed systems.[^6] DNS A queries are sent from a UDP socket with the same interface selection before the proxy falls back to the system resolver.

The real HTTPS smoke test exposed a second failure after tunnel establishment: Windows returned `WSAENETUNREACH` (10051) because the selected interface had no route to public destinations. Selecting an interface does not supply a route. The generated profile now removes inherited explicit routes and adds `route 0.0.0.0 0.0.0.0 vpn_gateway 9999`. This low-priority route serves sockets pinned to the tunnel while the ordinary route wins for unpinned sockets. Keel rejects the tunnel if it cannot verify a preferred normal route, and checks every 250 ms while connected, closing its own tunnel if that condition stops holding. It no longer attempts to delete global `/1` routes belonging to other connections.

The route monitor is best effort, not packet-level enforcement: a normal-connection failure can briefly make the lower-priority route eligible before the monitor closes the tunnel. Strict isolation during network transitions requires a separate routing compartment or filtering policy, beyond proxy settings and route metrics.

Two boundaries remain intentional:

- The isolation applies to Keel's HTTP client and terminal programs that honor `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY`.
- The tunnel currently carries IPv4 upstream connections. The proxy resolves A records and uses the IPv4 interface-selection semantics required by `IP_UNICAST_IF`.

A future requirement for mandatory coverage of arbitrary child-process sockets would need a Windows Filtering Platform policy, a per-process virtual network namespace equivalent, or another enforcement layer. Environment variables alone cannot enforce that property.

## Verification

The protocol parser and encoder are covered by Rust unit tests, including rejection of a zero process ID. The complete repository check runs TypeScript checking, frontend tests, Rust formatting, and Clippy with warnings denied.

Startup regression tests cover access-denied recovery, avoiding elevation for other failures, canceled approval, and another client starting the service. An ignored `live_private_tunnel` test accepts a local autologin profile through `KEEL_VPN_SMOKE_PROFILE`, establishes a tunnel through the real service, checks HTTPS through Keel's proxy and the normal route, and cleans up its process and temporary files. Run it explicitly with `cargo test --manifest-path src-tauri/Cargo.toml live_private_tunnel --lib -- --ignored --nocapture`.

The server also intermittently returned `AUTH_FAILED,TEMP[backoff 60]:LICENSE` with a two-connection limit during reconnect testing. This is now reported as a connection-limit error instead of suggesting that saved credentials are wrong.

After adding the tunnel route, the HTTPS check exposed `WSAEWOULDBLOCK` (10035) in the proxy's upload loop. On Windows, sockets accepted from the nonblocking listener inherit its mode. The handler now explicitly restores blocking mode before reading the CONNECT header or copying traffic, so pauses between TLS packets do not abort the connection. A local socket regression test reproduces delayed header packets on a nonblocking accepted socket without requiring a VPN.

On the development machine, the final live test passed: the real service established the tunnel, Keel's connection finalization started its proxy and route monitor, an HTTPS request to `https://example.com` succeeded through that proxy, and the normal route remained selected before and after the request. Cleanup closed the test tunnel and proxy. Administrator approval recovery and cancellation were exercised through regression tests; the final live run used the already-running service.

## Sources

[^1]: OpenVPN. “[Windows Interactive Service implementation](https://github.com/OpenVPN/openvpn/blob/master/src/openvpnserv/interactive.c).” Source code, accessed 2026-09-14.
[^2]: OpenVPN GUI. “[Interactive Service client implementation](https://github.com/OpenVPN/openvpn-gui/blob/master/openvpn.c).” Source code, accessed 2026-09-14.
[^3]: Microsoft. “[Named Pipe Client](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-client).” Win32 documentation.
[^4]: Microsoft. “[WaitNamedPipeW function](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-waitnamedpipew).” Win32 API documentation.
[^5]: OpenVPN. “[OpenVPN 2.6 Manual](https://openvpn.net/community-docs/community-articles/openvpn-2-6-manual.html).” Community documentation.
[^6]: Microsoft. “[IPPROTO_IP socket options](https://learn.microsoft.com/en-us/windows/win32/winsock/ipproto-ip-socket-options).” Winsock documentation.
[^7]: Microsoft. “[StartServiceW](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-startservicew)” and “[ShellExecuteExW](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shellexecuteexw).” Win32 API documentation.
