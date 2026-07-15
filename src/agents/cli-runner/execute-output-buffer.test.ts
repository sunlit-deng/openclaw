import { describe, expect, it } from "vitest";
import { appendCliOutputTail } from "./execute-output-buffer.js";

const TAIL_BYTES = 64 * 1024;

describe("appendCliOutputTail", () => {
  it("keeps ascii tails bounded to the last window", () => {
    const tail = appendCliOutputTail(Buffer.alloc(0), "a".repeat(TAIL_BYTES + 5000));

    expect(tail.byteLength).toBe(TAIL_BYTES);
    expect(tail.toString("utf8")).toBe("a".repeat(TAIL_BYTES));
  });

  it("returns the existing tail when the chunk is empty", () => {
    const tail = appendCliOutputTail(Buffer.alloc(0), "abc");

    expect(appendCliOutputTail(tail, "")).toBe(tail);
  });

  it("does not split multibyte characters when one chunk overflows the window", () => {
    // 21846 * 3 = 65538 bytes: the byte-window cut lands inside the first character.
    const chunk = "汉".repeat(21846);

    const tail = appendCliOutputTail(Buffer.alloc(0), chunk);
    const decoded = tail.toString("utf8");

    expect(decoded).not.toContain("�");
    expect(decoded).toBe("汉".repeat(21845));
    expect(tail.byteLength).toBeLessThanOrEqual(TAIL_BYTES);
  });

  it("does not split multibyte characters when an appended chunk overflows the window", () => {
    // 21845 * 3 = 65535 bytes of CJK, then 2 ascii bytes push the cut mid-character.
    const tail = appendCliOutputTail(Buffer.alloc(0), "汉".repeat(21845));

    const next = appendCliOutputTail(tail, "ab");
    const decoded = next.toString("utf8");

    expect(decoded).not.toContain("�");
    expect(decoded).toBe(`${"汉".repeat(21844)}ab`);
    expect(next.byteLength).toBeLessThanOrEqual(TAIL_BYTES);
  });
});
