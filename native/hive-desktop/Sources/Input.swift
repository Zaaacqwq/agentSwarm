import ApplicationServices
import Foundation

/// Synthetic mouse and keyboard events (needs Accessibility).
enum Input {
    static let source = CGEventSource(stateID: .hidSystemState)

    static func requireTrust() throws {
        guard AXIsProcessTrusted() else { throw HelperError.permission("Accessibility is not granted to Hive Desktop") }
    }

    static func click(at p: CGPoint, button: String, count: Int) throws {
        try requireTrust()
        let (down, up, btn): (CGEventType, CGEventType, CGMouseButton) = button == "right"
            ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
        CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: btn)?.post(tap: .cghidEventTap)
        usleep(60_000)
        for n in 1...max(1, min(count, 3)) {
            for type in [down, up] {
                let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: btn)
                e?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
                e?.post(tap: .cghidEventTap)
                usleep(20_000)
            }
        }
    }

    static func move(to p: CGPoint) throws {
        try requireTrust()
        CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
    }

    static func type(_ text: String) throws {
        try requireTrust()
        var chunk = ""
        func flush() {
            guard !chunk.isEmpty else { return }
            let units = Array(chunk.utf16)
            for down in [true, false] {
                let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
                e?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                e?.post(tap: .cghidEventTap)
            }
            usleep(15_000)
            chunk = ""
        }
        for ch in text {
            if ch == "\n" || ch == "\r" { flush(); try press(keyCode: 36, flags: []); continue }
            if ch == "\t" { flush(); try press(keyCode: 48, flags: []); continue }
            if chunk.utf16.count + String(ch).utf16.count > 16 { flush() }
            chunk.append(ch)
        }
        flush()
    }

    static func key(_ combo: String) throws {
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
        try press(keyCode: code, flags: flags)
    }

    static func press(keyCode: CGKeyCode, flags: CGEventFlags) throws {
        try requireTrust()
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: down)
            e?.flags = flags
            e?.post(tap: .cghidEventTap)
            usleep(15_000)
        }
    }

    static func scroll(dx: Int32, dy: Int32, at p: CGPoint?) throws {
        try requireTrust()
        if let p { try move(to: p); usleep(40_000) }
        CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: -dy, wheel2: -dx, wheel3: 0)?.post(tap: .cghidEventTap)
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
