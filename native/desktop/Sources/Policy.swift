import AppKit

/// What an agent may touch: only the app under test. The list of apps that are never allowed stays as a backstop.
enum Policy {
    static let deniedBundles: Set<String> = [
        "com.apple.systempreferences", "com.apple.Settings", "com.apple.keychainaccess", "com.apple.Passwords",
        "com.apple.SecurityAgent", "com.apple.loginwindow", "com.apple.Terminal", "com.googlecode.iterm2",
        "dev.warp.Warp-Stable", "com.mitchellh.ghostty", "net.kovidgoyal.kitty", "io.alacritty",
        "com.1password.1password", "com.agilebits.onepassword7", "com.bitwarden.desktop", "com.lastpass.LastPass",
        "com.dashlane.dashlanephonefinal", "dev.agentswarm.desktop",
        // Anything that runs scripts or controls the system would sidestep the Terminal ban.
        "com.apple.ScriptEditor2", "com.apple.Automator", "com.apple.shortcuts", "com.apple.ActivityMonitor",
        "com.apple.Console", "com.apple.DiskUtility", "com.apple.installer", "com.apple.DirectoryUtility",
        "com.apple.Spotlight", "com.raycast.macos", "com.runningwithcrayons.Alfred", "com.apple.systemevents",
    ]

    /// Keys used for editing; with Option they move by words.
    static let editingKeys: Set<String> = [
        "return", "enter", "tab", "space", "delete", "backspace", "escape", "forwarddelete",
        "home", "end", "pageup", "pagedown", "left", "right", "up", "down",
    ]

    /**
     * Why a key combination is refused, or nil. An allowlist: typing and editing keys, Option for words, and
     * Command shortcuts inside the app. Never Control, Fn or function keys, Command with Option, launchers,
     * app or window switching, hiding, screenshots or logging out: they reach the system, not the app.
     */
    static func comboRefusal(_ combo: String) -> String? {
        let parts = normalizedCombo(combo).split(separator: "+").map(String.init)
        guard let key = parts.last else { return "No key" }
        let mods = Set(parts.dropLast())
        let refused = "\(combo) is not allowed: only typing, editing keys and the app's own Command shortcuts"
        let functionKey = key.count > 1 && key.hasPrefix("f") && Int(key.dropFirst()) != nil
        if functionKey || mods.contains("ctrl") || mods.contains("fn") { return refused }
        if mods.isSubset(of: ["shift"]) { return nil }
        if mods.isSubset(of: ["alt", "shift"]) { return key == "space" ? refused : nil }
        guard mods.contains("cmd"), mods.isSubset(of: ["cmd", "shift"]) else { return refused }
        if ["space", "tab", "`", "h", "m", "escape"].contains(key) { return refused }
        if mods.contains("shift") && (key == "q" || (key.count == 1 && key.first!.isNumber)) { return refused }
        return nil
    }

    static func normalizedCombo(_ combo: String) -> String {
        let order = ["ctrl", "cmd", "alt", "shift", "fn"]
        let alias = ["control": "ctrl", "command": "cmd", "meta": "cmd", "option": "alt", "opt": "alt", "esc": "escape"]
        let parts = combo.lowercased().split(separator: "+").map { p -> String in
            let t = p.trimmingCharacters(in: .whitespaces)
            return alias[t] ?? t
        }
        let mods = order.filter { parts.contains($0) }
        let keys = parts.filter { !order.contains($0) }
        return (mods + keys).joined(separator: "+")
    }

    /// Why a process may not be touched, or nil when it is the app under test.
    static func refusal(pid: pid_t?, target: pid_t) -> String? {
        guard let pid else { return "Nothing is there" }
        if pid == target { return nil }
        let bundle = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
        if let bundle, deniedBundles.contains(bundle) { return "\(bundle) is off limits to agents" }
        let name = NSRunningApplication(processIdentifier: pid)?.localizedName ?? "another app"
        return "That is \(name), not the app under test: only the app under test can be used"
    }
}

struct WindowHit {
    let pid: pid_t
    let bounds: CGRect
}

enum Windows {
    /// Topmost on-screen window containing a global point (top-left origin), skipping our own.
    static func at(_ point: CGPoint) -> WindowHit? {
        let me = ProcessInfo.processInfo.processIdentifier
        for w in onScreen() where w.pid != me && w.bounds.contains(point) { return w }
        return nil
    }

    /// On-screen windows front to back.
    static func onScreen() -> [WindowHit] {
        let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return [] }
        return list.compactMap { info in
            guard let pid = info[kCGWindowOwnerPID as String] as? pid_t,
                  let alpha = info[kCGWindowAlpha as String] as? Double, alpha > 0,
                  let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDict) else { return nil }
            return WindowHit(pid: pid, bounds: bounds)
        }
    }

    /// The process whose element is at a point, as Accessibility sees it: windows that let clicks through are not it.
    static func axPid(at p: CGPoint) -> pid_t? {
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 1.0)
        var element: AXUIElement?
        guard AXUIElementCopyElementAtPosition(system, Float(p.x), Float(p.y), &element) == .success, let element else { return nil }
        return UITree.pid(of: element)
    }

    /// The app that has keyboard focus (a Spotlight panel can have it while another app is frontmost).
    static func focusedPid() -> pid_t? {
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 1.0)
        guard let app = UITree.element(system, kAXFocusedApplicationAttribute) else { return nil }
        return UITree.pid(of: app)
    }
}

/// Whether a process runs in a sandbox (sandbox_check from libsystem_sandbox). Unknown counts as not.
enum Sandbox {
    private typealias Check = @convention(c) (pid_t, UnsafePointer<CChar>?, Int32) -> Int32
    private static let check: Check? = {
        guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "sandbox_check") else { return nil }
        return unsafeBitCast(sym, to: Check.self)
    }()

    static func applies(to pid: pid_t) -> Bool {
        guard let check else { return false }
        return check(pid, nil, 0) == 1
    }
}
