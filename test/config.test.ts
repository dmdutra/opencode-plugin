import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadServerState, persistEntry, type McpEntry } from '../config.js';

describe('loadServerState and persistEntry across multi-file config precedence', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dd-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('finds Datadog entry in root opencode.json when .opencode/opencode.json only contains plugins', async () => {
    // .opencode/opencode.json has plugins only
    await mkdir(join(tempDir, '.opencode'), { recursive: true });
    await writeFile(
      join(tempDir, '.opencode', 'opencode.json'),
      JSON.stringify({ plugins: ['@datadog/opencode-plugin'] }, null, 2),
    );

    // root opencode.json has datadog entry with key-auth (oauth: false)
    const rootEntry: McpEntry = {
      type: 'remote',
      url: 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp',
      oauth: false,
      headers: { DD_API_KEY: 'test-key' },
    };
    await writeFile(
      join(tempDir, 'opencode.json'),
      JSON.stringify({ mcp: { servers: { datadog: rootEntry } } }, null, 2),
    );

    const state = await loadServerState(tempDir, 'datadog');
    expect(state.kind).toBe('configured');
    if (state.kind !== 'configured') return;

    expect(state.read.file).toBe('opencode.json');
    expect(state.entry.oauth).toBe(false);
    expect(state.parsed.domain).toBe('mcp.datadoghq.com');

    // Updating via persistEntry should update root opencode.json and leave .opencode/opencode.json untouched
    const updatedEntry: McpEntry = {
      ...state.entry,
      url: 'https://mcp.datadoghq.eu/api/unstable/mcp-server/mcp',
    };
    await persistEntry(tempDir, state.read, 'datadog', updatedEntry);

    const rootContent = JSON.parse(await readFile(join(tempDir, 'opencode.json'), 'utf8'));
    expect(rootContent.mcp.servers.datadog.url).toBe('https://mcp.datadoghq.eu/api/unstable/mcp-server/mcp');
    expect(rootContent.mcp.servers.datadog.oauth).toBe(false);

    const dotOpencodeContent = JSON.parse(await readFile(join(tempDir, '.opencode', 'opencode.json'), 'utf8'));
    expect(dotOpencodeContent.mcp).toBeUndefined();
  });

  it('prefers Datadog entry in .opencode/opencode.json over root opencode.json', async () => {
    await mkdir(join(tempDir, '.opencode'), { recursive: true });
    await writeFile(
      join(tempDir, '.opencode', 'opencode.json'),
      JSON.stringify(
        {
          mcp: {
            servers: {
              datadog: {
                type: 'remote',
                url: 'https://mcp.datadoghq.eu/api/unstable/mcp-server/mcp',
              },
            },
          },
        },
        null,
        2,
      ),
    );

    await writeFile(
      join(tempDir, 'opencode.json'),
      JSON.stringify(
        {
          mcp: {
            servers: {
              datadog: {
                type: 'remote',
                url: 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp',
              },
            },
          },
        },
        null,
        2,
      ),
    );

    const state = await loadServerState(tempDir, 'datadog');
    expect(state.kind).toBe('configured');
    if (state.kind !== 'configured') return;

    expect(state.read.file).toBe(join('.opencode', 'opencode.json'));
    expect(state.parsed.domain).toBe('mcp.datadoghq.eu');
  });

  it('targets existing .opencode/opencode.json when Datadog is not yet set up', async () => {
    await mkdir(join(tempDir, '.opencode'), { recursive: true });
    await writeFile(
      join(tempDir, '.opencode', 'opencode.json'),
      JSON.stringify({ plugins: ['@datadog/opencode-plugin'] }, null, 2),
    );

    const state = await loadServerState(tempDir, 'datadog');
    expect(state.kind).toBe('not-setup');
    if (state.kind !== 'not-setup') return;

    expect(state.read.status).toBe('parsed');
    if (state.read.status !== 'parsed') return;
    expect(state.read.file).toBe(join('.opencode', 'opencode.json'));

    const newEntry: McpEntry = {
      type: 'remote',
      url: 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp',
      oauth: {},
    };
    await persistEntry(tempDir, state.read, 'datadog', newEntry);

    const dotOpencodeContent = JSON.parse(await readFile(join(tempDir, '.opencode', 'opencode.json'), 'utf8'));
    expect(dotOpencodeContent.mcp.servers.datadog.url).toBe('https://mcp.datadoghq.com/api/unstable/mcp-server/mcp');
  });

  it('targets fresh opencode.json when no config file exists', async () => {
    const state = await loadServerState(tempDir, 'datadog');
    expect(state.kind).toBe('not-setup');
    if (state.kind !== 'not-setup') return;
    expect(state.read.status).toBe('missing');

    const newEntry: McpEntry = {
      type: 'remote',
      url: 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp',
      oauth: {},
    };
    await persistEntry(tempDir, state.read, 'datadog', newEntry);

    const rootContent = JSON.parse(await readFile(join(tempDir, 'opencode.json'), 'utf8'));
    expect(rootContent.mcp.servers.datadog.url).toBe('https://mcp.datadoghq.com/api/unstable/mcp-server/mcp');
  });

  it('reports malformed config if candidate file has syntax errors', async () => {
    await mkdir(join(tempDir, '.opencode'), { recursive: true });
    await writeFile(join(tempDir, '.opencode', 'opencode.json'), '{ invalid json');

    const state = await loadServerState(tempDir, 'datadog');
    expect(state.kind).toBe('malformed-config');
    if (state.kind !== 'malformed-config') return;
    expect(state.file).toBe(join('.opencode', 'opencode.json'));
  });

  it('preserves legacy mcp[mcpName] path when modifying existing legacy configuration', async () => {
    await writeFile(
      join(tempDir, 'opencode.json'),
      JSON.stringify(
        {
          mcp: {
            datadog: {
              type: 'remote',
              url: 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp',
              oauth: false,
            },
          },
        },
        null,
        2,
      ),
    );

    const state = await loadServerState(tempDir, 'datadog');
    expect(state.kind).toBe('configured');
    if (state.kind !== 'configured') return;

    expect(state.entry.oauth).toBe(false);

    const updatedEntry: McpEntry = {
      ...state.entry,
      url: 'https://mcp.datadoghq.eu/api/unstable/mcp-server/mcp',
    };
    await persistEntry(tempDir, state.read, 'datadog', updatedEntry);

    const rootContent = JSON.parse(await readFile(join(tempDir, 'opencode.json'), 'utf8'));
    expect(rootContent.mcp.datadog.url).toBe('https://mcp.datadoghq.eu/api/unstable/mcp-server/mcp');
    expect(rootContent.mcp.servers).toBeUndefined();
  });
});

describe('config source selection', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dd-source-test-'));
    await mkdir(join(directory, '.opencode'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it.each(['.', '.opencode'])('prefers JSONC over JSON in %s', async (folder) => {
    for (const extension of ['json', 'jsonc']) {
      await writeFile(join(directory, folder, `opencode.${extension}`), JSON.stringify({
        mcp: { servers: { datadog: { type: 'remote', url: `https://${extension}.example` } } },
      }));
    }
    const state = await loadServerState(directory, 'datadog');
    expect(state.kind).toBe('configured');
    if (state.kind !== 'configured') throw new Error('Expected configured server');
    expect(state.read.file).toBe(join(folder, 'opencode.jsonc'));
    expect(state.parsed.domain).toBe('jsonc.example');
  });

  it('does not fall back to a shadowed server when the winning URL is invalid', async () => {
    await writeFile(join(directory, '.opencode', 'opencode.json'), JSON.stringify({
      mcp: { servers: { datadog: { type: 'remote', url: 'invalid' } } },
    }));
    await writeFile(join(directory, 'opencode.json'), JSON.stringify({
      mcp: { servers: { datadog: { type: 'remote', url: 'https://mcp.datadoghq.com' } } },
    }));
    const state = await loadServerState(directory, 'datadog');
    expect(state.kind).toBe('not-setup');
    if (state.kind !== 'not-setup' || state.read.status !== 'parsed') throw new Error('Expected source file');
    expect(state.read.file).toBe(join('.opencode', 'opencode.json'));
  });

  it('updates the legacy entry without copying it into another server namespace', async () => {
    const legacy = {
      type: 'remote', url: 'https://mcp.datadoghq.com', enabled: false,
      timeout: 12000, oauth: { clientId: 'legacy-client' },
    };
    const other = { type: 'remote', url: 'https://other.example' };
    await writeFile(join(directory, 'opencode.json'), JSON.stringify({
      mcp: { datadog: legacy, servers: { other } },
    }));
    const state = await loadServerState(directory, 'datadog');
    if (state.kind !== 'configured') throw new Error('Expected configured server');
    const updated = { ...state.entry, url: 'https://mcp.datadoghq.eu' };
    await persistEntry(directory, state.read, 'datadog', updated);
    const config = JSON.parse(await readFile(join(directory, 'opencode.json'), 'utf8'));
    expect(config.mcp.datadog).toEqual(updated);
    expect(config.mcp.servers).toEqual({ other });
  });
});
