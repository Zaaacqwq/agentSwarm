import AppKit

/**
 * Notices you using the Mac during a session: any mouse or keyboard event without our mark. The tap only
 * listens; events pass through unchanged. It needs Accessibility, like the input it guards.
 */
final class PersonWatcher {
    private let arming: Arming
    private var tap: CFMachPort?
    private(set) var active = false

    init(arming: Arming) {
        self.arming = arming
    }

    func start() {
        let types: [CGEventType] = [.mouseMoved, .leftMouseDown, .rightMouseDown, .otherMouseDown, .leftMouseDragged, .scrollWheel, .keyDown, .flagsChanged]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }
        let me = Unmanaged.passUnretained(self).toOpaque()
        guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask, callback: { _, type, event, refcon in
            guard let refcon else { return Unmanaged.passUnretained(event) }
            let watcher = Unmanaged<PersonWatcher>.fromOpaque(refcon).takeUnretainedValue()
            watcher.seen(type, event)
            return Unmanaged.passUnretained(event)
        }, userInfo: me) else {
            log("cannot watch for your input: grant Accessibility, then restart the helper")
            return
        }
        self.tap = tap
        CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, tap, 0), .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        active = true
    }

    private func seen(_ type: CGEventType, _ event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return
        }
        if event.getIntegerValueField(.eventSourceUserData) == Input.mark { return }
        arming.personActive()
    }
}
