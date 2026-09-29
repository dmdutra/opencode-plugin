// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

// opencode.json / opencode.jsonc I/O, server-state reads, and live MCP
// management (`applyMcpServer`). Grouped into one module
// because they share the `McpEntry` shape and the `oauth: false` preservation
// rule needs to live in one place.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type ParseError, applyEdits, modify, parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';
import type { MCPDomain } from '@opencode/plugin/promise/mcp';

import { type ParsedUrl, parseMcpUrl } from './url.js';

export type McpEntry = {
  type: 'remote' | 'local';
  url: string;
  oauth?: Record<string, unknown> | false;
  headers?: Record<string, string>;
  enabled?: boolean;
  disabled?: boolean;
  timeout?: number | { catalog?: number; execution?: number };
};

export type OpenCodeConfig = {
  mcp?: Record<string, McpEntry> & {
    servers?: Record<string, McpEntry>;
  };
};

export const CONFIG_FILES = [
  join('.opencode', 'opencode.json'),
  join('.opencode', 'opencode.jsonc'),
  'opencode.json',
  'opencode.jsonc',
] as const;

export type ReadResult =
  | { status: 'missing' }
  | { status: 'malformed'; file: string; reason: string }
  | { status: 'parsed'; file: string; text: string; config: OpenCodeConfig };

export const readConfigFile = async (dir: string, file: string): Promise<ReadResult> => {
  let text: string;
  try {
    text = await readFile(join(dir, file), 'utf8');
  } catch {
    return { status: 'missing' };
  }

  const errors: ParseError[] = [];
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true }) as unknown;

  if (errors.length > 0) {
    const first = errors[0];
    const reason = `${printParseErrorCode(first.error)} at offset ${String(first.offset)}`;
    return { status: 'malformed', file, reason };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'malformed', file, reason: 'top-level value is not an object' };
  }
  return { status: 'parsed', file, text, config: parsed as OpenCodeConfig };
};

export const findConfigFile = async (dir: string): Promise<string | undefined> => {
  for (const file of CONFIG_FILES) {
    try {
      await readFile(join(dir, file), 'utf8');
      return file;
    } catch {
      // try next
    }
  }
  return undefined;
};

export const readConfig = async (dir: string, file?: string): Promise<ReadResult> => {
  const targetFile = file ?? (await findConfigFile(dir));
  if (!targetFile) return { status: 'missing' };
  return readConfigFile(dir, targetFile);
};

export const getMcpEntry = (config: OpenCodeConfig, mcpName: string): McpEntry | undefined => {
  if (config.mcp?.servers && typeof config.mcp.servers === 'object') {
    const server = config.mcp.servers[mcpName];
    if (server) return server;
  }
  const direct = config.mcp?.[mcpName];
  if (direct && typeof direct === 'object' && 'url' in direct) {
    return direct as McpEntry;
  }
  return undefined;
};

export const getMcpPath = (config: OpenCodeConfig, mcpName: string): (string | number)[] => {
  if (config.mcp?.servers && typeof config.mcp.servers === 'object') {
    return ['mcp', 'servers', mcpName];
  }
  if (config.mcp?.[mcpName] && typeof config.mcp[mcpName] === 'object' && 'url' in config.mcp[mcpName]) {
    return ['mcp', mcpName];
  }
  return ['mcp', 'servers', mcpName];
};

// Persists `entry` at `config.mcp.servers[mcpName]` (or legacy `config.mcp[mcpName]`),
// either as a surgical edit on an existing file (preserving comments, trailing commas,
// and sibling keys) or by creating a fresh opencode.json. Callers pass the existing `ReadResult` so we
// don't re-read the file — and so a 'malformed' result is an explicit branch
// that tools already refused to reach.
export const persistEntry = async (
  dir: string,
  read: Exclude<ReadResult, { status: 'malformed' }>,
  mcpName: string,
  entry: McpEntry,
): Promise<void> => {
  const [sourceText, targetFile, config] =
    read.status === 'parsed' ? [read.text, read.file, read.config] : ['{}', 'opencode.json', {}];
  const path = getMcpPath(config, mcpName);
  const edits = modify(sourceText, path, entry, { formattingOptions: { tabSize: 2, insertSpaces: true } });
  const output = applyEdits(sourceText, edits);
  // Creating fresh — add trailing newline; editing — trust existing formatting.
  const finalText = read.status === 'parsed' ? output : `${output}\n`;
  const targetPath = join(dir, targetFile);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, finalText);
};

export type ServerState =
  | { kind: 'not-setup'; read: Exclude<ReadResult, { status: 'malformed' }> }
  | { kind: 'malformed-config'; file: string; reason: string }
  | { kind: 'configured'; read: Extract<ReadResult, { status: 'parsed' }>; entry: McpEntry; parsed: ParsedUrl };

export const loadServerState = async (dir: string, mcpName: string): Promise<ServerState> => {
  let highestPrecedenceRead: Extract<ReadResult, { status: 'parsed' }> | undefined;

  for (const file of CONFIG_FILES) {
    const read = await readConfigFile(dir, file);
    if (read.status === 'malformed') {
      return { kind: 'malformed-config', file: read.file, reason: read.reason };
    }
    if (read.status === 'missing') {
      continue;
    }

    // Keep track of the highest-precedence existing configuration file in case no entry is found.
    highestPrecedenceRead ??= read;

    const entry = getMcpEntry(read.config, mcpName);
    if (entry?.url) {
      const parsed = parseMcpUrl(entry.url);
      if (parsed?.domain) {
        return { kind: 'configured', read, entry, parsed };
      }
    }
  }

  if (highestPrecedenceRead) {
    return { kind: 'not-setup', read: highestPrecedenceRead };
  }

  return { kind: 'not-setup', read: { status: 'missing' } };
};

export const malformedConfigMessage = (state: Extract<ServerState, { kind: 'malformed-config' }>): string =>
  [
    `Your ${state.file} could not be parsed: ${state.reason}.`,
    'Fix the syntax error manually before using Datadog tools. The plugin will not overwrite a malformed config.',
  ].join('\n');

export const applyMcpServer = async (
  mcp: MCPDomain | undefined,
  mcpName: string,
  url: string,
  oauth: McpEntry['oauth'],
): Promise<void> => {
  if (!mcp) return;
  await mcp.transform((editor) => {
    editor.set(mcpName, {
      type: 'remote',
      url,
      ...(oauth === false ? { oauth: false } : {}),
    });
  });
  await mcp.reload();
};

export const addMcpServer = applyMcpServer;
export const reconnectMcpServer = applyMcpServer;
