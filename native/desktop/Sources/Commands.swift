import AppKit

/// One JSON request in, one JSON response out. Everything but status needs the token of the approved session.
final class Commands {
    let arming = Arming()
    private let ui = UITree()
    private let appsDir: String
    /// Whether the helper can tell when you use the Mac (it needs Accessibility at start).
    var watching: () -> Bool = { false }
    /// One command at a time touches the screen; status and ping never wait behind it.
    private let work = NSLock()
    /// The last look: clicks are given in its coordinates, and an element number refers to its list.
    private var lastLook: Look?

    init(appsDir: String) {
        self.appsDir = appsDir
    }

    func stopByUser() {
        quit(arming.disarm(byUser: true))
    }

    func handle(_ req: [String: Any]) -> [String: Any] {
        let cmd = req["cmd"] as? String ?? ""
        let exclusive = cmd != "status" && cmd != "ping"
        if exclusive { work.lock() }
        defer { if exclusive { work.unlock() } }
        do {
            return try run(cmd, req).merging(["ok": true]) { a, _ in a }
        } catch let e as HelperError {
            var out: [String: Any] = ["ok": false, "code": e.code, "error": e.message]
            if case .paused(let until) = e { out["pausedUntilMs"] = Int(until.timeIntervalSince1970 * 1000) }
            return out
        } catch {
            return ["ok": false, "code": "failed", "error": "\(error)"]
        }
    }

    private func run(_ cmd: String, _ req: [String: Any]) throws -> [String: Any] {
        switch cmd {
        case "ping": return [:]
        case "status": return status()
        case "request_access":
            _ = CGRequestScreenCaptureAccess()
            _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            return status()
        case "arm":
            guard let ms = req["untilMs"] as? Double, let holder = req["holder"] as? String, let session = req["session"] as? String, session.count >= 16 else {
                throw HelperError.bad("arm needs untilMs, holder and session")
            }
            try arming.arm(until: Date(timeIntervalSince1970: ms / 1000), holder: holder, session: session)
            lastLook = nil
            return status()
        case "disarm":
            quit(arming.disarm(session: req["session"] as? String))
            lastLook = nil
            return status()
        case "ack_stop":
            arming.acknowledgeStop()
            return status()
        default:
            return try control(cmd, req, session: try arming.check(req["session"] as? String))
        }
    }

    /// The commands of a session.
    private func control(_ cmd: String, _ req: [String: Any], session: (target: pid_t?, pausedUntil: Date?)) throws -> [String: Any] {
        if cmd == "open" { return try open(req) }
        guard let target = session.target else { throw HelperError.bad("No app is open yet; open it first (desktop_open)") }
        guard let app = NSRunningApplication(processIdentifier: target), !app.isTerminated else {
            throw HelperError.failed("The app under test has quit; open it again (desktop_open)")
        }
        switch cmd {
        case "look": return try look(target, req)
        case "close":
            quit(target)
            return [:]
        case "focus":
            try focus(app)
            return settle(target)
        default: break
        }
        // Input: never while you are using the Mac.
        if let until = session.pausedUntil { throw HelperError.paused(until) }
        switch cmd {
        case "click", "scroll":
            let p = try point(req, required: cmd == "click")
            if let p { try onTarget(p, target) } else { try frontmost(target) }
            if cmd == "click" { try Input.click(at: p!, button: req["button"] as? String ?? "left", count: int(req, "count") ?? 1) }
            else { try Input.scroll(dx: clamp(int(req, "dx") ?? 0), dy: clamp(int(req, "dy") ?? 0), at: p) }
        case "press":
            guard let n = int(req, "element") else { throw HelperError.bad("press needs element") }
            let el = try ui.element(n)
            if let reason = Policy.refusal(pid: UITree.pid(of: el), target: target) { throw HelperError.denied(reason) }
            if let c = UITree.center(el) { try onTarget(c, target) }
            _ = try ui.press(n)
        case "type":
            guard let text = req["text"] as? String, !text.isEmpty, text.count <= 2000 else { throw HelperError.bad("type needs 1-2000 characters of text") }
            try frontmost(target)
            try Input.type(text)
        case "key":
            guard let combo = req["combo"] as? String else { throw HelperError.bad("key needs combo") }
            if Policy.deniedCombos.contains(Policy.normalizedCombo(combo)) { throw HelperError.denied("\(combo) is off limits to agents") }
            try frontmost(target)
            try Input.key(combo)
        default:
            throw HelperError.bad("Unknown command \"\(cmd)\"")
        }
        return settle(target)
    }

    /// Opens an app swarmd staged for this session (and only from there), as a new instance started by the system.
    private func open(_ req: [String: Any]) throws -> [String: Any] {
        guard let path = req["path"] as? String, path.hasSuffix(".app") else { throw HelperError.bad("open needs the path of a .app") }
        let root = URL(fileURLWithPath: appsDir).resolvingSymlinksInPath().path + "/"
        let url = URL(fileURLWithPath: path).resolvingSymlinksInPath()
        guard url.path.hasPrefix(root), FileManager.default.fileExists(atPath: url.path) else { throw HelperError.denied("Only apps agentSwarm staged can be opened") }
        let config = NSWorkspace.OpenConfiguration()
        config.createsNewApplicationInstance = true
        config.activates = true
        config.addsToRecentItems = false
        config.promptsUserIfNeeded = false
        let opened: NSRunningApplication = try blocking {
            try await NSWorkspace.shared.openApplication(at: url, configuration: config)
        }
        let session = req["session"] as? String ?? ""
        if let previous = try arming.setTarget(opened.processIdentifier, session: session), previous != opened.processIdentifier { quit(previous) }
        lastLook = nil
        usleep(1_500_000)
        return ["pid": Int(opened.processIdentifier), "name": opened.localizedName ?? ""] .merging(settle(opened.processIdentifier)) { a, _ in a }
    }

    private func look(_ target: pid_t, _ req: [String: Any]) throws -> [String: Any] {
        let maxWidth = max(320, min(int(req, "maxWidth") ?? 1280, 2560))
        let shot = try Capture.look(pid: target, maxWidth: maxWidth, grid: req["grid"] as? Bool ?? true)
        lastLook = shot
        let text: String
        do {
            text = try ui.dump(pid: target, position: { shot.toImage($0) }, maxNodes: int(req, "maxNodes") ?? 300)
        } catch let e as HelperError {
            text = "(The interface could not be read: \(e.message))"
        }
        return ["image": shot.jpeg.base64EncodedString(), "width": shot.width, "height": shot.height, "ui": text]
            .merging(settle(target, wait: false)) { a, _ in a }
    }

    private func point(_ req: [String: Any], required: Bool) throws -> CGPoint? {
        guard let x = req["x"] as? Double, let y = req["y"] as? Double else {
            if required { throw HelperError.bad("click needs x and y") }
            return nil
        }
        guard let look = lastLook else { throw HelperError.bad("Look first (desktop_look): coordinates are in its screenshot") }
        return try look.toGlobal(x: x, y: y)
    }

    private func onTarget(_ p: CGPoint, _ target: pid_t) throws {
        if let reason = Policy.refusal(pid: Windows.at(p)?.pid, target: target) { throw HelperError.denied(reason) }
    }

    /// Typing and keys go to whatever has focus: it must be the app under test.
    private func frontmost(_ target: pid_t) throws {
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let focused = Windows.focusedPid()
        if front != target || (focused != nil && focused != target) {
            throw HelperError.denied("The app under test is not in front; bring it forward first (desktop_focus)")
        }
    }

    private func focus(_ app: NSRunningApplication) throws {
        _ = app.activate(options: [.activateAllWindows])
        let ax = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetAttributeValue(ax, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        usleep(300_000)
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else {
            throw HelperError.failed("macOS did not bring the app forward; try again")
        }
    }

    private func quit(_ pid: pid_t?) {
        guard let pid, let app = NSRunningApplication(processIdentifier: pid) else { return }
        app.terminate()
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
            if !app.isTerminated { app.forceTerminate() }
        }
    }

    /// Lets the UI react before the agent looks again, and says whether the app is still in front.
    private func settle(_ target: pid_t, wait: Bool = true) -> [String: Any] {
        if wait { usleep(250_000) }
        return ["inFront": NSWorkspace.shared.frontmostApplication?.processIdentifier == target]
    }

    func status() -> [String: Any] {
        let s = arming.state
        var armed: Any = NSNull()
        if let until = s.until {
            armed = [
                "untilMs": Int(until.timeIntervalSince1970 * 1000), "holder": s.holder,
                "app": s.target.flatMap { NSRunningApplication(processIdentifier: $0)?.localizedName } ?? NSNull(),
                "pausedUntilMs": s.pausedUntil.map { Int($0.timeIntervalSince1970 * 1000) } ?? NSNull(),
            ] as [String: Any]
        }
        return [
            "screenRecording": CGPreflightScreenCaptureAccess(),
            "accessibility": AXIsProcessTrusted(),
            "watching": watching(),
            "armed": armed,
            "stoppedByUser": arming.stoppedByUser,
            "pid": Int(ProcessInfo.processInfo.processIdentifier),
        ]
    }

    private func clamp(_ v: Int) -> Int32 { Int32(max(-5000, min(v, 5000))) }

    private func int(_ req: [String: Any], _ key: String) -> Int? { (req[key] as? NSNumber)?.intValue }
}
