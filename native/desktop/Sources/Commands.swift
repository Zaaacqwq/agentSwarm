import AppKit

/// One JSON request in, one JSON response out. Everything but status needs the token of the approved session.
final class Commands {
    let arming = Arming()
    private let ui = UITree()
    private let appsDir: String
    /// Whether the helper can tell when you use the Mac (it needs Accessibility at start).
    var watching: () -> Bool = { false }
    /// One action at a time touches the screen. Session commands (arm, disarm, Stop) never wait behind it.
    private let work = NSLock()
    /// The last look: clicks are given in its coordinates, and an element number refers to its list.
    private let lookLock = NSLock()
    private var lastLook: Look?
    /// The helper ends a session at its time even if swarmd does not.
    private var lapse: DispatchWorkItem?
    /// The workstation user the app under test runs as (nil: as you, the fallback when none is given).
    private var targetUser: String?
    private let clipboard = Clipboard()
    static let wsApp = "/usr/local/libexec/agentswarm/ws-app"
    private static let sessionCommands: Set<String> = ["ping", "status", "request_access", "arm", "disarm", "ack_stop"]

    init(appsDir: String) {
        self.appsDir = appsDir
    }

    func stopByUser() {
        endSession(arming.disarm(byUser: true))
    }

    func handle(_ req: [String: Any]) -> [String: Any] {
        let cmd = req["cmd"] as? String ?? ""
        let exclusive = !Commands.sessionCommands.contains(cmd)
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
            setLook(nil)
            // What you copied stays out of the app's reach during the session; it comes back after.
            clipboard.stash()
            scheduleLapse(session: session)
            return status()
        case "disarm":
            endSession(arming.disarm(session: req["session"] as? String))
            return status()
        case "ack_stop":
            arming.acknowledgeStop()
            return status()
        default:
            let token = req["session"] as? String
            return try control(cmd, req, token: token ?? "", session: try arming.check(token))
        }
    }

    /// The commands of a session. Only `look` and `close` go on while you use the Mac.
    private func control(_ cmd: String, _ req: [String: Any], token: String, session: (target: pid_t?, pausedUntil: Date?)) throws -> [String: Any] {
        if let until = session.pausedUntil, cmd != "look", cmd != "close" { throw HelperError.paused(until) }
        if cmd == "open" { return try open(req, token: token) }
        guard let target = session.target else { throw HelperError.bad("No app is open yet; open it first (desktop_open)") }
        // It may run as a workstation user: kill(0) says whether it is there without signalling it.
        guard kill(target, 0) == 0 || errno == EPERM else {
            throw HelperError.failed("The app under test has quit; open it again (desktop_open)")
        }
        // Run before every event of an action: the session and your pause are checked again; for keys, also
        // that the app is in front (a click is checked by what is under the point instead).
        let stillOurs: () throws -> Void = { [self] in
            let now = try arming.check(token)
            if let until = now.pausedUntil { throw HelperError.paused(until) }
        }
        let inFront: () throws -> Void = { [self] in
            try stillOurs()
            try frontmost(target)
        }
        switch cmd {
        case "look": return try look(target, req)
        case "close":
            quit(target)
            return [:]
        case "focus":
            try focus(target)
        case "click":
            let p = try point(req)!
            try Input.click(at: p, button: req["button"] as? String ?? "left", count: int(req, "count") ?? 1) { try stillOurs(); try self.onTarget(p, target) }
        case "scroll":
            let p = try point(req)
            try Input.scroll(dx: clamp(int(req, "dx") ?? 0), dy: clamp(int(req, "dy") ?? 0), at: p) { if let p { try stillOurs(); try self.onTarget(p, target) } else { try inFront() } }
        case "press":
            guard let n = int(req, "element") else { throw HelperError.bad("press needs element") }
            let el = try ui.element(n)
            if let reason = Policy.refusal(pid: UITree.pid(of: el), target: target) { throw HelperError.denied(reason) }
            try stillOurs()
            if try !ui.pressAX(n) {
                guard let c = UITree.center(el) else { throw HelperError.failed("Element [\(n)] cannot be pressed and has no position") }
                try Input.click(at: c, button: "left", count: 1) { try stillOurs(); try self.onTarget(c, target) }
            }
        case "type":
            guard let text = req["text"] as? String, !text.isEmpty, text.count <= 2000 else { throw HelperError.bad("type needs 1-2000 characters of text") }
            try Input.type(text, check: inFront)
        case "key":
            guard let combo = req["combo"] as? String else { throw HelperError.bad("key needs combo") }
            if let reason = Policy.comboRefusal(combo) { throw HelperError.denied(reason) }
            try Input.key(combo, check: inFront)
        default:
            throw HelperError.bad("Unknown command \"\(cmd)\"")
        }
        return settle(target)
    }

    /**
     * Opens an app swarmd staged (and only from there). With `user` (ws-N) it runs as that workstation user through
     * ws-app: in your GUI session, but with none of your files, keychain or clipboard. Without, it is started by the
     * system as you. Either way it is not the helper's child and has none of its permissions, and an app that is not
     * in the App Sandbox is closed at once.
     */
    private func open(_ req: [String: Any], token: String) throws -> [String: Any] {
        guard let path = req["path"] as? String, path.hasSuffix(".app"), !path.contains("/../") else { throw HelperError.bad("open needs the path of a .app") }
        let root = (appsDir as NSString).standardizingPath + "/"
        guard (path as NSString).standardizingPath.hasPrefix(root) else { throw HelperError.denied("Only apps agentSwarm staged can be opened") }
        let user = req["user"] as? String
        if let user, user.range(of: "^ws-[0-9]{1,2}$", options: .regularExpression) == nil { throw HelperError.bad("user must be a workstation user") }
        let pid = try user.map { try launchAs($0, path) } ?? launchAsYou(path)
        guard Sandbox.applies(to: pid) else {
            stop(pid, user: user)
            throw HelperError.denied("The app was not running in the App Sandbox, so it was closed")
        }
        do {
            if let previous = try arming.setTarget(pid, session: token), previous != pid { quit(previous) }
        } catch {
            // The session ended while the app was starting: it does not stay open.
            stop(pid, user: user)
            throw error
        }
        targetUser = user
        setLook(nil)
        usleep(1_500_000)
        let name = NSRunningApplication(processIdentifier: pid)?.localizedName ?? (path as NSString).lastPathComponent.replacingOccurrences(of: ".app", with: "")
        return ["pid": Int(pid), "name": name].merging(settle(pid)) { a, _ in a }
    }

    private func launchAsYou(_ path: String) throws -> pid_t {
        let config = NSWorkspace.OpenConfiguration()
        config.createsNewApplicationInstance = true
        config.activates = true
        config.addsToRecentItems = false
        config.promptsUserIfNeeded = false
        let url = URL(fileURLWithPath: path)
        let opened: NSRunningApplication = try blocking(seconds: 60) {
            try await NSWorkspace.shared.openApplication(at: url, configuration: config)
        }
        return opened.processIdentifier
    }

    /// Through ws-app, which checks the path again and prints the app's pid.
    private func launchAs(_ user: String, _ path: String) throws -> pid_t {
        let out = try sudoWsApp(user, "open", path)
        guard let pid = pid_t(out.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 1 else { throw HelperError.failed("ws-app did not say which process the app is") }
        // Give it a moment to put up its window and come forward.
        for _ in 0..<30 where !Windows.onScreen().contains(where: { $0.pid == pid }) { usleep(200_000) }
        return pid
    }

    @discardableResult
    private func sudoWsApp(_ args: String...) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/sudo")
        p.arguments = ["-n", Commands.wsApp] + args
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = FileHandle.nullDevice
        try p.run()
        p.waitUntilExit()
        let text = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        guard p.terminationStatus == 0 else {
            let why = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            throw HelperError.failed("Could not start the app as \(args.first ?? "?"): \(why.trimmingCharacters(in: .whitespacesAndNewlines))")
        }
        return text
    }

    private func look(_ target: pid_t, _ req: [String: Any]) throws -> [String: Any] {
        let maxWidth = max(320, min(int(req, "maxWidth") ?? 1280, 2560))
        let shot = try Capture.look(pid: target, maxWidth: maxWidth, grid: req["grid"] as? Bool ?? true)
        setLook(shot)
        let text: String
        do {
            text = try ui.dump(pid: target, position: { shot.toImage($0) }, maxNodes: int(req, "maxNodes") ?? 300)
        } catch let e as HelperError {
            text = "(The interface could not be read: \(e.message))"
        }
        return ["image": shot.jpeg.base64EncodedString(), "width": shot.width, "height": shot.height, "ui": text]
            .merging(settle(target, wait: false)) { a, _ in a }
    }

    private func setLook(_ look: Look?) {
        lookLock.lock(); lastLook = look; lookLock.unlock()
    }

    private func point(_ req: [String: Any]) throws -> CGPoint? {
        guard let x = req["x"] as? Double, let y = req["y"] as? Double else {
            if req["cmd"] as? String == "click" { throw HelperError.bad("click needs x and y") }
            return nil
        }
        lookLock.lock()
        let look = lastLook
        lookLock.unlock()
        guard let look else { throw HelperError.bad("Look first (desktop_look): coordinates are in its screenshot") }
        return try look.toGlobal(x: x, y: y)
    }

    /// The point is on the app under test, both by its windows and by what Accessibility finds there: a window
    /// that lets clicks through to another app is not enough.
    private func onTarget(_ p: CGPoint, _ target: pid_t) throws {
        if let reason = Policy.refusal(pid: Windows.at(p)?.pid, target: target) { throw HelperError.denied(reason) }
        if let reason = Policy.refusal(pid: Windows.axPid(at: p), target: target) { throw HelperError.denied(reason) }
    }

    /// Typing and keys go to whatever has focus: it must be the app under test (unknown focus counts as not).
    private func frontmost(_ target: pid_t) throws {
        guard isFront(target), Windows.focusedPid() == target else {
            throw HelperError.denied("The app under test is not in front; bring it forward first (desktop_focus)")
        }
    }

    /// In front: the frontmost app, or (for another user's app, which NSWorkspace may not report) the owner of the topmost window.
    private func isFront(_ target: pid_t) -> Bool {
        if let front = NSWorkspace.shared.frontmostApplication?.processIdentifier, front == target { return true }
        return Windows.topmostAppWindow()?.pid == target
    }

    private func focus(_ target: pid_t) throws {
        _ = NSRunningApplication(processIdentifier: target)?.activate(options: [.activateAllWindows])
        AXUIElementSetAttributeValue(AXUIElementCreateApplication(target), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        usleep(300_000)
        guard isFront(target) else { throw HelperError.failed("macOS did not bring the app forward; try again") }
    }

    /// At the session's end the helper closes the app itself, whether or not swarmd says so.
    private func scheduleLapse(session: String) {
        lapse?.cancel()
        guard let until = arming.state.until else { return }
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.endSession(self.arming.disarm(session: session))
        }
        lapse = item
        DispatchQueue.global().asyncAfter(deadline: .now() + max(0, until.timeIntervalSinceNow) + 0.5, execute: item)
    }

    private func endSession(_ app: pid_t?) {
        setLook(nil)
        quit(app)
        clipboard.restore()
    }

    private func quit(_ pid: pid_t?) {
        guard let pid else { return }
        stop(pid, user: targetUser)
        targetUser = nil
    }

    /// Yours: terminate (then force). A workstation user's: ws-app stops it (the helper may not signal it).
    private func stop(_ pid: pid_t, user: String?) {
        if let user {
            do { try sudoWsApp(user, "stop", String(pid)) } catch { log("could not stop the app: \(error)") }
            return
        }
        guard let app = NSRunningApplication(processIdentifier: pid) else { return }
        app.terminate()
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
            if !app.isTerminated { app.forceTerminate() }
        }
    }

    /// Lets the UI react before the agent looks again, and says whether the app is still in front.
    private func settle(_ target: pid_t, wait: Bool = true) -> [String: Any] {
        if wait { usleep(250_000) }
        return ["inFront": isFront(target)]
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
