import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { validateConfig, parseChannelGroups } from '../../src/utils/config.js';

describe('validateConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    // Strip any real group-routing values loaded from the developer's local
    // .env so tests stay hermetic and never leak real secrets into assertion
    // output.
    for (const key of Object.keys(process.env)) {
      if (
        key.endsWith('_CHANNELS') ||
        key.endsWith('_ANTHROPIC_API_KEY') ||
        key.endsWith('_GITHUB_TOKEN')
      ) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return valid config when all environment variables are set', () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.ALLOWED_USER_ID = 'test-user-id';
    process.env.BASE_FOLDER = '/test/folder';

    const config = validateConfig();

    expect(config).toEqual({
      discordToken: 'test-token',
      allowedUserId: 'test-user-id',
      baseFolder: '/test/folder',
      channelApiKeys: new Map(),
      channelGithubTokens: new Map(),
    });
  });

  it('should exit with error when DISCORD_TOKEN is missing', () => {
    delete process.env.DISCORD_TOKEN;
    process.env.ALLOWED_USER_ID = 'test-user-id';
    process.env.BASE_FOLDER = '/test/folder';

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => validateConfig()).toThrow('process.exit called');
    expect(consoleSpy).toHaveBeenCalledWith('DISCORD_TOKEN environment variable is required');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('should return config with undefined allowedUserId and warn when ALLOWED_USER_ID is missing', () => {
    process.env.DISCORD_TOKEN = 'test-token';
    delete process.env.ALLOWED_USER_ID;
    process.env.BASE_FOLDER = '/test/folder';

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const config = validateConfig();

    expect(config).toEqual({
      discordToken: 'test-token',
      allowedUserId: undefined,
      baseFolder: '/test/folder',
      channelApiKeys: new Map(),
      channelGithubTokens: new Map(),
    });
    expect(warnSpy).toHaveBeenCalledWith(
      'ALLOWED_USER_ID is not set - everyone in the channel can trigger the bot'
    );

    warnSpy.mockRestore();
  });

  it('should exit with error when BASE_FOLDER is missing', () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.ALLOWED_USER_ID = 'test-user-id';
    delete process.env.BASE_FOLDER;

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => validateConfig()).toThrow('process.exit called');
    expect(consoleSpy).toHaveBeenCalledWith('BASE_FOLDER environment variable is required');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});

describe('parseChannelGroups', () => {
  it('should map a group with both tokens set into both maps', () => {
    const env = {
      GROUP1_CHANNELS: 'a, b,c',
      GROUP1_ANTHROPIC_API_KEY: 'sk-group1',
      GROUP1_GITHUB_TOKEN: 'gh-group1',
    };

    const result = parseChannelGroups(env);

    expect(result.channelApiKeys).toEqual(
      new Map([
        ['a', 'sk-group1'],
        ['b', 'sk-group1'],
        ['c', 'sk-group1'],
      ])
    );
    expect(result.channelGithubTokens).toEqual(
      new Map([
        ['a', 'gh-group1'],
        ['b', 'gh-group1'],
        ['c', 'gh-group1'],
      ])
    );
  });

  it('should only populate channelGithubTokens when the group has no ANTHROPIC_API_KEY', () => {
    const env = {
      GROUP2_CHANNELS: 'd,e',
      GROUP2_GITHUB_TOKEN: 'gh-group2',
    };

    const result = parseChannelGroups(env);

    expect(result.channelGithubTokens).toEqual(
      new Map([
        ['d', 'gh-group2'],
        ['e', 'gh-group2'],
      ])
    );
    expect(result.channelApiKeys).toEqual(new Map());
  });

  it('should only populate channelApiKeys when the group has no GITHUB_TOKEN', () => {
    const env = {
      GROUP3_CHANNELS: 'f',
      GROUP3_ANTHROPIC_API_KEY: 'sk-group3',
    };

    const result = parseChannelGroups(env);

    expect(result.channelApiKeys).toEqual(new Map([['f', 'sk-group3']]));
    expect(result.channelGithubTokens).toEqual(new Map());
  });

  it('should return empty maps when no groups are configured', () => {
    const result = parseChannelGroups({ DISCORD_TOKEN: 'x' });
    expect(result.channelApiKeys).toEqual(new Map());
    expect(result.channelGithubTokens).toEqual(new Map());
  });

  it('should exit with error when a group has _CHANNELS but neither token is set', () => {
    const env = {
      GROUP1_CHANNELS: 'a,b,c',
    };

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => parseChannelGroups(env)).toThrow('process.exit called');
    expect(consoleSpy).toHaveBeenCalledWith(
      'GROUP1_CHANNELS is set but neither GROUP1_ANTHROPIC_API_KEY nor GROUP1_GITHUB_TOKEN is set'
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('should warn and keep the alphabetically first group when a channel is duplicated', () => {
    const env = {
      GROUP1_CHANNELS: 'a',
      GROUP1_ANTHROPIC_API_KEY: 'sk-group1',
      GROUP2_CHANNELS: 'a',
      GROUP2_GITHUB_TOKEN: 'gh-group2',
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = parseChannelGroups(env);

    expect(result.channelApiKeys.get('a')).toBe('sk-group1');
    expect(result.channelGithubTokens.has('a')).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      'Channel "a" already has a group assigned; ignoring duplicate assignment from group "GROUP2"'
    );

    warnSpy.mockRestore();
  });
});
