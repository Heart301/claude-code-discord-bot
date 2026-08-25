import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;

export function sanitizeFilename(name: string): string {
  const base = path.basename(name);
  const sanitized = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized === "" ? "_" : sanitized;
}

export interface AttachmentInput {
  url: string;
  name: string;
  size: number;
}

export interface SkippedAttachment {
  name: string;
  reason: string;
}

export interface DownloadResult {
  paths: string[];
  skipped: SkippedAttachment[];
  dir: string;
}

export class AttachmentStore {
  // A fixed, shared path under os.tmpdir() (e.g. /tmp/claude-discord-bot)
  // can be pre-created by another local user or a stale process with
  // permissions that lock this process out. mkdtempSync gives each run its
  // own uniquely-named, privately-owned directory instead.
  private readonly baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-discord-bot-"));
  private channelDirs = new Map<string, string>();

  async downloadAttachments(
    channelId: string,
    messageId: string,
    attachments: AttachmentInput[]
  ): Promise<DownloadResult> {
    const dir = path.join(this.baseDir, channelId);
    fs.mkdirSync(dir, { recursive: true });
    this.channelDirs.set(channelId, dir);

    const paths: string[] = [];
    const skipped: SkippedAttachment[] = [];

    for (const attachment of attachments) {
      if (attachment.size > MAX_ATTACHMENT_SIZE_BYTES) {
        skipped.push({ name: attachment.name, reason: "exceeds 25MB limit" });
        continue;
      }

      const safeName = sanitizeFilename(attachment.name);
      const filePath = path.join(dir, `${messageId}-${safeName}`);

      try {
        const response = await fetch(attachment.url);
        if (!response.ok) {
          skipped.push({
            name: attachment.name,
            reason: `download failed: HTTP ${response.status}`,
          });
          continue;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(filePath, buffer);
        paths.push(filePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        skipped.push({ name: attachment.name, reason: `download failed: ${message}` });
      }
    }

    return { paths, skipped, dir };
  }

  cleanupChannel(channelId: string): void {
    const dir = this.channelDirs.get(channelId);
    if (!dir) return;

    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      console.error(`Error cleaning up attachments for channel ${channelId}:`, error);
    }

    this.channelDirs.delete(channelId);
  }
}

export function formatAttachmentsForPrompt(prompt: string, paths: string[]): string {
  if (paths.length === 0) return prompt;
  const fileList = paths.map((p) => `- ${p}`).join("\n");
  return `${prompt}\n\n[附加檔案]\n${fileList}`;
}
