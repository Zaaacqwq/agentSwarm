import AppKit

/// Apps an agent may never see or drive, whatever the session allows.
enum Policy {
    static let deniedBundles: Set<String> = [
        "com.apple.systempreferences", "com.apple.Settings", "com.apple.keychainaccess", "com.apple.Passwords",
        "com.apple.SecurityAgent", "com.apple.loginwindow", "com.apple.Terminal", "com.googlecode.iterm2",
        "dev.warp.Warp-Stable", "com.mitchellh.ghostty", "net.kovidgoyal.kitty", "io.alacritty",
        "com.1password.1password", "com.agilebits.onepassword7", "com.bitwarden.desktop", "com.lastpass.LastPass",
        "com.dashlane.dashlanephonefinal", "dev.hive.desktop",
        // Anything that runs scripts or controls the system would sidestep the Terminal ban.
        "com.apple.ScriptEditor2", "com.apple.Automator", "com.apple.shortcuts", "com.apple.ActivityMonitor",
        "com.apple.Console", "com.apple.DiskUtility", "com.apple.installer", "com.apple.DirectoryUtility",
        "com.apple.Spotlight", "com.raycast.macos", "com.runningwithcrayons.Alfred", "com.apple.systemevents",
    ]

    /// Shortcuts that open launchers or end the session.
    static let deniedCombos: Set<String> = ["cmd+space", "cmd+alt+space", "ctrl+space", "cmd+alt+escape", "cmd+shift+q", "cmd+alt+shift+q", "ctrl+cmd+q"]

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
    /// Browser windows showing the Hive UI itself (document titles "Hive" or "Hive · …",
    /// possibly followed by the browser's own " - Google Chrome" style suffix).
    static let hiveTitle = try! NSRegularExpression(pattern: "^Hive(?: · .*)?(?:\\s[-–—]\\s.*)?$")

    static func isHiveTitle(_ title: String?) -> Bool {
        guard let title, !title.isEmpty else { return false }
        return hiveTitle.firstMatch(in: title, range: NSRange(title.startIndex..., in: title)) != nil
    }

    static func deniedReason(bundle: String?, title: String?, url: String? = nil) -> String? {
        if let bundle, deniedBundles.contains(bundle) { return "\(bundle) is off limits to agents" }
        if isHiveTitle(title) { return "The Hive UI is off limits to agents" }
        if let url, let host = URL(string: url)?.host?.lowercased(),
           host == "localhost" || host == "127.0.0.1" || host == "::1" || host.hasSuffix(".localhost") {
            return "Local web apps (including the Hive UI) are off limits to agents"
        }
        return nil
    }
}

struct WindowHit {
    let pid: pid_t
    let bundle: String?
    let name: String
    let title: String?
}

enum Windows {
    /// Topmost on-screen window containing a global point (top-left origin), skipping our own.
    static func at(_ point: CGPoint) -> WindowHit? {
        let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return nil }
        let me = ProcessInfo.processInfo.processIdentifier
        for info in list {
            guard let pid = info[kCGWindowOwnerPID as String] as? pid_t, pid != me,
                  let alpha = info[kCGWindowAlpha as String] as? Double, alpha > 0,
                  let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDict), bounds.contains(point) else { continue }
            let app = NSRunningApplication(processIdentifier: pid)
            return WindowHit(pid: pid, bundle: app?.bundleIdentifier, name: (info[kCGWindowOwnerName as String] as? String) ?? "",
                             title: info[kCGWindowName as String] as? String)
        }
        return nil
    }

    /// The app that actually has keyboard focus (a Spotlight panel can have it while another app is frontmost).
    static func focusedApp() -> (bundle: String?, url: String?) {
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 1.0)
        guard let app = UITree.element(system, kAXFocusedApplicationAttribute), let pid = UITree.pid(of: app) else { return (nil, nil) }
        let window = UITree.element(app, kAXFocusedWindowAttribute)
        let url = window.flatMap { UITree.string($0, kAXDocumentAttribute) }
        return (NSRunningApplication(processIdentifier: pid)?.bundleIdentifier, url)
    }

    /// The frontmost app and the title of its front window.
    static func frontmost() -> WindowHit? {
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        let list = (CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]]) ?? []
        let title = list.first { ($0[kCGWindowOwnerPID as String] as? pid_t) == app.processIdentifier && ($0[kCGWindowLayer as String] as? Int) == 0 }?[kCGWindowName as String] as? String
        return WindowHit(pid: app.processIdentifier, bundle: app.bundleIdentifier, name: app.localizedName ?? "", title: title)
    }
}

/**
 * Input is only accepted while hived has armed an approved control session; expiry is enforced here
 * too. A person's Stop latches until hived confirms it revoked the approval, so an agent cannot
 * simply re-arm the session it was just stopped from.
 */
final class Arming {
    private let lock = NSLock()
    private var until: Date?
    private var holder = ""
    private var session = ""
    private var stopped = false
    var onChange: ((Date?, String) -> Void)?

    static let maxSession: TimeInterval = 60 * 60

    func arm(until: Date, holder: String, session: String) throws {
        let capped = min(until, Date().addingTimeInterval(Arming.maxSession))
        lock.lock()
        if stopped { lock.unlock(); throw HelperError.denied("A person stopped desktop control; it must be approved again") }
        self.until = capped; self.holder = holder; self.session = session
        lock.unlock()
        onChange?(capped, holder)
    }

    /// Disarms if `session` is nil or still the armed one (a late disarm never ends a newer session).
    @discardableResult
    func disarm(session: String? = nil, byUser: Bool = false) -> Bool {
        lock.lock()
        if let session, session != self.session { lock.unlock(); return false }
        until = nil; holder = ""; self.session = ""
        if byUser { stopped = true }
        lock.unlock()
        onChange?(nil, "")
        return true
    }

    func acknowledgeStop() {
        lock.lock(); stopped = false; lock.unlock()
    }

    var stoppedByUser: Bool {
        lock.lock(); defer { lock.unlock() }
        return stopped
    }

    var current: (until: Date, holder: String, session: String)? {
        lock.lock(); defer { lock.unlock() }
        guard let until, until > Date() else { return nil }
        return (until, holder, session)
    }
}
