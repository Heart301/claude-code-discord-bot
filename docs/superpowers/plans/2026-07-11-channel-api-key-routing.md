# 頻道 → Anthropic API Key 分組 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓不同 Discord 頻道使用不同的 Anthropic API key（例如 a,b,c 用一組、d,e,f 用另一組），同一個 Discord app / process 內完成，不需要多開 bot。

**Architecture:** 在 `validateConfig()` 啟動時解析 `ANTHROPIC_API_KEY_<NAME>` / `ANTHROPIC_API_KEY_<NAME>_CHANNELS` 環境變數組，產生 `channelName -> apiKey` 的 `Map`，掛進 `Config`。`index.ts` 把這份 map 傳給 `ClaudeManager`；`ClaudeManager.runClaudeCode` 在組 spawn env 時，若頻道有對應的 key 就覆寫 `ANTHROPIC_API_KEY`，否則維持現況（沿用繼承的 `process.env`）。

**Tech Stack:** Bun, TypeScript, vitest（`bun run test:run`）。

## Global Constraints

- 只能用 `bun run test:run` 執行測試（不可用裸 `bun test`），依專案 CLAUDE.md 規定。
- 絕對不可執行 `bun run src/index.ts` 或啟動真正的 bot（專案 CLAUDE.md 明文禁止）。
- 環境變數命名規則固定為 `ANTHROPIC_API_KEY_<NAME>` 搭配 `ANTHROPIC_API_KEY_<NAME>_CHANNELS`（逗號分隔頻道名稱），來自已核准的 spec `docs/superpowers/specs/2026-07-11-channel-api-key-routing-design.md`。
- 群組名稱要依字母序排序後處理，重複頻道採「先到先贏」且印警告，不可中斷啟動。
- 群組有 `_CHANNELS` 卻沒有對應 `ANTHROPIC_API_KEY_<NAME>` 時，印錯誤並 `process.exit(1)`（比照現有 `DISCORD_TOKEN`/`BASE_FOLDER` 檢查風格）。

---

### Task 1: `parseChannelApiKeys` 純函式 + `Config` 型別擴充

**Files:**
- Modify: `src/utils/config.ts`
- Modify: `src/types/index.ts:54-58`（`Config` 介面）
- Modify: `test/utils/config.test.ts`

**Interfaces:**
- Produces: `parseChannelApiKeys(env: Record<string, string | undefined>): Map<string, string>`（匯出函式，key 是頻道名稱，value 是對應的 API key 字串）
- Produces: `Config.channelApiKeys: Map<string, string>`（`validateConfig()` 回傳值新增欄位）

- [ ] **Step 1: 在 `test/utils/config.test.ts` 新增 `parseChannelApiKeys` 的失敗測試**

在檔案最下方（`describe('validateConfig', ...)` 區塊結尾的 `});` 之後）新增：

```ts
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
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `bun run test:run test/utils/config.test.ts`
Expected: FAIL，錯誤訊息包含 `parseChannelApiKeys is not a function` 或 import 找不到 named export。

- [ ] **Step 3: 在 `src/types/index.ts` 的 `Config` 介面新增欄位**

把 `src/types/index.ts:54-58`：

```ts
export interface Config {
  discordToken: string;
  allowedUserId: string | undefined;
  baseFolder: string;
}
```

改成：

```ts
export interface Config {
  discordToken: string;
  allowedUserId: string | undefined;
  baseFolder: string;
  channelApiKeys: Map<string, string>;
}
```

- [ ] **Step 4: 在 `src/utils/config.ts` 實作 `parseChannelApiKeys` 並掛進 `validateConfig()`**

把整個檔案內容改成：

```ts
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
```

- [ ] **Step 5: 更新既有的 `validateConfig` 測試斷言**

現有的 `test/utils/config.test.ts` 裡三個用到 `expect(config).toEqual({...})` 的測試（「should return valid config when all environment variables are set」與「should return config with undefined allowedUserId ...」）目前沒有預期 `channelApiKeys` 欄位，會因為新欄位而失敗。把這兩處的 `toEqual` 物件都加上 `channelApiKeys: new Map()`，例如：

```ts
    expect(config).toEqual({
      discordToken: 'test-token',
      allowedUserId: 'test-user-id',
      baseFolder: '/test/folder',
      channelApiKeys: new Map(),
    });
```

（另一個測試同樣加上 `channelApiKeys: new Map()`，`allowedUserId` 維持該測試原本的 `undefined`。）

- [ ] **Step 6: 執行測試確認全部通過**

Run: `bun run test:run test/utils/config.test.ts`
Expected: PASS，所有測試（含新增的 4 個 `parseChannelApiKeys` 測試與既有的 4 個 `validateConfig` 測試）都通過。

- [ ] **Step 7: Commit**

```bash
git add src/utils/config.ts src/types/index.ts test/utils/config.test.ts
git commit -m "feat: parse channel-to-API-key groups from env vars"
```

---

### Task 2: `ClaudeManager` 依頻道覆寫 `ANTHROPIC_API_KEY`

**Files:**
- Modify: `src/claude/manager.ts:23-27`（constructor）、`src/claude/manager.ts:98-107`（spawn env）
- Modify: `test/claude/manager.test.ts`

**Interfaces:**
- Consumes: 無新的外部依賴（沿用 Task 1 的 `Map<string, string>` 型別，但這個 task 不 import `parseChannelApiKeys`，只接收建構好的 map）
- Produces: `new ClaudeManager(baseFolder: string, channelApiKeys?: Map<string, string>)`（第二參數預設 `new Map()`，維持向後相容）

- [ ] **Step 1: 在 `test/claude/manager.test.ts` 的 `runClaudeCode` 區塊新增兩個失敗測試**

在 `test/claude/manager.test.ts` 第 186 行（`});` 結束 `it('should set up process when directory exists', ...)`）之後、`describe('runClaudeCode', ...)` 的收尾 `});` 之前，新增：

```ts
    it('should override ANTHROPIC_API_KEY when the channel has a mapped key', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const mockProcess = {
        pid: 12345,
        stdin: { end: vi.fn() },
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        kill: vi.fn()
      };

      const { spawn } = await import('child_process');
      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      const channelApiKeys = new Map([['test-channel', 'sk-test-key']]);
      const managerWithKeys = new ClaudeManager(mockBaseFolder, channelApiKeys);
      managerWithKeys.reserveChannel('channel-1', undefined, {});

      try {
        await managerWithKeys.runClaudeCode('channel-1', 'test-channel', 'test prompt');
      } catch (error) {
        // Expected to fail due to mocking, just checking setup
      }

      expect(spawn).toHaveBeenCalledWith(
        '/bin/bash',
        ['-c', expect.stringContaining('claude')],
        expect.objectContaining({
          env: expect.objectContaining({ ANTHROPIC_API_KEY: 'sk-test-key' }),
        })
      );

      managerWithKeys.destroy();
    });

    it('should not override ANTHROPIC_API_KEY when the channel has no mapped key', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const mockProcess = {
        pid: 12345,
        stdin: { end: vi.fn() },
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        kill: vi.fn()
      };

      const { spawn } = await import('child_process');
      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      manager.reserveChannel('channel-1', undefined, {});

      try {
        await manager.runClaudeCode('channel-1', 'test-channel', 'test prompt');
      } catch (error) {
        // Expected to fail due to mocking, just checking setup
      }

      const call = vi.mocked(spawn).mock.calls[0];
      const options = call[2] as { env: Record<string, string | undefined> };
      expect(options.env.ANTHROPIC_API_KEY).toBe(process.env.ANTHROPIC_API_KEY);
    });
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `bun run test:run test/claude/manager.test.ts`
Expected: 第一個新測試 FAIL（`spawn` 收到的 `env.ANTHROPIC_API_KEY` 不是 `'sk-test-key'`，因為 constructor 目前只接受一個參數、且 spawn 沒有做覆寫邏輯）。

- [ ] **Step 3: 修改 `src/claude/manager.ts` 的 constructor**

把 `src/claude/manager.ts:23-27`：

```ts
  constructor(private baseFolder: string) {
    this.db = new DatabaseManager();
    // Clean up old sessions on startup
    this.db.cleanupOldSessions();
  }
```

改成：

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

- [ ] **Step 4: 修改 `src/claude/manager.ts` 的 spawn env 組裝**

把 `src/claude/manager.ts:98-107`：

```ts
    const commandString = buildClaudeCommand(workingDir, prompt, sessionId, discordContext);
    console.log(`Running command: ${commandString}`);

    const claude = spawn("/bin/bash", ["-c", commandString], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        SHELL: "/bin/bash",
      },
    });
```

改成：

```ts
    const commandString = buildClaudeCommand(workingDir, prompt, sessionId, discordContext);
    console.log(`Running command: ${commandString}`);

    const spawnEnv: Record<string, string | undefined> = {
      ...process.env,
      SHELL: "/bin/bash",
    };

    const apiKeyOverride = this.channelApiKeys.get(channelName);
    if (apiKeyOverride) {
      spawnEnv.ANTHROPIC_API_KEY = apiKeyOverride;
    }

    const claude = spawn("/bin/bash", ["-c", commandString], {
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv,
    });
```

- [ ] **Step 5: 執行測試確認全部通過**

Run: `bun run test:run test/claude/manager.test.ts`
Expected: PASS，所有既有測試與 2 個新增測試都通過。

- [ ] **Step 6: Commit**

```bash
git add src/claude/manager.ts test/claude/manager.test.ts
git commit -m "feat: override ANTHROPIC_API_KEY per channel in ClaudeManager"
```

---

### Task 3: 串接 `index.ts` 並更新設定文件

**Files:**
- Modify: `src/index.ts:17`
- Modify: `.env.example`
- Modify: `README.md`（環境變數設定章節，約第 84-101 行）

**Interfaces:**
- Consumes: `Config.channelApiKeys`（Task 1 產出）、`ClaudeManager(baseFolder, channelApiKeys?)`（Task 2 產出）

- [ ] **Step 1: 修改 `src/index.ts` 傳入 `channelApiKeys`**

把 `src/index.ts:17`：

```ts
  const claudeManager = new ClaudeManager(config.baseFolder);
```

改成：

```ts
  const claudeManager = new ClaudeManager(config.baseFolder, config.channelApiKeys);
```

- [ ] **Step 2: 在 `.env.example` 補上分組設定範例與說明**

在 `.env.example` 的 `BASE_FOLDER=/Users/your-user-name/repos` 那一行之後，新增：

```env

# Optional: route specific Discord channels to a different Anthropic API key.
# <NAME> can be any string; add as many ANTHROPIC_API_KEY_<NAME> /
# ANTHROPIC_API_KEY_<NAME>_CHANNELS pairs as you need. Channels not listed in
# any group keep using the default ANTHROPIC_API_KEY / claude CLI login.
#ANTHROPIC_API_KEY_GROUP1=sk-ant-xxxx
#ANTHROPIC_API_KEY_GROUP1_CHANNELS=a,b,c
#ANTHROPIC_API_KEY_GROUP2=sk-ant-yyyy
#ANTHROPIC_API_KEY_GROUP2_CHANNELS=d,e,f
```

- [ ] **Step 3: 在 `README.md` 的環境變數章節補上同樣說明**

在 `README.md:100`（`BASE_FOLDER=/path/to/your/repos` 那一行）之後、程式碼區塊結束（` ``` `）之前，新增：

```env

# Optional: route specific Discord channels to a different Anthropic API key.
# <NAME> can be any string; add as many pairs as you need.
# Channels not listed in any group keep using the default ANTHROPIC_API_KEY / claude CLI login.
#ANTHROPIC_API_KEY_GROUP1=sk-ant-xxxx
#ANTHROPIC_API_KEY_GROUP1_CHANNELS=a,b,c
#ANTHROPIC_API_KEY_GROUP2=sk-ant-yyyy
#ANTHROPIC_API_KEY_GROUP2_CHANNELS=d,e,f
```

- [ ] **Step 4: 執行完整測試套件確認沒有破壞任何東西**

Run: `bun run test:run`
Expected: PASS，所有測試檔案（含 Task 1、Task 2 新增的測試）都通過，無失敗項目。

- [ ] **Step 5: Commit**

```bash
git add src/index.ts .env.example README.md
git commit -m "feat: wire channel API key routing into bot startup and docs"
```

---

## Self-Review Notes

- **Spec coverage**：`.env` 命名規則與解析（Task 1）、first-match-wins 警告（Task 1）、缺 key 報錯（Task 1）、未設定頻道 fallback（Task 2 的 `if (apiKeyOverride)` 判斷）、`ClaudeManager`/`index.ts` 串接（Task 2、Task 3）、文件更新（Task 3）都各自對應到一個 task。spec 明訂「範圍外」的多 Discord app 方案、channel ID 對應、key 輪替皆未在此計畫中出現，符合預期。
- **Placeholder scan**：三個 task 的每個 step 都附完整程式碼與明確指令、預期輸出，沒有「TBD」「add error handling」等佔位字樣。
- **Type consistency**：`channelApiKeys: Map<string, string>` 這個型別從 `Config`（Task 1）→ `ClaudeManager` constructor（Task 2）→ `index.ts` 呼叫（Task 3）維持一致，函式名稱 `parseChannelApiKeys` 與呼叫處也一致。
