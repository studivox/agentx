import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

describe('PHASE 3: Real Stdio MCP Integration Harness', () => {
  let tmpDir: string;
  let ledgerPath: string;
  let manifestPath: string;
  let fixtureServerPath: string;
  let proxyProcess: ChildProcess | null = null;
  let clientTransport: StdioClientTransport | null = null;
  let client: Client | null = null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentx-phase3-'));
    ledgerPath = join(tmpDir, 'test-ledger.db');
    manifestPath = join(tmpDir, 'test-manifest.json');
    fixtureServerPath = join(tmpDir, 'fixture-server.mjs');

    const mcpSdkServerPath = join(process.cwd(), 'node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js');
    const mcpSdkStdioServerPath = join(process.cwd(), 'node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js');
    const mcpSdkTypesPath = join(process.cwd(), 'node_modules/@modelcontextprotocol/sdk/dist/esm/types.js');

    // Create fixture MCP server implementation with proper inputSchema on all tools
    const fixtureCode = `
import { Server } from '${mcpSdkServerPath}';
import { StdioServerTransport } from '${mcpSdkStdioServerPath}';
import { CallToolRequestSchema, ListToolsRequestSchema } from '${mcpSdkTypesPath}';

const server = new Server({ name: 'fixture-server', version: '0.1.0' }, { capabilities: { tools: {} } });
const state = { records: new Map(), callCounts: {} };

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      { name: 'successful_mutation', description: 'Mutates state cleanly', inputSchema: { type: 'object', properties: {} } },
      { name: 'commit_and_drop', description: 'Mutates state then crashes/drops response', inputSchema: { type: 'object', properties: {} } },
      { name: 'fail_before_commit', description: 'Fails without mutating state', inputSchema: { type: 'object', properties: {} } },
      { name: 'slow_mutation', description: 'Slow response', inputSchema: { type: 'object', properties: {} } },
      { name: 'verify_state', description: 'Checks state', inputSchema: { type: 'object', properties: {} } },
      { name: 'compensate_action', description: 'Rolls back state', inputSchema: { type: 'object', properties: {} } },
      { name: 'crash_process', description: 'Crashes child process', inputSchema: { type: 'object', properties: {} } },
      { name: 'stderr_noisy_mutation', description: 'Emits stderr noise', inputSchema: { type: 'object', properties: {} } }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = req.params.arguments || {};
  state.callCounts[name] = (state.callCounts[name] || 0) + 1;

  if (name === 'successful_mutation') {
    state.records.set(args.id, args.val);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, id: args.id, val: args.val, callCount: state.callCounts[name] }) }] };
  }

  if (name === 'commit_and_drop') {
    state.records.set(args.id, 'COMMITTED_INTERNALLY');
    // Exit immediately to simulate network drop after remote commitment
    process.exit(1);
  }

  if (name === 'fail_before_commit') {
    return { isError: true, content: [{ type: 'text', text: 'Validation error in backend' }] };
  }

  if (name === 'slow_mutation') {
    await new Promise(r => setTimeout(r, 1200));
    return { content: [{ type: 'text', text: JSON.stringify({ slow: true }) }] };
  }

  if (name === 'verify_state') {
    const exists = state.records.has(args.id);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          id: args.id,
          status: exists ? 'CONFIRMED' : 'NOT_FOUND',
          val: state.records.get(args.id) || null
        })
      }]
    };
  }

  if (name === 'compensate_action') {
    state.records.delete(args.id);
    return { content: [{ type: 'text', text: JSON.stringify({ compensated: true, id: args.id }) }] };
  }

  if (name === 'crash_process') {
    process.exit(2);
  }

  if (name === 'stderr_noisy_mutation') {
    process.stderr.write('[DOWNSTREAM_NOISE] This is a stderr log from downstream server\\n');
    return { content: [{ type: 'text', text: JSON.stringify({ noisy: true }) }] };
  }

  return { isError: true, content: [{ type: 'text', text: 'Unknown tool: ' + name }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
`;
    writeFileSync(fixtureServerPath, fixtureCode, 'utf-8');

    // Create test manifest
    const manifest = {
      version: '0.1.0',
      ledgerPath,
      tools: {
        successful_mutation: {
          toolName: 'successful_mutation',
          riskLevel: 'MUTATING_CRITICAL',
          logicalKeys: ['id'],
          timeoutMs: 5000,
          maxRetries: 1
        },
        commit_and_drop: {
          toolName: 'commit_and_drop',
          riskLevel: 'MUTATING_CRITICAL',
          logicalKeys: ['id'],
          timeoutMs: 1000,
          maxRetries: 1,
          verifier: {
            toolName: 'verify_state',
            argumentMapping: { id: 'id' },
            matchKeyPath: 'status',
            expectedValue: 'CONFIRMED'
          }
        },
        slow_mutation: {
          toolName: 'slow_mutation',
          riskLevel: 'MUTATING_SAFE',
          timeoutMs: 400,
          maxRetries: 1
        },
        verify_state: {
          toolName: 'verify_state',
          riskLevel: 'READ_ONLY'
        },
        compensate_action: {
          toolName: 'compensate_action',
          riskLevel: 'MUTATING_SAFE',
          logicalKeys: ['id']
        },
        stderr_noisy_mutation: {
          toolName: 'stderr_noisy_mutation',
          riskLevel: 'MUTATING_SAFE'
        }
      }
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  });

  afterEach(async () => {
    if (client) {
      try {
        await client.close();
      } catch {
        // ignore
      }
    }
    if (clientTransport) {
      try {
        await clientTransport.close();
      } catch {
        // ignore
      }
    }
    if (proxyProcess && !proxyProcess.killed) {
      proxyProcess.kill('SIGTERM');
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. Handles successful mutation over real stdio JSON-RPC transport', async () => {
    const cliPath = join(process.cwd(), 'dist/cli.js');
    clientTransport = new StdioClientTransport({
      command: 'node',
      args: [cliPath, 'wrap', '--server', 'node', fixtureServerPath, '--manifest', manifestPath, '--db', ledgerPath],
      env: { ...process.env, AGENTX_LOG_LEVEL: 'SILENT', NODE_PATH: join(process.cwd(), 'node_modules') }
    });

    client = new Client({ name: 'test-client', version: '0.1.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);
    const successTool = tools.tools.find(t => t.name === 'successful_mutation');
    expect(successTool).toBeDefined();

    const res = await client.callTool({
      name: 'successful_mutation',
      arguments: { id: 'rec_100', val: 'initial_data' }
    });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].type).toBe('text');
    const parsed = JSON.parse(res.content[0].text as string);
    expect(parsed.success).toBe(true);
    expect(parsed.id).toBe('rec_100');
  });

  it('2. Prevents duplicate execution on re-calling successful mutation with reordered keys', async () => {
    const cliPath = join(process.cwd(), 'dist/cli.js');
    clientTransport = new StdioClientTransport({
      command: 'node',
      args: [cliPath, 'wrap', '--server', 'node', fixtureServerPath, '--manifest', manifestPath, '--db', ledgerPath],
      env: { ...process.env, AGENTX_LOG_LEVEL: 'SILENT', NODE_PATH: join(process.cwd(), 'node_modules') }
    });

    client = new Client({ name: 'test-client', version: '0.1.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    // Call 1
    const res1 = await client.callTool({
      name: 'successful_mutation',
      arguments: { id: 'rec_200', val: 'alpha' }
    });
    expect(res1.isError).toBeFalsy();
    const parsed1 = JSON.parse(res1.content[0].text as string);
    expect(parsed1.callCount).toBe(1);

    // Call 2 with reordered arguments
    const res2 = await client.callTool({
      name: 'successful_mutation',
      arguments: { val: 'alpha', id: 'rec_200' }
    });
    expect(res2.isError).toBeFalsy();
    const parsed2 = JSON.parse(res2.content[0].text as string);
    // Cached result returned with 0 downstream calls (callCount remains 1)
    expect(parsed2.callCount).toBe(1);
  });

  it('3. Enforces timeout on slow mutation over real stdio transport', async () => {
    const cliPath = join(process.cwd(), 'dist/cli.js');
    clientTransport = new StdioClientTransport({
      command: 'node',
      args: [cliPath, 'wrap', '--server', 'node', fixtureServerPath, '--manifest', manifestPath, '--db', ledgerPath],
      env: { ...process.env, AGENTX_LOG_LEVEL: 'SILENT', NODE_PATH: join(process.cwd(), 'node_modules') }
    });

    client = new Client({ name: 'test-client', version: '0.1.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    const res = await client.callTool({
      name: 'slow_mutation',
      arguments: { foo: 'bar' }
    });

    // Slow mutation exceeded 400ms timeout
    expect(res.isError).toBe(true);
  });

  it('4. Stderr noise from downstream server does not corrupt JSON-RPC stdout', async () => {
    const cliPath = join(process.cwd(), 'dist/cli.js');
    clientTransport = new StdioClientTransport({
      command: 'node',
      args: [cliPath, 'wrap', '--server', 'node', fixtureServerPath, '--manifest', manifestPath, '--db', ledgerPath],
      env: { ...process.env, AGENTX_LOG_LEVEL: 'SILENT', NODE_PATH: join(process.cwd(), 'node_modules') }
    });

    client = new Client({ name: 'test-client', version: '0.1.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    const res = await client.callTool({
      name: 'stderr_noisy_mutation',
      arguments: { item: 42 }
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text as string);
    expect(parsed.noisy).toBe(true);
  });
});
