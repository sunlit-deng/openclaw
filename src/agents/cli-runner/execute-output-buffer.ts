const CLI_RUNNER_OUTPUT_TAIL_BYTES = 64 * 1024;

function truncateToUtf8TailWindow(buffer: Buffer): Buffer {
  // Skip UTF-8 continuation bytes so the byte-window cut never splits a
  // multibyte character into U+FFFD replacement noise in diagnostics.
  let start = buffer.byteLength - CLI_RUNNER_OUTPUT_TAIL_BYTES;
  while (start < buffer.byteLength && (buffer[start]! & 0b1100_0000) === 0b1000_0000) {
    start += 1;
  }
  return Buffer.from(buffer.subarray(start));
}

export function appendCliOutputTail(tail: Buffer, chunk: string): Buffer {
  if (!chunk) {
    return tail;
  }
  const chunkBuffer = Buffer.from(chunk);
  if (chunkBuffer.byteLength >= CLI_RUNNER_OUTPUT_TAIL_BYTES) {
    return truncateToUtf8TailWindow(chunkBuffer);
  }
  const next = Buffer.concat([tail, chunkBuffer], tail.byteLength + chunkBuffer.byteLength);
  if (next.byteLength <= CLI_RUNNER_OUTPUT_TAIL_BYTES) {
    return next;
  }
  return truncateToUtf8TailWindow(next);
}
