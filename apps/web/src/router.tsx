import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

/** Paths are the only routing state, so every view has a shareable URL. */
export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  return path;
}

export function navigate(to: string): void {
  if (to === location.pathname) return;
  history.pushState(null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
}

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  const current = location.pathname === to || (to !== "/" && location.pathname.startsWith(`${to}/`));
  const click = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={click} className={className} aria-current={current ? "page" : undefined}>{children}</a>;
}
