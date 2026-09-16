# Private OpenVPN on Windows

Keel can route its own supported HTTP traffic through an OpenVPN tunnel without replacing Windows' preferred default route. This document describes the architecture, trust boundaries, and contributor constraints for that feature.

## Design goals

The VPN integration is designed to:

1. Reuse a local `.ovpn` profile without modifying the original file.
2. Prevent server-pushed routes and DNS settings from taking over the host.
3. Start OpenVPN through the privileged Windows Interactive Service when adapter changes require elevation.
4. Expose a loopback HTTP CONNECT proxy whose upstream sockets are pinned to the tunnel interface.
5. Pass proxy settings to Keel's HTTP client and newly started terminal processes.
6. Tear down Keel-owned OpenVPN processes on disconnect and normal application shutdown.

The feature is an application-routing convenience, not a host firewall or process-level kill switch. Programs that ignore the supplied proxy variables can still use the machine's normal route.

## Profile isolation

Keel writes a working copy of the selected profile to a fixed path (`keel-app.ovpn` in the user's OpenVPN config directory). The generated configuration suppresses server-pushed routing and DNS changes, removes inherited explicit routes, and adds a low-priority default route through the VPN gateway. The normal Windows default route therefore remains preferred for unpinned traffic while tunnel-pinned sockets retain a usable route.

The original profile is never rewritten by this process.

## OpenVPN Interactive Service

On Windows, non-elevated OpenVPN processes can establish the control connection but may not be able to perform privileged adapter operations. Keel therefore uses the OpenVPN Interactive Service over `\\.\pipe\openvpn\service` when available.

The service protocol sends the working directory, OpenVPN options, and standard input as NUL-terminated UTF-16 fields. Keel keeps a single pipe handle for the full request, treats `ERROR_PIPE_BUSY` as transient, bounds all waits, rejects malformed responses, and surfaces service-start failures without elevating the Keel application itself.

If the service is stopped and Windows requires administrator rights to start it, only the system service-start command is elevated. Keel and child terminals remain unelevated.

## Process ownership and shutdown

Keel identifies only OpenVPN processes associated with its generated `keel-app.ovpn` configuration or Keel VPN log path. It does not intentionally stop unrelated OpenVPN GUI or OpenVPN Connect sessions.

On Windows, the OpenVPN engine receives a named exit event so a normal disconnect can follow OpenVPN's graceful termination path. A Win32 job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` provides crash cleanup when graceful shutdown is impossible.

The app records the engine PID under its own application-data directory and uses bounded cleanup during connect, disconnect, and shutdown.

## Traffic selection

The local CONNECT proxy binds upstream IPv4 sockets to the tunnel address and sets the Windows `IP_UNICAST_IF` option to the tunnel's IPv4 interface index. DNS A queries use the same interface selection before any system-resolver fallback.

Connection finalization compares the public IPv4 observed through the proxy with the public IPv4 on the normal route. A matching result is treated as a failed isolated connection rather than a successful VPN connection.

While connected, Keel monitors the preferred normal route and the OpenVPN process. Losing either causes Keel to close its proxy and transition the VPN state out of connected mode.

## Terminal lifecycle

Proxy environment variables are captured when a child process starts. Connecting or reconnecting the VPN cannot rewrite the environment of an already-running shell or agent. New and restarted terminals receive the current proxy environment; existing terminals can be restarted from the UI when their proxy state is stale.

Keel sets the conventional HTTP proxy variables and compatibility variables required by supported agent runtimes. These variables direct cooperative clients to the local proxy; they do not enforce routing for arbitrary sockets.

## Security boundaries

- Tunnel routing currently targets IPv4 upstream connections.
- The proxy only protects traffic that actually uses it.
- A network transition can briefly change route eligibility before the monitor reacts.
- Strict process-wide isolation would require a stronger Windows mechanism such as Windows Filtering Platform policy or an equivalent network compartment.
- VPN profiles and local agent credentials are user data and must never be committed to the repository.

## Verification

The Rust test suite covers profile rewriting, service-protocol encoding and parsing, process matching, startup error handling, route helpers, and proxy behavior that can be exercised without a live VPN.

An ignored live tunnel test is also available for maintainers with a local autologin profile. It is intentionally opt-in because it depends on machine networking, OpenVPN installation, and private profile material. The normal repository check does not require VPN credentials:

```sh
pnpm check
```

## References

- [OpenVPN Windows Interactive Service implementation](https://github.com/OpenVPN/openvpn/blob/master/src/openvpnserv/interactive.c)
- [OpenVPN GUI Interactive Service client](https://github.com/OpenVPN/openvpn-gui/blob/master/openvpn.c)
- [Microsoft: Named Pipe Client](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-client)
- [Microsoft: WaitNamedPipeW](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-waitnamedpipew)
- [OpenVPN 2.6 manual](https://openvpn.net/community-docs/community-articles/openvpn-2-6-manual.html)
- [Microsoft: IPPROTO_IP socket options](https://learn.microsoft.com/en-us/windows/win32/winsock/ipproto-ip-socket-options)
- [Microsoft: StartServiceW](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-startservicew)
