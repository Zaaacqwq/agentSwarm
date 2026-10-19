import AppKit
import ApplicationServices

/// Reads an app's accessibility tree as compact text; numbered elements can then be pressed.
final class UITree {
    private let lock = NSLock()
    private var elements: [AXUIElement] = []

    static let actionable: Set<String> = [
        "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXMenuItem", "AXMenuBarItem",
        "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXLink", "AXTab", "AXSlider", "AXIncrementor",
        "AXDisclosureTriangle", "AXSwitch",
    ]

    /// `position` turns a global point into the coordinates of the last look, when it is in it.
    func dump(pid: pid_t, position: (CGPoint) -> (Int, Int)?, maxNodes: Int = 300) throws -> String {
        guard AXIsProcessTrusted() else { throw HelperError.permission("Accessibility is not granted to agentSwarm Desktop") }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 1.5)
        var roots: [AXUIElement] = []
        if let focused = UITree.element(app, kAXFocusedWindowAttribute) { roots.append(focused) }
        if let menuBar = UITree.element(app, kAXMenuBarAttribute) { roots.append(menuBar) }
        if roots.isEmpty, let windows = UITree.attr(app, kAXWindowsAttribute) as? [AXUIElement] { roots = Array(windows.prefix(1)) }
        var found: [AXUIElement] = []
        var lines: [String] = []
        func walk(_ el: AXUIElement, depth: Int) {
            guard found.count < maxNodes, depth < 30 else { return }
            let role = UITree.string(el, kAXRoleAttribute) ?? "?"
            // Menus are huge; list only the top level of the menu bar.
            if role == "AXMenu" && depth > 1 { return }
            let label = [UITree.string(el, kAXTitleAttribute), UITree.string(el, kAXDescriptionAttribute), UITree.string(el, kAXPlaceholderValueAttribute)]
                .compactMap { $0 }.first { !$0.isEmpty }
            let value = UITree.string(el, kAXValueAttribute).map { $0.count > 80 ? String($0.prefix(80)) + "…" : $0 }
            let show = UITree.actionable.contains(role) || label != nil || (value != nil && !(value!.isEmpty))
            var nextDepth = depth
            if show {
                found.append(el)
                var line = String(repeating: "  ", count: depth) + "[\(found.count)] \(role.dropFirst(2))"
                if let label { line += " \"\(label)\"" }
                if let value, !value.isEmpty, value != label { line += " = \"\(value)\"" }
                if UITree.bool(el, kAXEnabledAttribute) == false { line += " (disabled)" }
                if let c = UITree.center(el), let (x, y) = position(c) { line += " @\(x),\(y)" }
                lines.append(line)
                nextDepth = depth + 1
            }
            if role == "AXMenuBar" {
                for child in (UITree.attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { walkShallow(child, depth: nextDepth) }
                return
            }
            for child in (UITree.attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { walk(child, depth: nextDepth) }
        }
        func walkShallow(_ el: AXUIElement, depth: Int) {
            guard found.count < maxNodes, let title = UITree.string(el, kAXTitleAttribute), !title.isEmpty else { return }
            found.append(el)
            lines.append(String(repeating: "  ", count: depth) + "[\(found.count)] MenuBarItem \"\(title)\"")
        }
        for root in roots { walk(root, depth: 0) }
        lock.lock(); elements = found; lock.unlock()
        if found.count >= maxNodes { lines.append("… [truncated at \(maxNodes) elements]") }
        return lines.joined(separator: "\n")
    }

    func element(_ n: Int) throws -> AXUIElement {
        lock.lock(); defer { lock.unlock() }
        guard n >= 1, n <= elements.count else { throw HelperError.bad("No element [\(n)]; look again (desktop_look)") }
        return elements[n - 1]
    }

    static func pid(of el: AXUIElement) -> pid_t? {
        var pid: pid_t = 0
        return AXUIElementGetPid(el, &pid) == .success ? pid : nil
    }

    /// Presses an element (AXPress), falling back to clicking its centre.
    func press(_ n: Int) throws -> CGPoint? {
        let el = try element(n)
        if AXUIElementPerformAction(el, kAXPressAction as CFString) == .success { return nil }
        guard let c = UITree.center(el) else { throw HelperError.failed("Element [\(n)] cannot be pressed and has no position") }
        try Input.click(at: c, button: "left", count: 1)
        return c
    }

    static func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
        var v: CFTypeRef?
        return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
    }

    static func element(_ el: AXUIElement, _ name: String) -> AXUIElement? {
        guard let v = attr(el, name), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)
    }

    static func string(_ el: AXUIElement, _ name: String) -> String? { attr(el, name) as? String }

    static func bool(_ el: AXUIElement, _ name: String) -> Bool? { (attr(el, name) as? NSNumber)?.boolValue }

    static func center(_ el: AXUIElement) -> CGPoint? {
        guard let p = attr(el, kAXPositionAttribute), let s = attr(el, kAXSizeAttribute),
              CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero, size = CGSize.zero
        AXValueGetValue(p as! AXValue, .cgPoint, &point)
        AXValueGetValue(s as! AXValue, .cgSize, &size)
        guard size.width > 0, size.height > 0 else { return nil }
        return CGPoint(x: point.x + size.width / 2, y: point.y + size.height / 2)
    }
}
