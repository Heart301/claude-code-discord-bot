# Claude process idle timeout + 總時長上限 設計文件

## 背景與目標

目前 `ClaudeManager.runClaudeCode`（`src/claude/manager.ts:157-171`）在 process 啟動時設一個單一固定的 20 分鐘 `setTimeout`，全程只有在收到 `result` 訊息時才會 `clearTimeout`。也就是說即使 Claude 一直有輸出、session 正常在跑，只要總執行時間超過 20 分鐘就會被強制 kill，造成本來可以完成的長任務被誤殺。

目標：改成「idle timeout」——只要 stdout 有任何輸出就重新計算逾時時間，讓真正還在動的 session 不會被砍；同時保留一個總時長上限，避免真的卡住但仍持續吐一點點輸出（或失控迴圈）的 session 無限跑下去。

## 逾時規則

- **Idle timeout：15 分鐘**——從「process 啟動」或「最近一次 stdout data event」起算，15 分鐘內都沒有任何新的 stdout 輸出（不需要是完整 JSON 行，收到任何原始 chunk 就算）就觸發。
- **總時長上限：60 分鐘**——從 process 啟動起算，不論中間有沒有輸出，滿 60 分鐘就觸發。
- 兩個計時器互相獨立，先到者觸發即可，觸發後都是同樣的收尾動作：`kill("SIGTERM")` + 送出對應的逾時 Embed + 清除另一個還沒觸發的計時器。
- 收到 `result` 訊息、或 process `close`/`error` 時，兩個計時器都要 `clearTimeout`，避免計時器在 process 已結束後才觸發、或持有已死的 process 參照。

## 架構與資料流

`src/claude/manager.ts` 的 `runClaudeCode`：

1. 宣告兩個 timer 變數（`idleTimer`、`absoluteTimer`），抽出共用的「觸發逾時」邏輯為一個 helper（例如 `triggerTimeout(kind: "idle" | "absolute")`），內容包含：kill process、清除另一個 timer、依 `kind` 組出不同文字的 Embed 並送出。
2. `absoluteTimer`：`runClaudeCode` 一開始 `setTimeout(() => triggerTimeout("absolute"), 60 * 60 * 1000)`，全程不重置。
3. `idleTimer`：抽出 `resetIdleTimer()` 函式（`clearTimeout` 舊的、`setTimeout(() => triggerTimeout("idle"), 15 * 60 * 1000)` 新的）。啟動時呼叫一次；`claude.stdout.on("data", ...)` 的 handler 最前面也呼叫一次（不需要等 JSON 解析完成，收到 raw chunk 就重置）。
4. 兩個 timer 的常數（`IDLE_TIMEOUT_MS = 15 * 60 * 1000`、`ABSOLUTE_TIMEOUT_MS = 60 * 60 * 1000`）定義在檔案上方，方便測試與閱讀。
5. 在 `result` 訊息處理完成的 `.then(...)`（現在的 `manager.ts:203-207`）跟既有的 `claude.on("close", ...)` / `claude.on("error", ...)` 裡，都補上清除 `idleTimer` 與 `absoluteTimer`（目前只清單一個 `timeout`）。

## 逾時訊息文字

| 情境 | 標題 | 內容 |
|---|---|---|
| Idle 逾時 | `⏰ 逾時` | `Claude Code 已 15 分鐘沒有任何回應` |
| 總時長逾時 | `⏰ 逾時` | `Claude Code 執行時間已超過 60 分鐘上限` |

顏色沿用現有的 `0xFFD700`（黃色）。

## 錯誤處理

| 情境 | 行為 |
|---|---|
| Idle timer 觸發 | kill process、清除 absolute timer、送出 idle 逾時 Embed |
| Absolute timer 觸發 | kill process、清除 idle timer、送出總時長逾時 Embed |
| 收到 `result` / process 正常結束 | 清除兩個 timer，不送任何逾時 Embed |
| process `close`（非 timeout 造成）/ `error` | 清除兩個 timer（沿用現有 `clearTimeout(timeout)` 的呼叫位置，各自補上第二個 timer） |

## 測試（TDD）

在 `test/claude/manager.test.ts` 用 `vi.useFakeTimers()` 新增：

1. stdout 每隔 < 15 分鐘就有輸出、總長超過 60 分鐘 → 60 分鐘整時觸發**總時長逾時**（不是 idle 逾時），process 被 kill。
2. stdout 完全沒有輸出，經過 15 分鐘（尚未到 60 分鐘）→ 觸發 **idle 逾時**，process 被 kill。
3. 任何一次 stdout data（即使不是完整 JSON 行、無法解析）都能重置 idle 計時器：驗證在 14 分 59 秒時收到一段輸出後，再等 15 分鐘才會觸發 idle 逾時（而不是原本累積的時間點）。
4. 收到 `result` 訊息後，繼續推進假時鐘超過 60 分鐘，process 不會再被 kill、也不會再送出任何逾時 Embed。

## 範圍外

- 不做「使用者可設定逾時時間」的功能（idle 15 分鐘 / 總時長 60 分鐘先寫死成常數）。
- 不處理 process `close`/`error` 已有的錯誤 Embed 與這次的逾時 Embed 的訊息去重（維持現況：只要不是 timeout 造成的 kill，既有的 close/error 分支邏輯不變）。
