import type { FastifyInstance } from "fastify";
import type { RouteDeps } from "../context.ts";

const HEARTBEAT_MS = 25_000;

/** One socket per tab. Events are scoped to the user's org; clients refetch snapshots on reconnect. */
export function registerWebSocket(app: FastifyInstance, deps: RouteDeps): void {
  app.get("/api/ws", { websocket: true }, (socket, request) => {
    const user = request.authUser;
    if (!user) {
      socket.close(4401, "unauthorized");
      return;
    }
    const unsubscribe = deps.services.bus.subscribe(({ orgId, event }) => {
      if (orgId !== user.orgId || socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify(event));
    });
    const heartbeat = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping();
    }, HEARTBEAT_MS);
    socket.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    // The socket is server-to-client only.
    socket.on("message", () => {});
  });
}
