/** One server-sent event as a browser reads it, or a comment. */
export interface PushedEvent {
  /** Its type: `message` when it names none; `retry` for the retry line; `comment` for a comment. */
  event: string;
  data: string;
  id?: string | undefined;
}

/**
 * Reads a response's server-sent events until `until` says there are enough, or `ms` pass; then
 * closes the response, as a browser that leaves the page does.
 */
export async function readPushed(
  res: Response,
  until: (events: PushedEvent[]) => boolean,
  ms = 5000,
): Promise<PushedEvent[]> {
  const body = res.body;
  if (!body) throw new Error("the response has no body to read");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: PushedEvent[] = [];
  const deadline = Date.now() + ms;
  let buffer = "";
  try {
    while (!until(events) && Date.now() < deadline) {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<null>((done) => {
        timer = setTimeout(() => done(null), Math.max(0, deadline - Date.now()));
      });
      const read = await Promise.race([reader.read(), late]);
      clearTimeout(timer);
      if (!read || read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const ev: PushedEvent = { event: "message", data: "" };
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) ev.event = "comment";
          else if (line.startsWith("event: ")) ev.event = line.slice(7);
          else if (line.startsWith("data: ")) data.push(line.slice(6));
          else if (line.startsWith("id: ")) ev.id = line.slice(4);
          else if (line.startsWith("retry: ")) ev.event = "retry";
        }
        ev.data = data.join("\n");
        events.push(ev);
      }
    }
  } finally {
    await reader.cancel();
  }
  return events;
}

/** The pushed events of one type, their data read as JSON. */
export function pushedOf<T>(events: PushedEvent[], type: string): T[] {
  return events.filter((e) => e.event === type).map((e) => JSON.parse(e.data) as T);
}
