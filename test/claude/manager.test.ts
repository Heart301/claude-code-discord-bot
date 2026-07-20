import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ClaudeManager } from '../../src/claude/manager.js';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs');
vi.mock('child_process');

// Mock bun:sqlite first
vi.mock('bun:sqlite', () => ({
  Database: vi.fn()
}));

vi.mock('../../src/db/database.js', () => ({
  DatabaseManager: vi.fn()
}));

describe('ClaudeManager', () => {
  let manager: ClaudeManager;
  let mockDb: any;
  const mockBaseFolder = '/test/base';

  beforeEach(async () => {
    vi.clearAllMocks();
    
    // Mock the DatabaseManager
    const { DatabaseManager } = await import('../../src/db/database.js');
    mockDb = {
      getSession: vi.fn(),
      setSession: vi.fn(),
      clearSession: vi.fn(),
      getAllSessions: vi.fn(),
      cleanupOldSessions: vi.fn(),
      getModel: vi.fn(),
      setModel: vi.fn(),
      close: vi.fn()
    };
    vi.mocked(DatabaseManager).mockImplementation(() => mockDb);
    
    manager = new ClaudeManager(mockBaseFolder);
  });

  afterEach(() => {
    manager.destroy();
    vi.restoreAllMocks();
  });

  describe('hasActiveProcess', () => {
    it('should return false when no active process exists', () => {
      expect(manager.hasActiveProcess('channel-1')).toBe(false);
    });

    it('should return true when active process exists', () => {
      manager.reserveChannel('channel-1', undefined, {});
      expect(manager.hasActiveProcess('channel-1')).toBe(true);
    });
  });

  describe('killActiveProcess', () => {
    it('should kill process when it exists', () => {
      const mockProcess = { kill: vi.fn() };
      manager.reserveChannel('channel-1', undefined, {});
      
      // Simulate setting the process
      const channelProcesses = (manager as any).channelProcesses;
      channelProcesses.get('channel-1').process = mockProcess;

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      
      manager.killActiveProcess('channel-1');
      
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
      expect(consoleSpy).toHaveBeenCalledWith('Killing active process for channel channel-1');
      
      consoleSpy.mockRestore();
    });

    it('should not throw when no process exists', () => {
      expect(() => manager.killActiveProcess('nonexistent')).not.toThrow();
    });
  });

  describe('clearSession', () => {
    it('should clear all session data', () => {
      manager.reserveChannel('channel-1', 'session-1', {});
      manager.setDiscordMessage('channel-1', { edit: vi.fn() });
      
      manager.clearSession('channel-1');
      
      expect(manager.hasActiveProcess('channel-1')).toBe(false);
      expect(mockDb.clearSession).toHaveBeenCalledWith('channel-1');
    });
  });

  describe('setDiscordMessage', () => {
    it('should set discord message', () => {
      const mockMessage = { edit: vi.fn() };
      manager.setDiscordMessage('channel-1', mockMessage);

      const channelMessages = (manager as any).channelMessages;

      expect(channelMessages.get('channel-1')).toBe(mockMessage);
    });
  });

  describe('reserveChannel', () => {
    it('should reserve channel without existing process', () => {
      const mockMessage = { edit: vi.fn() };
      manager.reserveChannel('channel-1', 'session-1', mockMessage);
      
      expect(manager.hasActiveProcess('channel-1')).toBe(true);
      // Note: reserveChannel sets the sessionId in the process object, not channelSessions
      // The sessionId is only set in channelSessions when Claude actually responds
    });

    it('should kill existing process when reserving channel', () => {
      const mockExistingProcess = { kill: vi.fn() };
      const mockMessage = { edit: vi.fn() };
      
      manager.reserveChannel('channel-1', undefined, mockMessage);
      const channelProcesses = (manager as any).channelProcesses;
      channelProcesses.get('channel-1').process = mockExistingProcess;
      
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      
      manager.reserveChannel('channel-1', 'new-session', mockMessage);
      
      expect(mockExistingProcess.kill).toHaveBeenCalledWith('SIGTERM');
      expect(consoleSpy).toHaveBeenCalledWith('Killing existing process for channel channel-1 before starting new one');
      
      consoleSpy.mockRestore();
    });
  });

  describe('getSessionId', () => {
    it('should return undefined when no session exists', () => {
      mockDb.getSession.mockReturnValue(undefined);
      expect(manager.getSessionId('channel-1')).toBeUndefined();
      expect(mockDb.getSession).toHaveBeenCalledWith('channel-1');
    });

    it('should return session ID when it exists', () => {
      mockDb.getSession.mockReturnValue('session-123');
      
      expect(manager.getSessionId('channel-1')).toBe('session-123');
      expect(mockDb.getSession).toHaveBeenCalledWith('channel-1');
    });
  });

  describe('runClaudeCode', () => {
    it('should throw error when working directory does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      
      await expect(
        manager.runClaudeCode('channel-1', 'test-channel', 'test prompt')
      ).rejects.toThrow('Working directory does not exist: /test/base/test-channel');
    });

    it('should set up process when directory exists', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      
      const mockProcess = {
        pid: 12345,
        stdin: { end: vi.fn() },
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        kill: vi.fn()
      };
      
      // Mock spawn from child_process module
      const { spawn } = await import('child_process');
      vi.mocked(spawn).mockReturnValue(mockProcess as any);
      
      manager.reserveChannel('channel-1', undefined, {});
      
      // Start the process and immediately resolve to avoid hanging
      try {
        await manager.runClaudeCode('channel-1', 'test-channel', 'test prompt');
      } catch (error) {
        // Expected to fail due to mocking, just checking setup
      }
      
      expect(spawn).toHaveBeenCalledWith('/bin/bash', ['-c', expect.stringContaining('claude')], expect.any(Object));
      expect(mockProcess.stdin.end).toHaveBeenCalled();
    });

    it('should pass the channel model override from the database to the spawned command', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockDb.getModel.mockReturnValue('opus');

      const mockProcess = {
        pid: 12345,
        stdin: { end: vi.fn() },
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        kill: vi.fn()
      };

      const { spawn } = await import('child_process');
      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      manager.reserveChannel('channel-1', undefined, {});

      try {
        await manager.runClaudeCode('channel-1', 'test-channel', 'test prompt');
      } catch (error) {
        // Expected to fail due to mocking, just checking setup
      }

      expect(mockDb.getModel).toHaveBeenCalledWith('channel-1');
      expect(spawn).toHaveBeenCalledWith(
        '/bin/bash',
        ['-c', expect.stringContaining("--model 'opus'")],
        expect.any(Object)
      );
    });

    it('should override ANTHROPIC_API_KEY when the channel has a mapped key', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const mockProcess = {
        pid: 12345,
        stdin: { end: vi.fn() },
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        kill: vi.fn()
      };

      const { spawn } = await import('child_process');
      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      const channelApiKeys = new Map([['test-channel', 'sk-test-key']]);
      const managerWithKeys = new ClaudeManager(mockBaseFolder, channelApiKeys);
      managerWithKeys.reserveChannel('channel-1', undefined, {});

      try {
        await managerWithKeys.runClaudeCode('channel-1', 'test-channel', 'test prompt');
      } catch (error) {
        // Expected to fail due to mocking, just checking setup
      }

      expect(spawn).toHaveBeenCalledWith(
        '/bin/bash',
        ['-c', expect.stringContaining('claude')],
        expect.objectContaining({
          env: expect.objectContaining({ ANTHROPIC_API_KEY: 'sk-test-key' }),
        })
      );

      managerWithKeys.destroy();
    });

    it('should not override ANTHROPIC_API_KEY when the channel has no mapped key', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const mockProcess = {
        pid: 12345,
        stdin: { end: vi.fn() },
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        kill: vi.fn()
      };

      const { spawn } = await import('child_process');
      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      manager.reserveChannel('channel-1', undefined, {});

      try {
        await manager.runClaudeCode('channel-1', 'test-channel', 'test prompt');
      } catch (error) {
        // Expected to fail due to mocking, just checking setup
      }

      const call = vi.mocked(spawn).mock.calls[0];
      const options = call[2] as { env: Record<string, string | undefined> };
      expect(options.env.ANTHROPIC_API_KEY).toBe(process.env.ANTHROPIC_API_KEY);
    });
  });

  describe('tool call messages', () => {
    let mockChannel: any;

    beforeEach(() => {
      mockChannel = { send: vi.fn() };
      manager.setDiscordMessage('channel-1', { channel: mockChannel });
    });

    function toolUseMessage(tools: Array<{ id: string; name: string; input?: any }>) {
      return {
        type: 'assistant',
        session_id: 'session-1',
        message: {
          content: tools.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input || {} })),
        },
      } as any;
    }

    it('does not send anything to Discord for an assistant reply that only contains tool_use', async () => {
      await (manager as any).handleAssistantMessage(
        'channel-1',
        toolUseMessage([
          { id: 'tool-1', name: 'Read', input: { file_path: 'foo.ts' } },
          { id: 'tool-2', name: 'Bash', input: { command: 'ls' } },
        ])
      );

      expect(mockChannel.send).not.toHaveBeenCalled();
    });

    it('still sends the text content when an assistant reply mixes text and tool_use', async () => {
      const message = toolUseMessage([{ id: 'tool-1', name: 'Read', input: { file_path: 'foo.ts' } }]);
      message.message.content.unshift({ type: 'text', text: 'checking the file' });

      await (manager as any).handleAssistantMessage('channel-1', message);

      expect(mockChannel.send).toHaveBeenCalledTimes(1);
      const sentEmbed = mockChannel.send.mock.calls[0][0].embeds[0];
      expect(sentEmbed.data.description).toBe('checking the file');
    });
  });

  describe('duplicate final message cleanup', () => {
    let mockChannel: any;

    beforeEach(() => {
      mockChannel = { send: vi.fn() };
      manager.setDiscordMessage('channel-1', { channel: mockChannel });
    });

    function assistantTextMessage(text: string) {
      return {
        type: 'assistant',
        session_id: 'session-1',
        message: { content: [{ type: 'text', text }] },
      } as any;
    }

    function resultMessage(overrides: Partial<{ subtype: string; result: string; num_turns: number }> = {}) {
      return {
        type: 'result',
        session_id: 'session-1',
        subtype: 'success',
        result: 'final answer',
        num_turns: 3,
        ...overrides,
      } as any;
    }

    it('deletes the last assistant message when its text matches the result', async () => {
      const sentAssistantMessage = { delete: vi.fn().mockResolvedValue(undefined) };
      mockChannel.send.mockResolvedValueOnce(sentAssistantMessage).mockResolvedValueOnce({});

      await (manager as any).handleAssistantMessage('channel-1', assistantTextMessage('final answer'));
      await (manager as any).handleResultMessage('channel-1', resultMessage({ result: 'final answer' }));

      expect(sentAssistantMessage.delete).toHaveBeenCalledTimes(1);
      expect(mockChannel.send).toHaveBeenCalledTimes(2);
    });

    it('keeps the last assistant message when its text differs from the result', async () => {
      const sentAssistantMessage = { delete: vi.fn().mockResolvedValue(undefined) };
      mockChannel.send.mockResolvedValueOnce(sentAssistantMessage).mockResolvedValueOnce({});

      await (manager as any).handleAssistantMessage('channel-1', assistantTextMessage('intermediate update'));
      await (manager as any).handleResultMessage('channel-1', resultMessage({ result: 'final answer' }));

      expect(sentAssistantMessage.delete).not.toHaveBeenCalled();
    });

    it('does not attempt to delete anything when no assistant message was sent', async () => {
      mockChannel.send.mockResolvedValueOnce({});

      await expect(
        (manager as any).handleResultMessage('channel-1', resultMessage({ result: 'final answer' }))
      ).resolves.not.toThrow();

      expect(mockChannel.send).toHaveBeenCalledTimes(1);
    });

    it('does not delete the last assistant message for a failed session', async () => {
      const sentAssistantMessage = { delete: vi.fn().mockResolvedValue(undefined) };
      mockChannel.send.mockResolvedValueOnce(sentAssistantMessage).mockResolvedValueOnce({});

      await (manager as any).handleAssistantMessage('channel-1', assistantTextMessage('final answer'));
      await (manager as any).handleResultMessage(
        'channel-1',
        resultMessage({ subtype: 'error_during_execution', result: 'final answer' })
      );

      expect(sentAssistantMessage.delete).not.toHaveBeenCalled();
    });

    it('deletes the duplicate assistant message when the CLI flushes the assistant and result lines in the same stdout chunk', async () => {
      // runClaudeCode dispatches handleAssistantMessage/handleResultMessage
      // without awaiting between lines, so this reproduces the real dispatch
      // order instead of the artificially-sequenced calls above.
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const sentAssistantMessage = { delete: vi.fn().mockResolvedValue(undefined) };
      mockChannel.send.mockResolvedValueOnce(sentAssistantMessage).mockResolvedValueOnce({});

      const mockProcess = {
        pid: 1,
        stdin: { end: vi.fn() },
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        kill: vi.fn(),
      };

      const { spawn } = await import('child_process');
      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      manager.reserveChannel('channel-1', undefined, {});
      await manager.runClaudeCode('channel-1', 'test-channel', 'test prompt');

      const dataHandler = mockProcess.stdout.on.mock.calls.find(
        (call: any[]) => call[0] === 'data'
      )?.[1];
      expect(dataHandler).toBeDefined();

      const assistantLine = JSON.stringify(assistantTextMessage('final answer'));
      const resultLine = JSON.stringify(resultMessage({ result: 'final answer' }));
      dataHandler(Buffer.from(`${assistantLine}\n${resultLine}\n`));

      // Flush the microtask/macrotask queue so any chained async work settles.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(sentAssistantMessage.delete).toHaveBeenCalledTimes(1);
    });
  });

  describe('idle timeout and absolute timeout', () => {
    let mockChannel: any;
    let mockProcess: any;

    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      vi.mocked(fs.existsSync).mockReturnValue(true);

      mockChannel = { send: vi.fn().mockResolvedValue({}) };
      manager.setDiscordMessage('channel-1', { channel: mockChannel });

      mockProcess = {
        pid: 1,
        stdin: { end: vi.fn() },
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        kill: vi.fn(),
      };

      const { spawn } = await import('child_process');
      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      manager.reserveChannel('channel-1', undefined, {});
      await manager.runClaudeCode('channel-1', 'test-channel', 'test prompt');
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function getStdoutDataHandler() {
      const call = mockProcess.stdout.on.mock.calls.find((c: any[]) => c[0] === 'data');
      return call?.[1];
    }

    it('kills the process after 15 minutes with no stdout output', () => {
      vi.advanceTimersByTime(15 * 60 * 1000);

      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockChannel.send).toHaveBeenCalledTimes(1);
      const embed = mockChannel.send.mock.calls[0][0].embeds[0];
      expect(embed.data.description).toBe('Claude Code 已 15 分鐘沒有任何回應');
    });

    it('resets the idle timer on any stdout output, even a partial non-JSON chunk', () => {
      const dataHandler = getStdoutDataHandler();
      expect(dataHandler).toBeDefined();

      // Just under the original idle deadline, some output arrives (not a full JSON line).
      vi.advanceTimersByTime(14 * 60 * 1000 + 59 * 1000);
      dataHandler(Buffer.from('partial output, not a full line yet'));

      // The original 15-minute-from-start deadline passes with no kill,
      // because the data above reset the timer.
      vi.advanceTimersByTime(2000);
      expect(mockProcess.kill).not.toHaveBeenCalled();

      // A further 15 minutes from the reset point with still no output
      // triggers the idle timeout.
      vi.advanceTimersByTime(15 * 60 * 1000);
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('triggers the absolute timeout instead of idle timeout when output keeps arriving but total runtime exceeds 60 minutes', () => {
      const dataHandler = getStdoutDataHandler();

      // Emit a small chunk every 10 minutes, well under the 15-minute idle
      // deadline, for just under an hour.
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(10 * 60 * 1000);
        dataHandler(Buffer.from('keep-alive chunk'));
      }
      expect(mockProcess.kill).not.toHaveBeenCalled();

      // Crossing the 60-minute absolute cap kills the process even though
      // output kept arriving.
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
      const embed = mockChannel.send.mock.calls[0][0].embeds[0];
      expect(embed.data.description).toBe('Claude Code 執行時間已超過 60 分鐘上限');
    });

    it('clears both timers once the result message is handled, so no timeout fires afterward', async () => {
      const dataHandler = getStdoutDataHandler();

      const resultLine = JSON.stringify({
        type: 'result',
        session_id: 'session-1',
        subtype: 'success',
        result: 'done',
        num_turns: 1,
      });
      dataHandler(Buffer.from(`${resultLine}\n`));

      // Flush the microtask/macrotask queue so the queued handleResultMessage
      // and its cleanup .then() settle (same pattern as the existing
      // "duplicate final message cleanup" tests — setImmediate is real here
      // because fake timers only fake setTimeout/clearTimeout).
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockProcess.kill).toHaveBeenCalledTimes(1);

      mockChannel.send.mockClear();
      vi.advanceTimersByTime(60 * 60 * 1000);

      expect(mockProcess.kill).toHaveBeenCalledTimes(1);
      expect(mockChannel.send).not.toHaveBeenCalled();
    });
  });

  describe('database integration', () => {
    it('should initialize database and cleanup old sessions on construction', () => {
      // The cleanupOldSessions call happens during construction, so we need to check
      // if it was called when the manager was created in beforeEach
      expect(mockDb.cleanupOldSessions).toHaveBeenCalled();
    });

    it('should close database on destroy', () => {
      manager.destroy();
      expect(mockDb.close).toHaveBeenCalled();
    });
  });
});