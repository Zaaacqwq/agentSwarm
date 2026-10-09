import AppKit

// hive-desktop: lets hived drive this Mac's GUI session during approved control sessions.
//   hive-desktop --socket "~/Library/Application Support/Hive/desktop.sock"
var socketPath = NSHomeDirectory() + "/Library/Application Support/Hive/desktop.sock"
var args = CommandLine.arguments.dropFirst().makeIterator()
while let arg = args.next() {
    if arg == "--socket", let value = args.next() { socketPath = value }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let commands = Commands()
let menu = StatusMenu(onStop: { commands.stopByUser() })
menu.currentUntil = { commands.arming.current?.until }
commands.arming.onChange = { until, holder in menu.update(until: until, holder: holder) }
let server = Server(path: socketPath, handler: commands.handle)
Thread { server.run() }.start()
log("hive-desktop started (screen recording: \(CGPreflightScreenCaptureAccess()), accessibility: \(AXIsProcessTrusted()))")
app.run()
