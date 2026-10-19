// R0 probe: can a vision model find on-screen elements well enough to tap them?
// Ground truth comes from the simulator's accessibility tree (AXe); the model only sees the screenshot.
//
//   node r0/vision-probe.mjs <simulator-udid> [model] [width]
//
// Reads the OpenRouter key from ~/.pi/agent/auth.json (never printed).
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const [udid, model = "qwen/qwen3.8-omni-flash", width = "603"] = process.argv.slice(2);
const key = JSON.parse(readFileSync(join(homedir(), ".pi/agent/auth.json"), "utf8")).openrouter.key;

function elements() {
  const tree = JSON.parse(execFileSync("axe", ["describe-ui", "--udid", udid], { stdio: ["ignore", "pipe", "ignore"] }).toString());
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.AXLabel && n.frame && ["AXButton", "AXTextField", "AXSwitch", "AXLink"].includes(n.role)) out.push({ role: n.role, label: n.AXLabel, ...n.frame });
      if (n.children) walk(n.children);
    }
  };
  walk(tree);
  const root = tree[0].frame;
  return { out, screen: { w: root.width, h: root.height } };
}

function screenshot() {
  const dir = mkdtempSync(join(tmpdir(), "r0-vision-"));
  const png = join(dir, "s.png");
  const jpg = join(dir, "s.jpg");
  execFileSync("xcrun", ["simctl", "io", udid, "screenshot", png], { stdio: "ignore" });
  execFileSync("sips", ["-Z", width, "-s", "format", "jpeg", png, "--out", jpg], { stdio: "ignore" });
  const data = readFileSync(jpg).toString("base64");
  rmSync(dir, { recursive: true, force: true });
  return data;
}

async function ask(image, label) {
  const started = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(60_000),
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } },
          { type: "text", text: `This is a phone screenshot. Where should I tap to activate "${label}"? Answer only with JSON {"x": <0-1000>, "y": <0-1000>} where x and y are the tap point as thousandths of the image width and height.` },
        ],
      }],
    }),
  });
  const body = await res.json();
  const text = body.choices?.[0]?.message?.content ?? "";
  // Models drift from the asked format: a missing quote, or Qwen's own {"point_2d": [x, y]}.
  const m = text.match(/x"?\s*:\s*([\d.]+)[^\d]+?y"?\s*:\s*([\d.]+)/) ?? text.match(/\[\s*([\d.]+)\s*,\s*([\d.]+)\s*\]/);
  return { point: m ? { x: Number(m[1]), y: Number(m[2]) } : null, raw: text.slice(0, 120), ms: Date.now() - started, cost: body.usage?.cost ?? null };
}

const { out, screen } = elements();
const image = screenshot();
// Each distinct visible label once; skip ones a person could not see (off-screen).
const seen = new Set();
const targets = out.filter((e) => e.y >= 0 && e.y + e.height <= screen.h && !seen.has(e.label) && seen.add(e.label)).slice(0, 12);
let hits = 0;
let cost = 0;
for (const t of targets) {
  const r = await ask(image, t.label.split(",")[0]).catch((e) => ({ point: null, raw: `request failed: ${e.name}`, ms: 60_000, cost: 0 }));
  cost += r.cost ?? 0;
  if (!r.point) { console.log(`MISS (unparsed) ${t.label.slice(0, 40)} :: ${r.raw}`); continue; }
  const px = (r.point.x / 1000) * screen.w;
  const py = (r.point.y / 1000) * screen.h;
  const hit = px >= t.x && px <= t.x + t.width && py >= t.y && py <= t.y + t.height;
  if (hit) hits++;
  const dx = Math.round(px - (t.x + t.width / 2));
  const dy = Math.round(py - (t.y + t.height / 2));
  console.log(`${hit ? "HIT " : "MISS"} ${t.role.padEnd(11)} ${t.label.slice(0, 34).padEnd(34)} off by (${dx}, ${dy}) pt  ${r.ms} ms`);
}
console.log(`\n${model} @ ${width}px wide: ${hits}/${targets.length} inside the element · $${cost.toFixed(4)}`);
