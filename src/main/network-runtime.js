import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join } from 'node:path';
import { APP_HOME, ROOT } from './config.js';
import { networkEnv } from './network-core.js';

export class NetworkRuntime {
  constructor({ home = join(APP_HOME, 'network'), command = process.execPath, entry = join(ROOT, 'src/main/network-mcp.js') } = {}) {
    this.home = home; this.command = command; this.entry = entry; this.client = null; this.transport = null; this.connecting = null;
  }
  async connect() {
    if (this.connecting) return this.connecting;
    if (this.client) return this.client;
    this.connecting = (async () => {
      const transport = new StdioClientTransport({ command: this.command, args: [this.entry],
        env: { ...networkEnv(), ELECTRON_RUN_AS_NODE: '1', NOVA_NETWORK_HOME: this.home }, stderr: 'pipe' });
      const client = new Client({ name: 'nova-collar', version: '0.4.0' }, { capabilities: {} });
      this.transport = transport;
      client.onclose = () => { if (this.client === client) this.client = null; };
      try {
        await client.connect(transport, { timeout: 10000 });
        // Drain diagnostic output without copying local paths into chat history.
        transport.stderr?.on('data', () => {});
        const list = await client.listTools();
        if (!list.tools.some(t => t.name === 'network_capture')) throw new Error('Wireshark MCP tools unavailable');
        this.client = client; return client;
      } catch (error) { await transport.close(); this.transport = null; throw error; }
    })();
    try { return await this.connecting; } finally { this.connecting = null; }
  }
  async call(name, args = {}, { signal } = {}) {
    if (signal?.aborted) throw new Error('Stopped');
    const client = await this.connect();
    const result = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: 75000 });
    return result.structuredContent || JSON.parse(result.content?.find(row => row.type === 'text')?.text || '{}');
  }
  async close() {
    if (this.connecting) await this.connecting.catch(() => {});
    const client = this.client; this.client = null;
    if (client) {
      await client.callTool({ name: 'network_stop', arguments: {} }, undefined, { timeout: 3000 }).catch(() => {});
      await client.close();
    }
    this.transport = null;
  }
}
export const networkRuntime = new NetworkRuntime();
