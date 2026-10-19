import AppKit
import SwiftUI

/// R9.0: what an app under test can do from inside the App Sandbox. Every line should say "blocked".
@main
struct ProbeApp: App {
    var body: some Scene {
        WindowGroup("Probe") { ProbeView() }
    }
}

/// One line per check, shown as soon as it is done; "done" at the end.
struct ProbeView: View {
    @State private var lines: [String] = []
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(lines.enumerated()), id: \.offset) { Text($0.element).font(.system(.body, design: .monospaced)) }
        }
        .padding()
        .frame(minWidth: 640, minHeight: 300, alignment: .topLeading)
        .task { await Probes.run { line in lines.append(line) } }
    }
}

enum Probes {
    /// The real home, not the container (the sandbox points NSHomeDirectory at the container).
    static let home: String = {
        guard let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir else { return "/Users" }
        return String(cString: dir)
    }()
    static let marker = home + "/Library/Application Support/agentSwarm/probe-escaped"

    @MainActor
    static func run(_ add: @escaping (String) -> Void) async {
        var out = Out(add: add)
        out.append("container: \(NSHomeDirectory())")
        out.append(check("read ~/Documents") { _ = try FileManager.default.contentsOfDirectory(atPath: home + "/Documents") })
        out.append(check("read ~/Library/Keychains") { _ = try FileManager.default.contentsOfDirectory(atPath: home + "/Library/Keychains") })
        out.append(check("read the login keychain file") {
            let h = try FileHandle(forReadingFrom: URL(fileURLWithPath: home + "/Library/Keychains/login.keychain-db"))
            _ = try h.read(upToCount: 16)
        })
        for path in ["/.ssh", "/.zsh_history", "/Library/Application Support/agentSwarm", "/Library/Mail", "/Desktop", "/Library/Messages", "/.config"] {
            out.append(check("read ~\(path)") {
                var dir: ObjCBool = false
                guard FileManager.default.fileExists(atPath: home + path, isDirectory: &dir) else { throw NSError(domain: "missing", code: 0) }
                if dir.boolValue { _ = try FileManager.default.contentsOfDirectory(atPath: home + path) } else { _ = try FileHandle(forReadingFrom: URL(fileURLWithPath: home + path)).read(upToCount: 16) }
            })
        }
        out.append(check("connect to the helper socket") {
            let fd = socket(AF_UNIX, SOCK_STREAM, 0)
            defer { close(fd) }
            var addr = sockaddr_un()
            addr.sun_family = sa_family_t(AF_UNIX)
            let path = Array((home + "/Library/Application Support/agentSwarm/desktop.sock").utf8)
            withUnsafeMutableBytes(of: &addr.sun_path) { $0.copyBytes(from: path); $0[path.count] = 0 }
            let r = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
            if r != 0 { throw NSError(domain: "connect", code: Int(errno)) }
        })
        out.append("clipboard: \(NSPasteboard.general.string(forType: .string) == nil ? "nothing read" : "READ")")
        out.append(check("write ~/probe.txt") { try "x".write(toFile: home + "/probe.txt", atomically: true, encoding: .utf8) })
        out.append(check("write /tmp/probe.txt") { try "x".write(toFile: "/tmp/agentswarm-probe.txt", atomically: true, encoding: .utf8) })
        out.append(await network())
        out.append(check("run /bin/sh writing outside") {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/sh")
            p.arguments = ["-c", "echo x > '\(home)/probe-sh.txt'"]
            try p.run()
            p.waitUntilExit()
            if p.terminationStatus != 0 { throw NSError(domain: "sh", code: Int(p.terminationStatus)) }
        })
        out.append(await escapeThroughTerminal())
        out.append(check("AppleScript to Finder") {
            var error: NSDictionary?
            _ = NSAppleScript(source: "tell application \"Finder\" to get name of startup disk")?.executeAndReturnError(&error)
            if let error { throw NSError(domain: "as", code: (error[NSAppleScript.errorNumber] as? Int) ?? -1) }
        })
        out.append("done")
    }

    /// Hands each line to the view as it comes.
    struct Out {
        let add: (String) -> Void
        mutating func append(_ line: String) { add(line) }
    }

    static func check(_ what: String, _ op: () throws -> Void) -> String {
        do {
            try op()
            return "\(what): ALLOWED"
        } catch {
            return "\(what): blocked (\((error as NSError).code))"
        }
    }

    static func network() async -> String {
        do {
            var request = URLRequest(url: URL(string: "https://example.com")!)
            request.timeoutInterval = 10
            _ = try await URLSession.shared.data(for: request)
            return "network: ALLOWED"
        } catch {
            return "network: blocked (\((error as NSError).code))"
        }
    }

    /// Writes a script into the container and asks the system to open it: Terminal would run it outside the sandbox.
    static func escapeThroughTerminal() async -> String {
        let script = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("probe.command")
        do {
            try "#!/bin/sh\ntouch '\(marker)'\n".write(to: script, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        } catch {
            return "open a .command: could not write it (\((error as NSError).code))"
        }
        let opened = NSWorkspace.shared.open(script)
        try? await Task.sleep(nanoseconds: 4_000_000_000)
        return "open a .command: \(opened ? "asked" : "refused"); see whether the marker file exists"
    }
}
