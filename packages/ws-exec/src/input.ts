import { createInterface } from "node:readline";

/**
 * stdin as lines: the first is the request (one line of JSON); the rest, if any, are a session's commands
 * (browser.session). A request with no newline at the end is read at EOF.
 */
export async function readRequest(stdin: NodeJS.ReadableStream, maxBytes: number): Promise<{ request: string; rest: AsyncIterable<string> }> {
  const lines = createInterface({ input: stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const first = await lines.next();
  const request = first.done ? "" : first.value;
  if (Buffer.byteLength(request) > maxBytes) throw new Error("Request too large");
  return { request, rest: { [Symbol.asyncIterator]: () => lines } };
}
