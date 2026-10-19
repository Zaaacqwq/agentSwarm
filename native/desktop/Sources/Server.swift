import Foundation

/// Line-delimited JSON over a Unix socket (mode 0600, same-user peers only), one request per connection.
final class Server {
    private let path: String
    private let handler: ([String: Any]) -> [String: Any]
    private let queue = DispatchQueue(label: "dev.agentswarm.desktop.connections", attributes: .concurrent)

    init(path: String, handler: @escaping ([String: Any]) -> [String: Any]) {
        self.path = path
        self.handler = handler
    }

    func run() {
        while true {
            let fd = listenSocket()
            if fd >= 0 {
                acceptLoop(fd)
                close(fd)
            }
            // The data volume may not be mounted yet, or the socket was removed: retry.
            sleep(5)
        }
    }

    private func listenSocket() -> Int32 {
        let bytes = Array(path.utf8)
        var addr = sockaddr_un()
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else {
            log("socket path too long: \(path)"); return -1
        }
        guard FileManager.default.fileExists(atPath: (path as NSString).deletingLastPathComponent) else { return -1 }
        addr.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &addr.sun_path) { buf in
            buf.copyBytes(from: bytes)
            buf[bytes.count] = 0
        }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return -1 }
        unlink(path)
        let old = umask(0o177)
        let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        umask(old)
        guard bound == 0, chmod(path, 0o600) == 0, listen(fd, 8) == 0 else {
            log("cannot listen on \(path): \(String(cString: strerror(errno)))")
            close(fd)
            return -1
        }
        log("listening on \(path)")
        return fd
    }

    private func acceptLoop(_ fd: Int32) {
        while true {
            let c = accept(fd, nil, nil)
            if c < 0 {
                if errno == EINTR { continue }
                return
            }
            // Each connection on its own thread: a stuck client never blocks the next request.
            queue.async { [self] in
                serve(c)
                close(c)
            }
            if !FileManager.default.fileExists(atPath: path) { return }
        }
    }

    private func serve(_ c: Int32) {
        var uid: uid_t = 0, gid: gid_t = 0
        guard getpeereid(c, &uid, &gid) == 0, uid == getuid() else { return }
        var timeout = timeval(tv_sec: 10, tv_usec: 0)
        setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        var data = Data()
        var buf = [UInt8](repeating: 0, count: 65536)
        while data.count < 1 << 20 {
            let n = read(c, &buf, buf.count)
            if n <= 0 { break }
            data.append(contentsOf: buf[0..<n])
            if buf[0..<n].contains(10) { break }
        }
        guard let nl = data.firstIndex(of: 10) else { return }
        let line = data[data.startIndex..<nl]
        let response: [String: Any]
        if let req = try? JSONSerialization.jsonObject(with: line) as? [String: Any] {
            response = handler(req)
        } else {
            response = ["ok": false, "code": "bad_request", "error": "Malformed request"]
        }
        guard var out = try? JSONSerialization.data(withJSONObject: response) else { return }
        out.append(10)
        out.withUnsafeBytes { raw in
            var sent = 0
            while sent < raw.count {
                let n = write(c, raw.baseAddress!.advanced(by: sent), raw.count - sent)
                if n <= 0 { return }
                sent += n
            }
        }
    }
}

func log(_ message: String) {
    FileHandle.standardError.write("[\(ISO8601DateFormatter().string(from: Date()))] \(message)\n".data(using: .utf8)!)
}
