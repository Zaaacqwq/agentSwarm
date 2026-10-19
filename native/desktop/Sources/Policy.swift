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

    /// Shortcuts that open launchers, switch apps or end the session.
    static let deniedCombos: Set<String> = [
        "cmd+space", "cmd+alt+space", "ctrl+space", "cmd+alt+escape", "cmd+shift+q", "cmd+alt+shift+q", "ctrl+cmd+q",
        "cmd+tab", "cmd+shift+tab", "cmd+`", "ctrl+up", "ctrl+down", "ctrl+left", "ctrl+right", "cmd+h", "cmd+alt+h", "cmd+m",
    ]

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

    /// The app that has keyboard focus (a Spotlight panel can have it while another app is frontmost).
    static func focusedPid() -> pid_t? {
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 1.0)
        guard let app = UITree.element(system, kAXFocusedApplicationAttribute) else { return nil }
        return UITree.pid(of: app)
    }
}
