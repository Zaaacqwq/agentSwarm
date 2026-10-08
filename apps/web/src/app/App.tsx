import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api, qk } from "./api.ts";
import { useLiveEvents } from "./live.ts";
import { Shell } from "../components/Shell.tsx";
import { AuthPage } from "../pages/auth/AuthPage.tsx";
import { ChatPage } from "../pages/chat/ChatPage.tsx";
import { AgentsPage } from "../pages/agents/AgentsPage.tsx";
import { SettingsPage } from "../pages/settings/SettingsPage.tsx";
import { WorkstationsPage } from "../pages/workstations/WorkstationsPage.tsx";

export function App() {
  const session = useQuery({ queryKey: qk.session, queryFn: api.session, staleTime: Infinity });
  const signedIn = !!session.data?.user;
  const live = useLiveEvents(signedIn);

  if (session.isPending) return <div className="grid min-h-dvh place-items-center text-sm text-muted">Loading…</div>;
  if (session.isError) return <div className="grid min-h-dvh place-items-center text-sm text-err">Cannot reach hived. Is it running?</div>;
  if (!signedIn) return <AuthPage mode={session.data.setupRequired ? "setup" : "login"} />;

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Shell live={live} />}>
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/chat/:channelId" element={<ChatPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/agents/:agentId" element={<AgentsPage />} />
          <Route path="/workstations" element={<WorkstationsPage />} />
          <Route path="/workstations/:workstationId" element={<WorkstationsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
