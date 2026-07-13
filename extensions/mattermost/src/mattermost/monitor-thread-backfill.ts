import { getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MattermostClient, MattermostPost } from "./client.js";
import type { HistoryEntry } from "./runtime-api.js";
import { fetchMattermostThreadPosts } from "./thread-posts.js";

type MattermostThreadBackfillFetcher = (
  client: MattermostClient,
  rootPostId: string,
  options: { limit: number; signal?: AbortSignal },
) => Promise<MattermostPost[]>;

// Cap the per-thread backfill marker map so it cannot outgrow the 1000-key
// `channelHistories` window it accompanies; an evicted thread simply
// re-backfills on its next cold inbound turn.
const MAX_THREAD_BACKFILL_MARKERS = 1000;

// Evict oldest marker keys (Map insertion order = LRU) once the map exceeds the
// cap. Kept local to the plugin so core history internals stay untouched.
function evictOldThreadBackfillMarkers(markers: Map<string, string>): void {
  while (markers.size > MAX_THREAD_BACKFILL_MARKERS) {
    const oldestKey = markers.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    markers.delete(oldestKey);
  }
}

export async function backfillMattermostThreadHistoryForMonitor(params: {
  client: MattermostClient;
  post: MattermostPost;
  threadRootId: string | undefined;
  historyKey: string | null;
  baseSessionKey: string;
  adoptBackfillSessionKey?: string;
  historyLimit: number;
  channelHistories: Map<string, HistoryEntry[]>;
  threadBackfillMarkers: Map<string, string>;
  threadBackfillInFlight: Map<string, Promise<void>>;
  fetchThreadPosts?: MattermostThreadBackfillFetcher;
  timeoutMs?: number;
}): Promise<void> {
  const {
    client,
    post,
    threadRootId,
    historyKey,
    baseSessionKey,
    adoptBackfillSessionKey,
    historyLimit,
    channelHistories,
    threadBackfillMarkers,
    threadBackfillInFlight,
    fetchThreadPosts = fetchMattermostThreadPosts,
    timeoutMs = 10_000,
  } = params;
  if (!threadRootId || !historyKey || historyLimit <= 0) {
    return;
  }

  // One marker per thread history key: the value is the current session marker.
  // This bounds marker memory and lookup cost to the number of live threads,
  // instead of accumulating a `${historyKey}:${session}` entry for every session
  // rotation and scanning the whole process-lifetime set on each candidate.
  // Writes refresh LRU order and stay under the local 1000-key cap so the marker
  // map cannot outgrow the `channelHistories` window it accompanies.
  const setMarker = (session: string): void => {
    threadBackfillMarkers.delete(historyKey);
    threadBackfillMarkers.set(historyKey, session);
    evictOldThreadBackfillMarkers(threadBackfillMarkers);
  };

  const currentMarker = threadBackfillMarkers.get(historyKey);
  if (currentMarker === baseSessionKey) {
    // Same-session marker already set. If a first cold turn is still fetching
    // (zero-debounce inbound bursts overlap on the awaited network boundary),
    // await that one bounded request so this turn reads the recovered window
    // instead of replying without prior context. No in-flight entry means the
    // fetch already completed, returned empty, timed out, or failed, and the
    // completed marker intentionally suppresses a retry.
    const inFlight = threadBackfillInFlight.get(historyKey);
    if (inFlight) {
      await inFlight.catch(() => {});
    }
    return;
  }
  // Adopt the earlier pending marker once the stored session id appears, so a
  // same-session follow-up does not refetch while a later real session rotation
  // still can.
  if (adoptBackfillSessionKey && currentMarker === adoptBackfillSessionKey) {
    setMarker(baseSessionKey);
    return;
  }
  const hasPriorBackfillForThread = currentMarker !== undefined;

  const existing = channelHistories.get(historyKey);
  if (existing && existing.length > 0 && !hasPriorBackfillForThread) {
    setMarker(baseSessionKey);
    return;
  }

  // Set the completed-attempt marker before awaiting so overlapping same-session
  // turns take the branch above and await this one operation. Publish the
  // in-flight promise so those turns can wait for the recovered window; clear it
  // in `finally` so the marker alone governs no-retry afterwards.
  setMarker(baseSessionKey);
  // Capture the marker this recovery owns so a stale older-session response
  // that resolves last does not overwrite a newer session's recovered window.
  // If the marker rotated while the fetch was in flight, skip the write.
  const ownedMarker = baseSessionKey;
  const recovery = (async () => {
    const abort = new AbortController();
    const timeoutId = setTimeout(() => abort.abort(), timeoutMs);
    try {
      // Request one extra post so the window still fills after we drop the
      // triggering post below when it is among the newest entries.
      const threadPosts = await fetchThreadPosts(client, threadRootId, {
        limit: historyLimit + 1,
        signal: abort.signal,
      });
      if (threadPosts.length === 0) {
        return;
      }

      // Filter current post before trimming so the history window is fully
      // utilized even when the triggering post is among the newest entries.
      const others = threadPosts.filter((p) => p.id !== post.id);
      const windowed = others.slice(-historyLimit);
      const entries: HistoryEntry[] = [];
      for (const p of windowed) {
        entries.push({
          sender: p.user_id ?? "unknown",
          body: p.message || "[attachment]",
          timestamp: typeof p.create_at === "number" ? p.create_at : undefined,
          messageId: p.id ?? undefined,
        });
      }
      if (entries.length > 0 && threadBackfillMarkers.get(historyKey) === ownedMarker) {
        channelHistories.set(historyKey, entries);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  })();
  threadBackfillInFlight.set(historyKey, recovery);
  try {
    await recovery;
  } catch {
    // Best-effort: server fetch failure or timeout should not block inbound dispatch.
  } finally {
    // Drop the in-flight handle once settled; the completed marker then governs
    // no-retry, and only this owner clears its own operation.
    if (threadBackfillInFlight.get(historyKey) === recovery) {
      threadBackfillInFlight.delete(historyKey);
    }
  }
}

export async function backfillMattermostThreadHistoryForMonitorTurn(params: {
  client: MattermostClient;
  post: MattermostPost;
  threadRootId: string | undefined;
  historyKey: string | null;
  historyLimit: number;
  channelHistories: Map<string, HistoryEntry[]>;
  threadBackfillMarkers: Map<string, string>;
  threadBackfillInFlight: Map<string, Promise<void>>;
  storePath: string;
  sessionKey: string;
}): Promise<void> {
  const currentAgentSessionId = normalizeOptionalString(
    getSessionEntry({ storePath: params.storePath, sessionKey: params.sessionKey })?.sessionId,
  );
  const baseSessionKey = currentAgentSessionId
    ? `session:${currentAgentSessionId}`
    : `pending:${params.sessionKey}`;
  await backfillMattermostThreadHistoryForMonitor({
    client: params.client,
    post: params.post,
    threadRootId: params.threadRootId,
    historyKey: params.historyKey,
    baseSessionKey,
    adoptBackfillSessionKey: currentAgentSessionId ? `pending:${params.sessionKey}` : undefined,
    historyLimit: params.historyLimit,
    channelHistories: params.channelHistories,
    threadBackfillMarkers: params.threadBackfillMarkers,
    threadBackfillInFlight: params.threadBackfillInFlight,
  });
}
