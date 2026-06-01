import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Session_start state retained so shutdown can emit any missing session_end. */
export type ActiveSessionForShutdown = {
  /** Config snapshot used to build the eventual shutdown session_end payload. */
  cfg: OpenClawConfig;
  /** Canonical session key that received session_start. */
  sessionKey: string;
  /** Durable run/session id used as the tracker identity. */
  sessionId: string;
  /** Session store path used to resolve transcript candidates at drain time. */
  storePath: string;
  /** Optional persisted/custom transcript file path from the active session. */
  sessionFile?: string;
  /** Agent scope used for per-agent transcript path resolution. */
  agentId?: string;
};

const trackedSessions = new Map<string, ActiveSessionForShutdown>();

/**
 * Track a session_start that may need a paired session_end during shutdown.
 *
 * Membership is keyed by durable session id so replace/reset/delete paths can
 * forget finalized sessions before the shutdown drain tries to close them.
 */
export function noteActiveSessionForShutdown(entry: ActiveSessionForShutdown): void {
  if (!entry.sessionId) {
    return;
  }
  trackedSessions.set(entry.sessionId, entry);
}

/** Forget a finalized session so the shutdown drain cannot double-fire it. */
export function forgetActiveSessionForShutdown(sessionId: string | undefined): void {
  if (!sessionId) {
    return;
  }
  trackedSessions.delete(sessionId);
}

/** Return a snapshot of sessions still awaiting shutdown finalization. */
export function listActiveSessionsForShutdown(): ActiveSessionForShutdown[] {
  return Array.from(trackedSessions.values());
}

/** Clear shutdown tracker state for tests and process-local reset hooks. */
export function clearActiveSessionsForShutdownTracker(): void {
  trackedSessions.clear();
}
