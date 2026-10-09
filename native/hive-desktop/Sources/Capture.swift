import CoreText
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

struct Shot {
    let jpeg: Data
    let width: Int
    let height: Int
    let display: Int
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
    /// Captures one display scaled to at most `maxWidth`, with denied apps and Hive UI windows left out.
    static func screenshot(display index: Int, maxWidth: Int, grid: Bool) throws -> Shot {
        guard CGPreflightScreenCaptureAccess() else { throw HelperError.permission("Screen Recording is not granted to Hive Desktop") }
        let info = try Displays.get(index)
        let (w, h) = Displays.imageSize(info, maxWidth: maxWidth)
        let image: CGImage = try blocking {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first(where: { $0.displayID == info.id }) else { throw HelperError.failed("Display \(index) is not capturable") }
            let hidden = content.windows.filter { w in
                Policy.deniedReason(bundle: w.owningApplication?.bundleIdentifier, title: w.title) != nil
            }
            let filter = SCContentFilter(display: display, excludingWindows: hidden)
            let config = SCStreamConfiguration()
            config.width = w
            config.height = h
            config.showsCursor = true
            return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        }
        let final = grid ? (drawGrid(on: image) ?? image) : image
        return Shot(jpeg: try jpeg(final), width: final.width, height: final.height, display: index)
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
