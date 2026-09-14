//! Local HTTP CONNECT proxy whose outbound sockets are pinned to one interface.
//!
//! Windows routing is destination-based. A TUN that has an address but no
//! default route will not be used unless the socket is bound to it. The
//! documented way to do that without touching the routing table is
//! `IP_UNICAST_IF` (Vista+): it selects the outgoing interface by index.
//!
//! Keel does not inject a DLL into child processes (ForceBindIP does not follow
//! agent CLIs reliably). Instead every pane inherits `HTTP_PROXY`/`HTTPS_PROXY`
//! pointing at this listener, and Keel's own HTTP client uses it too. CONNECT
//! is what Node, Python and curl speak; that is the traffic the agents make.

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const HEADER_LIMIT: usize = 16 * 1024;
const DNS_TIMEOUT: Duration = Duration::from_secs(3);
const VPN_DNS: Ipv4Addr = Ipv4Addr::new(1, 1, 1, 1);

pub struct ProxyHandle {
    pub port: u16,
    running: Arc<AtomicBool>,
}

impl ProxyHandle {
    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        // Unblock accept() by connecting to ourselves.
        let _ = TcpStream::connect_timeout(
            &SocketAddr::from((Ipv4Addr::LOCALHOST, self.port)),
            Duration::from_millis(200),
        );
    }
}

/// Listen on 127.0.0.1:0 and send CONNECT destinations out `if_index`.
pub fn start(if_index: u32) -> std::io::Result<ProxyHandle> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let running = Arc::new(AtomicBool::new(true));
    let flag = Arc::clone(&running);

    thread::Builder::new()
        .name("keel-vpn-proxy".into())
        .spawn(move || accept_loop(listener, flag, if_index))
        .map_err(std::io::Error::other)?;

    Ok(ProxyHandle { port, running })
}

fn accept_loop(listener: TcpListener, running: Arc<AtomicBool>, if_index: u32) {
    while running.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                if !running.load(Ordering::SeqCst) {
                    break;
                }
                let _ = thread::Builder::new()
                    .name("keel-vpn-conn".into())
                    .spawn(move || {
                        let _ = handle_client(stream, if_index);
                    });
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(50));
            }
            Err(_) => break,
        }
    }
}

fn handle_client(mut client: TcpStream, if_index: u32) -> std::io::Result<()> {
    // Windows accepts inherit the listener's nonblocking mode. Header reads
    // and the bidirectional copy below are blocking operations; leaving that
    // flag set can abort TLS as soon as a client pauses between packets.
    client.set_nonblocking(false)?;
    client.set_read_timeout(Some(Duration::from_secs(15)))?;
    client.set_write_timeout(Some(Duration::from_secs(15)))?;
    let header = read_headers(&mut client)?;
    let Some(target) = parse_connect(&header) else {
        let _ = client.write_all(
            b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        return Ok(());
    };
    let upstream = match dial_via_interface(&target.0, target.1, if_index) {
        Ok(stream) => stream,
        Err(_) => {
            let _ = client.write_all(
                b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            return Ok(());
        }
    };
    client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")?;
    client.set_read_timeout(None)?;
    client.set_write_timeout(None)?;
    pump(client, upstream);
    Ok(())
}

fn read_headers(stream: &mut TcpStream) -> std::io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    while buf.len() < HEADER_LIMIT {
        let n = stream.read(&mut byte)?;
        if n == 0 {
            break;
        }
        buf.push(byte[0]);
        if buf.windows(4).any(|window| window == b"\r\n\r\n") {
            return Ok(buf);
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        "CONNECT header too large or incomplete",
    ))
}

/// `CONNECT host:port HTTP/1.1` → (host, port)
pub fn parse_connect(header: &[u8]) -> Option<(String, u16)> {
    let text = std::str::from_utf8(header).ok()?;
    let line = text.lines().next()?.trim();
    let mut parts = line.split_whitespace();
    if !parts.next()?.eq_ignore_ascii_case("CONNECT") {
        return None;
    }
    let authority = parts.next()?;
    split_host_port(authority)
}

fn split_host_port(authority: &str) -> Option<(String, u16)> {
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, tail) = rest.split_once(']')?;
        let port = tail.strip_prefix(':')?.parse().ok()?;
        return Some((host.to_string(), port));
    }
    let (host, port) = authority.rsplit_once(':')?;
    if host.is_empty() {
        return None;
    }
    Some((host.to_string(), port.parse().ok()?))
}

fn dial_via_interface(host: &str, port: u16, if_index: u32) -> std::io::Result<TcpStream> {
    let ip = resolve_host(host, if_index)?;
    let addr = SocketAddr::new(ip, port);
    let socket = socket2::Socket::new(
        socket2::Domain::for_address(addr),
        socket2::Type::STREAM,
        Some(socket2::Protocol::TCP),
    )?;
    pin_socket_to_interface(&socket, if_index, addr.is_ipv6())?;
    socket.connect_timeout(&addr.into(), CONNECT_TIMEOUT)?;
    Ok(socket.into())
}

fn resolve_host(host: &str, if_index: u32) -> std::io::Result<IpAddr> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(ip);
    }
    if let Ok(ip) = dns_a_via_interface(host, if_index) {
        return Ok(IpAddr::V4(ip));
    }
    // Last resort: system resolver. Prefer A so we can pin IPv4 to the TUN.
    for addr in std::net::ToSocketAddrs::to_socket_addrs(&(host, 0))? {
        if addr.is_ipv4() {
            return Ok(addr.ip());
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AddrNotAvailable,
        format!("no IPv4 address for {host}"),
    ))
}

/// DNS A lookup sent out the VPN interface, so the name query is not an ISP leak.
fn dns_a_via_interface(name: &str, if_index: u32) -> std::io::Result<Ipv4Addr> {
    let query = build_dns_query(name);
    let socket = socket2::Socket::new(
        socket2::Domain::IPV4,
        socket2::Type::DGRAM,
        Some(socket2::Protocol::UDP),
    )?;
    pin_socket_to_interface(&socket, if_index, false)?;
    let udp: UdpSocket = socket.into();
    udp.set_read_timeout(Some(DNS_TIMEOUT))?;
    udp.set_write_timeout(Some(DNS_TIMEOUT))?;
    udp.send_to(&query, SocketAddr::from((VPN_DNS, 53)))?;
    let mut buf = [0u8; 512];
    let (n, _) = udp.recv_from(&mut buf)?;
    parse_dns_a(&buf[..n]).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "DNS response had no A record",
        )
    })
}

fn build_dns_query(name: &str) -> Vec<u8> {
    let mut packet = Vec::with_capacity(64);
    packet.extend_from_slice(&[
        0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    for label in name.trim_end_matches('.').split('.') {
        let bytes = label.as_bytes();
        packet.push(bytes.len() as u8);
        packet.extend_from_slice(bytes);
    }
    packet.push(0);
    packet.extend_from_slice(&[0x00, 0x01, 0x00, 0x01]);
    packet
}

fn parse_dns_a(packet: &[u8]) -> Option<Ipv4Addr> {
    if packet.len() < 12 {
        return None;
    }
    let answers = u16::from_be_bytes([packet[6], packet[7]]) as usize;
    if answers == 0 {
        return None;
    }
    let mut i = 12usize;
    // Skip question.
    while i < packet.len() && packet[i] != 0 {
        i += 1 + packet[i] as usize;
    }
    i += 5; // zero + type + class
    for _ in 0..answers {
        if i + 12 > packet.len() {
            return None;
        }
        if packet[i] & 0xC0 == 0xC0 {
            i += 2;
        } else {
            while i < packet.len() && packet[i] != 0 {
                i += 1 + packet[i] as usize;
            }
            i += 1;
        }
        if i + 10 > packet.len() {
            return None;
        }
        let rtype = u16::from_be_bytes([packet[i], packet[i + 1]]);
        let rdlen = u16::from_be_bytes([packet[i + 8], packet[i + 9]]) as usize;
        i += 10;
        if rtype == 1 && rdlen == 4 && i + 4 <= packet.len() {
            return Some(Ipv4Addr::new(
                packet[i],
                packet[i + 1],
                packet[i + 2],
                packet[i + 3],
            ));
        }
        i += rdlen;
    }
    None
}

fn pin_socket_to_interface(
    socket: &socket2::Socket,
    if_index: u32,
    ipv6: bool,
) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawSocket;
        // IP_UNICAST_IF / IPV6_UNICAST_IF: interface index in network byte order.
        const IP_UNICAST_IF: i32 = 31;
        const IPV6_UNICAST_IF: i32 = 31;
        const IPPROTO_IP: i32 = 0;
        const IPPROTO_IPV6: i32 = 41;
        let idx = if_index.to_be();
        let level = if ipv6 { IPPROTO_IPV6 } else { IPPROTO_IP };
        let name = if ipv6 { IPV6_UNICAST_IF } else { IP_UNICAST_IF };
        let ret = unsafe {
            winapi::um::winsock2::setsockopt(
                socket.as_raw_socket() as usize,
                level,
                name,
                std::ptr::addr_of!(idx).cast(),
                std::mem::size_of_val(&idx) as i32,
            )
        };
        if ret == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (socket, if_index, ipv6);
        Ok(())
    }
}

fn pump(left: TcpStream, right: TcpStream) {
    let mut left_read = left;
    let mut right_read = right;
    let mut left_write = match left_read.try_clone() {
        Ok(stream) => stream,
        Err(_) => return,
    };
    let mut right_write = match right_read.try_clone() {
        Ok(stream) => stream,
        Err(_) => return,
    };
    let forward = thread::spawn(move || {
        let _ = std::io::copy(&mut left_read, &mut right_write);
        let _ = right_write.shutdown(Shutdown::Write);
    });
    let _ = std::io::copy(&mut right_read, &mut left_write);
    let _ = left_write.shutdown(Shutdown::Write);
    let _ = forward.join();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inherited_nonblocking_mode_does_not_abort_delayed_client_packets() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let (server, _) = listener.accept().unwrap();
        // Reproduce Windows' accepted-socket state on every test platform.
        server.set_nonblocking(true).unwrap();
        let handler = thread::spawn(move || handle_client(server, 0));
        thread::sleep(Duration::from_millis(30));
        client.write_all(b"GET / HTTP/1.1\r\n").unwrap();
        thread::sleep(Duration::from_millis(30));
        client.write_all(b"\r\n").unwrap();
        let mut reply = String::new();
        client.read_to_string(&mut reply).unwrap();
        handler.join().unwrap().unwrap();
        assert!(reply.starts_with("HTTP/1.1 400 Bad Request"));
    }

    #[test]
    fn parse_connect_host_port() {
        let header = b"CONNECT api.x.ai:443 HTTP/1.1\r\nHost: api.x.ai:443\r\n\r\n";
        assert_eq!(parse_connect(header), Some(("api.x.ai".into(), 443)));
    }

    #[test]
    fn parse_connect_ipv6() {
        let header = b"CONNECT [::1]:443 HTTP/1.1\r\n\r\n";
        assert_eq!(parse_connect(header), Some(("::1".into(), 443)));
    }

    #[test]
    fn dns_query_encodes_labels() {
        let q = build_dns_query("example.com");
        assert_eq!(q[12], 7);
        assert_eq!(&q[13..20], b"example");
        assert_eq!(q[20], 3);
        assert_eq!(&q[21..24], b"com");
        assert_eq!(q[24], 0);
    }
}
