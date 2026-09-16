import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

// Bump only after merging the matching upstream tag into src/intercom/.
const VENDORED_PI_INTERCOM_VERSION = "0.13.0";
const require = createRequire(import.meta.url);
const installedUpstream = require("pi-intercom/package.json") as { version?: unknown };

test("tracked Intercom package matches the vendored release marker", () => {
  assert.equal(installedUpstream.version, VENDORED_PI_INTERCOM_VERSION);
});
