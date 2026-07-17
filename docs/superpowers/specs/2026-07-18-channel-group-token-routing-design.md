# 頻道群組 → 多種 Token（Anthropic API Key / GitHub Token）分組 設計文件

## 背景與目標

目前（`2026-07-11-channel-api-key-routing-design.md` 已實作的版本）只支援依頻道分組覆寫 `ANTHROPIC_API_KEY`，格式是 `ANTHROPIC_API_KEY_<NAME>` / `ANTHROPIC_API_KEY_<NAME>_CHANNELS`，channels 清單是綁在單一 token 類型底下的。

現在要新增第二種可覆寫的 token：`GITHUB_TOKEN`（GitHub Fine-grained Personal Access Token），讓不同頻道群組也能用不同權限範圍的 GitHub token（例如某群組的 repo 只能用 read-only token，另一群組可以用有寫入權限的 token）。

如果比照舊格式各自帶一份 `_CHANNELS`（`ANTHROPIC_API_KEY_GROUP1_CHANNELS` 和 `GITHUB_TOKEN_GROUP1_CHANNELS`），同一組頻道清單要重複打兩次、容易兜不起來。因此這次一併把「頻道群組」和「token 類型」拆開：**頻道清單只跟群組名稱綁一次**，群組底下可以掛任意種類的 token（目前是 Anthropic API key 和 GitHub token，之後要加第三種 token 類型也不用改頻道清單的解析邏輯）。

這是一個**破壞性變更**：`.env` 命名規則改變，且不做向下相容，需要手動更新既有 `.env`。

## 設定方式（.env）

```
GROUP1_CHANNELS=a,b,c
GROUP1_ANTHROPIC_API_KEY=sk-ant-xxxx
GROUP1_GITHUB_TOKEN=github_pat_xxxx

GROUP2_CHANNELS=d,e,f
GROUP2_ANTHROPIC_API_KEY=sk-ant-xxxx
GROUP2_GITHUB_TOKEN=github_pat_yyyy
```

- `<NAME>`（如 `GROUP1`、`GROUP2`）可以是任意字串。
- `<NAME>_CHANNELS` 用逗號分隔頻道名稱，解析時 trim 前後空白，決定這個群組涵蓋哪些頻道。
- 同一個群組底下的 `<NAME>_ANTHROPIC_API_KEY` 和 `<NAME>_GITHUB_TOKEN` **都是可選的**，可以只設一個，但**至少要設一個**——兩個都沒設代表這個群組的頻道清單沒有任何 token 要覆寫，視為設定錯誤。
- 沒被列進任何群組 `_CHANNELS` 的頻道：兩種 token 都不覆寫，沿用 spawn 繼承的 `process.env`（host 上既有的登入/預設認證，或 bot process 自己 `.env` 裡若有全域 `ANTHROPIC_API_KEY` / `GITHUB_TOKEN` 的話）。

## 架構與資料流

1. **`src/utils/config.ts`**
   - 移除舊的 `parseChannelApiKeys`，新增 `parseChannelGroups(env: Record<string, string | undefined>): { channelApiKeys: Map<string, string>; channelGithubTokens: Map<string, string> }`：
     - 用 regex `^(.+)_CHANNELS$` 掃描傳入的 env 物件，抓出所有群組名稱。
     - 群組名稱依字母排序後依序處理（讓重複頻道衝突時的「先到先贏」行為固定可預期）。
     - 對每個群組，讀 `<NAME>_ANTHROPIC_API_KEY` 和 `<NAME>_GITHUB_TOKEN`；兩者都沒設，印錯誤訊息並 `process.exit(1)`。
     - 把 `<NAME>_CHANNELS` 值用逗號拆開、trim、過濾空字串；逐一檢查該頻道名稱是否已經被更早處理（字母序較前）的群組登記過——**一個頻道只能屬於一個群組**（不再分別對兩種 token 各自判斷重複）。若已被登記，印警告並整組跳過該頻道，不覆蓋既有登記；若未被登記，依該群組實際有設定的 token（一個或兩個）寫入對應的 `channelApiKeys` / `channelGithubTokens` Map。
   - `validateConfig()` 呼叫 `parseChannelGroups(process.env)`，兩個 Map 都掛進回傳的 `Config`。

2. **`src/types/index.ts`**
   - `Config` 新增欄位 `channelGithubTokens: Map<string, string>`（`channelApiKeys: Map<string, string>` 維持不變）。

3. **`src/index.ts`**
   - `new ClaudeManager(config.baseFolder, config.channelApiKeys, config.channelGithubTokens)`。

4. **`src/claude/manager.ts`**
   - `ClaudeManager` 建構子新增參數 `channelGithubTokens: Map<string, string>`，存成 instance 欄位。
   - `runClaudeCode` 組 spawn env 時，在既有 `channelApiKeys` 覆寫 `ANTHROPIC_API_KEY` 的邏輯旁邊，比照加一段：若 `channelGithubTokens.get(channelName)` 有值，把它設進 `spawnEnv.GITHUB_TOKEN`（只設這一個變數，不重複設 `GH_TOKEN`）。兩段覆寫邏輯互相獨立。

5. **`.env.example`**
   - 把舊的 `ANTHROPIC_API_KEY_GROUP1` / `ANTHROPIC_API_KEY_GROUP1_CHANNELS` 範例改成新格式，並補上 `GROUP1_GITHUB_TOKEN` 的範例與說明。

## 錯誤處理

| 情境 | 行為 |
|---|---|
| 群組設了 `<NAME>_CHANNELS`，但 `<NAME>_ANTHROPIC_API_KEY` 和 `<NAME>_GITHUB_TOKEN` 都沒設 | 啟動時報錯並 `process.exit(1)` |
| 同一個頻道名稱出現在兩個群組的 `_CHANNELS` 清單 | 啟動時印警告，整個頻道採用字母序較前的群組（該群組設了哪些 token 就套用哪些），不中斷啟動 |
| 頻道不在任何群組清單裡 | 執行期兩種 token 都不覆寫，沿用 spawn 繼承的 `process.env`（現況行為） |
| 群組只設 `<NAME>_ANTHROPIC_API_KEY`，沒設 `<NAME>_GITHUB_TOKEN`（反之亦然） | 合法。該群組頻道只覆寫有設定的那一種 token |

## 測試

- `parseChannelGroups` 是純函式，透過 `bun run test:run` 涵蓋以下案例（改寫並取代 `test/utils/config.test.ts` 裡原本測 `parseChannelApiKeys` 的區塊）：
  - 群組同時設定 `_ANTHROPIC_API_KEY` 和 `_GITHUB_TOKEN` → 兩個 Map 都正確對應。
  - 群組只設 `_GITHUB_TOKEN`（沒設 `_ANTHROPIC_API_KEY`）→ 只出現在 `channelGithubTokens`，`channelApiKeys` 沒有該頻道。
  - 群組只設 `_ANTHROPIC_API_KEY`（沒設 `_GITHUB_TOKEN`）→ 只出現在 `channelApiKeys`。
  - 群組有 `_CHANNELS` 但兩種 token 都沒設 → 報錯退出。
  - 同一頻道出現在兩個群組的 `_CHANNELS` → 印警告，整個頻道採用第一個（字母序較前）群組的設定。
  - 環境變數裡完全沒有任何 `*_CHANNELS` → 回傳兩個空 Map。
- `manager.ts` 裡 spawn env 覆寫的邏輯很薄，不特別寫整合測試（會牽涉到真的 spawn `claude` process，超出這次範圍），比照上一版的做法。

## 範圍外

- 不做 `.env` 舊格式（`ANTHROPIC_API_KEY_GROUP1_CHANNELS`）的向下相容 shim；既有 `.env` 需要手動改成新格式。
- 不處理原生 `git` 指令認證方式（`http.extraheader`、SSH 相關設定等）；本次僅透過 `spawnEnv.GITHUB_TOKEN` 覆寫，`gh` CLI 會讀取此變數，原生 `git` 是否吃到則視 host 既有的 credential helper 設定而定（已與使用者確認：此主機的 SSH key 僅有 deploy 唯讀權限，非本次要處理的風險）。
- 不支援用 channel ID 取代 channel name 做對應（沿用現有 `BASE_FOLDER/channelName` 的既有慣例）。
- 不處理 key/token 的輪替、遮罩顯示、secrets 管理等進階需求。
- 不新增第三種 token 類型（例如其他外部服務的 API key）；但架構上（群組名稱與 token 類型分離）之後要加不困難。
