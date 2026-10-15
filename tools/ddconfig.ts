// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import { type McpEntry, loadServerState, malformedConfigMessage, persistEntry } from '../config.js';
import { SITE_TABLE, domainToSite, isKnownDomain, resolveSiteToDomain } from '../site.js';
import { lines } from '../text.js';
import type { ToolDeps } from './types.js';

export const createDdconfig = ({ directory, urls, mcpName }: ToolDeps) => ({
  name: 'ddconfig',
  description: [
    'Configure or troubleshoot the Datadog MCP server.',
    'Use to view the current configuration, change the Datadog domain or site,',
    'or diagnose connection issues.',
  ].join(' '),
  input: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'change-site', 'troubleshoot'],
        description: 'Action to perform. Omit to show current status.',
      },
      site: {
        type: 'string',
        description: 'New Datadog site or MCP domain (for change-site action)',
      },
    },
    additionalProperties: false,
  },
  async execute(args: { action?: 'status' | 'change-site' | 'troubleshoot'; site?: string }) {
    const state = await loadServerState(directory, mcpName);

    if (state.kind === 'malformed-config') return { content: malformedConfigMessage(state) };
    if (state.kind === 'not-setup') {
      return {
        content: 'The Datadog MCP server has not been set up. Use the ddsetup tool first.',
      };
    }

    const { entry, parsed, read } = state;
    const currentDomain = parsed.domain;
    const currentSite = domainToSite(currentDomain);
    const currentToolsets = parsed.toolsets;
    const action = args.action ?? 'status';

    if (action === 'status') {
      return {
        content: lines(
          'Datadog MCP server configuration:',
          `  Domain: ${currentDomain}`,
          currentSite && `  Site: ${currentSite}`,
          currentToolsets ? `  Toolsets: ${currentToolsets}` : '  Toolsets: (server defaults)',
          entry.oauth === false ? '  Auth: API key' : '  Auth: OAuth',
          '',
          'Available actions:',
          '  - Use ddconfig with action "change-site" to switch domains',
          '  - Use ddconfig with action "troubleshoot" to diagnose issues',
          '  - Use ddtoolsets to manage toolsets',
        ),
      };
    }

    if (action === 'change-site') {
      if (!args.site) {
        return {
          content: lines(
            `Current domain: ${currentDomain}${currentSite ? ` (${currentSite})` : ''}`,
            '',
            'Provide a site code or MCP domain to switch to:',
            SITE_TABLE,
          ),
        };
      }

      const newDomain = resolveSiteToDomain(args.site);
      if (!newDomain) {
        return {
          content: lines(`Could not resolve "${args.site}" to a Datadog MCP domain.`, '', 'Available sites:', SITE_TABLE),
        };
      }

      if (newDomain === currentDomain) {
        return {
          content: `The domain is already set to ${currentDomain}. No changes needed.`,
        };
      }

      const unknownDomainNote =
        !isKnownDomain(newDomain) &&
        `Note: "${newDomain}" is not a known Datadog MCP domain. If the plugin fails to connect, re-run ddconfig with a site code from the list.`;

      const newUrl = urls.build(newDomain, currentToolsets);
      const newEntry: McpEntry = { ...entry, url: newUrl };
      await persistEntry(directory, read, mcpName, newEntry);

      const newSite = domainToSite(newDomain);
      const header = `Domain changed from ${currentDomain} to ${newDomain}${newSite ? ` (${newSite})` : ''}.`;

      return {
        content: lines(
          header,
          unknownDomainNote,
          '',
          'Configuration saved. OpenCode will reload the MCP server automatically.',
          'If authentication is required, follow the prompt from OpenCode or use `/mcps` to complete sign-in.',
        ),
      };
    }

    // action === 'troubleshoot'
    return {
      content: lines(
        'The Datadog MCP server is configured but may not be responding.',
        '',
        `Current domain: ${currentDomain}${currentSite ? ` (${currentSite})` : ''}`,
        '',
        'Common causes:',
        `  1. Domain issue — verify "${currentDomain}" is correct for your Datadog site.`,
        '     Use ddconfig with action "change-site" to update if needed.',
        '  2. Authentication — OAuth tokens may have expired.',
        '     Run `/mcps` or restart OpenCode and re-authenticate when prompted.',
        '  3. Network or access — your network may be blocking the connection,',
        '     or your Datadog account may not have the MCP Read permission.',
      ),
    };
  },
});
