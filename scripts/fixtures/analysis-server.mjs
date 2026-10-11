// Test-only MCP peer. This tests Collar's lifecycle, not Ghidra's analysis.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { writeFileSync } from 'node:fs';
const server = new Server({ name: 'test-analysis', version: '1' }, { capabilities: { tools: {} } });
let path = '';
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools:
  ['open_binary', 'close_binary', 'export_evidence_bundle', 'echo', 'wait', 'fail', 'large'].map(name => ({ name,
    description: name, inputSchema: { type: 'object', additionalProperties: true } })) }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args = {} } = request.params;
  if (name === 'open_binary') path = args.path;
  if (name === 'export_evidence_bundle') writeFileSync(args.path, JSON.stringify({ path }));
  if (name === 'wait') await new Promise((yes, no) => {
    const timer = setTimeout(yes, 5000);
    extra.signal.addEventListener('abort', () => { clearTimeout(timer); no(new Error('Cancelled')); }, { once: true });
  });
  const data = name === 'large' ? { text: 'Evidence '.repeat(9000) } : { path, args };
  return { isError: name === 'fail', content: [{ type: 'text', text: JSON.stringify(data) }] };
});
await server.connect(new StdioServerTransport());
