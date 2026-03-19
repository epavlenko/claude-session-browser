import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface SessionInfo {
  id: string;
  projectDir: string;
  projectName: string;
  title: string;
  lastModified: number;
  fileSize: number;
  messageCount: number;
  cwd?: string;
  gitBranch?: string;
  filePath: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getProjectsDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(configDir, "projects");
}

/** Encode a workspace path the same way Claude Code does */
export function encodeProjectPath(workspacePath: string): string {
  return workspacePath.replace(/[^a-zA-Z0-9]/g, "-");
}

function decodeProjectName(encoded: string): string {
  const parts = encoded.split("-").filter(Boolean);

  const skipWords = new Set([
    "users", "home", "documents", "htdocs", "projects",
    "vibecoding", "library", "mobile", "icloud", "md",
    "obsidian", "knowledge", "base",
  ]);

  const meaningful: string[] = [];
  let foundMeaningful = false;
  for (let i = parts.length - 1; i >= 0; i--) {
    const lower = parts[i].toLowerCase();
    if (skipWords.has(lower) && !foundMeaningful) {
      continue;
    }
    foundMeaningful = true;
    meaningful.unshift(parts[i]);
    if (meaningful.length >= 3) {
      break;
    }
  }

  return meaningful.join("-") || encoded;
}

/** Read first N bytes of a file */
async function readHead(filePath: string, bytes: number): Promise<string> {
  const fd = await fs.promises.open(filePath, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fd.read(buf, 0, bytes, 0);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    await fd.close();
  }
}

/** Read last N bytes of a file */
async function readTail(filePath: string, bytes: number, fileSize: number): Promise<string> {
  if (fileSize <= bytes) {return "";}  // head already covers it
  const fd = await fs.promises.open(filePath, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fd.read(buf, 0, bytes, fileSize - bytes);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    await fd.close();
  }
}

/** Extract a JSON field value from a JSONL chunk (last occurrence wins) */
function extractField(chunk: string, field: string): string | undefined {
  const pattern = `"${field}":"`;
  const pattern2 = `"${field}": "`;
  // Use lastIndexOf to get the most recent value (e.g. after rename)
  let idx = chunk.lastIndexOf(pattern);
  let pLen = pattern.length;
  if (idx === -1) {
    idx = chunk.lastIndexOf(pattern2);
    pLen = pattern2.length;
  }
  if (idx === -1) {return undefined;}
  const start = idx + pLen;
  const end = chunk.indexOf('"', start);
  if (end === -1) {return undefined;}
  return chunk.slice(start, end);
}

/** Extract first user message text from JSONL head */
function extractFirstPrompt(head: string): string | undefined {
  const lines = head.split("\n");
  for (const line of lines) {
    if (!line.includes('"type":"user"') && !line.includes('"type": "user"')) {
      continue;
    }
    try {
      const obj = JSON.parse(line);
      if (obj.type === "user" && obj.message?.content) {
        const content = obj.message.content;
        if (typeof content === "string") {
          const clean = content.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "").trim();
          if (clean) {return clean.slice(0, 120);}
        }
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c.type === "text" && c.text) {
              const clean = c.text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "").trim();
              if (clean && clean.length > 3) {return clean.slice(0, 120);}
            }
          }
        }
      }
    } catch {
      // skip malformed lines
    }
  }
  return undefined;
}

/** Count user+assistant messages from head chunk */
function countMessages(head: string): number {
  let count = 0;
  const lines = head.split("\n");
  for (const line of lines) {
    if (line.includes('"type":"user"') || line.includes('"type": "user"') ||
        line.includes('"type":"assistant"') || line.includes('"type": "assistant"')) {
      count++;
    }
  }
  return count;
}

async function parseSessionFile(filePath: string, projectDir: string): Promise<SessionInfo | null> {
  try {
    const stat = await fs.promises.stat(filePath);
    const basename = path.basename(filePath, ".jsonl");

    if (!UUID_RE.test(basename)) {return null;}

    const headSize = Math.min(65536, stat.size);
    const head = await readHead(filePath, headSize);
    const tail = await readTail(filePath, 65536, stat.size);

    const firstLine = head.slice(0, head.indexOf("\n"));
    if (firstLine.includes('"isSidechain":true') || firstLine.includes('"isSidechain": true')) {
      return null;
    }

    // Check tail first for customTitle (rename appends to end)
    const title =
      extractField(tail, "customTitle") ||
      extractField(head, "customTitle") ||
      extractField(tail, "aiTitle") ||
      extractField(head, "aiTitle") ||
      extractFirstPrompt(head);

    if (!title) {return null;}

    const projectName = decodeProjectName(projectDir);

    return {
      id: basename,
      projectDir,
      projectName,
      title: title.replace(/\\n/g, " ").trim(),
      lastModified: stat.mtimeMs,
      fileSize: stat.size,
      messageCount: countMessages(head),
      cwd: extractField(head, "cwd"),
      gitBranch: extractField(head, "gitBranch"),
      filePath,
    };
  } catch {
    return null;
  }
}

/** Rename a session by appending a customTitle entry */
export async function renameSession(filePath: string, sessionId: string, newTitle: string): Promise<void> {
  const entry = JSON.stringify({ type: "custom-title", sessionId, customTitle: newTitle });
  await fs.promises.appendFile(filePath, entry + "\n");
}

/** Delete a session file */
export async function deleteSession(filePath: string, sessionId: string): Promise<void> {
  await fs.promises.unlink(filePath);
  // Also remove subagents dir if exists
  const dir = filePath.replace(".jsonl", "");
  try {
    await fs.promises.rm(dir, { recursive: true });
  } catch {
    // no subagents dir
  }
}

/** Search session content for a query string (reads full file) */
export async function searchSessionContent(filePath: string, query: string): Promise<boolean> {
  try {
    const content = await fs.promises.readFile(filePath, "utf8");
    return content.toLowerCase().includes(query.toLowerCase());
  } catch {
    return false;
  }
}

export async function fetchAllSessions(): Promise<SessionInfo[]> {
  const projectsDir = getProjectsDir();

  let projectDirs: string[];
  try {
    projectDirs = await fs.promises.readdir(projectsDir);
  } catch {
    return [];
  }

  const allSessions: SessionInfo[] = [];

  await Promise.all(
    projectDirs.map(async (projDir) => {
      const dirPath = path.join(projectsDir, projDir);
      try {
        const dirStat = await fs.promises.stat(dirPath);
        if (!dirStat.isDirectory()) {return;}

        const files = await fs.promises.readdir(dirPath);
        const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

        const sessions = await Promise.all(
          jsonlFiles.map((f) => parseSessionFile(path.join(dirPath, f), projDir))
        );

        for (const s of sessions) {
          if (s) {allSessions.push(s);}
        }
      } catch {
        // skip inaccessible dirs
      }
    })
  );

  allSessions.sort((a, b) => b.lastModified - a.lastModified);
  return allSessions;
}
