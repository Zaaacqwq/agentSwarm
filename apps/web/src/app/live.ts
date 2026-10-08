import { useEffect, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Agent, Channel, MessagePage, ServerEvent, Workstation } from "@hive/core";
import { qk } from "./api.ts";

export type LiveStatus = "connecting" | "live" | "offline";

const MAX_BACKOFF_MS = 15_000;

/**
 * Keeps the query cache in step with the server. On every (re)connect it refetches
 * snapshots first, so missed events never leave the UI stale.
 */
export function useLiveEvents(enabled: boolean): LiveStatus {
  const client = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>("connecting");

  useEffect(() => {
    if (!enabled) return;
    let socket: WebSocket | null = null;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const connect = (): void => {
      setStatus("connecting");
      const proto = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${proto}://${location.host}/api/ws`);
      socket.onopen = () => {
        attempt = 0;
        setStatus("live");
        void client.invalidateQueries();
      };
      socket.onmessage = (m) => {
        try {
          applyEvent(client, JSON.parse(String(m.data)) as ServerEvent);
        } catch {
          void client.invalidateQueries();
        }
      };
      socket.onclose = () => {
        if (disposed) return;
        setStatus("offline");
        const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt++);
        timer = setTimeout(connect, delay);
      };
    };
    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [enabled, client]);

  return status;
}

export function applyEvent(client: QueryClient, event: ServerEvent): void {
  switch (event.type) {
    case "message.created": {
      const { message } = event;
      const key = qk.messages(message.channelId);
      if (client.getQueryState(key)?.fetchStatus === "fetching" || !client.getQueryData(key)) {
        // A fetch in flight may predate this message; refetch rather than patch a page we do not have yet.
        void client.invalidateQueries({ queryKey: key });
      }
      client.setQueryData<MessagePage>(key, (page) =>
        page && !page.messages.some((m) => m.id === message.id)
          ? { ...page, messages: [...page.messages, message] }
          : page,
      );
      client.setQueryData<Channel[]>(qk.channels, (list) =>
        list
          ?.map((c) => (c.id === message.channelId ? { ...c, lastMessage: message } : c))
          .sort((a, b) => (b.lastMessage?.createdAt ?? b.createdAt) - (a.lastMessage?.createdAt ?? a.createdAt)),
      );
      return;
    }
    case "agent.state":
      client.setQueryData<Agent[]>(qk.agents, (list) => list?.map((a) => (a.id === event.agentId ? { ...a, state: event.state } : a)));
      client.setQueryData<Channel[]>(qk.channels, (list) => list?.map((c) => (c.agentId === event.agentId ? { ...c, agentState: event.state } : c)));
      return;
    case "agent.updated":
      client.setQueryData<Agent[]>(qk.agents, (list) => {
        if (!list) return list;
        return list.some((a) => a.id === event.agent.id) ? list.map((a) => (a.id === event.agent.id ? event.agent : a)) : [...list, event.agent];
      });
      return;
    case "agent.deleted":
      client.setQueryData<Agent[]>(qk.agents, (list) => list?.filter((a) => a.id !== event.agentId));
      void client.invalidateQueries({ queryKey: qk.channels });
      return;
    case "run.updated":
      refreshRunsSoon(client, event.run.agentId);
      return;
    case "activity.created":
      refreshRunsSoon(client, event.activity.agentId);
      return;
    case "workstation.updated":
      client.setQueryData<Workstation[]>(qk.workstations, (list) => {
        if (!list) return list;
        return list.some((w) => w.id === event.workstation.id)
          ? list.map((w) => (w.id === event.workstation.id ? event.workstation : w))
          : [...list, event.workstation];
      });
      return;
    case "worktree.updated":
      void client.invalidateQueries({ queryKey: qk.worktrees(event.worktree.workstationId) });
      return;
    case "git.pushed":
      void client.invalidateQueries({ queryKey: qk.pushes(event.push.agentId) });
      return;
    case "host.updated":
      client.setQueryData(qk.host, event.host);
      return;
  }
}

const RUNS_REFRESH_MS = 400;
const pendingRunRefresh = new Map<string, ReturnType<typeof setTimeout>>();

/** Busy runs emit many events; coalesce them into one inspector refetch per agent. */
function refreshRunsSoon(client: QueryClient, agentId: string): void {
  if (pendingRunRefresh.has(agentId)) return;
  pendingRunRefresh.set(
    agentId,
    setTimeout(() => {
      pendingRunRefresh.delete(agentId);
      void client.invalidateQueries({ queryKey: qk.agentRuns(agentId) });
      void client.invalidateQueries({ queryKey: qk.agentUsage(agentId) });
      void client.invalidateQueries({ queryKey: qk.usage });
    }, RUNS_REFRESH_MS),
  );
}
