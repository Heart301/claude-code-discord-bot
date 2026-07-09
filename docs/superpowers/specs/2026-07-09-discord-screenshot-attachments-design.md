# Discord 截圖附件處理功能 — 設計文件

日期:2026-07-09

## 背景與目的

目前 Discord bot 的訊息處理流程(`src/bot/client.ts` 的 `handleMessage`)完全忽略 `message.attachments`,只把 `message.content`(純文字)傳進 `ClaudeManager.runClaudeCode()`,最終組成 `claude -p "<text>"` 指令字串。使用者上傳截圖時,Claude Code 完全看不到圖片內容。

本功能要讓使用者上傳的截圖(或其他附件)可以被對應 channel 的 Claude Code session 讀取到。

## 核心方案

Claude Code CLI 的 `-p` 參數只接受純文字,不支援直接夾帶 base64 圖片。但 Claude Code 內建的 Read 工具原生支援讀取本機圖片檔案。因此採用:

**下載附件到系統暫存目錄 → 在 prompt 文字尾端附加檔案的絕對路徑 → 由 Claude 自行決定是否用 Read 工具讀取。**

`ClaudeManager`/`shell.ts` 的既有邏輯不需要修改,因為對它們來說輸入仍然只是一段文字 prompt。

## 架構

新增獨立模組 `src/utils/attachments.ts`,匯出一個 `AttachmentStore` class,由 `DiscordBot`(`src/bot/client.ts`)持有並呼叫。

```
Discord message (可能含 attachments)
        │
        ▼
handleMessage()
  1. attachmentStore.cleanupChannel(channelId)   // 清掉上一輪暫存檔
  2. if attachments non-empty:
       paths = await attachmentStore.downloadAttachments(channelId, messageId, attachments)
       prompt = message.content + 附加檔案路徑清單
     else:
       prompt = message.content
  3. claudeManager.runClaudeCode(..., prompt, ...)   // 既有流程,不變
```

## 元件設計

### `AttachmentStore`(`src/utils/attachments.ts`)

```ts
class AttachmentStore {
  // channelId -> 目前這批暫存檔所在目錄
  private channelDirs = new Map<string, string>();

  async downloadAttachments(
    channelId: string,
    messageId: string,
    attachments: Iterable<{ url: string; name: string; size: number }>
  ): Promise<{ paths: string[]; skipped: { name: string; reason: string }[] }>;

  cleanupChannel(channelId: string): void;
}
```

- **檔案大小限制**:單一附件超過 25MB 直接跳過,加入 `skipped` 清單(reason: `"exceeds 25MB limit"`),不下載。
- **檔名清洗**:對 `attachment.name` 先 `path.basename()`,再移除白名單外字元(只保留英數字、`.`、`_`、`-`,其餘替換為 `_`),避免路徑穿越攻擊。
- **儲存路徑**:`os.tmpdir()/claude-discord-bot/<channelId>/<messageId>-<清洗後檔名>`。
- **下載來源**:只使用 discord.js `Attachment.url`(Discord CDN 網址),不接受任何使用者自訂 URL。
- **下載失敗**(網路錯誤、非 2xx 回應):該檔案跳過,加入 `skipped` 清單(reason: 錯誤訊息),console.error 記錄,不中斷其餘附件的下載。
- **`cleanupChannel`**:若 `channelDirs` 有記錄該 channel 的目錄,`fs.rmSync(dir, { recursive: true, force: true })` 並移除記錄;找不到記錄則是 no-op。刪除若拋出例外,只 console.error,不往外拋。

### `src/bot/client.ts` 改動

- `DiscordBot` 建構子內建立一個 `AttachmentStore` 實例。
- `handleMessage` 中,在既有的權限檢查、`general` 頻道排除檢查之後、組 prompt 之前:
  1. 呼叫 `attachmentStore.cleanupChannel(channelId)`(不論這則訊息本身有沒有附件,都要清掉「上一輪」的)。
  2. 若 `message.attachments.size > 0`,呼叫 `downloadAttachments`,取得 `paths` 與 `skipped`。
     - 若 `paths` 非空,把以下文字附加到 prompt 尾端:
       ```

       [附加檔案]
       - <path1>
       - <path2>
       ```
     - 若 `skipped` 非空,發一則沿用現有 `⚠️ Warning` 樣式的 embed,列出被跳過的檔名與原因。
  3. 用組好的 prompt(而非原始 `message.content`)呼叫 `claudeManager.runClaudeCode(...)`。

## 安全性

- **絕不執行上傳的檔案**:整個流程只有「下載寫入暫存目錄」與「把路徑字串塞進 prompt 文字」兩個動作,程式碼本身不對附件做任何 `exec`/`spawn`/`chmod +x`。附件是否被讀取,完全交由 Claude 判斷是否呼叫 Read 工具,Read 工具本身只讀取內容、不執行。
- **路徑穿越防護**:檔名一律先 `path.basename()` 再套用白名單字元過濾,確保寫入位置永遠在 `os.tmpdir()/claude-discord-bot/<channelId>/` 之下。
- **SSRF 防護**:只下載 discord.js 附件物件自帶的 `url`(Discord CDN),不解析或接受 prompt 文字中的任意 URL。
- **暫存目錄權限**:使用系統預設權限建立,不額外放寬。

## 資料流總結

1. 使用者傳訊息(可能含附件)。
2. 清掉這個 channel 上一輪暫存檔。
3. 若有附件:檢查大小 → 清洗檔名 → 下載到暫存目錄 → 記錄目錄供下次清理。
4. 組出最終 prompt(原文字 + 檔案路徑清單),照舊呼叫 `runClaudeCode`。
5. Claude 視需要用 Read 工具讀取路徑對應的圖片/檔案。
6. 該 channel 下一則訊息進來時,回到步驟 2,清掉這一批。

## 測試計畫

新增 `test/utils/attachments.test.ts`,比照現有 vitest 風格(見 `test/utils/shell.test.ts`):

- mock `fetch` 回傳假的檔案內容,驗證 `downloadAttachments` 確實把檔案寫到預期路徑,回傳正確的 `paths`。
- 附件 `size` 超過 25MB → 被放進 `skipped`,不產生檔案。
- 附件 `name` 含 `../` 或路徑分隔符號 → 清洗後檔名不含這些字元,且檔案仍寫在該 channel 的暫存目錄內(不會逃逸出去)。
- `fetch` 失敗(reject 或非 2xx)→ 該附件被放進 `skipped`,其餘附件仍正常下載。
- `cleanupChannel` 對已存在目錄:目錄被刪除,且再次呼叫是 no-op。
- `cleanupChannel` 對未知 channelId:no-op,不拋出例外。

`src/bot/client.ts` 的改動,視現有 `test/bot/client.test.ts` 的 mock 方式(mock `message`/`channel`/discord.js Client),額外驗證:

- 有附件時,傳給 `runClaudeCode` 的 prompt 字串包含正確的檔案路徑清單。
- 沒有附件時,prompt 與 `message.content` 完全相同(不受影響,行為不變)。
- 每則新訊息處理前都會呼叫一次 `cleanupChannel`。

## 範圍之外(Out of scope)

- 不處理「非同步下載期間使用者又送新訊息」的併發情況——`ClaudeManager.hasActiveProcess` 已確保同一 channel 同時間只會處理一則訊息,不需要額外鎖。
- 不對圖片做任何轉檔、壓縮或內容分析,原封不動下載。
- 不提供設定項調整 25MB 限制或暫存路徑,先以合理預設值滿足需求。
