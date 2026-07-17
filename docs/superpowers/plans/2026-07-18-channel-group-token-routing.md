# 頻道群組 → 多種 Token 分組 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把頻道分組機制從「單一 token 類型各自帶一份 `_CHANNELS`」改成「頻道清單與群組名稱綁一次，群組底下可掛任意組合的 `ANTHROPIC_API_KEY` / `GITHUB_TOKEN`」，並讓 `GITHUB_TOKEN` 依群組覆寫進 spawn 的 Claude process。

**Architecture:** `src/utils/config.ts` 的 `parseChannelGroups()` 取代舊的 `parseChannelApiKeys()`，一次解析出 `channelApiKeys` 和 `channelGithubTokens` 兩個 `Map<channelName, token>`；兩者透過 `Config` 型別、`src/index.ts`、`src/claude/manager.ts` 一路往下傳，`ClaudeManager.runClaudeCode` spawn Claude process 時各自獨立覆寫 `spawnEnv.ANTHROPIC_API_KEY` / `spawnEnv.GITHUB_TOKEN`。

**Tech Stack:** TypeScript (strict mode, Bun runtime), Vitest（`bun run test:run` 執行，禁止用 `bun test`）。

## Global Constraints

- 測試指令固定用 `bun run test:run`，不要用 `bun test`（`CLAUDE.md` / `Testing Notes`）。
- 絕對不要執行 `bun run src/index.ts` 或任何啟動 bot 的指令（`CLAUDE.md` / `Important Restrictions`）。
- 這是破壞性變更：不做 `ANTHROPIC_API_KEY_GROUP1_CHANNELS` 舊格式的向下相容 shim（spec `docs/superpowers/specs/2026-07-18-channel-group-token-routing-design.md` / 範圍外）。
- `spawnEnv` 只設 `GITHUB_TOKEN`，不要順便設 `GH_TOKEN`（spec / 架構與資料流 4）。
- 頻道與群組是一對一關係：一個頻道被某群組登記後，其他群組即使清單裡也列了同一個頻道名稱，也不能覆蓋，只能印警告跳過（spec / 錯誤處理）。

---

### Task 1: 重寫 `config.ts` 的頻道群組解析邏輯（TDD）

**Files:**
- Modify: `src/utils/config.ts`（整份重寫）
- Test: `test/utils/config.test.ts`（整份重寫）

**Interfaces:**
- Produces: `export function parseChannelGroups(env: Record<string, string | undefined>): { channelApiKeys: Map<string, string>; channelGithubTokens: Map<string, string> }`
- Produces: `export function validateConfig(): Config`（簽章不變，回傳值新增 `channelGithubTokens` 欄位，見 Task 2 的 `Config` 型別）

- [ ] **Step 1: 寫失敗的測試 — 整份取代 `test/utils/config.test.ts`**

```ts
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
```

- [ ] **Step 2: 執行測試，確認因為 `parseChannelGroups` 還不存在而失敗**

Run: `bun run test:run test/utils/config.test.ts`
Expected: FAIL — `parseChannelGroups is not a function`（或 import 找不到該 export）

- [ ] **Step 3: 整份重寫 `src/utils/config.ts`**

```ts
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
```

- [ ] **Step 4: 執行測試，確認全數通過**

Run: `bun run test:run test/utils/config.test.ts`
Expected: PASS — 全部測試（`validateConfig` 4 個 + `parseChannelGroups` 6 個）綠燈

- [ ] **Step 5: Commit**

```bash
git add src/utils/config.ts test/utils/config.test.ts
git commit -m "feat: merge channel token routing into shared GROUP*_CHANNELS config"
```

---

### Task 2: 把 `channelGithubTokens` 串進 `Config` 型別、`index.ts`、`manager.ts`

**Files:**
- Modify: `src/types/index.ts:54-59`
- Modify: `src/index.ts:17`
- Modify: `src/claude/manager.ts:33-40`（constructor）
- Modify: `src/claude/manager.ts:123-131`（spawn env）

**Interfaces:**
- Consumes: `parseChannelGroups` 回傳的 `{ channelApiKeys: Map<string, string>; channelGithubTokens: Map<string, string> }`（Task 1）
- Produces: `ClaudeManager` 建構子簽章變為 `constructor(private baseFolder: string, private channelApiKeys: Map<string, string> = new Map(), private channelGithubTokens: Map<string, string> = new Map())`

- [ ] **Step 1: 更新 `Config` 型別 — `src/types/index.ts:54-59`**

把：
```ts
export interface Config {
  discordToken: string;
  allowedUserId: string | undefined;
  baseFolder: string;
  channelApiKeys: Map<string, string>;
}
```
改成：
```ts
export interface Config {
  discordToken: string;
  allowedUserId: string | undefined;
  baseFolder: string;
  channelApiKeys: Map<string, string>;
  channelGithubTokens: Map<string, string>;
}
```

- [ ] **Step 2: 更新 `src/index.ts:17`**

把：
```ts
  const claudeManager = new ClaudeManager(config.baseFolder, config.channelApiKeys);
```
改成：
```ts
  const claudeManager = new ClaudeManager(config.baseFolder, config.channelApiKeys, config.channelGithubTokens);
```

- [ ] **Step 3: 更新 `ClaudeManager` 建構子 — `src/claude/manager.ts:33-40`**

把：
```ts
  constructor(
    private baseFolder: string,
    private channelApiKeys: Map<string, string> = new Map()
  ) {
    this.db = new DatabaseManager();
    // Clean up old sessions on startup
    this.db.cleanupOldSessions();
  }
```
改成：
```ts
  constructor(
    private baseFolder: string,
    private channelApiKeys: Map<string, string> = new Map(),
    private channelGithubTokens: Map<string, string> = new Map()
  ) {
    this.db = new DatabaseManager();
    // Clean up old sessions on startup
    this.db.cleanupOldSessions();
  }
```

- [ ] **Step 4: 更新 spawn env 覆寫邏輯 — `src/claude/manager.ts:123-131`**

把：
```ts
    const spawnEnv: Record<string, string | undefined> = {
      ...process.env,
      SHELL: "/bin/bash",
    };

    const apiKeyOverride = this.channelApiKeys.get(channelName);
    if (apiKeyOverride) {
      spawnEnv.ANTHROPIC_API_KEY = apiKeyOverride;
    }
```
改成：
```ts
    const spawnEnv: Record<string, string | undefined> = {
      ...process.env,
      SHELL: "/bin/bash",
    };

    const apiKeyOverride = this.channelApiKeys.get(channelName);
    if (apiKeyOverride) {
      spawnEnv.ANTHROPIC_API_KEY = apiKeyOverride;
    }

    const githubTokenOverride = this.channelGithubTokens.get(channelName);
    if (githubTokenOverride) {
      spawnEnv.GITHUB_TOKEN = githubTokenOverride;
    }
```

- [ ] **Step 5: Typecheck 確認沒有型別錯誤（這段 wiring 沒有自動化測試，spec 已明確排除 spawn 邏輯的整合測試）**

Run: `bunx tsc --noEmit`
Expected: 無錯誤輸出（exit code 0）

- [ ] **Step 6: 跑一次全專案測試，確認沒有破壞既有測試**

Run: `bun run test:run`
Expected: PASS — 所有既有測試（含 Task 1 新增的）維持綠燈

- [ ] **Step 7: Commit**

```bash
git add src/types/index.ts src/index.ts src/claude/manager.ts
git commit -m "feat: route per-channel GITHUB_TOKEN override through ClaudeManager spawn env"
```

---

### Task 3: 更新 `.env.example`

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: 把舊格式範例改成新的群組命名格式**

把：
```
# Optional: route specific Discord channels to a different Anthropic API key.
# <NAME> can be any string; add as many ANTHROPIC_API_KEY_<NAME> /
# ANTHROPIC_API_KEY_<NAME>_CHANNELS pairs as you need. Channels not listed in
# any group keep using the default ANTHROPIC_API_KEY / claude CLI login.
#ANTHROPIC_API_KEY_GROUP1=sk-ant-xxxx
#ANTHROPIC_API_KEY_GROUP1_CHANNELS=a,b,c
#ANTHROPIC_API_KEY_GROUP2=sk-ant-yyyy
#ANTHROPIC_API_KEY_GROUP2_CHANNELS=d,e,f
```
改成：
```
# Optional: route specific Discord channels to a different Anthropic API key
# and/or GitHub token (e.g. a Fine-grained Personal Access Token scoped to
# specific repos). <NAME> can be any string; the channel list is shared
# across both token types so you only list channels once per group.
# Each group needs at least one of _ANTHROPIC_API_KEY / _GITHUB_TOKEN set
# (both is fine too). Channels not listed in any group keep using the
# default ANTHROPIC_API_KEY / GITHUB_TOKEN / claude CLI login.
#GROUP1_CHANNELS=a,b,c
#GROUP1_ANTHROPIC_API_KEY=sk-ant-xxxx
#GROUP1_GITHUB_TOKEN=github_pat_xxxx
#GROUP2_CHANNELS=d,e,f
#GROUP2_GITHUB_TOKEN=github_pat_yyyy
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs: update .env.example for unified GROUP*_CHANNELS token routing"
```

---

## Self-Review Notes

- **Spec coverage:** `.env` 格式（Task 3）、`parseChannelGroups` 解析與錯誤/警告行為（Task 1）、`Config`/`index.ts`/`manager.ts` wiring（Task 2）、spawnEnv 只設 `GITHUB_TOKEN` 不設 `GH_TOKEN`（Task 2 Step 4）都各有對應任務。spec 明確排除的 spawn 整合測試、舊格式相容 shim，計畫裡也都沒有納入。
- **Placeholder scan:** 三個任務的每個 step 都附完整程式碼／指令，沒有「TBD」或「加上適當的錯誤處理」這類空話。
- **Type consistency:** `parseChannelGroups` 回傳型別、`Config.channelGithubTokens`、`ClaudeManager` 建構子參數名稱（`channelGithubTokens`）、spawn env 覆寫用的變數名稱（`githubTokenOverride`）在三個任務之間一致。
