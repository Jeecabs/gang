import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { startGuiServer, recentFeed, parseGuiPort, type GuiServer } from "./server.ts";

async function startTestGui(): Promise<{ gui: GuiServer; port: number }> {
  const gui = startGuiServer({ port: 0, getSnapshot: () => ({ sessions: [], feed: [] }) });
  await once(gui.server, "listening");
  return { gui, port: (gui.server.address() as AddressInfo).port };
}

test("recentFeed drops entries older than the recency window", () => {
  const now = 1_000_000_000_000;
  const hour = 3_600_000;
  const feed = [
    { ts: now - 7 * hour, text: "old" },
    { ts: now - 2 * hour, text: "recent" },
    { ts: now, text: "now" },
    { text: "no-ts" },
  ];
  assert.deepEqual(recentFeed(feed, now, 6 * hour).map((e) => e.text), ["recent", "now"]);
});

test("parseGuiPort rejects invalid values", () => {
  assert.equal(parseGuiPort("8123"), 8123);
  assert.equal(parseGuiPort(0), 0);
  assert.equal(parseGuiPort("bad"), 7717);
  assert.equal(parseGuiPort(-1), 7717);
  assert.equal(parseGuiPort(65_536), 7717);
});

test("GUI emits a routed message over SSE to a connected client", async () => {
  const { gui, port } = await startTestGui();

  try {
    const res = await new Promise<http.IncomingMessage>((resolve) =>
      http.get(`http://127.0.0.1:${port}/events`, resolve));

    // Collect SSE chunks; resolve once we see the routed event.
    let buf = "";
    const gotRouted = new Promise<string>((resolve) => {
      res.on("data", (c: Buffer) => {
        buf += c.toString();
        if (buf.includes("ROUTED-XYZ")) resolve(buf);
      });
    });

    // Wait for the initial snapshot frame so we know the client is registered, then route.
    await new Promise<void>((resolve) => {
      const check = () => (buf.includes('"snapshot"') ? resolve() : setTimeout(check, 5));
      check();
    });
    gui.broadcast({ type: "message", from: "worker", to: "boss", text: "ROUTED-XYZ" });

    const data = await gotRouted;
    assert.match(data, /data: .*ROUTED-XYZ/);
    assert.match(data, /"from":"worker"/);
    res.destroy();
  } finally {
    gui.close();
    await once(gui.server, "close");
  }
});

test("GUI serves the dashboard at /", async () => {
  const { gui, port } = await startTestGui();
  try {
    const body = await new Promise<string>((resolve) => {
      http.get(`http://127.0.0.1:${port}/`, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve(b));
      });
    });
    assert.match(body, /mission control/i);
    assert.match(body, /EventSource\("\/events"\)/);
  } finally {
    gui.close();
    await once(gui.server, "close");
  }
});
