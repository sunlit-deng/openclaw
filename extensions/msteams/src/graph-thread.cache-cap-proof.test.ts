// Live proof: exercises the real resolveTeamGroupId with 501 unique team IDs,
// proving pruneMapToMaxSize caps the cache at 500 entries (insertion-order
// eviction, matching the existing Slack/Discord/Nextcloud pattern).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchGraphJson: vi.fn(async () => ({ id: "fake-group-id" })),
}));

vi.mock("./graph.js", () => ({
  fetchGraphJson: mocks.fetchGraphJson,
}));

type GraphThreadModule = typeof import("./graph-thread.js");
let resolveTeamGroupId: GraphThreadModule["resolveTeamGroupId"];
let cacheForTest: GraphThreadModule["_teamGroupIdCacheForTest"];

describe("resolveTeamGroupId cache cap (production path)", () => {
  beforeAll(async () => {
    ({ resolveTeamGroupId, _teamGroupIdCacheForTest: cacheForTest } =
      await import("./graph-thread.js"));
  });

  beforeEach(() => {
    cacheForTest.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cacheForTest.clear();
    vi.clearAllMocks();
  });

  it("caps cache at 500 entries — 501st evicts oldest by insertion order", async () => {
    // Fill exactly 500 entries.
    for (let i = 0; i < 500; i++) {
      await resolveTeamGroupId("fake-token", `team-${i.toString().padStart(8, "0")}`);
    }
    expect(mocks.fetchGraphJson).toHaveBeenCalledTimes(500);
    expect(cacheForTest.size).toBe(500);

    // 501st unique team → pruneMapToMaxSize fires, evicts oldest entry.
    await resolveTeamGroupId("fake-token", "overflow-team");
    expect(mocks.fetchGraphJson).toHaveBeenCalledTimes(501);
    // Cache stays at 500 (not 501).
    expect(cacheForTest.size).toBe(500);

    // team-00000000 was inserted first → evicted by the overflow.
    // Calling it again must trigger a fresh Graph fetch.
    const callsBefore = mocks.fetchGraphJson.mock.calls.length;
    await resolveTeamGroupId("fake-token", "team-00000000");
    expect(mocks.fetchGraphJson).toHaveBeenCalledTimes(callsBefore + 1);
  });

  it("cache hit skips Graph API call", async () => {
    await resolveTeamGroupId("fake-token", "cached-team");
    const calls = mocks.fetchGraphJson.mock.calls.length;
    await resolveTeamGroupId("fake-token", "cached-team");
    expect(mocks.fetchGraphJson).toHaveBeenCalledTimes(calls);
    expect(cacheForTest.size).toBe(1);
  });

  // Negative control: without the cap (simulated by removing pruneMapToMaxSize),
  // 501 inserts would give 501 entries. The production cap prevents this.
  it("negative control: raw Map grows beyond 500 without cap", () => {
    const raw = new Map<string, string>();
    for (let i = 0; i < 501; i++) raw.set(`k${i}`, `v${i}`);
    expect(raw.size).toBe(501);
    // With pruneMapToMaxSize + cap=500, size would be 500, not 501.
  });
});
