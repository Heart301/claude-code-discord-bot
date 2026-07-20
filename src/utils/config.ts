import type { Config } from '../types/index.js';

export function parseChannelGroups(
  env: Record<string, string | undefined>
): { channelApiKeys: Map<string, string>; channelGithubTokens: Map<string, string> } {
  const groupNames = new Set<string>();

  for (const key of Object.keys(env)) {
    const match = key.match(/^(.+)_CHANNELS$/);
    if (match) {
      groupNames.add(match[1]);
    }
  }

  const sortedGroupNames = Array.from(groupNames).sort();
  const channelApiKeys = new Map<string, string>();
  const channelGithubTokens = new Map<string, string>();
  const assignedChannels = new Set<string>();

  for (const groupName of sortedGroupNames) {
    const apiKey = env[`${groupName}_ANTHROPIC_API_KEY`];
    const githubToken = env[`${groupName}_GITHUB_TOKEN`];

    if (!apiKey && !githubToken) {
      console.error(
        `${groupName}_CHANNELS is set but neither ${groupName}_ANTHROPIC_API_KEY nor ${groupName}_GITHUB_TOKEN is set`
      );
      process.exit(1);
    }

    const channelsValue = env[`${groupName}_CHANNELS`] ?? '';
    const channelNames = channelsValue
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);

    for (const channelName of channelNames) {
      if (assignedChannels.has(channelName)) {
        console.warn(
          `Channel "${channelName}" already has a group assigned; ignoring duplicate assignment from group "${groupName}"`
        );
        continue;
      }
      assignedChannels.add(channelName);

      if (apiKey) {
        channelApiKeys.set(channelName, apiKey);
      }
      if (githubToken) {
        channelGithubTokens.set(channelName, githubToken);
      }
    }
  }

  return { channelApiKeys, channelGithubTokens };
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

  const { channelApiKeys, channelGithubTokens } = parseChannelGroups(process.env);

  return {
    discordToken,
    allowedUserId,
    baseFolder,
    channelApiKeys,
    channelGithubTokens,
  };
}
