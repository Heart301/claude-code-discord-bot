import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { validateConfig } from '../../src/utils/config.js';

describe('validateConfig', () => {
  const originalEnv = process.env;
  
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
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

import { parseChannelApiKeys } from '../../src/utils/config.js';

describe('parseChannelApiKeys', () => {
  it('should parse two groups into a channel-to-key map', () => {
    const env = {
      ANTHROPIC_API_KEY_GROUP1: 'sk-group1',
      ANTHROPIC_API_KEY_GROUP1_CHANNELS: 'a, b,c',
      ANTHROPIC_API_KEY_GROUP2: 'sk-group2',
      ANTHROPIC_API_KEY_GROUP2_CHANNELS: 'd,e,f',
    };

    const result = parseChannelApiKeys(env);

    expect(result).toEqual(
      new Map([
        ['a', 'sk-group1'],
        ['b', 'sk-group1'],
        ['c', 'sk-group1'],
        ['d', 'sk-group2'],
        ['e', 'sk-group2'],
        ['f', 'sk-group2'],
      ])
    );
  });

  it('should return an empty map when no groups are configured', () => {
    const result = parseChannelApiKeys({ DISCORD_TOKEN: 'x' });
    expect(result).toEqual(new Map());
  });

  it('should exit with error when a group has _CHANNELS but no matching key', () => {
    const env = {
      ANTHROPIC_API_KEY_GROUP1_CHANNELS: 'a,b,c',
    };

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => parseChannelApiKeys(env)).toThrow('process.exit called');
    expect(consoleSpy).toHaveBeenCalledWith(
      'ANTHROPIC_API_KEY_GROUP1_CHANNELS is set but ANTHROPIC_API_KEY_GROUP1 is missing'
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('should warn and keep the alphabetically first group when a channel is duplicated', () => {
    const env = {
      ANTHROPIC_API_KEY_GROUP1: 'sk-group1',
      ANTHROPIC_API_KEY_GROUP1_CHANNELS: 'a',
      ANTHROPIC_API_KEY_GROUP2: 'sk-group2',
      ANTHROPIC_API_KEY_GROUP2_CHANNELS: 'a',
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = parseChannelApiKeys(env);

    expect(result.get('a')).toBe('sk-group1');
    expect(warnSpy).toHaveBeenCalledWith(
      'Channel "a" already has an API key group assigned; ignoring duplicate assignment from group "GROUP2"'
    );

    warnSpy.mockRestore();
  });
});