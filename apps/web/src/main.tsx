import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, qk } from "./app/api.ts";
import { App } from "./app/App.tsx";
import "./styles/global.css";

// Any 401 means the session expired: drop to the login screen.
const onError = (error: unknown) => {
  if (error instanceof ApiError && error.status === 401) client.setQueryData(qk.session, { setupRequired: false, user: null });
};

const client = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: { queries: { retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2, refetchOnWindowFocus: false } },
});

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
