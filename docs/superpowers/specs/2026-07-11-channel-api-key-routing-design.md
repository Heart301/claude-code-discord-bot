# 頻道 → Anthropic API Key 分組 設計文件

## 背景與目標

目前 bot 是單一 process、單一 Discord app，`ClaudeManager.runClaudeCode` 透過 `spawn("/bin/bash", ...)` 執行 `claude` CLI，spawn 時的 env 直接繼承 `process.env`（`src/claude/manager.ts:101-107`），沒有明確設定 `ANTHROPIC_API_KEY`，因此目前所有頻道共用 host 上 `claude` CLI 既有的登入/預設認證。

目標：讓不同 Discord 頻道使用不同的 Anthropic API key，例如頻道 a, b, c 用一組 key、d, e, f 用另一組 key，且維持單一 Discord app / 單一 process（不需要多開 bot 或用 Discord 權限隔離頻道）。

## 設定方式（.env）

用環境變數命名規則描述任意多組「群組 key + 群組頻道清單」：

```
ANTHROPIC_API_KEY_GROUP1=sk-ant-xxxx
ANTHROPIC_API_KEY_GROUP1_CHANNELS=a,b,c

ANTHROPIC_API_KEY_GROUP2=sk-ant-yyyy
ANTHROPIC_API_KEY_GROUP2_CHANNELS=d,e,f
```

- `<NAME>`（如 `GROUP1`、`GROUP2`）可以是任意字串，之後要加第三組只要在 `.env` 多加一組 `ANTHROPIC_API_KEY_<NAME>` / `ANTHROPIC_API_KEY_<NAME>_CHANNELS`，不用改程式碼。
- `_CHANNELS` 用逗號分隔頻道名稱，解析時 trim 前後空白。
- 沒被列進任何群組的頻道：不覆寫 `ANTHROPIC_API_KEY`，沿用目前行為（吃 spawn 繼承到的 `process.env`，也就是 host 上 `claude` CLI 既有的登入/預設認證，或是 bot process 自己 `.env` 裡若設定了全域 `ANTHROPIC_API_KEY` 的話）。

## 架構與資料流

1. **`src/utils/config.ts`**
   - 新增純函式 `parseChannelApiKeys(env: Record<string, string | undefined>): Map<string, string>`：
     - 用 regex `^ANTHROPIC_API_KEY_(.+)_CHANNELS$` 掃描傳入的 env 物件，抓出所有群組名稱。
     - 群組名稱依字母排序後依序處理（讓重複頻道衝突時的「先到先贏」行為固定可預期）。
     - 對每個群組，讀對應的 `ANTHROPIC_API_KEY_<NAME>`；若沒設定，視為設定錯誤。
     - 把 `_CHANNELS` 值用逗號拆開、trim、過濾空字串，逐一寫入回傳的 `Map<頻道名稱, apiKey>`；若某頻道名稱已經被更早處理的群組登記過，印警告並保留原本（先到先贏）的對應，不覆蓋。
   - `validateConfig()` 呼叫 `parseChannelApiKeys(process.env)`，結果掛進回傳的 `Config`。若解析途中遇到「群組缺 key」的設定錯誤，比照現有 `DISCORD_TOKEN` / `BASE_FOLDER` 的檢查風格：印錯誤訊息並 `process.exit(1)`。

2. **`src/types/index.ts`**
   - `Config` 型別新增欄位 `channelApiKeys: Map<string, string>`。

3. **`src/index.ts`**
   - `new ClaudeManager(config.baseFolder, config.channelApiKeys)`。

4. **`src/claude/manager.ts`**
   - `ClaudeManager` 建構子新增參數 `channelApiKeys: Map<string, string>`，存成 instance 欄位。
   - `runClaudeCode` 組 spawn env 時：
     - 若 `channelApiKeys.get(channelName)` 有值，把它設進 `env.ANTHROPIC_API_KEY`（覆蓋掉 `process.env` 裡原本可能有的值）。
     - 若沒有對應值，維持現有的 `{ ...process.env, SHELL: "/bin/bash" }`，不做任何覆寫。

## 錯誤處理

| 情境 | 行為 |
|---|---|
| 群組設了 `_CHANNELS` 但沒對應的 `ANTHROPIC_API_KEY_<NAME>` | 啟動時報錯並 `process.exit(1)` |
| 同一個頻道名稱出現在兩個群組的 `_CHANNELS` 清單 | 啟動時印警告，採用字母序較前的群組（first-match wins），不中斷啟動 |
| 頻道不在任何群組清單裡 | 執行期不覆寫 `ANTHROPIC_API_KEY`，沿用 spawn 繼承的 `process.env`（現況行為） |

## 測試

- `parseChannelApiKeys` 是純函式，透過 `bun run test:run` 涵蓋以下案例：
  - 兩組群組皆正常設定 → 回傳正確的頻道對照 Map。
  - 某群組缺 `ANTHROPIC_API_KEY_<NAME>` → 拋出錯誤／導致呼叫端報錯退出。
  - 同一頻道出現在兩個群組 → 印警告，且對照結果採第一個（字母序較前）群組的 key。
  - 環境變數裡完全沒有任何 `ANTHROPIC_API_KEY_*_CHANNELS` → 回傳空 Map。
- `manager.ts` 裡 spawn env 覆寫的邏輯很薄（`if (map.has(channelName)) env.ANTHROPIC_API_KEY = ...`），不特別寫整合測試（會牽涉到真的 spawn `claude` process，超出這次範圍）。

## 範圍外

- 不支援用 channel ID 取代 channel name 做對應（沿用現有 `BASE_FOLDER/channelName` 的既有慣例，用頻道名稱）。
- 不做多 Discord app / 多 bot token 的方案（那是設計討論中被捨棄的替代方案）。
- 不處理 key 的輪替、遮罩顯示、secrets 管理等進階需求。
