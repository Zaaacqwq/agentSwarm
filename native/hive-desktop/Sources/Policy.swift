import AppKit

/// Apps an agent may never see or drive, whatever the session allows.
enum Policy {
    static let deniedBundles: Set<String> = [
        "com.apple.systempreferences", "com.apple.Settings", "com.apple.keychainaccess", "com.apple.Passwords",
        "com.apple.SecurityAgent", "com.apple.loginwindow", "com.apple.Terminal", "com.googlecode.iterm2",
        "dev.warp.Warp-Stable", "com.mitchellh.ghostty", "net.kovidgoyal.kitty", "io.alacritty",
        "com.1password.1password", "com.agilebits.onepassword7", "com.bitwarden.desktop", "com.lastpass.LastPass",
        "com.dashlane.dashlanephonefinal", "dev.hive.desktop",
    ]
    /// Browser windows showing the Hive UI itself (document titles "Hive" or "Hive · …",
    /// possibly followed by the browser's own " - Google Chrome" style suffix).
    static let hiveTitle = try! NSRegularExpression(pattern: "^Hive(?: · .*)?(?:\\s[-–—]\\s.*)?$")

    static func isHiveTitle(_ title: String?) -> Bool {
        guard let title, !title.isEmpty else { return false }
        return hiveTitle.firstMatch(in: title, range: NSRange(title.startIndex..., in: title)) != nil
    }

    static func deniedReason(bundle: String?, title: String?) -> String? {
        if let bundle, deniedBundles.contains(bundle) { return "\(bundle) is off limits to agents" }
        if isHiveTitle(title) { return "The Hive UI is off limits to agents" }
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

    /// The frontmost app and the title of its front window.
    static func frontmost() -> WindowHit? {
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        let list = (CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]]) ?? []
        let title = list.first { ($0[kCGWindowOwnerPID as String] as? pid_t) == app.processIdentifier && ($0[kCGWindowLayer as String] as? Int) == 0 }?[kCGWindowName as String] as? String
        return WindowHit(pid: app.processIdentifier, bundle: app.bundleIdentifier, name: app.localizedName ?? "", title: title)
    }
}

/// Input is only accepted while hived has armed an approved control session; expiry is enforced here too.
final class Arming {
    private let lock = NSLock()
    private var until: Date?
    private var holder = ""
    var onChange: ((Date?, String) -> Void)?

    static let maxSession: TimeInterval = 60 * 60

    func arm(until: Date, holder: String) {
        let capped = min(until, Date().addingTimeInterval(Arming.maxSession))
        lock.lock(); self.until = capped; self.holder = holder; lock.unlock()
        onChange?(capped, holder)
    }

    func disarm() {
        lock.lock(); until = nil; holder = ""; lock.unlock()
        onChange?(nil, "")
    }

    var current: (until: Date, holder: String)? {
        lock.lock(); defer { lock.unlock() }
        guard let until, until > Date() else { return nil }
        return (until, holder)
    }
}
