import { useEffect, useRef, useState } from "react";
import type { LiveMessage } from "@hive/contracts";
import { api } from "./api.ts";

type Listener = (msg: LiveMessage) => void;
const listeners = new Set<Listener>();
const reconnects = new Set<() => void>();
let socket: WebSocket | null = null;
let retry = 1000;
let connectedBefore = false;

function connect(): void {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`);
  socket = ws;
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data)) as LiveMessage;
    for (const l of listeners) l(msg);
  };
  ws.onopen = () => {
    retry = 1000;
    // Events sent while the socket was down are missed; let views reload.
    if (connectedBefore) for (const fn of reconnects) fn();
    connectedBefore = true;
  };
  ws.onclose = () => {
    socket = null;
    if (listeners.size) setTimeout(connect, (retry = Math.min(retry * 2, 15_000)));
  };
}

/** Every live message from hived, for as long as the component is mounted. */
export function useLive(listener: Listener): void {
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => {
    const l: Listener = (m) => ref.current(m);
    listeners.add(l);
    if (!socket) connect();
    return () => void listeners.delete(l);
  }, []);
}

/** Runs `fn` whenever the live connection comes back after a drop. */
export function useReconnect(fn: () => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const f = () => ref.current();
    reconnects.add(f);
    return () => void reconnects.delete(f);
  }, []);
}

/** Loads a resource and reloads it on demand; `set` lets live updates patch it in place. */
export function useResource<T>(path: string | null): { data: T | null; error: string | null; reload: () => void; set: (fn: (prev: T | null) => T | null) => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    api<T>("GET", path).then((d) => alive && (setData(d), setError(null))).catch((e: Error) => alive && setError(e.message));
    return () => void (alive = false);
  }, [path, tick]);
  return { data, error, reload: () => setTick((t) => t + 1), set: setData };
}
