import CoreGraphics

/// Displays in a stable order: main first, then left to right. Coordinates are global points, top-left origin.
struct DisplayInfo {
    let index: Int
    let id: CGDirectDisplayID
    let bounds: CGRect
    let main: Bool
}

enum Displays {
    static func all() -> [DisplayInfo] {
        var count: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &count)
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        CGGetActiveDisplayList(count, &ids, &count)
        let mainID = CGMainDisplayID()
        let sorted = ids.sorted { a, b in
            if a == mainID { return true }
            if b == mainID { return false }
            return CGDisplayBounds(a).minX < CGDisplayBounds(b).minX
        }
        return sorted.enumerated().map { DisplayInfo(index: $0.offset, id: $0.element, bounds: CGDisplayBounds($0.element), main: $0.element == mainID) }
    }

    static func get(_ index: Int) throws -> DisplayInfo {
        let list = all()
        guard index >= 0, index < list.count else { throw HelperError.bad("No display \(index); there are \(list.count)") }
        return list[index]
    }

    /// Screenshot images are at most `width` pixels wide; agents give coordinates in that space.
    static func imageSize(_ d: DisplayInfo, maxWidth: Int) -> (Int, Int) {
        let w = min(maxWidth, Int(d.bounds.width))
        return (w, Int((Double(w) * d.bounds.height / d.bounds.width).rounded()))
    }

    static func toGlobal(_ d: DisplayInfo, x: Double, y: Double, maxWidth: Int) throws -> CGPoint {
        let (w, h) = imageSize(d, maxWidth: maxWidth)
        guard x >= 0, y >= 0, x <= Double(w), y <= Double(h) else { throw HelperError.bad("(\(Int(x)), \(Int(y))) is outside the \(w)×\(h) screenshot of display \(d.index)") }
        let scale = d.bounds.width / Double(w)
        return CGPoint(x: d.bounds.minX + x * scale, y: d.bounds.minY + y * scale)
    }

    /// Global point to (display, screenshot coordinates), for describing UI elements.
    static func toImage(_ p: CGPoint, maxWidth: Int) -> (Int, Int, Int)? {
        guard let d = all().first(where: { $0.bounds.contains(p) }) else { return nil }
        let (w, _) = imageSize(d, maxWidth: maxWidth)
        let scale = Double(w) / d.bounds.width
        return (d.index, Int(((p.x - d.bounds.minX) * scale).rounded()), Int(((p.y - d.bounds.minY) * scale).rounded()))
    }
}

enum HelperError: Error {
    case bad(String)
    case denied(String)
    case permission(String)
    case failed(String)

    var code: String {
        switch self {
        case .bad: return "bad_request"
        case .denied: return "denied"
        case .permission: return "permission"
        case .failed: return "failed"
        }
    }

    var message: String {
        switch self {
        case .bad(let m), .denied(let m), .permission(let m), .failed(let m): return m
        }
    }
}
