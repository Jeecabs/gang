import assert from "node:assert/strict";
import test from "node:test";

import { renderGangResult } from "./index.ts";

const theme = {
  fg: (_color: string, text: string) => text,
} as any;

const result = {
  content: [{ type: "text" as const, text: "Gang members (run 12345678).\nworker · running\nreviewer · done" }],
  details: undefined,
};

test("gang result is compact by default and complete when expanded", () => {
  const collapsed = renderGangResult(result, { expanded: false, isPartial: false }, theme, false).render(500).join("\n");
  assert.match(collapsed, /^Gang members \(run 12345678\)\./);
  assert.doesNotMatch(collapsed, /worker · running/);
  assert.match(collapsed, /expand/);

  const expanded = renderGangResult(result, { expanded: true, isPartial: false }, theme, false).render(500).join("\n");
  assert.match(expanded, /worker · running/);
  assert.match(expanded, /reviewer · done/);
});
