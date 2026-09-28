// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import { type McpEntry, applyMcpServer, loadServerState, malformedConfigMessage, persistEntry } from '../config.js';
import { formatToolsetList, lines, parseToolsetList } from '../text.js';
import type { ToolDeps } from './types.js';

type ToolsetAction = 'list' | 'enable' | 'disable' | 'reset';

// Computes the next toolset list. Returns a string to short-circuit with an
// error message, or an array with the new toolsets. `force` gates removal of
// the core toolset because it's the foundation for most Datadog workflows.
const computeNewToolsets = (
  action: Exclude<ToolsetAction, 'list'>,
  current: string[],
  requested: string | undefined,
  force: boolean,
): string[] | string => {
  if (action === 'reset') return [];

  if (!requested) return `Provide a comma-separated list of toolset names to ${action}. Example: "core,alerting"`;
  const target = parseToolsetList(requested);
  if (target.length === 0) return 'No valid toolset names provided.';

  const next =
    action === 'enable' ? [...new Set([...current, ...target])] : current.filter((t) => !new Set(target).has(t));

  if (current.includes('core') && !next.includes('core') && !force) {
    return lines(
      'Warning: removing the "core" toolset may break most Datadog workflows.',
      'The core toolset provides essential functionality that other toolsets depend on.',
      '',
      'To confirm, call ddtoolsets again with force set to true.',
      `Current toolsets: ${formatToolsetList(current)}`,
      `Proposed toolsets: ${formatToolsetList(next)}`,
    );
  }

  return next;
};

export const createDdtoolsets = ({ mcp, directory, urls, mcpName }: ToolDeps) => ({
  name: 'ddtoolsets',
  description: [
    'View and manage Datadog MCP server toolsets.',
    'Toolsets control which groups of tools are available.',
    'Use to list current toolsets, enable or disable specific ones, or reset to server defaults.',
  ].join(' '),
  input: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'enable', 'disable', 'reset'],
        description: 'Action to perform. Omit to list current toolsets.',
      },
      toolsets: {
        type: 'string',
        description: 'Comma-separated toolset names (for enable/disable actions)',
      },
      force: {
        type: 'boolean',
        description: 'Set to true to confirm removing the core toolset',
      },
    },
    additionalProperties: false,
  },
  async execute(args: { action?: ToolsetAction; toolsets?: string; force?: boolean }) {
    const state = await loadServerState(directory, mcpName);

    if (state.kind === 'malformed-config') return { content: malformedConfigMessage(state) };
    if (state.kind === 'not-setup') {
      return {
        content: 'The Datadog MCP server has not been set up. Use the ddsetup tool first.',
      };
    }

    const { entry, parsed, read } = state;
    const current = parseToolsetList(parsed.toolsets);
    const action: ToolsetAction = args.action ?? 'list';

    if (action === 'list') {
      return {
        content: lines(
          'Current Datadog MCP toolsets:',
          current.length > 0 ? `  Enabled: ${current.join(', ')}` : '  Using server defaults',
          '',
          'Available actions:',
          '  - Use ddtoolsets with action "enable" and toolsets "name1,name2" to enable toolsets',
          '  - Use ddtoolsets with action "disable" and toolsets "name1,name2" to disable toolsets',
          '  - Use ddtoolsets with action "reset" to revert to server defaults',
        ),
      };
    }

    const next = computeNewToolsets(action, current, args.toolsets, args.force ?? false);
    if (typeof next === 'string') return { content: next };

    const newUrl = urls.build(parsed.domain, next.join(','));
    const newEntry: McpEntry = { ...entry, url: newUrl };
    await persistEntry(directory, read, mcpName, newEntry);

    const label =
      action === 'reset' ? 'Toolsets reset to server defaults.' : `Toolsets updated: ${formatToolsetList(next)}`;

    try {
      await applyMcpServer(mcp, mcpName, newUrl, entry.oauth);
      return {
        content: lines(label, '', 'The MCP server is reconnecting with the updated toolsets.'),
      };
    } catch {
      return {
        content: lines(label, '', 'The user needs to restart OpenCode for the changes to take effect.'),
      };
    }
  },
});
