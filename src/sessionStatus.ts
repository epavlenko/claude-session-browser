import { execSync } from "child_process";
import * as fs from "fs";

export type SessionStatus = "closed" | "open" | "active" | "awaiting_review";

/** Get set of session IDs that have a running claude process */
export function getActiveSessionIds(): Set<string> {
  const ids = new Set<string>();
  try {
    const output = execSync("ps aux", { encoding: "utf8", timeout: 3000 });
    const lines = output.split("\n");
    for (const line of lines) {
      if (!line.includes("claude")) {continue;}
      // Match --resume <uuid>
      const match = line.match(/--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (match) {
        ids.add(match[1]);
      }
    }
  } catch {
    // ps failed — treat all as closed
  }
  return ids;
}

/** Read last meaningful message type from a JSONL file */
export function getLastMessageType(filePath: string): "user" | "assistant" | null {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const stat = fs.fstatSync(fd);
      // Read last 32KB
      const tailSize = Math.min(32768, stat.size);
      const buf = Buffer.alloc(tailSize);
      fs.readSync(fd, buf, 0, tailSize, stat.size - tailSize);
      const tail = buf.toString("utf8");

      const lines = tail.split("\n").filter(Boolean);
      // Walk backwards to find last user or assistant message
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (line.includes('"type":"assistant"') || line.includes('"type": "assistant"')) {
          return "assistant";
        }
        if (line.includes('"type":"user"') || line.includes('"type": "user"')) {
          return "user";
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Determine session status:
 * - closed: no running process
 * - active: running process, last message is user (agent working)
 * - awaiting_review: running process, last message is assistant (waiting for user)
 * - open: running process, can't determine state
 */
export function getSessionStatus(
  sessionId: string,
  filePath: string,
  activeIds: Set<string>
): SessionStatus {
  if (!activeIds.has(sessionId)) {
    return "closed";
  }

  const lastMsg = getLastMessageType(filePath);
  if (lastMsg === "user") {
    return "active";
  }
  if (lastMsg === "assistant") {
    return "awaiting_review";
  }
  return "open";
}
