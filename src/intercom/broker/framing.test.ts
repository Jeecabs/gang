import test from "node:test";
import assert from "node:assert/strict";
import type { Socket } from "node:net";
import { createMessageReader, MAX_FRAME_BYTES, writeMessage } from "./framing.ts";

test("framing reads messages split across chunks", () => {
  let written: Buffer | undefined;
  const socket = {
    write(chunk: Buffer) {
      written = Buffer.from(chunk);
      return true;
    },
  } as unknown as Socket;

  writeMessage(socket, { ok: true });
  assert.ok(written);

  const messages: unknown[] = [];
  const reader = createMessageReader((msg) => messages.push(msg), (error) => assert.fail(error.message));
  reader(written.subarray(0, 3));
  reader(written.subarray(3));

  assert.deepEqual(messages, [{ ok: true }]);
});

test("framing rejects oversized outgoing payloads", () => {
  const socket = { write: () => true } as unknown as Socket;
  assert.throws(() => writeMessage(socket, "x".repeat(MAX_FRAME_BYTES + 1)), /exceeds/);
});

test("framing rejects oversized incoming frames before buffering payload", () => {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);

  let error: Error | undefined;
  const reader = createMessageReader(() => assert.fail("message should not be emitted"), (err) => {
    error = err;
  });
  reader(header);

  assert.ok(error);
  assert.match(error.message, /exceeds/);
});
