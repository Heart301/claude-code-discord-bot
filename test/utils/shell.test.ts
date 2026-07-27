import { describe, it, expect, afterEach } from 'vitest';
import { escapeShellString, buildClaudeCommand } from '../../src/utils/shell.js';

describe('escapeShellString', () => {
  it('should wrap simple strings in single quotes', () => {
    expect(escapeShellString('hello world')).toBe("'hello world'");
  });

  it('should escape single quotes properly', () => {
    expect(escapeShellString("don't")).toBe("'don'\\''t'");
  });

  it('should handle multiple single quotes', () => {
    expect(escapeShellString("can't won't")).toBe("'can'\\''t won'\\''t'");
  });

  it('should handle empty string', () => {
    expect(escapeShellString('')).toBe("''");
  });

  it('should handle string with only single quotes', () => {
    expect(escapeShellString("'''")).toBe("''\\'''\\'''\\'''");
  });
});

describe('buildClaudeCommand', () => {
  const mcpConfigJson = '{"mcpServers":{"discord-permissions":{"type":"http","url":"http://localhost:3001/mcp"}}}';
  const mcpFlags = `--mcp-config '${mcpConfigJson}' --strict-mcp-config --permission-prompt-tool mcp__discord-permissions__approve_tool --allowedTools mcp__discord-permissions`;

  it('should build basic command without session ID', () => {
    const command = buildClaudeCommand('/test/dir', 'hello world');
    expect(command).toBe(`cd /test/dir && claude --output-format stream-json --model 'opus' -p 'hello world' --verbose ${mcpFlags}`);
  });

  it('should build command with session ID', () => {
    const command = buildClaudeCommand('/test/dir', 'hello world', 'session-123');
    expect(command).toBe(`cd /test/dir && claude --resume session-123 --output-format stream-json --model 'opus' -p 'hello world' --verbose ${mcpFlags}`);
  });

  it('should properly escape prompt with special characters', () => {
    const command = buildClaudeCommand('/test/dir', "don't use this");
    expect(command).toBe(`cd /test/dir && claude --output-format stream-json --model 'opus' -p 'don'\\''t use this' --verbose ${mcpFlags}`);
  });

  it('should handle complex prompts', () => {
    const prompt = "Fix the bug in 'config.js' and don't break anything";
    const command = buildClaudeCommand('/project/path', prompt, 'abc-123');
    expect(command).toBe(`cd /project/path && claude --resume abc-123 --output-format stream-json --model 'opus' -p 'Fix the bug in '\\''config.js'\\'' and don'\\''t break anything' --verbose ${mcpFlags}`);
  });

  it('should include Discord context as HTTP headers in the MCP config', () => {
    const command = buildClaudeCommand('/test/dir', 'hello', undefined, {
      channelId: 'chan-1',
      channelName: 'general',
      userId: 'user-9',
      messageId: 'msg-5',
    });
    const expectedConfig = '{"mcpServers":{"discord-permissions":{"type":"http","url":"http://localhost:3001/mcp","headers":{"X-Discord-Channel-Id":"chan-1","X-Discord-Channel-Name":"general","X-Discord-User-Id":"user-9","X-Discord-Message-Id":"msg-5"}}}}';
    expect(command).toContain(`--mcp-config '${expectedConfig}'`);
  });

  it('should omit the message ID header when messageId is missing', () => {
    const command = buildClaudeCommand('/test/dir', 'hello', undefined, {
      channelId: 'chan-1',
      channelName: 'general',
      userId: 'user-9',
    });
    expect(command).toContain('"X-Discord-User-Id":"user-9"}');
    expect(command).not.toContain('X-Discord-Message-Id');
  });

  it('should use a custom model when provided', () => {
    const command = buildClaudeCommand('/test/dir', 'hello world', undefined, undefined, 'opus');
    expect(command).toBe(`cd /test/dir && claude --output-format stream-json --model 'opus' -p 'hello world' --verbose ${mcpFlags}`);
  });

  it('should shell-escape a model name with special characters', () => {
    const command = buildClaudeCommand('/test/dir', 'hi', undefined, undefined, "model; rm -rf /");
    expect(command).toContain(`--model 'model; rm -rf /'`);
  });

  it('should respect MCP_SERVER_PORT for the MCP server URL', () => {
    process.env.MCP_SERVER_PORT = '4500';
    try {
      const command = buildClaudeCommand('/test/dir', 'hello');
      expect(command).toContain('http://localhost:4500/mcp');
    } finally {
      delete process.env.MCP_SERVER_PORT;
    }
  });

  describe('CLAUDE_PERMISSION_MODE override', () => {
    afterEach(() => {
      delete process.env.CLAUDE_PERMISSION_MODE;
    });

    it('should use --dangerously-skip-permissions and drop the MCP flags for "dangerous"', () => {
      process.env.CLAUDE_PERMISSION_MODE = 'dangerous';
      const command = buildClaudeCommand('/test/dir', 'hello world');
      expect(command).toBe(
        "cd /test/dir && claude --output-format stream-json --model 'opus' -p 'hello world' --verbose --dangerously-skip-permissions"
      );
    });

    it('should use --permission-mode auto for "auto"', () => {
      process.env.CLAUDE_PERMISSION_MODE = 'auto';
      const command = buildClaudeCommand('/test/dir', 'hello world');
      expect(command).toBe(
        "cd /test/dir && claude --output-format stream-json --model 'opus' -p 'hello world' --verbose --permission-mode auto"
      );
    });

    it('should use --permission-mode bypassPermissions for "bypass"', () => {
      process.env.CLAUDE_PERMISSION_MODE = 'bypass';
      const command = buildClaudeCommand('/test/dir', 'hello world');
      expect(command).toBe(
        "cd /test/dir && claude --output-format stream-json --model 'opus' -p 'hello world' --verbose --permission-mode bypassPermissions"
      );
    });

    it('should preserve --resume placement with an override mode set', () => {
      process.env.CLAUDE_PERMISSION_MODE = 'bypass';
      const command = buildClaudeCommand('/test/dir', 'hello world', 'session-123');
      expect(command).toBe(
        "cd /test/dir && claude --resume session-123 --output-format stream-json --model 'opus' -p 'hello world' --verbose --permission-mode bypassPermissions"
      );
    });

    it('should ignore unrecognized values and fall back to the Discord approval flow', () => {
      process.env.CLAUDE_PERMISSION_MODE = 'nonsense';
      const command = buildClaudeCommand('/test/dir', 'hello world');
      expect(command).toBe(`cd /test/dir && claude --output-format stream-json --model 'opus' -p 'hello world' --verbose ${mcpFlags}`);
    });
  });
});