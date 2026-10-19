import AppKit

/**
 * During a session the clipboard is empty: an app under test (or an agent) never reads what you copied, such as a
 * password. Afterwards it comes back, unless you copied something new meanwhile.
 */
final class Clipboard {
    private let lock = NSLock()
    private var saved: [NSPasteboardItem]?
    private var clearedAt: Int?

    func stash() {
        lock.withLock {
            let board = NSPasteboard.general
            if saved == nil {
                saved = board.pasteboardItems?.map { item in
                    let copy = NSPasteboardItem()
                    for type in item.types { if let data = item.data(forType: type) { copy.setData(data, forType: type) } }
                    return copy
                }
            }
            clearedAt = board.clearContents()
        }
    }

    func restore() {
        lock.withLock {
            defer { saved = nil; clearedAt = nil }
            let board = NSPasteboard.general
            guard let saved, let clearedAt, board.changeCount == clearedAt else { return }
            board.clearContents()
            if !saved.isEmpty { board.writeObjects(saved) }
        }
    }
}
