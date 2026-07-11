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
    it('should set discord message and initialize tool call tracking', () => {
      const mockMessage = { edit: vi.fn() };
      manager.setDiscordMessage('channel-1', mockMessage);

      const channelMessages = (manager as any).channelMessages;
      const channelToolCalls = (manager as any).channelToolCalls;

      expect(channelMessages.get('channel-1')).toBe(mockMessage);
      expect(channelToolCalls.get('channel-1')).toEqual(new Map());
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

  describe('tool call message merging', () => {
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

    function toolResultMessage(results: Array<{ tool_use_id: string; content: string; is_error?: boolean }>) {
      return {
        type: 'user',
        session_id: 'session-1',
        message: {
          content: results.map((r) => ({
            type: 'tool_result',
            tool_use_id: r.tool_use_id,
            content: r.content,
            is_error: r.is_error,
          })),
        },
      } as any;
    }

    it('sends a single message for multiple tool_use calls in one assistant reply', async () => {
      const sentMessage = { edit: vi.fn().mockResolvedValue(undefined) };
      mockChannel.send.mockResolvedValue(sentMessage);

      await (manager as any).handleAssistantMessage(
        'channel-1',
        toolUseMessage([
          { id: 'tool-1', name: 'Read', input: { file_path: 'foo.ts' } },
          { id: 'tool-2', name: 'Bash', input: { command: 'ls' } },
        ])
      );

      expect(mockChannel.send).toHaveBeenCalledTimes(1);
      const sentEmbed = mockChannel.send.mock.calls[0][0].embeds[0];
      expect(sentEmbed.data.description).toContain('⏳ 🔧 Read (file_path=foo.ts)');
      expect(sentEmbed.data.description).toContain('⏳ 🔧 Bash (command=ls)');
    });

    it('updates only the affected line when a tool result arrives, without sending a new message', async () => {
      const sentMessage = { edit: vi.fn().mockResolvedValue(undefined) };
      mockChannel.send.mockResolvedValue(sentMessage);

      await (manager as any).handleAssistantMessage(
        'channel-1',
        toolUseMessage([
          { id: 'tool-1', name: 'Read', input: { file_path: 'foo.ts' } },
          { id: 'tool-2', name: 'Bash', input: { command: 'ls' } },
        ])
      );

      await (manager as any).handleToolResultMessage(
        'channel-1',
        toolResultMessage([{ tool_use_id: 'tool-1', content: 'file contents' }])
      );

      expect(mockChannel.send).toHaveBeenCalledTimes(1);
      expect(sentMessage.edit).toHaveBeenCalledTimes(1);
      const updatedDescription = sentMessage.edit.mock.calls[0]![0].embeds[0].data.description;
      expect(updatedDescription).toContain('✅ 🔧 Read (file_path=foo.ts)');
      expect(updatedDescription).toContain('⏳ 🔧 Bash (command=ls)');
    });

    it('marks a tool as failed with ❌ when the result is an error', async () => {
      const sentMessage = { edit: vi.fn().mockResolvedValue(undefined) };
      mockChannel.send.mockResolvedValue(sentMessage);

      await (manager as any).handleAssistantMessage(
        'channel-1',
        toolUseMessage([{ id: 'tool-1', name: 'Bash', input: { command: 'false' } }])
      );

      await (manager as any).handleToolResultMessage(
        'channel-1',
        toolResultMessage([{ tool_use_id: 'tool-1', content: 'command failed', is_error: true }])
      );

      const updatedDescription = sentMessage.edit.mock.calls[0]![0].embeds[0].data.description;
      expect(updatedDescription).toContain('❌ 🔧 Bash (command=false)');
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