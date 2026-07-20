import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CommandHandler } from '../../src/bot/commands.js';

interface MockModel {
  id: string;
  displayName: string;
}

// Mock ClaudeManager
const mockClaudeManager = {
  clearSession: vi.fn(),
  setModel: vi.fn(),
  getAvailableModels: vi.fn(async (): Promise<MockModel[]> => []),
};

function makeChatInputInteraction(overrides: Record<string, any> = {}) {
  return {
    isChatInputCommand: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    reply: vi.fn(),
    ...overrides,
  };
}

function makeSelectMenuInteraction(overrides: Record<string, any> = {}) {
  return {
    isChatInputCommand: () => false,
    isStringSelectMenu: () => true,
    isModalSubmit: () => false,
    customId: 'model-select',
    reply: vi.fn(),
    update: vi.fn(),
    showModal: vi.fn(),
    ...overrides,
  };
}

function makeModalSubmitInteraction(overrides: Record<string, any> = {}) {
  return {
    isChatInputCommand: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => true,
    customId: 'model-custom-modal',
    reply: vi.fn(),
    ...overrides,
  };
}

describe('CommandHandler', () => {
  let commandHandler: CommandHandler;
  const allowedUserId = 'user-123';

  beforeEach(() => {
    commandHandler = new CommandHandler(mockClaudeManager as any, allowedUserId);
    vi.clearAllMocks();
  });

  describe('getCommands', () => {
    it('should return array of slash commands', () => {
      const commands = commandHandler.getCommands();
      expect(commands).toHaveLength(2);
      expect(commands[0].name).toBe('clear');
      expect(commands[1].name).toBe('model');
    });
  });

  describe('handleInteraction', () => {
    it('should ignore irrelevant interaction types', async () => {
      const mockInteraction = {
        isChatInputCommand: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
      };

      await commandHandler.handleInteraction(mockInteraction);
      // Should not throw or call any methods
      expect(mockClaudeManager.clearSession).not.toHaveBeenCalled();
    });

    it('should deny unauthorized users', async () => {
      const mockInteraction = makeChatInputInteraction({
        user: { id: 'unauthorized-user' },
      });

      await commandHandler.handleInteraction(mockInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: 'You are not authorized to use this bot.',
        ephemeral: true,
      });
      expect(mockClaudeManager.clearSession).not.toHaveBeenCalled();
    });

    it('should handle clear command for authorized user', async () => {
      const channelId = 'channel-123';
      const mockInteraction = makeChatInputInteraction({
        user: { id: allowedUserId },
        channelId,
        commandName: 'clear',
      });

      await commandHandler.handleInteraction(mockInteraction);

      expect(mockClaudeManager.clearSession).toHaveBeenCalledWith(channelId);
      expect(mockInteraction.reply).toHaveBeenCalledWith(
        'Session cleared! Next message will start a new Claude Code session.'
      );
    });

    it('should reply with a fallback model select menu when no models can be fetched', async () => {
      mockClaudeManager.getAvailableModels.mockResolvedValueOnce([]);
      const mockInteraction = makeChatInputInteraction({
        user: { id: allowedUserId },
        channelId: 'channel-123',
        commandName: 'model',
      });

      await commandHandler.handleInteraction(mockInteraction);

      expect(mockClaudeManager.setModel).not.toHaveBeenCalled();
      expect(mockInteraction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '請選擇這個頻道要使用的 model：',
          components: expect.any(Array),
          ephemeral: true,
        })
      );
    });

    it('should populate the select menu from the Anthropic Models API when available', async () => {
      mockClaudeManager.getAvailableModels.mockResolvedValueOnce([
        { id: 'claude-opus-4-8', displayName: 'Claude Opus 4.8' },
        { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' },
      ]);
      const channelName = 'my-channel';
      const mockInteraction = makeChatInputInteraction({
        user: { id: allowedUserId },
        channelId: 'channel-123',
        channel: { name: channelName },
        commandName: 'model',
      });

      await commandHandler.handleInteraction(mockInteraction);

      expect(mockClaudeManager.getAvailableModels).toHaveBeenCalledWith(channelName);

      const replyArg = mockInteraction.reply.mock.calls[0][0];
      const selectMenu = replyArg.components[0].components[0];
      const optionValues = selectMenu.options.map((o: any) => o.data.value);
      expect(optionValues).toEqual(['claude-opus-4-8', 'claude-sonnet-5', '__custom__']);
    });

    it('should set the model and update the message when a preset option is selected', async () => {
      const channelId = 'channel-123';
      const mockInteraction = makeSelectMenuInteraction({
        user: { id: allowedUserId },
        channelId,
        values: ['opus'],
      });

      await commandHandler.handleInteraction(mockInteraction);

      expect(mockClaudeManager.setModel).toHaveBeenCalledWith(channelId, 'opus');
      expect(mockInteraction.update).toHaveBeenCalledWith({
        content: '這個頻道之後將使用 `opus` 模型。',
        components: [],
      });
      expect(mockInteraction.showModal).not.toHaveBeenCalled();
    });

    it('should show a modal when the custom option is selected', async () => {
      const mockInteraction = makeSelectMenuInteraction({
        user: { id: allowedUserId },
        channelId: 'channel-123',
        values: ['__custom__'],
      });

      await commandHandler.handleInteraction(mockInteraction);

      expect(mockInteraction.showModal).toHaveBeenCalledTimes(1);
      expect(mockClaudeManager.setModel).not.toHaveBeenCalled();
      expect(mockInteraction.update).not.toHaveBeenCalled();
    });

    it('should set the model from the custom modal submission', async () => {
      const channelId = 'channel-123';
      const mockInteraction = makeModalSubmitInteraction({
        user: { id: allowedUserId },
        channelId,
        fields: { getTextInputValue: vi.fn(() => 'claude-opus-4-8') },
      });

      await commandHandler.handleInteraction(mockInteraction);

      expect(mockClaudeManager.setModel).toHaveBeenCalledWith(channelId, 'claude-opus-4-8');
      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: '這個頻道之後將使用 `claude-opus-4-8` 模型。',
        ephemeral: true,
      });
    });

    it('should reject a blank model name from the custom modal', async () => {
      const mockInteraction = makeModalSubmitInteraction({
        user: { id: allowedUserId },
        channelId: 'channel-123',
        fields: { getTextInputValue: vi.fn(() => '   ') },
      });

      await commandHandler.handleInteraction(mockInteraction);

      expect(mockClaudeManager.setModel).not.toHaveBeenCalled();
      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: '請輸入有效的 model 名稱。',
        ephemeral: true,
      });
    });

    it('should ignore unknown commands', async () => {
      const mockInteraction = makeChatInputInteraction({
        user: { id: allowedUserId },
        channelId: 'channel-123',
        commandName: 'unknown',
      });

      await commandHandler.handleInteraction(mockInteraction);

      expect(mockClaudeManager.clearSession).not.toHaveBeenCalled();
      expect(mockInteraction.reply).not.toHaveBeenCalled();
    });
  });
});
