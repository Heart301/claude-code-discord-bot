export function escapeShellString(str: string): string {
  // Replace ' with '\'' and wrap in single quotes
  return `'${str.replace(/'/g, "'\\''")}'`;
}

export interface DiscordContext {
  channelId: string;
  channelName: string;
  userId: string;
  messageId?: string;
}

type PermissionOverrideMode = "dangerous" | "auto" | "bypass";

// CLAUDE_PERMISSION_MODE lets an operator skip the per-tool-call Discord
// approval flow entirely. Unset (the default) keeps every tool call routed
// through the discord-permissions MCP server for manual approval.
function getPermissionOverrideMode(): PermissionOverrideMode | undefined {
  const value = process.env.CLAUDE_PERMISSION_MODE?.toLowerCase();
  if (value === "dangerous" || value === "auto" || value === "bypass") {
    return value;
  }
  return undefined;
}

export function buildClaudeCommand(
  workingDir: string,
  prompt: string,
  sessionId?: string,
  discordContext?: DiscordContext,
  model: string = "opus"
): string {
  const escapedPrompt = escapeShellString(prompt);
  const overrideMode = getPermissionOverrideMode();

  const commandParts = [
    `cd ${workingDir}`,
    "&&",
    "claude",
    "--output-format",
    "stream-json",
    "--model",
    escapeShellString(model),
    "-p",
    escapedPrompt,
    "--verbose",
  ];

  if (overrideMode === "dangerous") {
    commandParts.push("--dangerously-skip-permissions");
  } else if (overrideMode === "auto") {
    commandParts.push("--permission-mode", "auto");
  } else if (overrideMode === "bypass") {
    commandParts.push("--permission-mode", "bypassPermissions");
  } else {
    // Claude Code 2.x accepts the MCP config inline as a JSON string; the
    // permission server is reached over HTTP directly (no stdio bridge).
    const mcpConfigJson = JSON.stringify(buildMcpConfig(discordContext));
    commandParts.push(
      "--mcp-config",
      escapeShellString(mcpConfigJson),
      "--strict-mcp-config",
      "--permission-prompt-tool",
      "mcp__discord-permissions__approve_tool",
      "--allowedTools",
      "mcp__discord-permissions"
    );
  }

  if (sessionId) {
    commandParts.splice(3, 0, "--resume", sessionId);
  }

  return commandParts.join(" ");
}

/**
 * MCP config pointing Claude Code at the bot's HTTP permission server.
 * Discord context travels as HTTP headers, which the server reads to route
 * approval prompts back to the right channel.
 */
function buildMcpConfig(discordContext?: DiscordContext): object {
  const port = process.env.MCP_SERVER_PORT || "3001";

  const server: Record<string, unknown> = {
    type: "http",
    url: `http://localhost:${port}/mcp`,
  };

  if (discordContext) {
    const headers: Record<string, string> = {
      "X-Discord-Channel-Id": discordContext.channelId,
      "X-Discord-Channel-Name": discordContext.channelName,
      "X-Discord-User-Id": discordContext.userId,
    };
    if (discordContext.messageId) {
      headers["X-Discord-Message-Id"] = discordContext.messageId;
    }
    server.headers = headers;
  }

  return {
    mcpServers: {
      "discord-permissions": server,
    },
  };
}
