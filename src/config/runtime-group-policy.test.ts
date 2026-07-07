// Covers runtime group-policy resolution from config and context.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  resetMissingProviderGroupPolicyFallbackWarningsForTesting,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
  resolveRuntimeGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "./runtime-group-policy.js";

beforeEach(() => {
  resetMissingProviderGroupPolicyFallbackWarningsForTesting();
});

describe("resolveRuntimeGroupPolicy", () => {
  it.each([
    {
      title: "fails closed when provider config is missing and no defaults are set",
      params: { providerConfigPresent: false },
      expectedPolicy: "allowlist",
      expectedFallbackApplied: true,
    },
    {
      title: "keeps configured fallback when provider config is present",
      params: { providerConfigPresent: true, configuredFallbackPolicy: "open" as const },
      expectedPolicy: "open",
      expectedFallbackApplied: false,
    },
    {
      title: "ignores global defaults when provider config is missing",
      params: {
        providerConfigPresent: false,
        defaultGroupPolicy: "disabled" as const,
        configuredFallbackPolicy: "open" as const,
        missingProviderFallbackPolicy: "allowlist" as const,
      },
      expectedPolicy: "allowlist",
      expectedFallbackApplied: true,
    },
  ])("$title", ({ params, expectedPolicy, expectedFallbackApplied }) => {
    const resolved = resolveRuntimeGroupPolicy(params);
    expect(resolved.groupPolicy).toBe(expectedPolicy);
    expect(resolved.providerMissingFallbackApplied).toBe(expectedFallbackApplied);
  });
});

describe("resolveOpenProviderRuntimeGroupPolicy", () => {
  it("uses open fallback when provider config exists", () => {
    const resolved = resolveOpenProviderRuntimeGroupPolicy({
      providerConfigPresent: true,
    });
    expect(resolved.groupPolicy).toBe("open");
    expect(resolved.providerMissingFallbackApplied).toBe(false);
  });
});

describe("resolveAllowlistProviderRuntimeGroupPolicy", () => {
  it("uses allowlist fallback when provider config exists", () => {
    const resolved = resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: true,
    });
    expect(resolved.groupPolicy).toBe("allowlist");
    expect(resolved.providerMissingFallbackApplied).toBe(false);
  });
});

describe("resolveDefaultGroupPolicy", () => {
  it("returns channels.defaults.groupPolicy when present", () => {
    const resolved = resolveDefaultGroupPolicy({
      channels: { defaults: { groupPolicy: "disabled" } },
    });
    expect(resolved).toBe("disabled");
  });
});

describe("warnMissingProviderGroupPolicyFallbackOnce", () => {
  it("logs only once per provider/account key", () => {
    const lines: string[] = [];
    const first = warnMissingProviderGroupPolicyFallbackOnce({
      providerMissingFallbackApplied: true,
      providerKey: "runtime-policy-test",
      accountId: "account-a",
      blockedLabel: GROUP_POLICY_BLOCKED_LABEL.room,
      log: (message) => lines.push(message),
    });
    const second = warnMissingProviderGroupPolicyFallbackOnce({
      providerMissingFallbackApplied: true,
      providerKey: "runtime-policy-test",
      accountId: "account-a",
      blockedLabel: GROUP_POLICY_BLOCKED_LABEL.room,
      log: (message) => lines.push(message),
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("channels.runtime-policy-test is missing");
    expect(lines[0]).toContain("room messages blocked");
  });
});

describe("warnedMissingProviderGroupPolicy LRU eviction", () => {
  let warnOnceFn: typeof warnMissingProviderGroupPolicyFallbackOnce;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("./runtime-group-policy.js");
    warnOnceFn = mod.warnMissingProviderGroupPolicyFallbackOnce;
  });

  it("evicts the least-recently-used entry when the cache exceeds its cap", () => {
    const CAP = 4096;
    const noopLog = () => {};

    // Fill the cache to cap via the public API.
    for (let i = 1; i <= CAP; i++) {
      warnOnceFn({
        providerMissingFallbackApplied: true,
        providerKey: `provider-${i}`,
        accountId: `account-${i}`,
        log: noopLog,
      });
    }

    // Push past the cap — "provider-1:account-1" was the first seeded entry.
    for (let i = CAP + 1; i <= CAP + 5; i++) {
      warnOnceFn({
        providerMissingFallbackApplied: true,
        providerKey: `provider-${i}`,
        accountId: `account-${i}`,
        log: noopLog,
      });
    }

    // Re-warn for the evicted entry — must emit (not deduped).
    const lines: string[] = [];
    const result = warnOnceFn({
      providerMissingFallbackApplied: true,
      providerKey: "provider-1",
      accountId: "account-1",
      log: (m) => lines.push(m),
    });
    expect(result).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("channels.provider-1 is missing");
  });

  it("keeps frequently accessed entries from being evicted (LRU touch)", () => {
    const CAP = 4096;
    const noopLog = () => {};

    // Seed cache to near-capacity.
    for (let i = 1; i < CAP; i++) {
      warnOnceFn({
        providerMissingFallbackApplied: true,
        providerKey: `provider-${i}`,
        accountId: `account-${i}`,
        log: noopLog,
      });
    }

    // Frequently touch "provider-2:account-2" to promote its recency.
    for (let i = 0; i < 42; i++) {
      warnOnceFn({
        providerMissingFallbackApplied: true,
        providerKey: "provider-2",
        accountId: "account-2",
        log: noopLog,
      });
    }

    // Push 500 extra entries past the cap.
    for (let i = CAP; i <= CAP + 500; i++) {
      warnOnceFn({
        providerMissingFallbackApplied: true,
        providerKey: `provider-${i}`,
        accountId: `account-${i}`,
        log: noopLog,
      });
    }

    // "provider-2:account-2" should still be cached because of LRU touches.
    const result = warnOnceFn({
      providerMissingFallbackApplied: true,
      providerKey: "provider-2",
      accountId: "account-2",
      log: () => {},
    });
    expect(result).toBe(false);
  });
});
