import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, qk } from "../../app/api.ts";
import { Button } from "../../components/ui/Button.tsx";
import { ErrorNote, Field, TextInput } from "../../components/ui/Field.tsx";
import { HiveMark } from "../../components/Shell.tsx";

export function AuthPage({ mode }: { mode: "setup" | "login" }) {
  const client = useQueryClient();
  const [username, setUsername] = useState(mode === "setup" ? "admin" : "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = mode === "setup" && confirm.length > 0 && confirm !== password;

  const submit = useMutation({
    mutationFn: () => (mode === "setup" ? api.setup({ username, password }) : api.login({ username, password })),
    onSuccess: (session) => client.setQueryData(qk.session, session),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!mismatch) submit.mutate();
  };

  return (
    <div className="grid min-h-dvh place-items-center px-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-6 rounded-card border border-line bg-surface/90 p-7 shadow-lift backdrop-blur">
        <div className="space-y-3">
          <HiveMark size={34} />
          <h1 className="text-[length:var(--text-display)] leading-tight font-extrabold tracking-tight">
            {mode === "setup" ? "Set up your hive" : "Welcome back"}
          </h1>
          <p className="text-sm text-muted">
            {mode === "setup"
              ? "Create the admin account. This screen only appears once."
              : "Sign in to talk to your agents."}
          </p>
        </div>
        <div className="space-y-4">
          <Field label="Username">
            <TextInput autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
          </Field>
          <Field label="Password" hint={mode === "setup" ? "At least 12 characters." : undefined}>
            <TextInput type="password" autoComplete={mode === "setup" ? "new-password" : "current-password"} minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          {mode === "setup" ? (
            <Field label="Confirm password" hint={mismatch ? <span className="text-err">Passwords do not match.</span> : undefined}>
              <TextInput type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </Field>
          ) : null}
        </div>
        <ErrorNote error={submit.error} />
        <Button type="submit" variant="primary" className="w-full" disabled={submit.isPending || mismatch}>
          {submit.isPending ? "Working…" : mode === "setup" ? "Create admin" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
