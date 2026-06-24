import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { startGuiServer } from "./server.ts";

test("GUI emits a routed message over SSE to a connected client", async () => {
  const gui = startGuiServer({ port: 0, getSnapshot: () => ({ sessions: [], feed: [] }) });
  await once(gui.server, "listening");
  const port = (gui.server.address() as AddressInfo).port;

  try {
    const res = await new Promise<http.IncomingMessage>((resolve) =>
      http.get(`http://localhost:${port}/events`, resolve));

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
  const gui = startGuiServer({ port: 0, getSnapshot: () => ({ sessions: [], feed: [] }) });
  await once(gui.server, "listening");
  const port = (gui.server.address() as AddressInfo).port;
  try {
    const body = await new Promise<string>((resolve) => {
      http.get(`http://localhost:${port}/`, (res) => {
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
