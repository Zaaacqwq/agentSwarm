import AppKit

/// One JSON request in, one JSON response out. Input and UI reading need an armed session.
final class Commands {
    let arming = Arming()
    let ui = UITree()
    /// One command at a time touches the screen; status and ping never wait behind it.
    private let work = NSLock()

    func stopByUser() {
        arming.disarm(byUser: true)
    }

    func handle(_ req: [String: Any]) -> [String: Any] {
        let cmd = req["cmd"] as? String ?? ""
        let exclusive = cmd != "status" && cmd != "ping"
        if exclusive { work.lock() }
        defer { if exclusive { work.unlock() } }
        do {
            return try run(req).merging(["ok": true]) { a, _ in a }
        } catch let e as HelperError {
            return ["ok": false, "code": e.code, "error": e.message]
        } catch {
            return ["ok": false, "code": "failed", "error": "\(error)"]
        }
    }

    private func run(_ req: [String: Any]) throws -> [String: Any] {
        let cmd = req["cmd"] as? String ?? ""
        let maxWidth = max(320, min(int(req, "maxWidth") ?? 1280, 2560))
        switch cmd {
        case "ping":
            return [:]
        case "status":
            return status()
        case "request_access":
            _ = CGRequestScreenCaptureAccess()
            _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            return status()
        case "arm":
            guard let ms = req["untilMs"] as? Double, let holder = req["holder"] as? String, let session = req["session"] as? String, !session.isEmpty else {
                throw HelperError.bad("arm needs untilMs, holder and session")
            }
            try arming.arm(until: Date(timeIntervalSince1970: ms / 1000), holder: holder, session: session)
            return status()
        case "disarm":
            arming.disarm(session: req["session"] as? String)
            return status()
        case "ack_stop":
            arming.acknowledgeStop()
            return status()
        case "screenshot":
            let shot = try Capture.screenshot(display: int(req, "display") ?? 0, maxWidth: maxWidth, grid: req["grid"] as? Bool ?? true)
            return ["image": shot.jpeg.base64EncodedString(), "width": shot.width, "height": shot.height, "display": shot.display, "frontmost": frontmost()]
        case "click", "move", "scroll":
            try requireArmed()
            let d = try Displays.get(int(req, "display") ?? 0)
            guard let x = req["x"] as? Double, let y = req["y"] as? Double else {
                if cmd == "scroll" { return try scroll(req, at: nil) }
                throw HelperError.bad("\(cmd) needs x and y")
            }
            let p = try Displays.toGlobal(d, x: x, y: y, maxWidth: maxWidth)
            try checkPoint(p)
            switch cmd {
            case "click": try Input.click(at: p, button: req["button"] as? String ?? "left", count: int(req, "count") ?? 1)
            case "move": try Input.move(to: p)
            default: return try scroll(req, at: p)
            }
            return settle()
        case "type":
            try requireArmed()
            guard let text = req["text"] as? String, !text.isEmpty, text.count <= 2000 else { throw HelperError.bad("type needs 1-2000 characters of text") }
            try checkFrontmost()
            try Input.type(text)
            return settle()
        case "key":
            try requireArmed()
            guard let combo = req["combo"] as? String else { throw HelperError.bad("key needs combo") }
            if Policy.deniedCombos.contains(Policy.normalizedCombo(combo)) { throw HelperError.denied("\(combo) is off limits to agents") }
            try checkFrontmost()
            try Input.key(combo)
            return settle()
        case "ui":
            try requireArmed()
            let target = try app(named: req["app"] as? String)
            if let reason = Policy.deniedReason(bundle: target.bundleIdentifier, title: nil) { throw HelperError.denied(reason) }
            if req["app"] == nil { try checkFrontmost() }
            let text = try ui.dump(pid: target.processIdentifier, maxWidth: maxWidth, maxNodes: int(req, "maxNodes") ?? 300)
            return ["text": text, "app": target.localizedName ?? "", "bundleId": target.bundleIdentifier ?? ""]
        case "press":
            try requireArmed()
            guard let n = int(req, "element") else { throw HelperError.bad("press needs element") }
            let el = try ui.element(n)
            let bundle = UITree.pid(of: el).flatMap { NSRunningApplication(processIdentifier: $0)?.bundleIdentifier }
            if let reason = Policy.deniedReason(bundle: bundle, title: nil) { throw HelperError.denied(reason) }
            if let c = UITree.center(el) { try checkPoint(c) }
            _ = try ui.press(n)
            return settle()
        default:
            throw HelperError.bad("Unknown command \"\(cmd)\"")
        }
    }

    private func scroll(_ req: [String: Any], at p: CGPoint?) throws -> [String: Any] {
        if p == nil { try checkFrontmost() }
        let dx = Int32(max(-5000, min(int(req, "dx") ?? 0, 5000)))
        let dy = Int32(max(-5000, min(int(req, "dy") ?? 0, 5000)))
        try Input.scroll(dx: dx, dy: dy, at: p)
        return settle()
    }

    private func requireArmed() throws {
        guard arming.current != nil else { throw HelperError.denied("No approved desktop control session is active") }
    }

    private func checkFrontmost() throws {
        if let front = Windows.frontmost(), let reason = Policy.deniedReason(bundle: front.bundle, title: front.title) { throw HelperError.denied(reason) }
        let focused = Windows.focusedApp()
        if let reason = Policy.deniedReason(bundle: focused.bundle, title: nil, url: focused.url) { throw HelperError.denied(reason) }
    }

    private func checkPoint(_ p: CGPoint) throws {
        try checkFrontmost()
        if let hit = Windows.at(p), let reason = Policy.deniedReason(bundle: hit.bundle, title: hit.title) { throw HelperError.denied(reason) }
    }

    private func app(named name: String?) throws -> NSRunningApplication {
        guard let name, !name.isEmpty else {
            guard let front = NSWorkspace.shared.frontmostApplication else { throw HelperError.failed("No frontmost app") }
            return front
        }
        let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
        if let a = apps.first(where: { $0.bundleIdentifier == name || $0.localizedName?.caseInsensitiveCompare(name) == .orderedSame }) { return a }
        throw HelperError.bad("No running app \"\(name)\"")
    }

    /// Lets the UI react before the agent looks again.
    private func settle() -> [String: Any] {
        usleep(250_000)
        return ["frontmost": frontmost()]
    }

    private func frontmost() -> [String: Any] {
        guard let f = Windows.frontmost() else { return [:] }
        let hidden = Policy.deniedReason(bundle: f.bundle, title: f.title) != nil
        return ["app": f.name, "bundleId": f.bundle ?? "", "title": hidden ? "" : (f.title ?? "")]
    }

    func status() -> [String: Any] {
        let armed: Any = arming.current.map { ["untilMs": Int($0.until.timeIntervalSince1970 * 1000), "holder": $0.holder, "session": $0.session] } ?? NSNull()
        return [
            "screenRecording": CGPreflightScreenCaptureAccess(),
            "accessibility": AXIsProcessTrusted(),
            "armed": armed,
            "stoppedByUser": arming.stoppedByUser,
            "displays": Displays.all().map { d -> [String: Any] in
                let (w, h) = Displays.imageSize(d, maxWidth: 1280)
                return ["index": d.index, "width": Int(d.bounds.width), "height": Int(d.bounds.height), "main": d.main, "imageWidth": w, "imageHeight": h]
            },
            "frontmost": frontmost(),
            "pid": Int(ProcessInfo.processInfo.processIdentifier),
        ]
    }

    private func int(_ req: [String: Any], _ key: String) -> Int? { (req[key] as? NSNumber)?.intValue }
}
