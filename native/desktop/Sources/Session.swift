import AppKit

/// The approved session: until when, for whom, its token, the app under test, and whether the person is using the Mac.
struct SessionState {
    let until: Date?
    let holder: String
    let target: pid_t?
    let pausedUntil: Date?
}

/**
 * Input is only accepted during a session swarmd armed after you approved it; its end is enforced here too.
 * Your Stop latches until swarmd confirms it ended the session, so an agent cannot simply start again.
 * While you use the Mac yourself, the agent's input pauses.
 */
final class Arming {
    private let lock = NSLock()
    private var until: Date?
    private var holder = ""
    private var session = ""
    private var target: pid_t?
    private var pausedUntil: Date?
    private var stopped = false
    var onChange: ((SessionState) -> Void)?

    static let maxSession: TimeInterval = 30 * 60
    static let pause: TimeInterval = 30

    func arm(until: Date, holder: String, session: String) throws {
        let capped = min(until, Date().addingTimeInterval(Arming.maxSession))
        lock.lock()
        if stopped { lock.unlock(); throw HelperError.denied("You stopped desktop control; it must be approved again") }
        self.until = capped; self.holder = holder; self.session = session; target = nil; pausedUntil = nil
        lock.unlock()
        changed()
    }

    /// Ends the session if `session` is nil or still the armed one (a late disarm never ends a newer session). Returns the app to close.
    @discardableResult
    func disarm(session: String? = nil, byUser: Bool = false) -> pid_t? {
        lock.lock()
        if let session, session != self.session { lock.unlock(); return nil }
        let app = target
        until = nil; holder = ""; self.session = ""; target = nil; pausedUntil = nil
        if byUser { stopped = true }
        lock.unlock()
        changed()
        return app
    }

    func acknowledgeStop() {
        lock.lock(); stopped = false; lock.unlock()
    }

    func setTarget(_ pid: pid_t, session: String) throws -> pid_t? {
        lock.lock()
        guard live, session == self.session else { lock.unlock(); throw HelperError.denied("No approved desktop session is active") }
        let previous = target
        target = pid
        lock.unlock()
        changed()
        return previous
    }

    /// You touched the mouse or keyboard during a session: the agent waits until you have been idle for a while.
    func personActive() {
        lock.lock()
        guard live else { lock.unlock(); return }
        let wasPaused = pausedUntil.map { $0 > Date() } ?? false
        pausedUntil = Date().addingTimeInterval(Arming.pause)
        lock.unlock()
        if !wasPaused { changed() }
    }

    /// The session for this token, or why there is none.
    func check(_ token: String?) throws -> (target: pid_t?, pausedUntil: Date?) {
        lock.lock(); defer { lock.unlock() }
        guard live, let token, !token.isEmpty, token == session else { throw HelperError.denied("No approved desktop session is active") }
        return (target, pausedUntil.flatMap { $0 > Date() ? $0 : nil })
    }

    var stoppedByUser: Bool {
        lock.lock(); defer { lock.unlock() }
        return stopped
    }

    var state: SessionState {
        lock.lock(); defer { lock.unlock() }
        guard live else { return SessionState(until: nil, holder: "", target: nil, pausedUntil: nil) }
        return SessionState(until: until, holder: holder, target: target, pausedUntil: pausedUntil.flatMap { $0 > Date() ? $0 : nil })
    }

    /// Callers hold the lock.
    private var live: Bool {
        guard let until else { return false }
        return until > Date()
    }

    private func changed() {
        onChange?(state)
    }
}
