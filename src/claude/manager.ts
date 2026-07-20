import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { EmbedBuilder } from "discord.js";
import type { SDKMessage } from "../types/index.js";
import { buildClaudeCommand, type DiscordContext } from "../utils/shell.js";
import { DatabaseManager } from "../db/database.js";
import { getAvailableModels, type AnthropicModel } from "../utils/models.js";

const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes with no stdout output
const ABSOLUTE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes total runtime, regardless of output

export class ClaudeManager {
  private db: DatabaseManager;
  private channelMessages = new Map<string, any>();
  private channelLastAssistantMessage = new Map<
    string,
    { message: any; text: string }
  >();
  // Serializes handleAssistantMessage/handleResultMessage/handleInitMessage
  // per channel so they run in stream order even though the stdout handler
  // dispatches them without awaiting between lines.
  private channelMessageChain = new Map<string, Promise<void>>();
  private channelNames = new Map<string, string>();
  private channelProcesses = new Map<
    string,
    {
      process: any;
      sessionId?: string;
      discordMessage: any;
    }
  >();

  constructor(
    private baseFolder: string,
    private channelApiKeys: Map<string, string> = new Map(),
    private channelGithubTokens: Map<string, string> = new Map()
  ) {
    this.db = new DatabaseManager();
    // Clean up old sessions on startup
    this.db.cleanupOldSessions();
  }

  hasActiveProcess(channelId: string): boolean {
    return this.channelProcesses.has(channelId);
  }

  killActiveProcess(channelId: string): void {
    const activeProcess = this.channelProcesses.get(channelId);
    if (activeProcess?.process) {
      console.log(`Killing active process for channel ${channelId}`);
      activeProcess.process.kill("SIGTERM");
    }
  }

  clearSession(channelId: string): void {
    this.killActiveProcess(channelId);
    this.db.clearSession(channelId);
    this.channelMessages.delete(channelId);
    this.channelLastAssistantMessage.delete(channelId);
    this.channelMessageChain.delete(channelId);
    this.channelNames.delete(channelId);
    this.channelProcesses.delete(channelId);
  }

  // Chains fn onto the previous queued message handler for this channel, so
  // stream messages are handled in order without blocking stdout parsing.
  private enqueueChannelMessage(channelId: string, fn: () => Promise<void>): Promise<void> {
    const previous = this.channelMessageChain.get(channelId) || Promise.resolve();
    const next = previous.then(fn).catch(console.error);
    this.channelMessageChain.set(channelId, next);
    return next;
  }

  setDiscordMessage(channelId: string, message: any): void {
    this.channelMessages.set(channelId, message);
  }

  reserveChannel(
    channelId: string,
    sessionId: string | undefined,
    discordMessage: any
  ): void {
    // Kill any existing process (safety measure)
    const existingProcess = this.channelProcesses.get(channelId);
    if (existingProcess?.process) {
      console.log(
        `Killing existing process for channel ${channelId} before starting new one`
      );
      existingProcess.process.kill("SIGTERM");
    }

    // Reserve the channel by adding a placeholder entry (prevents race conditions)
    this.channelProcesses.set(channelId, {
      process: null, // Will be set when process actually starts
      sessionId,
      discordMessage,
    });
  }

  getSessionId(channelId: string): string | undefined {
    return this.db.getSession(channelId);
  }

  getModel(channelId: string): string | undefined {
    return this.db.getModel(channelId);
  }

  setModel(channelId: string, model: string): void {
    this.db.setModel(channelId, model);
  }

  // Per-channel key override (<GROUP>_ANTHROPIC_API_KEY) takes priority over
  // the process-wide key, matching the key used to actually run Claude Code.
  private resolveApiKey(channelName: string): string | undefined {
    return this.channelApiKeys.get(channelName) || process.env.ANTHROPIC_API_KEY;
  }

  async getAvailableModels(channelName: string): Promise<AnthropicModel[]> {
    const apiKey = this.resolveApiKey(channelName);
    if (!apiKey) return [];

    try {
      return await getAvailableModels(apiKey);
    } catch (error) {
      console.error("Error fetching available models:", error);
      return [];
    }
  }

  async runClaudeCode(
    channelId: string,
    channelName: string,
    prompt: string,
    sessionId?: string,
    discordContext?: DiscordContext
  ): Promise<void> {
    // Store the channel name for path replacement
    this.channelNames.set(channelId, channelName);
    const workingDir = path.join(this.baseFolder, channelName);
    console.log(`Running Claude Code in: ${workingDir}`);

    // Check if working directory exists
    if (!fs.existsSync(workingDir)) {
      throw new Error(`Working directory does not exist: ${workingDir}`);
    }

    const model = this.db.getModel(channelId);
    const commandString = buildClaudeCommand(workingDir, prompt, sessionId, discordContext, model);
    console.log(`Running command: ${commandString}`);

    const spawnEnv: Record<string, string | undefined> = {
      ...process.env,
      SHELL: "/bin/bash",
    };

    // Strip raw per-group secrets (e.g. GROUP1_ANTHROPIC_API_KEY,
    // GROUP1_GITHUB_TOKEN) so a spawned session can't read other channels'
    // group tokens via printenv — only the resolved value for this channel
    // should reach the subprocess.
    for (const key of Object.keys(spawnEnv)) {
      if (key.endsWith('_ANTHROPIC_API_KEY') || key.endsWith('_GITHUB_TOKEN')) {
        delete spawnEnv[key];
      }
    }

    const apiKeyOverride = this.channelApiKeys.get(channelName);
    if (apiKeyOverride) {
      spawnEnv.ANTHROPIC_API_KEY = apiKeyOverride;
    }

    const githubTokenOverride = this.channelGithubTokens.get(channelName);
    if (githubTokenOverride) {
      spawnEnv.GITHUB_TOKEN = githubTokenOverride;
    }

    const claude = spawn("/bin/bash", ["-c", commandString], {
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv,
    });

    console.log(`Claude process spawned with PID: ${claude.pid}`);

    // Update the channel process tracking with actual process
    const channelProcess = this.channelProcesses.get(channelId);
    if (channelProcess) {
      channelProcess.process = claude;
    }

    // Close stdin to signal we're not sending input
    claude.stdin.end();

    // Add immediate listeners to debug
    claude.on("spawn", () => {
      console.log("Process successfully spawned");
    });

    claude.on("error", (error) => {
      console.error("Process spawn error:", error);
    });

    let buffer = "";

    let idleTimer: ReturnType<typeof setTimeout>;
    let absoluteTimer: ReturnType<typeof setTimeout>;

    const triggerTimeout = (kind: "idle" | "absolute") => {
      console.log(`Claude process timed out (${kind}), killing it`);
      clearTimeout(idleTimer);
      clearTimeout(absoluteTimer);
      claude.kill("SIGTERM");

      const channel = this.channelMessages.get(channelId)?.channel;
      if (channel) {
        const timeoutEmbed = new EmbedBuilder()
          .setTitle("⏰ 逾時")
          .setDescription(
            kind === "idle"
              ? "Claude Code 已 15 分鐘沒有任何回應"
              : "Claude Code 執行時間已超過 60 分鐘上限"
          )
          .setColor(0xFFD700); // Yellow for timeout

        channel.send({ embeds: [timeoutEmbed] }).catch(console.error);
      }
    };

    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => triggerTimeout("idle"), IDLE_TIMEOUT_MS);
    };

    resetIdleTimer();
    absoluteTimer = setTimeout(() => triggerTimeout("absolute"), ABSOLUTE_TIMEOUT_MS);

    claude.stdout.on("data", (data) => {
      resetIdleTimer();
      const rawData = data.toString();
      console.log("Raw stdout data:", rawData);
      
      // Log all streamed output to log.txt
      try {
        fs.appendFileSync(path.join(process.cwd(), 'log.txt'), 
          `[${new Date().toISOString()}] Channel: ${channelId}\n${rawData}\n---\n`);
      } catch (error) {
        console.error("Error writing to log.txt:", error);
      }
      
      buffer += rawData;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          console.log("Processing line:", line);
          try {
            const parsed: SDKMessage = JSON.parse(line);
            console.log("Parsed message type:", parsed.type);

            if (parsed.type === "assistant" && parsed.message.content) {
              this.enqueueChannelMessage(channelId, () =>
                this.handleAssistantMessage(channelId, parsed)
              );
            } else if (parsed.type === "result") {
              this.enqueueChannelMessage(channelId, () =>
                this.handleResultMessage(channelId, parsed)
              ).then(() => {
                clearTimeout(idleTimer);
                clearTimeout(absoluteTimer);
                claude.kill("SIGTERM");
                this.channelProcesses.delete(channelId);
              });
            } else if (parsed.type === "system") {
              console.log("System message:", parsed.subtype);
              if (parsed.subtype === "init") {
                this.enqueueChannelMessage(channelId, () =>
                  this.handleInitMessage(channelId, parsed)
                );
              }
              const channelName = this.channelNames.get(channelId) || "default";
              this.db.setSession(channelId, parsed.session_id, channelName);
            }
          } catch (error) {
            console.error("Error parsing JSON:", error, "Line:", line);
          }
        }
      }
    });

    claude.on("close", (code) => {
      console.log(`Claude process exited with code ${code}`);
      clearTimeout(idleTimer);
      clearTimeout(absoluteTimer);
      // Ensure cleanup on process close
      this.channelProcesses.delete(channelId);

      if (code !== 0 && code !== null) {
        // Process failed - send error embed to Discord
        const channel = this.channelMessages.get(channelId)?.channel;
        if (channel) {
          const errorEmbed = new EmbedBuilder()
            .setTitle("❌ Claude Code 執行失敗")
            .setDescription(`程序結束，代碼：${code}`)
            .setColor(0xFF0000); // Red for error
          
          channel.send({ embeds: [errorEmbed] }).catch(console.error);
        }
      }
    });

    claude.stderr.on("data", (data) => {
      const stderrOutput = data.toString();
      console.error("Claude stderr:", stderrOutput);

      // If there's significant stderr output, send warning to Discord
      if (
        stderrOutput.trim() &&
        !stderrOutput.includes("INFO") &&
        !stderrOutput.includes("DEBUG")
      ) {
        const channel = this.channelMessages.get(channelId)?.channel;
        if (channel) {
          const warningEmbed = new EmbedBuilder()
            .setTitle("⚠️ 警告")
            .setDescription(stderrOutput.trim())
            .setColor(0xFFA500); // Orange for warnings
          
          channel.send({ embeds: [warningEmbed] }).catch(console.error);
        }
      }
    });

    claude.on("error", (error) => {
      console.error("Claude process error:", error);
      clearTimeout(idleTimer);
      clearTimeout(absoluteTimer);

      // Clean up process tracking on error
      this.channelProcesses.delete(channelId);

      // Send error to Discord
      const channel = this.channelMessages.get(channelId)?.channel;
      if (channel) {
        const processErrorEmbed = new EmbedBuilder()
          .setTitle("❌ 程序錯誤")
          .setDescription(error.message)
          .setColor(0xFF0000); // Red for errors
        
        channel.send({ embeds: [processErrorEmbed] }).catch(console.error);
      }
    });
  }

  private async handleInitMessage(channelId: string, parsed: any): Promise<void> {
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;
    
    const initEmbed = new EmbedBuilder()
      .setTitle("🚀 Claude Code 工作階段已啟動")
      .setDescription(`**工作目錄：** ${parsed.cwd}\n**模型：** ${parsed.model}\n**可用工具：** ${parsed.tools.length} 個`)
      .setColor(0x00FF00); // Green for init
    
    try {
      await channel.send({ embeds: [initEmbed] });
    } catch (error) {
      console.error("Error sending init message:", error);
    }
  }

  private async handleAssistantMessage(
    channelId: string,
    parsed: SDKMessage & { type: "assistant" }
  ): Promise<void> {
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    const content = Array.isArray(parsed.message.content)
      ? parsed.message.content.find((c: any) => c.type === "text")?.text || ""
      : parsed.message.content;

    try {
      // If there's text content, send an assistant message
      if (content && content.trim()) {
        const assistantEmbed = new EmbedBuilder()
          .setTitle("💬 Claude")
          .setDescription(content)
          .setColor(0x7289DA); // Discord blurple

        const sentMessage = await channel.send({ embeds: [assistantEmbed] });
        this.channelLastAssistantMessage.set(channelId, {
          message: sentMessage,
          text: content.trim(),
        });
      }

      const channelName = this.channelNames.get(channelId) || "default";
      this.db.setSession(channelId, parsed.session_id, channelName);
    } catch (error) {
      console.error("Error sending assistant message:", error);
    }
  }

  private async handleResultMessage(
    channelId: string,
    parsed: SDKMessage & { type: "result" }
  ): Promise<void> {
    console.log("Result message:", parsed);
    const channelName = this.channelNames.get(channelId) || "default";
    this.db.setSession(channelId, parsed.session_id, channelName);

    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    // The final assistant text message duplicates the result text below;
    // remove it so only the "Session Complete" message remains.
    const lastAssistant = this.channelLastAssistantMessage.get(channelId);
    if (
      lastAssistant &&
      parsed.subtype === "success" &&
      "result" in parsed &&
      lastAssistant.text === parsed.result.trim()
    ) {
      try {
        await lastAssistant.message.delete();
      } catch (error) {
        console.error("Error deleting duplicate assistant message:", error);
      }
    }
    this.channelLastAssistantMessage.delete(channelId);

    // Create a final result embed
    const resultEmbed = new EmbedBuilder();

    if (parsed.subtype === "success") {
      let description = "result" in parsed ? parsed.result : "任務已完成";
      description += `\n\n*共 ${parsed.num_turns} 個回合完成*`;

      resultEmbed
        .setTitle("✅ 工作階段完成")
        .setDescription(description)
        .setColor(0x00FF00); // Green for success
    } else {
      resultEmbed
        .setTitle("❌ 工作階段失敗")
        .setDescription(`任務失敗：${parsed.subtype}`)
        .setColor(0xFF0000); // Red for failure
    }

    try {
      await channel.send({ embeds: [resultEmbed] });
    } catch (error) {
      console.error("Error sending result message:", error);
    }

    console.log("Got result message, cleaning up process tracking");
  }



  // Clean up resources
  destroy(): void {
    // Close all active processes
    for (const [channelId] of this.channelProcesses) {
      this.killActiveProcess(channelId);
    }
    
    // Close database connection
    this.db.close();
  }
}
