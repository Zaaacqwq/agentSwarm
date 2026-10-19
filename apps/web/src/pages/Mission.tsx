import { useEffect, useRef, useState } from "react";
import type { MissionMessageView, MissionView } from "@agentswarm/contracts";
import { api, money, when } from "../api.ts";
import { useLive, useReconnect, useResource } from "../live.ts";
import { Badge, Field, Form, PageHead } from "../components/ui.tsx";
import { STAGE_LABEL, StageRail } from "../components/StageRail.tsx";
import { Tree } from "../components/Tree.tsx";
import { TreeActivity } from "../components/Activity.tsx";
import { Link } from "../router.tsx";

export function MissionPage({ id }: { id: string }) {
  const mission = useResource<MissionView>(`/missions/${id}`);
  const messages = useResource<MissionMessageView[]>(`/missions/${id}/messages`);
  useReconnect(() => {
    mission.reload();
    messages.reload();
  });
  useLive((m) => {
    if (m.kind === "mission" && m.mission.id === id) mission.set(() => m.mission);
    if (m.kind === "mission_message" && m.message.missionId === id) messages.set((prev) => (prev?.some((x) => x.id === m.message.id) ? prev : [...(prev ?? []), m.message]));
  });
  if (!mission.data) return mission.error ? <p className="error">{mission.error}</p> : null;
  const m = mission.data;
  const ended = m.stage === "done" || m.stage === "cancelled";
  const approval = [...(messages.data ?? [])].reverse().find((x) => x.kind === "approval");
  return (
    <div className="stack">
      <PageHead title={m.title} sub={<><span className={m.waitingForYou ? "needs-you" : "muted"}>{m.waitingForYou ? "Needs you · " : ""}{STAGE_LABEL[m.stage]}</span> · {m.githubRepo} · <span className="mono">{m.branch}</span>{m.linear && <> · <a href={m.linear.url} target="_blank" rel="noreferrer">{m.linear.key} ↗</a></>}</>}
        action={ended ? undefined : <button className="btn ghost" onClick={() => confirm("Stop this mission? Running agents are cancelled.") && api("POST", `/missions/${id}/cancel`, {}).catch((e: Error) => alert(e.message))}>Stop mission</button>} />
      <StageRail stage={m.stage} fast={m.fast} />
      {m.stage === "awaiting_approval" && <ApprovalGate mission={m} summary={approval?.text ?? m.stageSummary ?? ""} />}
      {m.stage === "awaiting_merge" && m.prUrl && (
        <section className="card gate-card" aria-labelledby="merge-head">
          <h2 id="merge-head">The pull request is ready</h2>
          <p>Review it on GitHub and merge it when you are happy (or close it to drop the mission). agentSwarm notices within a few minutes, writes a short retrospective and cleans up.</p>
          <p><a className="btn signal" href={m.prUrl} target="_blank" rel="noreferrer">Open the pull request ↗</a></p>
        </section>
      )}
      {m.error && <div className="card error" role="alert">{m.error} · reply below to let the lead continue.</div>}
      <div className="split">
        <Conversation mission={m} messages={messages.data ?? []} ended={ended} />
        <aside className="stack">
          <section className="card stack" aria-label="Mission facts">
            <div className="row" style={{ gap: "var(--space-8)" }}>
              <div className="stat"><b>{money(m.costUsd)}</b><span>of {money(m.budgetUsd)}</span></div>
              <div className="stat"><b>{m.leadStatus === "succeeded" ? <Badge status="cancelled">idle</Badge> : <Badge status={m.leadStatus} />}</b><span>Lead</span></div>
            </div>
            {!ended && <BudgetEdit mission={m} />}
            <div>
              <h3 className="mini">Your words</h3>
              <p className="quote">{m.intent}</p>
            </div>
            <div>
              <h3 className="mini">Documents</h3>
              {m.docs.length ? <ul className="plain">{m.docs.map((d) => <li key={d.name}><a href={d.url} target="_blank" rel="noreferrer">{d.name} ↗</a></li>)}</ul> : <p className="faint">None yet; they appear as stages finish ({m.docsPath}/).</p>}
            </div>
            {m.prUrl && <p>Pull request: <a href={m.prUrl} target="_blank" rel="noreferrer">{m.prUrl.split("/").slice(-2).join(" #")}</a> {m.prState && <Badge status={m.prState === "merged" ? "ok" : m.prState === "closed" ? "cancelled" : "running"}>{m.prState}</Badge>}</p>}
            <p className="faint">
              Lead run: <Link to={`/agents/${m.leadAgentId}/runs/${m.rootRunId}`}>timeline</Link>
              {m.discordThreadId ? " · in Discord" : ""} · started {when(m.createdAt)}
            </p>
          </section>
          {m.retro && (
            <section className="card" aria-labelledby="retro-head">
              <h2 id="retro-head">Retrospective</h2>
              <p className="pre">{m.retro}</p>
            </section>
          )}
        </aside>
      </div>
      <Tree treeId={m.treeId} current={m.rootRunId} />
      <TreeActivity treeId={m.treeId} />
    </div>
  );
}

function ApprovalGate({ mission, summary }: { mission: MissionView; summary: string }) {
  const [changing, setChanging] = useState(false);
  const [comment, setComment] = useState("");
  const plan = mission.docs.find((d) => d.name === "plan.md");
  return (
    <section className="card gate-card" aria-labelledby="gate-head">
      <h2 id="gate-head">The plan is waiting for your approval</h2>
      <p className="pre">{summary}</p>
      {plan && <p><a href={plan.url} target="_blank" rel="noreferrer">Read the full plan ↗</a></p>}
      <p className="faint">Nothing is built until you approve.</p>
      {!changing ? (
        <div className="row">
          <button className="btn signal" onClick={() => api("POST", `/missions/${mission.id}/approve`, {}).catch((e: Error) => alert(e.message))}>Approve the plan</button>
          <button className="btn ghost" onClick={() => setChanging(true)}>Request changes</button>
        </div>
      ) : (
        <Form submit="Send back to planning" onSubmit={async () => {
          await api("POST", `/missions/${mission.id}/changes`, { text: comment });
          setComment("");
          setChanging(false);
        }}>
          <Field label="What should change?"><textarea value={comment} onChange={(e) => setComment(e.target.value)} required /></Field>
        </Form>
      )}
    </section>
  );
}

function Conversation({ mission, messages, ended }: { mission: MissionView; messages: MissionMessageView[]; ended: boolean }) {
  const [text, setText] = useState("");
  const list = useRef<HTMLOListElement>(null);
  // Keep the newest message in view inside the scrolling list. (Return nothing: some browsers'
  // scroll methods return a Promise, which React would take for a cleanup function.)
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [messages.length]);
  const asking = [...messages].reverse().find((x) => x.author !== "system")?.kind === "question";
  return (
    <section className="card stack chat-card" aria-labelledby="chat-head">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="chat-head">Conversation</h2>
        <span className="faint">{mission.linear ? "Also in its Linear ticket" : mission.discordThreadId ? "Also in its Discord thread" : "Dashboard only"}</span>
      </div>
      <ol className="chat" ref={list}>
        {messages.map((x) => <Message key={x.id} m={x} />)}
      </ol>
      {!ended && (
        <Form submit={mission.stage === "awaiting_approval" ? "Send as a change request" : asking ? "Answer" : "Send to the lead"} onSubmit={async () => {
          await api("POST", `/missions/${mission.id}/messages`, { text });
          setText("");
        }}>
          <Field label={asking ? "Your answer" : "Message the lead"}><textarea value={text} onChange={(e) => setText(e.target.value)} required style={{ minHeight: 72 }} /></Field>
        </Form>
      )}
    </section>
  );
}

function Message({ m }: { m: MissionMessageView }) {
  if (m.author === "system" && m.kind === "stage") return <li className="msg divider"><span>{m.text.replace(/^Stage: /, "")}</span></li>;
  const who = m.author === "user" ? `You${m.source === "discord" ? " · Discord" : ""}` : m.author === "lead" ? (m.kind === "question" ? "Lead asks" : m.kind === "approval" ? "Lead · plan for approval" : "Lead") : m.kind === "error" ? "Problem" : "agentSwarm";
  return (
    <li className={`msg ${m.author} ${m.kind}`}>
      <div className="who">{who} <span className="faint">{new Date(m.createdAt).toLocaleTimeString()}</span></div>
      <p className="pre">{m.text}</p>
    </li>
  );
}

function BudgetEdit({ mission }: { mission: MissionView }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(String(mission.budgetUsd));
  if (!open) return <button className="btn ghost small" onClick={() => setOpen(true)}>Change budget</button>;
  return (
    <Form submit="Set budget" onSubmit={async () => {
      await api("PUT", `/missions/${mission.id}/budget`, { budgetUsd: Number(value) });
      setOpen(false);
    }}>
      <Field label="Budget (USD)"><input type="number" min={0.1} max={50} step={0.1} value={value} onChange={(e) => setValue(e.target.value)} required /></Field>
    </Form>
  );
}
