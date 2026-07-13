import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
} from "discord.js";
import type { ClaudeManager } from '../claude/manager.js';
import { CommandHandler } from './commands.js';
import type { MCPPermissionServer } from '../mcp/server.js';
import { AttachmentStore, formatAttachmentsForPrompt } from '../utils/attachments.js';

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

  /**
   * Set the MCP server for handling approval reactions
   */
  setMCPServer(mcpServer: MCPPermissionServer): void {
    this.mcpServer = mcpServer;
  }

  private setupEventHandlers(): void {
    this.client.once("ready", async () => {
      console.log(`Bot is ready! Logged in as ${this.client.user?.tag}`);
      await this.commandHandler.registerCommands(
        process.env.DISCORD_TOKEN!,
        this.client.user!.id
      );
    });

    this.client.on("interactionCreate", async (interaction) => {
      await this.commandHandler.handleInteraction(interaction);
    });

    this.client.on("messageCreate", async (message) => {
      await this.handleMessage(message);
    });

    // Handle reactions for MCP approval
    this.client.on("messageReactionAdd", async (reaction, user) => {
      await this.handleReactionAdd(reaction, user);
    });
  }

  /**
   * Handle reaction add events for MCP approval
   */
  private async handleReactionAdd(reaction: any, user: any): Promise<void> {
    // Ignore bot reactions
    if (user.bot) return;

    // Only process reactions from the authorized user (everyone if unset)
    if (this.allowedUserId && user.id !== this.allowedUserId) return;

    // Only process ✅ and ❌ reactions
    if (reaction.emoji.name !== '✅' && reaction.emoji.name !== '❌') return;

    console.log(`Discord: Reaction ${reaction.emoji.name} by ${user.id} on message ${reaction.message.id}`);

    // Pass to MCP server if available
    if (this.mcpServer) {
      const approved = reaction.emoji.name === '✅';
      this.mcpServer.getPermissionManager().handleApprovalReaction(
        reaction.message.channelId,
        reaction.message.id,
        user.id,
        approved
      );
    }
  }

  private async handleMessage(message: any): Promise<void> {
    if (message.author.bot) return;

    console.log("MESSAGE CREATED", message.id);

    if (this.allowedUserId && message.author.id !== this.allowedUserId) {
      return;
    }

    const channelId = message.channelId;

    // Atomic check-and-lock: if channel is already processing, skip
    if (this.claudeManager.hasActiveProcess(channelId)) {
      console.log(
        `Channel ${channelId} is already processing, skipping new message`
      );
      return;
    }

    const channelName =
      message.channel && "name" in message.channel
        ? message.channel.name
        : "default";
    
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

      try {
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
      } catch (error) {
        console.error("Error downloading attachments:", error);

        const errorMessage = error instanceof Error ? error.message : String(error);
        try {
          await message.channel.send(`Error downloading attachments: ${errorMessage}`);
        } catch (sendError) {
          console.error("Failed to send attachment error message:", sendError);
        }
      }
    }

    const sessionId = this.claudeManager.getSessionId(channelId);

    console.log(`Received message in channel: ${channelName} (${channelId})`);
    console.log(`Message content: ${message.content}`);
    console.log(`Existing session ID: ${sessionId || "none"}`);

    try {
      // Check if we have an existing session
      const isNewSession = !sessionId;
      
      // Create status embed
      const statusEmbed = new EmbedBuilder()
        .setColor(0xFFD700); // Yellow for startup
      
      if (isNewSession) {
        statusEmbed
          .setTitle("🆕 Starting New Session")
          .setDescription("Initializing Claude Code...");
      } else {
        statusEmbed
          .setTitle("🔄 Continuing Session")
          .setDescription(`**Session ID:** ${sessionId}\nResuming Claude Code...`);
      }
      
      // Create initial Discord message
      const reply = await message.channel.send({ embeds: [statusEmbed] });
      console.log("Created Discord message:", reply.id);
      this.claudeManager.setDiscordMessage(channelId, reply);

      // Create Discord context for MCP server
      const discordContext = {
        channelId: channelId,
        channelName: channelName,
        userId: message.author.id,
        messageId: message.id,
      };

      // Reserve the channel and run Claude Code
      this.claudeManager.reserveChannel(channelId, sessionId, reply);
      await this.claudeManager.runClaudeCode(channelId, channelName, prompt, sessionId, discordContext);
    } catch (error) {
      console.error("Error running Claude Code:", error);
      
      // Clean up on error
      this.claudeManager.clearSession(channelId);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      try {
        await message.channel.send(`Error: ${errorMessage}`);
      } catch (sendError) {
        console.error("Failed to send error message:", sendError);
      }
    }
  }

  async login(token: string): Promise<void> {
    await this.client.login(token);
  }
}