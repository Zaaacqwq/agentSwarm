import AppKit

// agentswarm-desktop: lets swarmd drive one app under test in this Mac's GUI session, during sessions you approve.
//   agentswarm-desktop --socket "~/Library/Application Support/agentSwarm/desktop.sock" --apps "~/Library/Application Support/agentSwarm/apps"
let support = NSHomeDirectory() + "/Library/Application Support/agentSwarm"
var socketPath = support + "/desktop.sock"
var appsDir = support + "/apps"
var args = CommandLine.arguments.dropFirst().makeIterator()
while let arg = args.next() {
    if arg == "--socket", let value = args.next() { socketPath = value }
    if arg == "--apps", let value = args.next() { appsDir = value }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let commands = Commands(appsDir: appsDir)
let menu = StatusMenu(onStop: { commands.stopByUser() })
commands.arming.onChange = { state in menu.update(state) }
let watcher = PersonWatcher(arming: commands.arming)
watcher.start()
// Accessibility granted after the helper started: the watcher is set up on the next status request.
commands.watching = {
    if !watcher.active && AXIsProcessTrusted() { DispatchQueue.main.async { watcher.start() } }
    return watcher.active
}
let server = Server(path: socketPath, handler: commands.handle)
Thread { server.run() }.start()
log("agentswarm-desktop started (screen recording: \(CGPreflightScreenCaptureAccess()), accessibility: \(AXIsProcessTrusted()), watching: \(watcher.active))")
app.run()
