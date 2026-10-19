import CoreText
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// What a look showed: the picture, and where it was on screen, so clicks in its coordinates map back.
struct Look {
    let jpeg: Data
    let width: Int
    let height: Int
    /// The captured area in global points (top-left origin).
    let rect: CGRect
    var scale: Double { Double(width) / rect.width }

    func toGlobal(x: Double, y: Double) throws -> CGPoint {
        guard x >= 0, y >= 0, x <= Double(width), y <= Double(height) else {
            throw HelperError.bad("(\(Int(x)), \(Int(y))) is outside the \(width)×\(height) screenshot")
        }
        return CGPoint(x: rect.minX + x / scale, y: rect.minY + y / scale)
    }

    func toImage(_ p: CGPoint) -> (Int, Int)? {
        guard rect.contains(p) else { return nil }
        return (Int(((p.x - rect.minX) * scale).rounded()), Int(((p.y - rect.minY) * scale).rounded()))
    }
}

/// Runs an async call from a plain (non-main) thread.
func blocking<T>(_ op: @escaping () async throws -> T) throws -> T {
    let sem = DispatchSemaphore(value: 0)
    var result: Result<T, Error>?
    Task.detached {
        do { result = .success(try await op()) } catch { result = .failure(error) }
        sem.signal()
    }
    sem.wait()
    return try result!.get()
}

enum Capture {
    /**
     * The app under test and nothing else: only its windows are captured (other apps' windows are left out,
     * not just covered), cropped to the area they cover on the display of its largest window.
     */
    static func look(pid: pid_t, maxWidth: Int, grid: Bool) throws -> Look {
        guard CGPreflightScreenCaptureAccess() else { throw HelperError.permission("Screen Recording is not granted to agentSwarm Desktop") }
        let (image, rect): (CGImage, CGRect) = try blocking {
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            guard let app = content.applications.first(where: { $0.processID == pid }) else { throw HelperError.failed("The app under test has no windows on screen; open it or bring it forward (desktop_focus)") }
            let windows = content.windows.filter { $0.owningApplication?.processID == pid && $0.isOnScreen && $0.frame.width > 1 && $0.frame.height > 1 }
            guard let main = windows.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else {
                throw HelperError.failed("The app under test has no windows on screen; open it or bring it forward (desktop_focus)")
            }
            let center = CGPoint(x: main.frame.midX, y: main.frame.midY)
            guard let display = content.displays.first(where: { $0.frame.contains(center) }) ?? content.displays.first else { throw HelperError.failed("No display") }
            let union = windows.filter { $0.frame.intersects(display.frame) }.reduce(main.frame) { $0.union($1.frame) }.intersection(display.frame)
            let scale = min(1.0, Double(maxWidth) / union.width)
            let filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
            let config = SCStreamConfiguration()
            config.sourceRect = CGRect(x: union.minX - display.frame.minX, y: union.minY - display.frame.minY, width: union.width, height: union.height)
            config.width = max(1, Int((union.width * scale).rounded()))
            config.height = max(1, Int((union.height * scale).rounded()))
            config.showsCursor = false
            return (try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config), union)
        }
        let final = grid ? (drawGrid(on: image) ?? image) : image
        return Look(jpeg: try jpeg(final), width: final.width, height: final.height, rect: rect)
    }

    static func jpeg(_ image: CGImage, quality: Double = 0.7) throws -> Data {
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { throw HelperError.failed("JPEG encoder unavailable") }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { throw HelperError.failed("JPEG encoding failed") }
        return data as Data
    }


    /// Faint lines every 100 px with labels on the top and left edges, so a model can read coordinates.
    static func drawGrid(on image: CGImage, step: Int = 100) -> CGImage? {
        let w = image.width, h = image.height
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue) else { return nil }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        ctx.setStrokeColor(CGColor(red: 1, green: 0, blue: 0.6, alpha: 0.28))
        ctx.setLineWidth(1)
        for x in stride(from: step, to: w, by: step) {
            ctx.move(to: CGPoint(x: Double(x) + 0.5, y: 0)); ctx.addLine(to: CGPoint(x: Double(x) + 0.5, y: Double(h)))
        }
        for y in stride(from: step, to: h, by: step) {
            let cy = Double(h - y) + 0.5
            ctx.move(to: CGPoint(x: 0, y: cy)); ctx.addLine(to: CGPoint(x: Double(w), y: cy))
        }
        ctx.strokePath()
        let font = CTFontCreateWithName("Menlo-Bold" as CFString, 11, nil)
        let attrs: [NSAttributedString.Key: Any] = [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(red: 1, green: 0, blue: 0.6, alpha: 0.9),
        ]
        func label(_ text: String, x: Double, yFromTop: Double) {
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attrs))
            ctx.textPosition = CGPoint(x: x, y: Double(h) - yFromTop - 11)
            CTLineDraw(line, ctx)
        }
        for x in stride(from: step, to: w, by: step) { label("\(x)", x: Double(x) + 2, yFromTop: 2) }
        for y in stride(from: step, to: h, by: step) { label("\(y)", x: 2, yFromTop: Double(y) + 2) }
        return ctx.makeImage()
    }
}
