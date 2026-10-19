import AppKit
import SwiftUI

/// R9.0: what an app under test can do from inside the App Sandbox. Every line should say "blocked".
@main
struct ProbeApp: App {
    @State private var lines: [String] = ["running…"]
    var body: some Scene {
        WindowGroup("Probe") {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(lines, id: \.self) { Text($0).font(.system(.body, design: .monospaced)).textSelection(.enabled) }
            }
            .padding()
            .frame(minWidth: 640, minHeight: 300, alignment: .topLeading)
            .task { lines = await Probes.run() }
        }
    }
}

enum Probes {
    /// The real home, not the container (the sandbox points NSHomeDirectory at the container).
    static let home: String = {
        guard let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir else { return "/Users" }
        return String(cString: dir)
    }()
    static let marker = home + "/Library/Application Support/agentSwarm/probe-escaped"

    static func run() async -> [String] {
        var out: [String] = ["container: \(NSHomeDirectory())"]
        out.append(check("read ~/Documents") { _ = try FileManager.default.contentsOfDirectory(atPath: home + "/Documents") })
        out.append(check("read ~/Library/Keychains") { _ = try FileManager.default.contentsOfDirectory(atPath: home + "/Library/Keychains") })
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
        return out
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
            _ = try await URLSession.shared.data(from: URL(string: "https://example.com")!)
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
