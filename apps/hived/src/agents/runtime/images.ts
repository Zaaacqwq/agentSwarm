/** Screenshots are large: only the most recent ones stay in the model's context and in checkpoints. */
export const KEEP_IMAGES = 2;
const PLACEHOLDER = { type: "text", text: "[earlier screenshot removed to save context]" } as const;

interface ContentBlock {
  readonly type: string;
}
interface MessageLike {
  readonly role?: string;
  readonly content?: unknown;
}

function imageCount(message: MessageLike): number {
  if (message.role !== "toolResult" || !Array.isArray(message.content)) return 0;
  return (message.content as ContentBlock[]).filter((c) => c.type === "image").length;
}

function stripImages<T extends MessageLike>(message: T): T {
  const content = (message.content as ContentBlock[]).map((c) => (c.type === "image" ? PLACEHOLDER : c));
  return { ...message, content };
}

/** Returns messages where tool-result images beyond the newest `keep` are replaced by a note. */
export function pruneImages<T extends MessageLike>(messages: readonly T[], keep = KEEP_IMAGES): T[] {
  let seen = 0;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const n = imageCount(out[i]!);
    if (n === 0) continue;
    if (seen >= keep) out[i] = stripImages(out[i]!);
    seen += n;
  }
  return out;
}

/** Same for Pi session entries ({ type: "message", message }) before they are checkpointed. */
export function pruneEntryImages(entries: readonly unknown[], keep = KEEP_IMAGES): unknown[] {
  const messages = entries.map((e) => ((e as { type?: string }).type === "message" ? ((e as { message?: MessageLike }).message ?? {}) : {}));
  const pruned = pruneImages(messages, keep);
  return entries.map((e, i) => (pruned[i] === messages[i] ? e : { ...(e as object), message: pruned[i] }));
}
