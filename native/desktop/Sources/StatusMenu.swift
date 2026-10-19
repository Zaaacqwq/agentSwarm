import AppKit

/// A menu bar item that exists only during a session, with a Stop button.
final class StatusMenu: NSObject {
    private var item: NSStatusItem?
    private var expiry: DispatchWorkItem?
    private let onStop: () -> Void

    init(onStop: @escaping () -> Void) {
        self.onStop = onStop
    }

    func update(_ state: SessionState) {
        DispatchQueue.main.async { [self] in
            expiry?.cancel()
            guard let until = state.until else { remove(); return }
            let status = item ?? NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            item = status
            let paused = state.pausedUntil != nil
            status.button?.title = paused ? "⬢ agentSwarm (paused)" : "⬢ agentSwarm"
            status.button?.toolTip = "\(state.holder) is testing an app on this Mac"
            let ends = DateFormatter.localizedString(from: until, dateStyle: .none, timeStyle: .short)
            let lines = [
                "\(state.holder) is testing an app on this Mac",
                paused ? "Paused while you use the Mac" : "Session ends at \(ends)",
            ]
            let menu = NSMenu()
            for line in lines {
                let entry = NSMenuItem(title: line, action: nil, keyEquivalent: "")
                entry.isEnabled = false
                menu.addItem(entry)
            }
            menu.addItem(.separator())
            let stop = NSMenuItem(title: "Stop agent control", action: #selector(stopClicked), keyEquivalent: "")
            stop.target = self
            menu.addItem(stop)
            status.menu = menu
            // The session can lapse without a further change: take the item down at its end.
            let lapse = DispatchWorkItem { [weak self] in self?.remove() }
            expiry = lapse
            DispatchQueue.main.asyncAfter(deadline: .now() + max(0, until.timeIntervalSinceNow) + 0.5, execute: lapse)
        }
    }

    private func remove() {
        if let item { NSStatusBar.system.removeStatusItem(item) }
        item = nil
    }

    @objc private func stopClicked() {
        onStop()
    }
}
