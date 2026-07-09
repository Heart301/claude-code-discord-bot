import * as path from "path";

export function sanitizeFilename(name: string): string {
  const base = path.basename(name);
  const sanitized = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized === "" ? "_" : sanitized;
}
