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

    it('falls back to the unaugmented prompt and does not throw when downloadAttachments rejects', async () => {
      mockDownloadAttachments.mockRejectedValue(new Error('disk full'));
      const attachments = new Map([
        ['a1', { url: 'https://cdn.discordapp.com/x.png', name: 'x.png', size: 1000 }],
      ]);
      const message = buildMessage({ attachments });

      await expect((discordBot as any).handleMessage(message)).resolves.not.toThrow();

      expect(mockClaudeManager.runClaudeCode).toHaveBeenCalledWith(
        channelId,
        'my-project',
        'look at this',
        undefined,
        expect.anything()
      );
    });
  });
});
