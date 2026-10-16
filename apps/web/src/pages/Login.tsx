import { useEffect, useState } from "react";
import type { Me } from "@hive/contracts";
import { api } from "../api.ts";
import { Field, Form } from "../components/ui.tsx";

export function Login({ onDone }: { onDone: (me: Me) => void }) {
  const [setup, setSetup] = useState<boolean | null>(null);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  useEffect(() => void api<{ required: boolean }>("GET", "/setup").then((s) => setSetup(s.required)), []);
  if (setup === null) return null;
  return (
    <div className="auth">
      <div className="card">
        <h1>Hive</h1>
        <p className="muted">{setup ? "Create the admin account for this Mac." : "Sign in to your agents."}</p>
        <Form submit={setup ? "Create account" : "Sign in"} onSubmit={async () => onDone(await api<Me>("POST", setup ? "/setup" : "/auth/login", { username, password }))}>
          <Field label="Username"><input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></Field>
          <Field label="Password" {...(setup ? { hint: "At least 12 characters." } : {})}>
            <input type="password" autoComplete={setup ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} minLength={12} required />
          </Field>
        </Form>
      </div>
    </div>
  );
}
