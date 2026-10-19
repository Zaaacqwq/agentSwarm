import Foundation

enum HelperError: Error {
    case bad(String)
    case denied(String)
    case permission(String)
    case failed(String)
    /// You are using the Mac: the agent's input waits until then.
    case paused(Date)

    var code: String {
        switch self {
        case .bad: return "bad_request"
        case .denied: return "denied"
        case .permission: return "permission"
        case .failed: return "failed"
        case .paused: return "paused"
        }
    }

    var message: String {
        switch self {
        case .bad(let m), .denied(let m), .permission(let m), .failed(let m): return m
        case .paused: return "The person is using this Mac; the agent's input waits until they stop"
        }
    }
}
