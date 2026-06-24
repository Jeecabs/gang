import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendIntercomLog } from "./tap.ts";

test("appendIntercomLog writes one valid JSONL line per routed message", () => {
  const dir = mkdtempSync(join(tmpdir(), "gang-tap-"));
  const logPath = join(dir, "intercom.jsonl");
  try {
    appendIntercomLog({ ts: 1, id: "a", from: "worker", to: "boss", text: "hi", expectsReply: true }, logPath);
    appendIntercomLog({ ts: 2, id: "b", from: "boss", to: "worker", text: "ok", replyTo: "a" }, logPath);

    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 2, "one line per call");

    const first = JSON.parse(lines[0]);
    assert.deepEqual(first, { ts: 1, id: "a", from: "worker", to: "boss", text: "hi", expectsReply: true });

    const second = JSON.parse(lines[1]);
    assert.equal(second.replyTo, "a");
    assert.equal(second.from, "boss");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendIntercomLog creates the log directory if missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "gang-tap-"));
  const logPath = join(dir, "nested", "deep", "intercom.jsonl");
  try {
    appendIntercomLog({ ts: 1, id: "a", from: "a", to: "b", text: "x" }, logPath);
    assert.match(readFileSync(logPath, "utf8"), /"text":"x"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
