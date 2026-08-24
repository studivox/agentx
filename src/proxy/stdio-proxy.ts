/**
 * AgentX Stdio MCP Proxy Server
 * Transparently wraps a downstream MCP server process and enforces transactional guarantees.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { MCPInterceptor } from './mcp-interceptor.js';
import { TransactionLedger } from '../ledger/transaction-ledger.js';
import { ManifestLoader } from '../manifest/manifest-loader.js';
import { logger } from '../utils/logger.js';

export interface StdioProxyOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  manifestPath?: string;
  ledgerPath?: string;
}

export class StdioProxy {
  private options: StdioProxyOptions;
  private server: Server;
  private client: Client;
  private clientTransport: StdioClientTransport | null = null;
  private interceptor: MCPInterceptor;
  private ledger: TransactionLedger;
  private manifestLoader: ManifestLoader;

  constructor(options: StdioProxyOptions) {
    this.options = options;
    this.manifestLoader = ManifestLoader.loadFromFile(options.manifestPath);

    const dbPath = options.ledgerPath || this.manifestLoader.getLedgerPath();
    this.ledger = new TransactionLedger(dbPath);
    this.interceptor = new MCPInterceptor(this.ledger, this.manifestLoader);

    this.server = new Server(
      {
        name: 'agentx-proxy',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.client = new Client(
      {
        name: 'agentx-client',
        version: '0.1.0',
      },
      {
        capabilities: {},
      }
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // 1. Intercept ListTools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      logger.debug('Handling ListTools request from upstream client');
      try {
        const downstreamTools = await this.client.listTools();
        return {
          tools: downstreamTools.tools.map(t => {
            const policy = this.manifestLoader.getPolicyForTool(t.name);
            return {
              ...t,
              description: t.description
                ? `[AgentX: ${policy.riskLevel}] ${t.description}`
                : `[AgentX: ${policy.riskLevel}]`,
            };
          }),
        };
      } catch (err) {
        logger.error('Failed to list tools from downstream MCP server:', err);
        throw err;
      }
    });

    // 2. Intercept CallTool with transactional interceptor
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const toolArgs = (request.params.arguments || {}) as Record<string, unknown>;

      logger.info(`Received CallTool request for ${toolName}`);

      const result = await this.interceptor.handleToolCall(
        {
          toolName,
          arguments: toolArgs,
          meta: (request.params as unknown as { _meta?: Record<string, unknown> })._meta,
        },
        async (name, args) => {
          const rawCall = await this.client.callTool({
            name,
            arguments: args,
          });
          return rawCall as {
            content: Array<{ type: string; text?: string; data?: string }>;
            isError?: boolean;
          };
        }
      );

      return {
        content: result.content,
        isError: result.isError,
      };
    });
  }

  /**
   * Starts downstream client connection and upstream stdio server.
   */
  public async start(): Promise<void> {
    logger.info(`Starting AgentX Stdio Proxy wrapping command: ${this.options.command} ${(this.options.args || []).join(' ')}`);

    const sanitizedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) {
        sanitizedEnv[k] = v;
      }
    }
    if (this.options.env) {
      for (const [k, v] of Object.entries(this.options.env)) {
        if (v !== undefined) {
          sanitizedEnv[k] = v;
        }
      }
    }

    // Connect to downstream target MCP server
    this.clientTransport = new StdioClientTransport({
      command: this.options.command,
      args: this.options.args || [],
      env: sanitizedEnv,
    });

    await this.client.connect(this.clientTransport);
    logger.info('Connected to downstream MCP server');

    // Connect upstream server to stdin/stdout
    const serverTransport = new StdioServerTransport();
    await this.server.connect(serverTransport);
    logger.info('AgentX Stdio Proxy is online and listening on stdin/stdout');

    // Graceful teardown hooks
    const shutdown = async () => {
      logger.info('Shutting down AgentX Stdio Proxy...');
      try {
        await this.server.close();
        if (this.clientTransport) {
          await this.clientTransport.close();
        }
      } catch {
        // Ignore errors during shutdown
      }
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}
