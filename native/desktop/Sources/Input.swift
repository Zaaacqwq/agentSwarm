import ApplicationServices
import Foundation

/// Synthetic mouse and keyboard events (needs Accessibility). Each carries a mark, so the watcher can tell them from yours.
enum Input {
    static let source = CGEventSource(stateID: .privateState)
    /// In every event we post (eventSourceUserData): anything without it came from you. Random per start.
    static let mark = Int64.random(in: 1 << 40 ..< 1 << 52)
    /// Run before every event: the session may have ended, you may have started using the Mac, or another
    /// app may have come to the front since the action began. It throws to stop the rest of the action.
    typealias Check = () throws -> Void

    static func requireTrust() throws {
        guard AXIsProcessTrusted() else { throw HelperError.permission("Accessibility is not granted to agentSwarm Desktop") }
    }

    private static func post(_ e: CGEvent?) {
        guard let e else { return }
        e.setIntegerValueField(.eventSourceUserData, value: mark)
        e.post(tap: .cghidEventTap)
    }

    static func click(at p: CGPoint, button: String, count: Int, check: Check) throws {
        try requireTrust()
        let (down, up, btn): (CGEventType, CGEventType, CGMouseButton) = button == "right"
            ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
        post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: btn))
        usleep(30_000)
        for n in 1...max(1, min(count, 3)) {
            for type in [down, up] {
                // Checked right before the press: what is under the point can change while the pointer moves.
                if type == down { try check() }
                let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: btn)
                e?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
                post(e)
                usleep(20_000)
            }
        }
    }

    static func move(to p: CGPoint) throws {
        try requireTrust()
        post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
    }

    static func type(_ text: String, check: Check) throws {
        try requireTrust()
        var chunk = ""
        func flush() throws {
            guard !chunk.isEmpty else { return }
            try check()
            let units = Array(chunk.utf16)
            for down in [true, false] {
                let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
                e?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                post(e)
            }
            usleep(15_000)
            chunk = ""
        }
        for ch in text {
            if ch == "\n" || ch == "\r" { try flush(); try check(); try press(keyCode: 36, flags: []); continue }
            if ch == "\t" { try flush(); try check(); try press(keyCode: 48, flags: []); continue }
            if chunk.utf16.count + String(ch).utf16.count > 16 { try flush() }
            chunk.append(ch)
        }
        try flush()
    }

    /// The key code and modifiers of a combination, e.g. "cmd+shift+s".
    static func parse(_ combo: String) throws -> (CGKeyCode, CGEventFlags) {
        var flags: CGEventFlags = []
        var code: CGKeyCode?
        for raw in combo.lowercased().split(separator: "+").map({ $0.trimmingCharacters(in: .whitespaces) }) {
            switch raw {
            case "cmd", "command", "meta": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "alt", "option", "opt": flags.insert(.maskAlternate)
            case "ctrl", "control": flags.insert(.maskControl)
            case "fn": flags.insert(.maskSecondaryFn)
            default:
                guard code == nil, let c = keyCodes[raw] else { throw HelperError.bad("Unknown key \"\(raw)\" in \"\(combo)\"") }
                code = c
            }
        }
        guard let code else { throw HelperError.bad("No key in \"\(combo)\"") }
        return (code, flags)
    }

    static func key(_ combo: String, check: Check) throws {
        let (code, flags) = try parse(combo)
        try check()
        try press(keyCode: code, flags: flags)
    }

    static func press(keyCode: CGKeyCode, flags: CGEventFlags) throws {
        try requireTrust()
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: down)
            e?.flags = flags
            post(e)
            usleep(15_000)
        }
    }

    static func scroll(dx: Int32, dy: Int32, at p: CGPoint?, check: Check) throws {
        try requireTrust()
        if let p { try move(to: p); usleep(40_000) }
        try check()
        post(CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: -dy, wheel2: -dx, wheel3: 0))
    }

    static let keyCodes: [String: CGKeyCode] = {
        var m: [String: CGKeyCode] = [
            "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
            "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27,
            "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
            "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
            "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
            "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
            "left": 123, "right": 124, "down": 125, "up": 126,
        ]
        let f: [CGKeyCode] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111]
        for (i, c) in f.enumerated() { m["f\(i + 1)"] = c }
        return m
    }()
}
