import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHelperContext, searchHelperHistory } from "../src/main/helper-context.js";
test("helper packet retains marked original/latest input, chronology, honest omissions and no queued text", () => {
  const rows = Array.from({length:12}, (_, i) => ({ id: `s${i}`, role: i % 2 ? "assistant" : "user", createdAt: `time-${i}`, content: (`Source ${i}: emoji 🙂 and \"quotes\"\n`).repeat(200) }));
  rows.push({ id: "pending", role: "user", state: "queued", content: "PENDING_MUST_NOT_APPEAR" });
  const packet = buildHelperContext(rows, { originalRequestId: "s0" });
  assert.equal(packet.selection.original_request_included, true);
  assert.equal(packet.selection.omitted_messages, 8);
  assert.deepEqual(packet.selection.sources.map(row => row.source_id), ["s0", "s9", "s10", "s11"]);
  assert(packet.selection.sources.every(row => row.omitted_characters > 0));
  assert(packet.textCharacters < 12000);
  assert(!JSON.stringify(packet).includes("PENDING_MUST_NOT_APPEAR"));
  assert(!JSON.stringify(packet.selection).includes("Source 0:"), "receipt keeps metadata, not duplicate text");
  assert.equal(buildHelperContext(rows).selection.original_request_included, false);
});
test("original user photo remains available after text steering and names its true source", () => {
  const rows = [{ id: "photo", role: "user", content: [{ type: "text", text: "Analyze this image" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }, { id: "steer", role: "user", content: "Focus on the red object" }];
  const packet = buildHelperContext(rows, { originalRequestId: "photo", query: "image" });
  assert.equal(packet.selection.image_source.source_id, "photo");
  assert.equal(packet.messages[1].content[1].image_url.url, "data:image/png;base64,AAAA");
  const found = searchHelperHistory([...rows, { id: "secret", role: "user", delivery: "paused", content: "unconsumed" }], "red");
  assert.equal(found.sources[0].source_id, "steer");
  assert(!JSON.stringify(found).includes("unconsumed"));
});
test("helper selection metadata survives the visible receipt and session reload without excerpt text", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "collar-helper-receipt-"));
  process.env.NOVAPUP_HOME = home;
  try {
    const { describeTool } = await import("../src/main/describe.js");
    const { bootSessions, saveSession, readSession } = await import("../src/main/sessions.js");
    const packet = buildHelperContext([{ id: "original", role: "user", content: "PRIVATE_EXCERPT_BODY" }], { originalRequestId: "original" });
    const receipt = describeTool("subagent", { pack: "host" }, { ok: true, summary: "Checked.", used: [], contextSelection: packet.selection });
    const { session } = bootSessions();
    saveSession(session.id, [receipt]);
    const restored = readSession(session.id).messages[0];
    assert.deepEqual(restored.contextSelection, packet.selection);
    assert(!JSON.stringify(restored).includes("PRIVATE_EXCERPT_BODY"));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
