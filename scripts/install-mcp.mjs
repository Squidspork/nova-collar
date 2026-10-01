#!/usr/bin/env node
/** MCP stdio for the installer. Same steps as `np install`, one tool at a time. */

import { applyEndpoint, applyFound, applyPull, inspectInstall } from "../src/main/install.js";

const tools = [
  {
    name: "install_scan",
    description: "Memory on this computer, model servers already answering, and whether Laya is present. Downloads nothing.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "install_apply",
    description: "Save the chat model. source is endpoint, found, or pull. Bring your own address with endpoint. found uses a server from install_scan. pull downloads a local model that fits. A key is stored and not returned.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["endpoint", "found", "pull"] },
        model: { type: "string" },
        url: { type: "string" },
        kind: { type: "string" },
        chatKey: { type: "string" },
      },
      required: ["source"],
    },
  },
];

function send(msg) {
  const body = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function publicScan(info) {
  return {
    memory: info.memory,
    found: info.found.map((row) => ({ name: row.name, url: row.url, models: row.models, kind: row.kind })),
    laya: { ready: info.laya.ready, diskGb: info.laya.diskGb, ramGb: info.laya.ramGb },
    localFit: info.localFit,
  };
}

async function callTool(name, args) {
  if (name === "install_scan") return publicScan(await inspectInstall());
  if (name === "install_apply") {
    const source = String(args.source || "");
    if (source === "endpoint") return applyEndpoint({ url: args.url, model: args.model, chatKey: args.chatKey });
    if (source === "found") {
      return applyFound({ url: args.url, kind: args.kind || "ollama", models: [args.model].filter(Boolean) }, args.model);
    }
    if (source === "pull") return applyPull((line) => process.stderr.write(`${line}\n`));
    return { ok: false, error: "source must be endpoint, found, or pull" };
  }
  return { ok: false, error: "unknown tool" };
}

let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buf.slice(0, headerEnd).toString();
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buf = buf.slice(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buf.length < start + length) return;
    const raw = buf.slice(start, start + length).toString();
    buf = buf.slice(start + length);
    handle(raw).catch((error) => {
      process.stderr.write(`${error.message || error}\n`);
    });
  }
});

async function handle(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "nova-collar-install", version: "0.1.0" },
      },
    });
    return;
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
    return;
  }
  if (msg.method === "tools/call") {
    const result = await callTool(msg.params?.name, msg.params?.arguments || {});
    const text = JSON.stringify(result);
    const leaked = msg.params?.arguments?.chatKey && text.includes(String(msg.params.arguments.chatKey));
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        content: [{ type: "text", text: leaked ? JSON.stringify({ ok: false, error: "refused to echo a key" }) : text }],
        isError: Boolean(result?.ok === false),
      },
    });
  }
}
