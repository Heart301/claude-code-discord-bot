import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sanitizeFilename, AttachmentStore } from '../../src/utils/attachments.js';
import * as fs from 'fs';

vi.mock('os', () => ({
  tmpdir: () => '/tmp',
}));

vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
}));

describe('sanitizeFilename', () => {
  it('keeps a simple safe filename unchanged', () => {
    expect(sanitizeFilename('screenshot.png')).toBe('screenshot.png');
  });

  it('strips directory components to prevent path traversal', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
  });

  it('strips absolute path components', () => {
    expect(sanitizeFilename('/etc/passwd')).toBe('passwd');
  });

  it('replaces disallowed characters with underscores', () => {
    expect(sanitizeFilename('my file@name!.png')).toBe('my_file_name_.png');
  });

  it('falls back to an underscore for an empty result', () => {
    expect(sanitizeFilename('...')).toBe('...');
    expect(sanitizeFilename('')).toBe('_');
  });
});

describe('AttachmentStore.downloadAttachments', () => {
  let store: AttachmentStore;

  beforeEach(() => {
    store = new AttachmentStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('downloads a valid attachment to the expected path', async () => {
    const fakeBytes = new TextEncoder().encode('fake-image-bytes').buffer;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => fakeBytes,
    }));

    const result = await store.downloadAttachments('chan-1', 'msg-1', [
      { url: 'https://cdn.discordapp.com/screenshot.png', name: 'screenshot.png', size: 1000 },
    ]);

    expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/claude-discord-bot/chan-1', { recursive: true });
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/tmp/claude-discord-bot/chan-1/msg-1-screenshot.png',
      Buffer.from(fakeBytes)
    );
    expect(result.paths).toEqual(['/tmp/claude-discord-bot/chan-1/msg-1-screenshot.png']);
    expect(result.skipped).toEqual([]);
  });

  it('skips attachments over the 25MB limit without fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await store.downloadAttachments('chan-1', 'msg-1', [
      { url: 'https://cdn.discordapp.com/huge.png', name: 'huge.png', size: 30_000_000 },
    ]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(result.paths).toEqual([]);
    expect(result.skipped).toEqual([{ name: 'huge.png', reason: 'exceeds 25MB limit' }]);
  });

  it('skips attachments when the download request fails with a non-OK status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    const result = await store.downloadAttachments('chan-1', 'msg-1', [
      { url: 'https://cdn.discordapp.com/missing.png', name: 'missing.png', size: 1000 },
    ]);

    expect(result.paths).toEqual([]);
    expect(result.skipped).toEqual([{ name: 'missing.png', reason: 'download failed: HTTP 404' }]);
  });

  it('skips attachments when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const result = await store.downloadAttachments('chan-1', 'msg-1', [
      { url: 'https://cdn.discordapp.com/broken.png', name: 'broken.png', size: 1000 },
    ]);

    expect(result.paths).toEqual([]);
    expect(result.skipped).toEqual([{ name: 'broken.png', reason: 'download failed: network down' }]);
  });

  it('sanitizes filenames so a malicious name cannot escape the channel directory', async () => {
    const fakeBytes = new TextEncoder().encode('x').buffer;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => fakeBytes,
    }));

    const result = await store.downloadAttachments('chan-1', 'msg-1', [
      { url: 'https://cdn.discordapp.com/x', name: '../../etc/passwd', size: 1000 },
    ]);

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/tmp/claude-discord-bot/chan-1/msg-1-passwd',
      Buffer.from(fakeBytes)
    );
    expect(result.paths).toEqual(['/tmp/claude-discord-bot/chan-1/msg-1-passwd']);
  });
});
