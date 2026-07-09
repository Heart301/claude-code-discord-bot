# Discord 截圖附件處理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓使用者在 Discord 傳訊息附上截圖(或其他檔案)時,該檔案會被下載到暫存目錄,檔案路徑會被附加到傳給 Claude Code 的 prompt 文字裡,讓 Claude 可以用 Read 工具讀取內容。

**Architecture:** 新增 `src/utils/attachments.ts`,匯出 `AttachmentStore` class(負責下載、清理)與 `formatAttachmentsForPrompt` 純函式(負責組 prompt 文字)。`src/bot/client.ts` 的 `handleMessage` 在既有流程中插入:清掉上一輪暫存檔 → 若有附件則下載並組新 prompt → 沿用既有的 `runClaudeCode` 呼叫。

**Tech Stack:** Bun + TypeScript,discord.js v14,vitest(`bun run test:run`),Node 內建 `fs`/`os`/`path`,全域 `fetch`。

## Global Constraints

- 單一附件大小上限:**25MB**,超過就跳過不下載。
- 暫存路徑固定為 `os.tmpdir()/claude-discord-bot/<channelId>/<messageId>-<清洗後檔名>`。
- 檔名清洗:先取 `path.basename()`,再把不在白名單(英數字、`.`、`_`、`-`)的字元換成 `_`。
- 只下載 discord.js 附件物件自帶的 `url`(Discord CDN),絕不解析 prompt 文字或其他來源的 URL。
- 絕不對下載的檔案做任何執行(`exec`/`spawn`/`chmod +x`)——只寫入磁碟與把路徑塞進文字。
- 清理時機:同一 channel 收到「下一則」新訊息時,清掉上一輪的暫存檔(不是處理完當次訊息就立刻清)。
- 測試一律用 `bun run test:run` 執行,不可用 `bun test`。

---

### Task 1: `sanitizeFilename` 純函式

**Files:**
- Create: `src/utils/attachments.ts`
- Test: `test/utils/attachments.test.ts`

**Interfaces:**
- Produces: `export function sanitizeFilename(name: string): string`

- [ ] **Step 1: Write the failing test**

Create `test/utils/attachments.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sanitizeFilename } from '../../src/utils/attachments.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:run test/utils/attachments.test.ts`
Expected: FAIL — `src/utils/attachments.ts` does not exist yet (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `src/utils/attachments.ts`:

```ts
import * as path from "path";

export function sanitizeFilename(name: string): string {
  const base = path.basename(name);
  const sanitized = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized === "" ? "_" : sanitized;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:run test/utils/attachments.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/utils/attachments.ts test/utils/attachments.test.ts
git commit -m "feat: add sanitizeFilename helper for attachment filenames"
```

---

### Task 2: `AttachmentStore.downloadAttachments`

**Files:**
- Modify: `src/utils/attachments.ts`
- Test: `test/utils/attachments.test.ts`

**Interfaces:**
- Consumes: `sanitizeFilename(name: string): string` (Task 1)
- Produces:
  - `export interface AttachmentInput { url: string; name: string; size: number; }`
  - `export interface SkippedAttachment { name: string; reason: string; }`
  - `export interface DownloadResult { paths: string[]; skipped: SkippedAttachment[]; }`
  - `export class AttachmentStore { async downloadAttachments(channelId: string, messageId: string, attachments: AttachmentInput[]): Promise<DownloadResult> }`

- [ ] **Step 1: Write the failing test**

Add to `test/utils/attachments.test.ts` (below the existing `sanitizeFilename` describe block):

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:run test/utils/attachments.test.ts`
Expected: FAIL — `AttachmentStore` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Replace the contents of `src/utils/attachments.ts` with:

```ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;

export function sanitizeFilename(name: string): string {
  const base = path.basename(name);
  const sanitized = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized === "" ? "_" : sanitized;
}

export interface AttachmentInput {
  url: string;
  name: string;
  size: number;
}

export interface SkippedAttachment {
  name: string;
  reason: string;
}

export interface DownloadResult {
  paths: string[];
  skipped: SkippedAttachment[];
}

export class AttachmentStore {
  private channelDirs = new Map<string, string>();

  async downloadAttachments(
    channelId: string,
    messageId: string,
    attachments: AttachmentInput[]
  ): Promise<DownloadResult> {
    const dir = path.join(os.tmpdir(), "claude-discord-bot", channelId);
    fs.mkdirSync(dir, { recursive: true });
    this.channelDirs.set(channelId, dir);

    const paths: string[] = [];
    const skipped: SkippedAttachment[] = [];

    for (const attachment of attachments) {
      if (attachment.size > MAX_ATTACHMENT_SIZE_BYTES) {
        skipped.push({ name: attachment.name, reason: "exceeds 25MB limit" });
        continue;
      }

      const safeName = sanitizeFilename(attachment.name);
      const filePath = path.join(dir, `${messageId}-${safeName}`);

      try {
        const response = await fetch(attachment.url);
        if (!response.ok) {
          skipped.push({
            name: attachment.name,
            reason: `download failed: HTTP ${response.status}`,
          });
          continue;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(filePath, buffer);
        paths.push(filePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        skipped.push({ name: attachment.name, reason: `download failed: ${message}` });
      }
    }

    return { paths, skipped };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:run test/utils/attachments.test.ts`
Expected: PASS (10 tests total: 5 from Task 1 + 5 from this task)

- [ ] **Step 5: Commit**

```bash
git add src/utils/attachments.ts test/utils/attachments.test.ts
git commit -m "feat: add AttachmentStore.downloadAttachments with size limit and error handling"
```

---

### Task 3: `AttachmentStore.cleanupChannel`

**Files:**
- Modify: `src/utils/attachments.ts`
- Test: `test/utils/attachments.test.ts`

**Interfaces:**
- Consumes: `AttachmentStore` (Task 2), internal `channelDirs` map populated by `downloadAttachments`
- Produces: `AttachmentStore.cleanupChannel(channelId: string): void`

- [ ] **Step 1: Write the failing test**

Add to `test/utils/attachments.test.ts`:

```ts
describe('AttachmentStore.cleanupChannel', () => {
  let store: AttachmentStore;

  beforeEach(() => {
    store = new AttachmentStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('removes the directory created for a channel', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    await store.downloadAttachments('chan-1', 'msg-1', [
      { url: 'https://cdn.discordapp.com/a.png', name: 'a.png', size: 10 },
    ]);

    store.cleanupChannel('chan-1');

    expect(fs.rmSync).toHaveBeenCalledWith('/tmp/claude-discord-bot/chan-1', {
      recursive: true,
      force: true,
    });
  });

  it('is a no-op for a channel with no downloaded attachments', () => {
    expect(() => store.cleanupChannel('unknown-channel')).not.toThrow();
    expect(fs.rmSync).not.toHaveBeenCalled();
  });

  it('does not call rmSync twice for the same channel', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    await store.downloadAttachments('chan-1', 'msg-1', [
      { url: 'https://cdn.discordapp.com/a.png', name: 'a.png', size: 10 },
    ]);

    store.cleanupChannel('chan-1');
    store.cleanupChannel('chan-1');

    expect(fs.rmSync).toHaveBeenCalledTimes(1);
  });

  it('swallows errors thrown by rmSync', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    (fs.rmSync as any).mockImplementation(() => {
      throw new Error('busy');
    });
    await store.downloadAttachments('chan-1', 'msg-1', [
      { url: 'https://cdn.discordapp.com/a.png', name: 'a.png', size: 10 },
    ]);

    expect(() => store.cleanupChannel('chan-1')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:run test/utils/attachments.test.ts`
Expected: FAIL — `cleanupChannel` is not a function.

- [ ] **Step 3: Write minimal implementation**

In `src/utils/attachments.ts`, add the method to the `AttachmentStore` class (after `downloadAttachments`):

```ts
  cleanupChannel(channelId: string): void {
    const dir = this.channelDirs.get(channelId);
    if (!dir) return;

    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      console.error(`Error cleaning up attachments for channel ${channelId}:`, error);
    }

    this.channelDirs.delete(channelId);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:run test/utils/attachments.test.ts`
Expected: PASS (14 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/utils/attachments.ts test/utils/attachments.test.ts
git commit -m "feat: add AttachmentStore.cleanupChannel"
```

---

### Task 4: `formatAttachmentsForPrompt`

**Files:**
- Modify: `src/utils/attachments.ts`
- Test: `test/utils/attachments.test.ts`

**Interfaces:**
- Produces: `export function formatAttachmentsForPrompt(prompt: string, paths: string[]): string`

- [ ] **Step 1: Write the failing test**

Add to `test/utils/attachments.test.ts`:

```ts
import { formatAttachmentsForPrompt } from '../../src/utils/attachments.js';

describe('formatAttachmentsForPrompt', () => {
  it('returns the original prompt unchanged when there are no paths', () => {
    expect(formatAttachmentsForPrompt('look at this', [])).toBe('look at this');
  });

  it('appends a file list block when paths are present', () => {
    const result = formatAttachmentsForPrompt('look at this', [
      '/tmp/claude-discord-bot/chan-1/msg-1-a.png',
      '/tmp/claude-discord-bot/chan-1/msg-1-b.png',
    ]);
    expect(result).toBe(
      'look at this\n\n[附加檔案]\n- /tmp/claude-discord-bot/chan-1/msg-1-a.png\n- /tmp/claude-discord-bot/chan-1/msg-1-b.png'
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:run test/utils/attachments.test.ts`
Expected: FAIL — `formatAttachmentsForPrompt` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Add to `src/utils/attachments.ts` (below the `AttachmentStore` class):

```ts
export function formatAttachmentsForPrompt(prompt: string, paths: string[]): string {
  if (paths.length === 0) return prompt;
  const fileList = paths.map((p) => `- ${p}`).join("\n");
  return `${prompt}\n\n[附加檔案]\n${fileList}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:run test/utils/attachments.test.ts`
Expected: PASS (16 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/utils/attachments.ts test/utils/attachments.test.ts
git commit -m "feat: add formatAttachmentsForPrompt helper"
```

---

### Task 5: Wire `AttachmentStore` into `DiscordBot.handleMessage`

**Files:**
- Modify: `src/bot/client.ts`
- Test: `test/bot/client.test.ts`

**Interfaces:**
- Consumes:
  - `AttachmentStore` with `downloadAttachments(channelId, messageId, attachments: AttachmentInput[]): Promise<DownloadResult>` and `cleanupChannel(channelId: string): void` (Task 2, 3)
  - `formatAttachmentsForPrompt(prompt: string, paths: string[]): string` (Task 4)
- Produces: `DiscordBot` now downloads attachments and passes an augmented prompt to `ClaudeManager.runClaudeCode`. No public interface changes — `DiscordBot`'s constructor signature and public methods (`login`, `setMCPServer`) are unchanged.

- [ ] **Step 1: Write the failing test**

Replace the full contents of `test/bot/client.test.ts` with:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DiscordBot } from '../../src/bot/client.js';

// Mock discord.js
vi.mock('discord.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    once: vi.fn(),
    on: vi.fn(),
    login: vi.fn().mockResolvedValue(undefined),
    user: { tag: 'TestBot#1234', id: 'bot-123' }
  })),
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
    GuildMessageReactions: 8,
  },
  EmbedBuilder: vi.fn().mockImplementation(() => {
    const embed: any = {};
    embed.setColor = vi.fn().mockReturnValue(embed);
    embed.setTitle = vi.fn().mockReturnValue(embed);
    embed.setDescription = vi.fn().mockReturnValue(embed);
    return embed;
  }),
}));

const { mockDownloadAttachments, mockCleanupChannel } = vi.hoisted(() => ({
  mockDownloadAttachments: vi.fn(),
  mockCleanupChannel: vi.fn(),
}));

vi.mock('../../src/utils/attachments.js', () => ({
  AttachmentStore: vi.fn().mockImplementation(() => ({
    downloadAttachments: mockDownloadAttachments,
    cleanupChannel: mockCleanupChannel,
  })),
  formatAttachmentsForPrompt: (prompt: string, paths: string[]) =>
    paths.length === 0 ? prompt : `${prompt}\n\n[附加檔案]\n${paths.map((p) => `- ${p}`).join('\n')}`,
}));

// Mock ClaudeManager
const mockClaudeManager = {
  hasActiveProcess: vi.fn(),
  clearSession: vi.fn(),
  setDiscordMessage: vi.fn(),
  reserveChannel: vi.fn(),
  runClaudeCode: vi.fn(),
  getSessionId: vi.fn(),
};

describe('DiscordBot', () => {
  let discordBot: DiscordBot;
  const allowedUserId = 'user-123';

  beforeEach(() => {
    vi.clearAllMocks();
    mockClaudeManager.hasActiveProcess.mockReturnValue(false);
    mockClaudeManager.getSessionId.mockReturnValue(undefined);
    mockDownloadAttachments.mockResolvedValue({ paths: [], skipped: [] });
    discordBot = new DiscordBot(mockClaudeManager as any, allowedUserId);
  });

  describe('login', () => {
    it('should call client.login with token', async () => {
      const token = 'test-token';
      await discordBot.login(token);
      expect(typeof discordBot.login).toBe('function');
    });
  });

  describe('constructor', () => {
    it('should create instance without throwing', () => {
      expect(() => new DiscordBot(mockClaudeManager as any, allowedUserId)).not.toThrow();
    });
  });

  describe('handleMessage attachment handling', () => {
    const channelId = 'chan-1';
    const messageId = 'msg-1';

    function buildMessage(overrides: any = {}) {
      return {
        id: messageId,
        author: { bot: false, id: allowedUserId },
        channelId,
        channel: {
          name: 'my-project',
          send: vi.fn().mockResolvedValue({ id: 'reply-1' }),
        },
        content: 'look at this',
        attachments: new Map(),
        ...overrides,
      };
    }

    it('calls cleanupChannel for every message, even without attachments', async () => {
      const message = buildMessage();
      await (discordBot as any).handleMessage(message);
      expect(mockCleanupChannel).toHaveBeenCalledWith(channelId);
    });

    it('passes the prompt unchanged when there are no attachments', async () => {
      const message = buildMessage();
      await (discordBot as any).handleMessage(message);

      expect(mockDownloadAttachments).not.toHaveBeenCalled();
      expect(mockClaudeManager.runClaudeCode).toHaveBeenCalledWith(
        channelId,
        'my-project',
        'look at this',
        undefined,
        expect.anything()
      );
    });

    it('appends downloaded file paths to the prompt when attachments are present', async () => {
      mockDownloadAttachments.mockResolvedValue({
        paths: ['/tmp/claude-discord-bot/chan-1/msg-1-screenshot.png'],
        skipped: [],
      });
      const attachments = new Map([
        ['a1', { url: 'https://cdn.discordapp.com/x.png', name: 'screenshot.png', size: 1000 }],
      ]);
      const message = buildMessage({ attachments });

      await (discordBot as any).handleMessage(message);

      expect(mockDownloadAttachments).toHaveBeenCalledWith(
        channelId,
        messageId,
        [{ url: 'https://cdn.discordapp.com/x.png', name: 'screenshot.png', size: 1000 }]
      );
      expect(mockClaudeManager.runClaudeCode).toHaveBeenCalledWith(
        channelId,
        'my-project',
        'look at this\n\n[附加檔案]\n- /tmp/claude-discord-bot/chan-1/msg-1-screenshot.png',
        undefined,
        expect.anything()
      );
    });

    it('sends a warning message listing skipped attachments', async () => {
      mockDownloadAttachments.mockResolvedValue({
        paths: [],
        skipped: [{ name: 'huge.png', reason: 'exceeds 25MB limit' }],
      });
      const attachments = new Map([
        ['a1', { url: 'https://cdn.discordapp.com/huge.png', name: 'huge.png', size: 30_000_000 }],
      ]);
      const message = buildMessage({ attachments });

      await (discordBot as any).handleMessage(message);

      expect(message.channel.send).toHaveBeenCalledWith(
        expect.objectContaining({ embeds: expect.any(Array) })
      );
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:run test/bot/client.test.ts`
Expected: FAIL — the three new `handleMessage attachment handling` tests fail because `client.ts` does not yet call `cleanupChannel`/`downloadAttachments` or use the augmented prompt (the module mock itself resolves fine, but assertions on `mockCleanupChannel`/`mockDownloadAttachments`/the augmented prompt string fail).

- [ ] **Step 3: Write minimal implementation**

In `src/bot/client.ts`:

1. Update the imports at the top of the file:

```ts
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
} from "discord.js";
import type { ClaudeManager } from '../claude/manager.js';
import { CommandHandler } from './commands.js';
import type { MCPPermissionServer } from '../mcp/server.js';
import { AttachmentStore, formatAttachmentsForPrompt } from '../utils/attachments.js';
```

2. Add a private field and initialize it in the constructor:

```ts
export class DiscordBot {
  public client: Client; // Make public so MCP server can access it
  private commandHandler: CommandHandler;
  private mcpServer?: MCPPermissionServer;
  private attachmentStore: AttachmentStore;

  constructor(
    private claudeManager: ClaudeManager,
    private allowedUserId: string | undefined
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions, // Add reactions for approval
      ],
    });

    this.commandHandler = new CommandHandler(claudeManager, allowedUserId);
    this.attachmentStore = new AttachmentStore();
    this.setupEventHandlers();
  }
```

3. In `handleMessage`, insert attachment handling right after the `general` channel check (`if (channelName === "general") { return; }`) and before `const sessionId = ...`, and use the resulting `prompt` variable instead of `message.content` in the `runClaudeCode` call:

```ts
    // Don't run in general channel
    if (channelName === "general") {
      return;
    }

    // Clean up attachments downloaded for the previous message in this channel
    this.attachmentStore.cleanupChannel(channelId);

    let prompt = message.content;
    if (message.attachments && message.attachments.size > 0) {
      const attachmentInputs = Array.from(message.attachments.values()).map((a: any) => ({
        url: a.url,
        name: a.name,
        size: a.size,
      }));

      const { paths, skipped } = await this.attachmentStore.downloadAttachments(
        channelId,
        message.id,
        attachmentInputs
      );

      prompt = formatAttachmentsForPrompt(prompt, paths);

      if (skipped.length > 0) {
        const warningEmbed = new EmbedBuilder()
          .setTitle("⚠️ Warning")
          .setDescription(skipped.map((s) => `${s.name}: ${s.reason}`).join("\n"))
          .setColor(0xFFA500);

        try {
          await message.channel.send({ embeds: [warningEmbed] });
        } catch (error) {
          console.error("Error sending attachment warning message:", error);
        }
      }
    }

    const sessionId = this.claudeManager.getSessionId(channelId);
```

4. Update the `runClaudeCode` call to use `prompt` instead of `message.content`:

```ts
      // Reserve the channel and run Claude Code
      this.claudeManager.reserveChannel(channelId, sessionId, reply);
      await this.claudeManager.runClaudeCode(channelId, channelName, prompt, sessionId, discordContext);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:run test/bot/client.test.ts`
Expected: PASS (6 tests total)

Then run the full suite to confirm no regressions:

Run: `bun run test:run`
Expected: PASS (all test files, including `test/utils/attachments.test.ts` from Tasks 1–4)

- [ ] **Step 5: Commit**

```bash
git add src/bot/client.ts test/bot/client.test.ts
git commit -m "feat: download Discord attachments and pass file paths to Claude Code"
```

---

## Manual Verification (does not require running the bot)

Per project restrictions, do not run `bun run src/index.ts` or `bun run start`. Instead, confirm behavior via:

- `bun run test:run` — full suite green.
- Re-read the final `src/bot/client.ts` and `src/utils/attachments.ts` diffs to confirm no `child_process`/`exec`/`spawn` call was added anywhere that touches a downloaded attachment path, satisfying the "never execute uploaded files" requirement from the spec.
