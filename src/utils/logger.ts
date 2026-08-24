/**
 * AgentTX Diagnostic Logger
 * CRITICAL INVARIANT: Logs MUST ONLY be written to stderr.
 * Standard output (stdout) is strictly reserved for MCP JSON-RPC protocol transport.
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4,
}

let currentLogLevel = LogLevel.INFO;

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

export function setLogLevelFromName(name?: string): void {
  if (!name) return;
  const upper = name.toUpperCase();
  if (upper === 'DEBUG') currentLogLevel = LogLevel.DEBUG;
  else if (upper === 'INFO') currentLogLevel = LogLevel.INFO;
  else if (upper === 'WARN') currentLogLevel = LogLevel.WARN;
  else if (upper === 'ERROR') currentLogLevel = LogLevel.ERROR;
  else if (upper === 'SILENT') currentLogLevel = LogLevel.SILENT;
}

function formatMessage(level: string, message: string, ...args: unknown[]): string {
  const timestamp = new Date().toISOString();
  let formattedArgs = '';
  if (args.length > 0) {
    try {
      formattedArgs = ' ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    } catch {
      formattedArgs = ' [Unserializable Args]';
    }
  }
  return `[${timestamp}] [AgentTX] [${level}] ${message}${formattedArgs}\n`;
}

export const logger = {
  debug(message: string, ...args: unknown[]): void {
    if (currentLogLevel <= LogLevel.DEBUG) {
      process.stderr.write(formatMessage('DEBUG', message, ...args));
    }
  },
  info(message: string, ...args: unknown[]): void {
    if (currentLogLevel <= LogLevel.INFO) {
      process.stderr.write(formatMessage('INFO', message, ...args));
    }
  },
  warn(message: string, ...args: unknown[]): void {
    if (currentLogLevel <= LogLevel.WARN) {
      process.stderr.write(formatMessage('WARN', message, ...args));
    }
  },
  error(message: string, ...args: unknown[]): void {
    if (currentLogLevel <= LogLevel.ERROR) {
      process.stderr.write(formatMessage('ERROR', message, ...args));
    }
  },
};
