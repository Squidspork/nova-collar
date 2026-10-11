// Local stdio MCP server: stdout is reserved for JSON-RPC. No listening port.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { NetworkCore } from './network-core.js';
import { NETWORK_TOOLS, NETWORK_EFFECTS } from './network-tools.js';

const core = new NetworkCore({ home: process.env.NOVA_NETWORK_HOME });
const server = new Server({ name: 'nova-collar-wireshark', version: '0.4.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: NETWORK_TOOLS.map(({ properties, required, ...tool }) => ({
  ...tool, inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: !NETWORK_EFFECTS.has(tool.name) && tool.name !== 'network_stop', destructiveHint: false, openWorldHint: ['network_discover', 'network_capture'].includes(tool.name) },
})) }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  try {
    const result = await core.call(request.params.name, request.params.arguments, { signal: extra.signal });
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: result.ok === false };
  } catch (error) {
    const result = { ok: false, error: String(error.message).slice(0, 2000) };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: true };
  }
});
let closing = false;
function close() {
  if (closing) return; closing = true; core.close();
  // Allow dumpcap to flush before the MCP worker exits.
  const deadline = setTimeout(() => process.exit(0), 2200);
  const poll = setInterval(() => {
    if (core.controllers.size) return;
    clearInterval(poll); clearTimeout(deadline); server.close().finally(() => process.exit(0));
  }, 50);
}
process.on('SIGTERM', close); process.on('SIGINT', close); process.stdin.on('end', close);
await server.connect(new StdioServerTransport());
