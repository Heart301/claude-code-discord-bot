import type { Config } from '../types/index.js';

export function parseChannelApiKeys(
  env: Record<string, string | undefined>
): Map<string, string> {
  const groupNames = new Set<string>();

  for (const key of Object.keys(env)) {
    const match = key.match(/^ANTHROPIC_API_KEY_(.+)_CHANNELS$/);
    if (match) {
      groupNames.add(match[1]);
    }
  }

  const sortedGroupNames = Array.from(groupNames).sort();
  const channelApiKeys = new Map<string, string>();

  for (const groupName of sortedGroupNames) {
    const apiKey = env[`ANTHROPIC_API_KEY_${groupName}`];

    if (!apiKey) {
      console.error(
        `ANTHROPIC_API_KEY_${groupName}_CHANNELS is set but ANTHROPIC_API_KEY_${groupName} is missing`
      );
      process.exit(1);
    }

    const channelsValue = env[`ANTHROPIC_API_KEY_${groupName}_CHANNELS`] ?? '';
    const channelNames = channelsValue
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);

    for (const channelName of channelNames) {
      if (channelApiKeys.has(channelName)) {
        console.warn(
          `Channel "${channelName}" already has an API key group assigned; ignoring duplicate assignment from group "${groupName}"`
        );
        continue;
      }
      channelApiKeys.set(channelName, apiKey);
    }
  }

  return channelApiKeys;
}

export function validateConfig(): Config {
  const discordToken = process.env.DISCORD_TOKEN;
  const allowedUserId = process.env.ALLOWED_USER_ID;
  const baseFolder = process.env.BASE_FOLDER;

  if (!discordToken) {
    console.error("DISCORD_TOKEN environment variable is required");
    process.exit(1);
  }

  if (!allowedUserId) {
    console.warn(
      "ALLOWED_USER_ID is not set - everyone in the channel can trigger the bot"
    );
  }

  if (!baseFolder) {
    console.error("BASE_FOLDER environment variable is required");
    process.exit(1);
  }

  const channelApiKeys = parseChannelApiKeys(process.env);

  return {
    discordToken,
    allowedUserId,
    baseFolder,
    channelApiKeys,
  };
}
