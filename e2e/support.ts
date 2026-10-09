import { randomBytes } from "node:crypto";

/** One admin password per Playwright run, shared by all specs (they run serially in one worker). */
export const PASSWORD = `e2e-${randomBytes(8).toString("hex")}`;
export const MODEL_URL = "http://127.0.0.1:4391/v1";
export const SHOTS = ".tmp/e2e-results/screens";
