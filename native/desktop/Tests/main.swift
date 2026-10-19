import Foundation

// The helper's rules without a screen: run by `npm run test:desktop`.
var failures = 0
func expect(_ ok: Bool, _ what: String, line: Int = #line) {
    if !ok { failures += 1; print("FAIL line \(line): \(what)") }
}
func throwsCode(_ code: String, _ what: String, line: Int = #line, _ op: () throws -> Void) {
    do { try op(); expect(false, "\(what): did not throw", line: line) } catch let e as HelperError { expect(e.code == code, "\(what): \(e.code)", line: line) } catch { expect(false, "\(what): \(error)", line: line) }
}

// Shortcuts: spelling does not matter; app switching and launchers are refused.
expect(Policy.normalizedCombo("Shift+Command+Q") == "cmd+shift+q", "normalized order")
expect(Policy.normalizedCombo("option+cmd+esc") == "cmd+alt+escape", "aliases")
for combo in ["cmd+tab", "Command+Space", "cmd+opt+esc", "ctrl+left", "cmd+h"] {
    expect(Policy.deniedCombos.contains(Policy.normalizedCombo(combo)), "\(combo) is denied")
}
for combo in ["cmd+s", "cmd+n", "return", "cmd+shift+n"] {
    expect(!Policy.deniedCombos.contains(Policy.normalizedCombo(combo)), "\(combo) is allowed")
}

// Only the app under test.
let me = ProcessInfo.processInfo.processIdentifier
expect(Policy.refusal(pid: me, target: me) == nil, "the target is allowed")
expect(Policy.refusal(pid: me, target: me + 1) != nil, "another process is refused")
expect(Policy.refusal(pid: nil, target: me) != nil, "nothing under the point is refused")

// A look's coordinates map back to the screen and stay inside it.
let look = Look(jpeg: Data(), width: 640, height: 400, rect: CGRect(x: 1000, y: 200, width: 1280, height: 800))
expect((try? look.toGlobal(x: 320, y: 200)) == CGPoint(x: 1640, y: 600), "image to screen")
expect(look.toImage(CGPoint(x: 1640, y: 600)).map { [$0.0, $0.1] } == [320, 200], "screen to image")
expect(look.toImage(CGPoint(x: 10, y: 10)) == nil, "outside the look")
throwsCode("bad_request", "outside the screenshot") { _ = try look.toGlobal(x: 641, y: 10) }

// Sessions: a token, an end, your Stop latches, your input pauses.
let a = Arming()
throwsCode("denied", "no session") { _ = try a.check("x") }
try! a.arm(until: Date().addingTimeInterval(60), holder: "QA", session: "token-0123456789abcdef")
throwsCode("denied", "wrong token") { _ = try a.check("other-0123456789abcdef") }
expect((try? a.check("token-0123456789abcdef")) != nil, "right token")
_ = try! a.setTarget(42, session: "token-0123456789abcdef")
expect(a.state.target == 42, "target set")
a.personActive()
expect((try? a.check("token-0123456789abcdef"))?.pausedUntil != nil, "paused while you use the Mac")
expect(a.disarm(session: "stale-0123456789abcdef") == nil && a.state.until != nil, "a late disarm keeps a newer session")
expect(a.disarm(byUser: true) == 42, "Stop returns the app to close")
throwsCode("denied", "Stop latches") { try a.arm(until: Date().addingTimeInterval(60), holder: "QA", session: "token-2-0123456789abcdef") }
a.acknowledgeStop()
expect((try? a.arm(until: Date().addingTimeInterval(60), holder: "QA", session: "token-2-0123456789abcdef")) != nil, "armed again after swarmd confirms")
try! a.arm(until: Date().addingTimeInterval(7200), holder: "QA", session: "token-3-0123456789abcdef")
expect(a.state.until! <= Date().addingTimeInterval(Arming.maxSession + 1), "sessions are capped")
try! a.arm(until: Date().addingTimeInterval(-1), holder: "QA", session: "token-4-0123456789abcdef")
throwsCode("denied", "an ended session") { _ = try a.check("token-4-0123456789abcdef") }

if failures > 0 { print("\(failures) failed"); exit(1) }
print("desktop helper: all checks passed")
