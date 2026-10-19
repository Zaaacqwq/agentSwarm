// Fake simctl (through xcrun), axe and xcodebuild for ws-exec's tests. State lives in $XDG_CACHE_HOME.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [tool, tools, ...args] = process.argv.slice(2);
const stateFile = join(process.env.XDG_CACHE_HOME ?? "/nonexistent", "fake-sim.json");
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { devices: [], calls: [] };
const save = () => writeFileSync(stateFile, JSON.stringify(state));
const stdin = () => {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
};
const fail = (msg, code = 1) => {
  process.stderr.write(`${msg}\n`);
  save();
  process.exit(code);
};
const device = (udid) => state.devices.find((d) => d.udid === udid) ?? fail(`Invalid device: ${udid}`, 164);
const RUNTIMES = [
  { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4", version: "26.4", isAvailable: true, platform: "iOS" },
  { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-27-0", version: "27.0", isAvailable: true, platform: "iOS" },
  { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-28-0", version: "28.0", isAvailable: false, platform: "iOS" },
  { identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-12-0", version: "12.0", isAvailable: true, platform: "watchOS" },
];

if (tool === "xcrun") {
  const [, sub, ...rest] = args;
  state.calls.push(["simctl", sub, ...rest]);
  switch (sub) {
    case "list":
      if (rest[0] === "runtimes") process.stdout.write(JSON.stringify({ runtimes: RUNTIMES }));
      else {
        const devices = {};
        for (const d of state.devices) (devices[d.runtime] ??= []).push({ udid: d.udid, name: d.name, state: d.state, deviceTypeIdentifier: d.deviceTypeIdentifier });
        // A device that belongs to nobody in particular, as Xcode creates them.
        (devices["com.apple.CoreSimulator.SimRuntime.iOS-27-0"] ??= []).push({ udid: "OTHER-0000", name: "iPhone 17", state: "Booted", deviceTypeIdentifier: "x" });
        process.stdout.write(JSON.stringify({ devices }));
      }
      break;
    case "create": {
      const udid = `FAKE-${state.devices.length + 1}-${Date.now() % 100000}`;
      state.devices.push({ udid, name: rest[0], deviceTypeIdentifier: rest[1], runtime: rest[2], state: "Shutdown", installed: [], erased: 0 });
      process.stdout.write(`${udid}\n`);
      break;
    }
    case "delete":
      device(rest[0]);
      state.devices = state.devices.filter((d) => d.udid !== rest[0]);
      break;
    case "boot":
      if (device(rest[0]).state === "Booted") fail("Unable to boot device in current state: Booted", 149);
      device(rest[0]).state = "Booted";
      break;
    case "bootstatus":
      device(rest[0]);
      break;
    case "shutdown":
      if (device(rest[0]).state !== "Booted") fail("Unable to shutdown device in current state: Shutdown", 149);
      device(rest[0]).state = "Shutdown";
      break;
    case "erase":
      device(rest[0]).erased++;
      break;
    case "install":
      device(rest[0]).installed.push(rest[1]);
      break;
    case "launch":
      process.stdout.write(`${rest[2]}: 4242\n`);
      break;
    case "spawn":
      process.stdout.write("12:00:01.000 Fridgy[4242] hello from the app\n");
      break;
    default:
      fail(`fake simctl: ${sub}`);
  }
} else if (tool === "axe") {
  const [sub, ...rest] = args;
  state.calls.push(["axe", sub, ...rest, ...(sub === "type" ? [stdin()] : [])]);
  if (sub === "describe-ui") process.stdout.write(readFileSync(join(tools, "ui.json"), "utf8"));
  else if (sub === "screenshot") copyFileSync(join(tools, "shot.png"), rest[rest.indexOf("--output") + 1]);
} else if (tool === "xcodebuild") {
  state.calls.push(["xcodebuild", ...args]);
  if (args.includes("FAIL_BUILD")) {
    process.stdout.write("/w/App/ContentView.swift:12:5: error: cannot find 'Foo' in scope\n** BUILD FAILED **\n");
    save();
    process.exit(65);
  }
  const derived = args[args.indexOf("-derivedDataPath") + 1];
  const app = join(derived, "Build", "Products", `${args[args.indexOf("-configuration") + 1]}-iphonesimulator`, "Demo.app");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.demo</string></dict></plist>\n`);
  process.stdout.write("** BUILD SUCCEEDED **\n");
}
save();
