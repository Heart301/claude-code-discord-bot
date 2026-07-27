import {
  SlashCommandBuilder,
  REST,
  Routes,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { ClaudeManager } from '../claude/manager.js';

const MODEL_SELECT_CUSTOM_ID = "model-select";
const MODEL_CUSTOM_OPTION_VALUE = "__custom__";
const MODEL_MODAL_CUSTOM_ID = "model-custom-modal";
const MODEL_MODAL_INPUT_ID = "model-name-input";

// Used only when the Anthropic Models API is unreachable (no API key
// resolvable for the channel, or the request fails).
const FALLBACK_MODEL_CHOICES = [
  { label: "Sonnet", value: "sonnet", description: "平衡速度與品質" },
  { label: "Opus", value: "opus", description: "最高品質，速度較慢（預設）" },
  { label: "Haiku", value: "haiku", description: "最快速，適合簡單任務" },
];

const MODEL_CUSTOM_OPTION = {
  label: "自訂輸入...",
  value: MODEL_CUSTOM_OPTION_VALUE,
  description: "輸入完整的 model 名稱或 ID",
};

// Discord select menus cap at 25 options total; reserve one for "custom".
const MAX_FETCHED_MODEL_OPTIONS = 24;

export class CommandHandler {
  constructor(
    private claudeManager: ClaudeManager,
    private allowedUserId: string | undefined
  ) {}

  getCommands() {
    return [
      new SlashCommandBuilder()
        .setName("clear")
        .setDescription("Clear the current Claude Code session"),
      new SlashCommandBuilder()
        .setName("model")
        .setDescription("Set the Claude model used in this channel"),
    ];
  }

  async registerCommands(token: string, clientId: string): Promise<void> {
    const rest = new REST().setToken(token);

    try {
      await rest.put(Routes.applicationCommands(clientId), {
        body: this.getCommands(),
      });
      console.log("Successfully registered application commands.");
    } catch (error) {
      console.error(error);
    }
  }

  async handleInteraction(interaction: any): Promise<void> {
    const isRelevant =
      interaction.isChatInputCommand() ||
      interaction.isStringSelectMenu() ||
      interaction.isModalSubmit();
    if (!isRelevant) return;

    if (this.allowedUserId && interaction.user.id !== this.allowedUserId) {
      await interaction.reply({
        content: "You are not authorized to use this bot.",
        ephemeral: true,
      });
      return;
    }

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "clear") {
        const channelId = interaction.channelId;
        this.claudeManager.clearSession(channelId);

        await interaction.reply(
          "Session cleared! Next message will start a new Claude Code session."
        );
      }

      if (interaction.commandName === "model") {
        const channelName =
          interaction.channel && "name" in interaction.channel
            ? interaction.channel.name
            : "default";

        const availableModels = await this.claudeManager.getAvailableModels(channelName);
        const modelOptions =
          availableModels.length > 0
            ? availableModels
                .slice(0, MAX_FETCHED_MODEL_OPTIONS)
                .map((m) => ({ label: m.displayName, value: m.id }))
            : FALLBACK_MODEL_CHOICES;

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(MODEL_SELECT_CUSTOM_ID)
            .setPlaceholder("選擇這個頻道要使用的 model")
            .addOptions([...modelOptions, MODEL_CUSTOM_OPTION])
        );

        await interaction.reply({
          content: "請選擇這個頻道要使用的 model：",
          components: [row],
          ephemeral: true,
        });
      }
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === MODEL_SELECT_CUSTOM_ID) {
      const selected = interaction.values[0];

      if (selected === MODEL_CUSTOM_OPTION_VALUE) {
        const modal = new ModalBuilder()
          .setCustomId(MODEL_MODAL_CUSTOM_ID)
          .setTitle("輸入自訂 model 名稱")
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId(MODEL_MODAL_INPUT_ID)
                .setLabel("Model 名稱")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
            )
          );

        await interaction.showModal(modal);
        return;
      }

      const channelId = interaction.channelId;
      this.claudeManager.setModel(channelId, selected);

      await interaction.update({
        content: `這個頻道之後將使用 \`${selected}\` 模型。`,
        components: [],
      });
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === MODEL_MODAL_CUSTOM_ID) {
      const channelId = interaction.channelId;
      const model = interaction.fields.getTextInputValue(MODEL_MODAL_INPUT_ID).trim();

      if (!model) {
        await interaction.reply({
          content: "請輸入有效的 model 名稱。",
          ephemeral: true,
        });
        return;
      }

      this.claudeManager.setModel(channelId, model);

      await interaction.reply({
        content: `這個頻道之後將使用 \`${model}\` 模型。`,
        ephemeral: true,
      });
    }
  }
}
