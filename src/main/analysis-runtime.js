import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { APP_HOME, ROOT } from './config.js';
import { denySecretPath } from './safe.js';

const OS = { darwin: 'mac', linux: 'linux', win32: 'win' };
export function analysisBundle() {
  // Packaged apps never consult developer overrides or global installations.
  const packaged = ROOT.endsWith('app.asar');
  const root = packaged ? join(process.resourcesPath, 'analysis')
    : (process.env.NOVA_ANALYSIS_BUNDLE || join(ROOT, `vendor/analysis/${OS[process.platform]}-${process.arch}`));
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
    if (manifest.target !== `${process.platform}-${process.arch}`) throw new Error(`Bundle is for ${manifest.target}`);
    for (const key of ['node', 'entry', 'java', 'java_home', 'ghidra']) {
      const p = resolve(root, manifest[key]);
      const child = relative(resolve(root), p);
      if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('Invalid bundle path');
      if (!existsSync(p)) throw new Error(`Missing bundled ${key}`);
    }
    return { ok: true, root, manifest };
  } catch (error) {
    return { ok: false, root, error: `Software analysis bundle unavailable: ${error.message}. Install a complete Nova Collar build.${packaged ? '' : ' For this source checkout, run npm run analysis:prepare.'}` };
  }
}

export function checkedAnalysisPath(raw) {
  if (typeof raw !== 'string' || !isAbsolute(raw)) throw new Error('Supply the exact absolute local path.');
  const path = existsSync(raw) ? realpathSync(raw) : resolve(raw);
  const denied = denySecretPath(path);
  if (denied) throw new Error(typeof denied === 'string' ? denied : 'This private path is not available to analysis.');
  return path;
}

// Explicit audited static operations. Everything else uses the visible execution
// tool and the same scheduled-task mutation holds as Collar's existing writes.
export const STATIC_ANALYSIS_TOOLS = new Set([
  'binary_session', 'binary_overview', 'inspect_artifact', 'analyze_javascript_application',
  'inspect_analysis_view', 'search_analysis',
  'analyze_function', 'inspect_native_api', 'list_procedures', 'list_names', 'list_strings',
  'list_segments', 'list_documents', 'decompile_procedure', 'disassemble_procedure',
  'get_call_graph', 'find_xrefs_to_name', 'trace_feature', 'trace_call_path',
  'trace_application_feature', 'trace_javascript_semantics', 'trace_native_values',
  'trace_native_ui_action', 'inspect_native_instruction', 'inspect_native_data_type',
  'resolve_native_call_targets', 'inspect_native_dispatch_metadata', 'analyze_swift_types',
  'get_objc_classes', 'get_objc_protocols', 'batch_decompile', 'address_name', 'comment',
  'inline_comment', 'compare_artifacts', 'compare_functions', 'compare_bundles',
  'compare_application_versions', 'compare_source_to_bundle', 'compare_javascript_export_shapes',
  'compare_managed_members', 'compare_web_captures', 'compare_web_screenshots',
  'compare_process_captures', 'find_changed_behavior', 'get_evidence_bundle',
  'inspect_web_network_capture', 'inspect_wasm_artifact', 'inspect_firmware_regions',
  'inspect_keyed_archive', 'inspect_asset_catalog', 'decode_interface_builder',
  'build_reconstruction_obligation_ledger', 'evaluate_reconstruction_coverage',
  'project_android_application_graph', 'project_apple_application_graph',
  'project_managed_application_graph', 'verify_managed_native_boundaries',
  'read_bytes', 'address_to_file_offset', 'read_function_instructions',
  'procedure_address', 'procedure_assembly', 'procedure_callees', 'procedure_callers',
  'procedure_info', 'procedure_references', 'procedure_pseudo_code',
  'resolve_containing_procedure', 'search_procedures', 'search_strings', 'xrefs',
  'list_bookmarks', 'next_address', 'prev_address', 'get_navigation_context',
  'inspect_address_context', 'inspect_native_load_image', 'inspect_binary_layout',
  'inspect_pe_resources', 'inspect_macho', 'inspect_signature', 'inspect_plist',
  'list_architectures', 'demangle_swift', 'trace_dylib_resolution',
  'inspect_managed_artifact', 'inspect_managed_members', 'inspect_managed_native_boundaries',
  'reconcile_javascript_runtime', 'build_call_path', 'correlate_static_and_runtime',
  'verify_reconstruction', 'list_unknowns', 'record_unknown', 'update_unknown',
  'verify_unknown_resolution',
]);

function decode(result) {
  if (result.structuredContent) return result.structuredContent;
  const text = (result.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
  try { return JSON.parse(text); } catch { return { text }; }
}

export class AnalysisManager {
  constructor({ home = join(APP_HOME, 'analysis'), bundle = analysisBundle, idleMs = 10 * 60_000 } = {}) {
    this.home = home;
    this.bundle = bundle;
    this.idleMs = idleMs;
    this.sessions = new Map();
    this.stopping = false;
  }
  status() {
    const bundle = this.bundle();
    return { ok: bundle.ok, error: bundle.error, versions: bundle.manifest?.versions,
      default_route: 'bundled-headless', project_route: 'ghidra',
      sessions: [...this.sessions.values()].map(s => ({ session_id: s.id, path: s.path, state: s.state, pid: s.transport?.pid, directory: s.directory })) };
  }
  async open(path, { kind = 'auto', signal, emit } = {}) {
    if (this.stopping) throw new Error('Software analysis is shutting down.');
    path = checkedAnalysisPath(path);
    if (!existsSync(path)) throw new Error(`Target does not exist: ${path}`);
    const selectedPath = path;
    if (kind === 'auto') {
      const directory = statSync(path).isDirectory();
      const asar = directory && [join(path, 'Contents/Resources/app.asar'), join(path, 'resources/app.asar')].find(existsSync);
      if (asar) { path = asar; kind = 'javascript'; }
      else kind = /\.(?:asar|[cm]?js)$/i.test(path) || (directory && existsSync(join(path, 'package.json'))) ? 'javascript' : 'native';
    }
    if (!['native', 'javascript'].includes(kind)) throw new Error('kind must be auto, native or javascript');
    const bundle = this.bundle();
    if (!bundle.ok) throw new Error(bundle.error);
    const id = randomUUID();
    const directory = join(this.home, id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const env = {
      GHIDRA_INSTALL_DIR: join(bundle.root, bundle.manifest.ghidra),
      JAVA_HOME: join(bundle.root, bundle.manifest.java_home),
      REA_ANALYSIS_PROVIDER: 'ghidra',
      REA_MCP_INPUT_SCHEMA_PROFILE: 'compact',
      REA_MCP_MAX_RESPONSE_BYTES: '10485760',
    };
    const transport = new StdioClientTransport({
      command: join(bundle.root, bundle.manifest.node),
      args: [join(bundle.root, bundle.manifest.entry), 'mcp'],
      env, cwd: directory, stderr: 'pipe', maxBufferSize: 32 * 1024 * 1024,
    });
    const client = new Client({ name: 'nova-collar-analysis', version: '1.0.0' }, { capabilities: {} });
    const lifecycle = new AbortController();
    signal = signal ? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal;
    const session = { id, directory, path, kind, client, transport, lifecycle, state: 'starting', queue: Promise.resolve(), timer: null, log: '' };
    this.sessions.set(id, session);
    transport.stderr.on('data', part => { session.log = (session.log + part.toString()).slice(-16_000); });
    client.onclose = () => { session.state = 'disconnected'; };
    try {
      signal?.throwIfAborted();
      await client.connect(transport, { signal, timeout: 60_000 });
      session.tools = [];
      let cursor;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 60_000 });
        session.tools.push(...page.tools); cursor = page.nextCursor;
      } while (cursor);
      session.state = 'ready';
      writeFileSync(join(directory, 'investigation.json'), JSON.stringify({ session_id: id, path, kind, versions: bundle.manifest.versions, created: new Date().toISOString() }, null, 2), { mode: 0o600 });
      const opened = await this.call(id, kind === 'javascript' ? 'analyze_javascript_application' : 'open_binary',
        kind === 'javascript' ? { input_path: path, detail: 'summary' } : { path, provider_id: 'ghidra' }, { signal, emit });
      if (!opened.ok) { await this.close(id); return opened; }
      return { ...opened, session_id: id, path, selected_path: selectedPath, kind, directory, next: 'Use analysis_tools to find an operation and its exact schema; analysis_call runs static operations. Keep this session_id for all follow-up calls.' };
    } catch (error) {
      await this.close(id).catch(() => {});
      throw new Error(`Could not open analysis: ${error.message}${session.log ? `\n${session.log.slice(-1500)}` : ''}`);
    }
  }
  get(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Unknown or expired session_id. Open the exact target with analysis_open. Saved reports remain in the investigation directory.');
    return session;
  }
  touch(session) {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => this.close(session.id).catch(() => {}), this.idleMs);
    session.timer.unref();
  }
  tools(id, { query = '', tool = '', offset = 0, limit = 12 } = {}) {
    const s = this.get(id); this.touch(s);
    if (tool) {
      const row = s.tools.find(t => t.name === tool);
      if (!row) throw new Error(`REA does not advertise ${tool}`);
      return { ok: true, session_id: id, tool: row, route: STATIC_ANALYSIS_TOOLS.has(tool) ? 'analysis_call' : 'analysis_run' };
    }
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = s.tools.filter(t => words.every(w => `${t.name} ${t.description}`.toLowerCase().includes(w)));
    offset = Math.max(0, Number(offset) || 0); limit = Math.max(1, Math.min(30, Number(limit) || 12));
    return { ok: true, total: rows.length, next_offset: offset + limit < rows.length ? offset + limit : null,
      tools: rows.slice(offset, offset + limit).map(t => ({ name: t.name, description: t.description,
        route: STATIC_ANALYSIS_TOOLS.has(t.name) ? 'analysis_call' : 'analysis_run' })),
      note: 'Listing does not establish engine availability. Request tool by exact name for its complete input schema. binary_session reports availability.' };
  }
  async call(id, tool, args = {}, { signal, emit } = {}) {
    const s = this.get(id);
    if (s.closing) throw new Error('Investigation is closing.');
    signal = signal ? AbortSignal.any([signal, s.lifecycle.signal]) : s.lifecycle.signal;
    const previous = s.queue;
    let release;
    s.queue = new Promise(r => { release = r; });
    await previous;
    clearTimeout(s.timer);
    try {
      signal?.throwIfAborted();
      if (!s.tools.some(t => t.name === tool)) throw new Error(`REA does not advertise ${tool}`);
      s.state = 'working';
      emit?.({ type: 'mood', mood: 'think', text: `Analyzing: ${tool}` });
      const result = await s.client.callTool({ name: tool, arguments: args }, undefined, {
        signal, timeout: 8 * 60_000, resetTimeoutOnProgress: true, maxTotalTimeout: 30 * 60_000,
        onprogress: progress => emit?.({ type: 'mood', mood: 'think', text: progress.message || `Analyzing: ${tool}` }),
      });
      const data = decode(result);
      const resultId = randomUUID();
      const resultPath = join(s.directory, `${resultId}.json`);
      const json = JSON.stringify(data, null, 2);
      writeFileSync(resultPath, json, { mode: 0o600 });
      s.state = 'ready';
      return { ok: !result.isError, session_id: id, tool, result_id: resultId, result_path: resultPath,
        ...(result.isError ? { error: data.error?.message || data.error || data.text || 'REA operation failed', details: data } : {}),
        ...(json.length <= 18000 ? { data } : { preview: json.slice(0, 12000), truncated: true, characters: json.length,
          next: 'Use analysis_read_result with result_id and offset to read the complete saved result. Original evidence is retained.' }) };
    } finally {
      if (s.state === 'working') s.state = 'ready';
      release(); this.touch(s);
    }
  }
  read(id, resultId, offset = 0, length = 12000) {
    if (!/^[0-9a-f-]{36}$/.test(String(id)) || !/^[0-9a-f-]{36}$/.test(String(resultId))) throw new Error('Invalid result identity');
    const text = readFileSync(join(this.home, id, `${resultId}.json`), 'utf8');
    offset = Math.max(0, Number(offset) || 0); length = Math.max(1, Math.min(18000, Number(length) || 12000));
    return { ok: true, session_id: id, result_id: resultId, text: text.slice(offset, offset + length),
      next_offset: offset + length < text.length ? offset + length : null, characters: text.length };
  }
  async close(id) {
    const s = this.sessions.get(id);
    if (!s) return { ok: true, already_closed: true };
    if (s.closing) return s.closing;
    s.lifecycle.abort(new Error('Investigation closed; pending analysis canceled.'));
    s.closing = (async () => {
      clearTimeout(s.timer);
      await s.queue;
      s.state = 'closing';
      const failures = [];
      if (s.client.getServerVersion()) {
        for (const [name, args] of [['export_evidence_bundle', { path: join(s.directory, 'evidence.json'), overwrite: true }], ['close_binary', {}]]) {
          try {
            const result = await s.client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
            if (result.isError) failures.push({ tool: name, details: decode(result) });
          } catch (error) { failures.push({ tool: name, error: error.message }); }
        }
      }
      try { await s.client.close(); }
      catch (error) { failures.push({ tool: 'disconnect', error: error.message }); }
      clearTimeout(s.timer);
      this.sessions.delete(id);
      const receipt = { ok: failures.length === 0, session_id: id, evidence_path: join(s.directory, 'evidence.json'), failures, closed: new Date().toISOString() };
      writeFileSync(join(s.directory, 'close.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
      return receipt;
    })();
    return s.closing;
  }
  async closeAll() {
    this.stopping = true;
    const results = await Promise.allSettled([...this.sessions.keys()].map(id => this.close(id)));
    return results;
  }
}

export const analysisManager = new AnalysisManager();
