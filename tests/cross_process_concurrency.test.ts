import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';

describe('Cross-Process Concurrency & Shared Ledger Coordination', () => {
  let tmpDir: string;
  let ledgerPath: string;
  let manifestPath: string;
  let sharedStateFile: string;
  let downstreamServerPath: string;
  let clientTransport1: StdioClientTransport | null = null;
  let clientTransport2: StdioClientTransport | null = null;
  let client1: Client | null = null;
  let client2: Client | null = null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentx-cross-process-'));
    ledgerPath = join(tmpDir, 'shared-ledger.db');
    manifestPath = join(tmpDir, 'manifest.json');
    sharedStateFile = join(tmpDir, 'downstream-state.json');
    downstreamServerPath = join(tmpDir, 'downstream-server.mjs');

    // Initialize shared downstream state
    writeFileSync(sharedStateFile, JSON.stringify({ mutationCount: 0, calls: [] }), 'utf-8');

    const mcpSdkServerPath = join(process.cwd(), 'node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js');
    const mcpSdkStdioServerPath = join(process.cwd(), 'node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js');
    const mcpSdkTypesPath = join(process.cwd(), 'node_modules/@modelcontextprotocol/sdk/dist/esm/types.js');

    // Create downstream MCP server that reads and atomically increments sharedStateFile
    const downstreamCode = `
import { Server } from '${mcpSdkServerPath}';
import { StdioServerTransport } from '${mcpSdkStdioServerPath}';
import { CallToolRequestSchema, ListToolsRequestSchema } from '${mcpSdkTypesPath}';
import { readFileSync, writeFileSync } from 'node:fs';

const stateFile = '${sharedStateFile}';
const server = new Server({ name: 'shared-downstream', version: '0.1.1' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'mutate_resource',
        description: 'Mutates resource in shared storage with artificial delay',
        inputSchema: {
          type: 'object',
          properties: {
            resourceId: { type: 'string' },
            value: { type: 'string' }
          },
          required: ['resourceId']
        }
      },
      {
        name: 'verify_resource',
        description: 'Checks state of resource in shared storage',
        inputSchema: {
          type: 'object',
          properties: {
            resourceId: { type: 'string' }
          },
          required: ['resourceId']
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === 'mutate_resource') {
    // Artificial delay to induce race conditions between processes
    await new Promise(r => setTimeout(r, 150));

    const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    state.mutationCount += 1;
    state.calls.push({ time: Date.now(), args, pid: process.pid });
    writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'COMMITTED',
            resourceId: args.resourceId,
            currentCount: state.mutationCount
          })
        }
      ]
    };
  }

  if (name === 'verify_resource') {
    const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    const exists = state.calls.some(c => c.args.resourceId === args.resourceId);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            resourceId: args.resourceId,
            status: exists ? 'COMMITTED' : 'ABSENT',
            mutationCount: state.mutationCount
          })
        }
      ]
    };
  }

  return { isError: true, content: [{ type: 'text', text: 'Unknown tool' }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
`;
    writeFileSync(downstreamServerPath, downstreamCode, 'utf-8');

    // Create policy manifest with verifier
    const manifest = {
      version: '0.1.1',
      ledgerPath,
      tools: {
        mutate_resource: {
          toolName: 'mutate_resource',
          riskLevel: 'MUTATING_CRITICAL',
          logicalKeys: ['resourceId'],
          timeoutMs: 1500,
          maxRetries: 1,
          verifier: {
            toolName: 'verify_resource',
            argumentMapping: { resourceId: 'resourceId' },
            matchKeyPath: 'status',
            expectedValue: 'COMMITTED'
          }
        },
        verify_resource: {
          toolName: 'verify_resource',
          riskLevel: 'READ_ONLY'
        }
      }
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  });

  afterEach(async () => {
    if (client1) {
      try { await client1.close(); } catch {}
    }
    if (client2) {
      try { await client2.close(); } catch {}
    }
    if (clientTransport1) {
      try { await clientTransport1.close(); } catch {}
    }
    if (clientTransport2) {
      try { await clientTransport2.close(); } catch {}
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. Two independent AgentX processes sharing one SQLite ledger execute downstream EXACTLY once under simultaneous load', async () => {
    const cliPath = join(process.cwd(), 'dist/cli.js');

    // Spawn Process 1
    clientTransport1 = new StdioClientTransport({
      command: 'node',
      args: [cliPath, 'wrap', '--server', 'node', downstreamServerPath, '--manifest', manifestPath, '--db', ledgerPath],
      env: { ...process.env, AGENTX_LOG_LEVEL: 'SILENT', NODE_PATH: join(process.cwd(), 'node_modules') }
    });
    client1 = new Client({ name: 'client-1', version: '0.1.1' }, { capabilities: {} });
    await client1.connect(clientTransport1);

    // Spawn Process 2
    clientTransport2 = new StdioClientTransport({
      command: 'node',
      args: [cliPath, 'wrap', '--server', 'node', downstreamServerPath, '--manifest', manifestPath, '--db', ledgerPath],
      env: { ...process.env, AGENTX_LOG_LEVEL: 'SILENT', NODE_PATH: join(process.cwd(), 'node_modules') }
    });
    client2 = new Client({ name: 'client-2', version: '0.1.1' }, { capabilities: {} });
    await client2.connect(clientTransport2);

    // Fire SIMULTANEOUS tool calls with identical logical arguments to both processes
    const callPayload = {
      name: 'mutate_resource',
      arguments: { resourceId: 'res_shared_alpha_1', value: 'data_val_100' }
    };

    const [res1, res2] = await Promise.all([
      client1.callTool(callPayload),
      client2.callTool(callPayload)
    ]);

    expect(res1.isError).toBeFalsy();
    expect(res2.isError).toBeFalsy();

    // Verify downstream mutation count in shared file
    const sharedState = JSON.parse(readFileSync(sharedStateFile, 'utf-8'));
    expect(sharedState.mutationCount).toBe(1);
    expect(sharedState.calls.length).toBe(1);
  });

  it('2. Process-owner crash recovery: surviving process resolves state via verifier upon lease expiry', async () => {
    const cliPath = join(process.cwd(), 'dist/cli.js');

    // Spawn Process 2 (survivor)
    clientTransport2 = new StdioClientTransport({
      command: 'node',
      args: [cliPath, 'wrap', '--server', 'node', downstreamServerPath, '--manifest', manifestPath, '--db', ledgerPath],
      env: { ...process.env, AGENTX_LOG_LEVEL: 'SILENT', NODE_PATH: join(process.cwd(), 'node_modules') }
    });
    client2 = new Client({ name: 'client-2', version: '0.1.1' }, { capabilities: {} });
    await client2.connect(clientTransport2);

    // Spawn Process 1 as separate child process that we will deliberately kill mid-flight
    const p1Proc = spawn('node', [cliPath, 'wrap', '--server', 'node', downstreamServerPath, '--manifest', manifestPath, '--db', ledgerPath], {
      env: { ...process.env, AGENTX_LOG_LEVEL: 'SILENT', NODE_PATH: join(process.cwd(), 'node_modules') }
    });

    const clientTransportTmp = new StdioClientTransport({
      command: 'node',
      args: [cliPath, 'wrap', '--server', 'node', downstreamServerPath, '--manifest', manifestPath, '--db', ledgerPath],
      env: { ...process.env, AGENTX_LOG_LEVEL: 'SILENT', NODE_PATH: join(process.cwd(), 'node_modules') }
    });
    const clientTmp = new Client({ name: 'client-tmp', version: '0.1.1' }, { capabilities: {} });
    await clientTmp.connect(clientTransportTmp);

    // Start mutation on clientTmp and immediately kill it to simulate sudden node crash
    const callPromise = clientTmp.callTool({
      name: 'mutate_resource',
      arguments: { resourceId: 'res_crash_recovery_1', value: 'val_before_crash' }
    });

    // Wait 50ms so Process 1 claims lease in SQLite and starts downstream mutation
    await new Promise(r => setTimeout(r, 50));
    try {
      await clientTransportTmp.close();
    } catch {}
    p1Proc.kill('SIGKILL');

    // Process 2 now attempts the same logical mutation or attempts recovery
    const resSurvivor = await client2.callTool({
      name: 'mutate_resource',
      arguments: { resourceId: 'res_crash_recovery_1', value: 'val_before_crash' }
    });

    expect(resSurvivor.isError).toBeFalsy();

    // Verify downstream state was NOT doubly mutated
    const sharedState = JSON.parse(readFileSync(sharedStateFile, 'utf-8'));
    const matchingCalls = sharedState.calls.filter((c: any) => c.args.resourceId === 'res_crash_recovery_1');
    expect(matchingCalls.length).toBe(1);
  });
});
