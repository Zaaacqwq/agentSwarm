import type { UiElement } from "@agentswarm/ws-exec";

/** Elements worth a number: something to read or to touch. Plain containers are skipped. */
const INTERACTIVE = /button|textfield|securetextfield|textview|searchfield|switch|toggle|slider|cell|link|tab|segment|picker|stepper|menu|checkbox|radio/i;

export interface NumberedElement {
  readonly n: number;
  readonly type: string;
  readonly label?: string;
  readonly value?: string;
  readonly id?: string;
  readonly enabled: boolean;
  /** The centre, in screen points: where a tap lands. */
  readonly center: readonly [number, number];
}

export interface Screen {
  /** The screen size in points (the root element's frame). */
  readonly width: number;
  readonly height: number;
  readonly elements: readonly NumberedElement[];
}

/** Numbers what an agent can read or tap, in reading order, from AXe's tree. */
export function numberElements(tree: readonly UiElement[]): Screen {
  const root = tree[0];
  const width = root?.frame[2] ?? 0;
  const height = root?.frame[3] ?? 0;
  const out: NumberedElement[] = [];
  const seen = new Set<string>();
  const visit = (e: UiElement, depth: number) => {
    const [x, y, w, h] = e.frame;
    const onScreen = w > 0 && h > 0 && x + w > 0 && y + h > 0 && (!width || x < width) && (!height || y < height);
    const worth = depth > 0 && onScreen && (Boolean(e.label || e.value || e.id) || INTERACTIVE.test(e.type));
    const center: [number, number] = [round(x + w / 2), round(y + h / 2)];
    // AXe repeats some elements (scroll bars); one number each.
    const key = `${e.type}|${e.label ?? ""}|${center.join(",")}`;
    if (worth && !seen.has(key)) {
      seen.add(key);
      out.push({ n: out.length + 1, type: e.type, ...(e.label ? { label: e.label } : {}), ...(e.value ? { value: e.value } : {}), ...(e.id ? { id: e.id } : {}), enabled: e.enabled !== false, center });
    }
    for (const c of e.children ?? []) visit(c, depth + 1);
  };
  for (const e of tree) visit(e, 0);
  return { width, height, elements: out };
}

const round = (n: number) => Math.round(n * 10) / 10;

/** What the agent reads: one line per element, at most `max`. */
export function formatScreen(screen: Screen, max = 150): string {
  const lines = screen.elements.slice(0, max).map((e) => {
    const parts = [`[${e.n}] ${e.type}`];
    if (e.label) parts.push(JSON.stringify(e.label.replace(/\s+/g, " ").slice(0, 120)));
    if (e.value) parts.push(`value ${JSON.stringify(e.value.slice(0, 80))}`);
    if (e.id) parts.push(`id ${e.id}`);
    if (!e.enabled) parts.push("(disabled)");
    parts.push(`at ${e.center[0]},${e.center[1]}`);
    return parts.join(" ");
  });
  const more = screen.elements.length > max ? `\n… ${screen.elements.length - max} more` : "";
  return `Screen ${screen.width}×${screen.height} points. Tap an element by its number.\n${lines.join("\n") || "(no labelled elements; take a screenshot)"}${more}`;
}
