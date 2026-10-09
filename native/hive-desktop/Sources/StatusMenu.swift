import AppKit

/// A menu bar item that exists only while an agent may drive the desktop, with a Stop button.
final class StatusMenu: NSObject {
    private var item: NSStatusItem?
    private let onStop: () -> Void

    init(onStop: @escaping () -> Void) {
        self.onStop = onStop
    }

    func update(until: Date?, holder: String) {
        DispatchQueue.main.async { [self] in
            guard let until else { remove(); return }
            let status = item ?? NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            item = status
            status.button?.title = "⬢ Hive"
            status.button?.toolTip = "\(holder) is controlling this Mac"
            let menu = NSMenu()
            let who = NSMenuItem(title: "\(holder) is controlling this Mac", action: nil, keyEquivalent: "")
            who.isEnabled = false
            let time = NSMenuItem(title: "Session ends at \(DateFormatter.localizedString(from: until, dateStyle: .none, timeStyle: .short))", action: nil, keyEquivalent: "")
            time.isEnabled = false
            let stop = NSMenuItem(title: "Stop agent control", action: #selector(stopClicked), keyEquivalent: "")
            stop.target = self
            menu.items = [who, time, .separator(), stop]
            status.menu = menu
            DispatchQueue.main.asyncAfter(deadline: .now() + max(0, until.timeIntervalSinceNow) + 0.5) { [weak self] in
                guard let self, let current = self.currentUntil?(), current > Date() else { self?.remove(); return }
            }
        }
    }

    var currentUntil: (() -> Date?)?

    private func remove() {
        if let item { NSStatusBar.system.removeStatusItem(item) }
        item = nil
    }

    @objc private func stopClicked() {
        onStop()
    }
}
