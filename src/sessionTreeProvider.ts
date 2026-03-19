import * as vscode from "vscode";
import { fetchAllSessions, SessionInfo, encodeProjectPath } from "./sessionReader";
import { SessionStatus, getActiveSessionIds, getSessionStatus } from "./sessionStatus";

export type ViewMode = "byProject" | "currentProject" | "all";

const VIEW_MODE_LABELS: Record<ViewMode, string> = {
  byProject: "By Project",
  currentProject: "Current Project",
  all: "All Sessions",
};

const VIEW_MODE_CYCLE: ViewMode[] = ["all", "byProject", "currentProject"];

// Status → icon + color
const STATUS_ICONS: Record<SessionStatus, { icon: string; color?: string }> = {
  closed: { icon: "circle-outline" },
  open: { icon: "circle-filled", color: "disabledForeground" },
  active: { icon: "circle-filled", color: "charts.blue" },
  awaiting_review: { icon: "circle-filled", color: "charts.green" },
};

const STATUS_TOOLTIPS: Record<SessionStatus, string> = {
  closed: "Closed",
  open: "Open",
  active: "Agent working",
  awaiting_review: "Awaiting review",
};

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private sessions: SessionInfo[] = [];
  private _viewMode: ViewMode = "all";
  private activeSessionIds = new Set<string>();

  get viewMode(): ViewMode {
    return this._viewMode;
  }

  cycleViewMode(): ViewMode {
    const idx = VIEW_MODE_CYCLE.indexOf(this._viewMode);
    this._viewMode = VIEW_MODE_CYCLE[(idx + 1) % VIEW_MODE_CYCLE.length];
    vscode.commands.executeCommand("setContext", "claudeSessions.viewMode", this._viewMode);
    this._onDidChangeTreeData.fire(undefined);
    return this._viewMode;
  }

  get viewModeLabel(): string {
    return VIEW_MODE_LABELS[this._viewMode];
  }

  async refresh(): Promise<void> {
    this.activeSessionIds = getActiveSessionIds();
    this.sessions = await fetchAllSessions();
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: SessionTreeItem): vscode.TreeItem {
    return element;
  }

  private getCurrentProjectDir(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {return undefined;}
    return encodeProjectPath(folders[0].uri.fsPath);
  }

  private getFilteredSessions(): SessionInfo[] {
    if (this._viewMode === "currentProject") {
      const currentDir = this.getCurrentProjectDir();
      if (!currentDir) {return [];}
      return this.sessions.filter((s) => s.projectDir === currentDir);
    }
    return this.sessions;
  }

  async getChildren(element?: SessionTreeItem): Promise<SessionTreeItem[]> {
    if (this.sessions.length === 0) {
      await this.refresh();
    }

    const filtered = this.getFilteredSessions();

    if (!element) {
      if (this._viewMode === "byProject") {
        const groups = new Map<string, SessionInfo[]>();
        for (const s of filtered) {
          const key = s.projectName;
          if (!groups.has(key)) {groups.set(key, []);}
          groups.get(key)!.push(s);
        }

        return Array.from(groups.entries()).map(
          ([name, sessions]) =>
            new SessionTreeItem(
              name,
              `${sessions.length} sessions`,
              vscode.TreeItemCollapsibleState.Collapsed,
              "project",
              undefined,
              sessions
            )
        );
      }

      // Flat list: no collapse, project + msgs in description
      return filtered.map((s) => {
        const status = getSessionStatus(s.id, s.filePath, this.activeSessionIds);
        const msgs = s.messageCount > 0 ? `${s.messageCount} msgs` : "";
        const subtitle = [s.projectName, msgs].filter(Boolean).join(" · ");
        return new SessionTreeItem(
          truncate(s.title, 70),
          `${formatDate(new Date(s.lastModified))} · ${subtitle}`,
          vscode.TreeItemCollapsibleState.None,
          "session",
          s,
          undefined,
          undefined,
          status
        );
      });
    }

    // Children of a session = detail row
    if (element.itemType === "session" && element.session) {
      const s = element.session;
      const msgs = s.messageCount > 0 ? `${s.messageCount} msgs` : "";
      const detail = [s.projectName, msgs].filter(Boolean).join(" · ");
      const detailItem = new SessionTreeItem(
        detail,
        "",
        vscode.TreeItemCollapsibleState.None,
        "detail",
        undefined,
        undefined,
        undefined,
        undefined
      );
      return [detailItem];
    }

    // Children of a project group
    if (element.sessions) {
      return element.sessions.map((s) => {
        const status = getSessionStatus(s.id, s.filePath, this.activeSessionIds);
        return new SessionTreeItem(
          truncate(s.title, 70),
          formatDate(new Date(s.lastModified)),
          vscode.TreeItemCollapsibleState.Expanded,
          "session",
          s,
          undefined,
          undefined,
          status
        );
      });
    }

    return [];
  }
}

function formatDate(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) {return "just now";}
  if (diffMins < 60) {return `${diffMins}m ago`;}
  if (diffHours < 24) {return `${diffHours}h ago`;}
  if (diffDays < 7) {return `${diffDays}d ago`;}
  return date.toLocaleDateString();
}

function truncate(s: string, len: number): string {
  return s.length <= len ? s : s.slice(0, len - 1) + "\u2026";
}

export class SessionTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    description: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly itemType: "project" | "session" | "detail",
    public readonly session?: SessionInfo,
    public readonly sessions?: SessionInfo[],
    subtitle?: string,
    status?: SessionStatus
  ) {
    super(label, collapsibleState);
    this.description = description;
    this.contextValue = itemType;

    if (itemType === "session" && session) {
      const statusLabel = status ? STATUS_TOOLTIPS[status] : "";

      this.tooltip = [
        session.title,
        statusLabel ? `Status: ${statusLabel}` : "",
        `Project: ${session.projectName}`,
        `ID: ${session.id}`,
        session.cwd ? `Dir: ${session.cwd}` : "",
        session.gitBranch ? `Branch: ${session.gitBranch}` : "",
        `Messages: ${session.messageCount}`,
        `Size: ${(session.fileSize / 1024).toFixed(0)} KB`,
      ]
        .filter(Boolean)
        .join("\n");

      // Status circle icon
      if (status) {
        const iconDef = STATUS_ICONS[status];
        this.iconPath = iconDef.color
          ? new vscode.ThemeIcon(iconDef.icon, new vscode.ThemeColor(iconDef.color))
          : new vscode.ThemeIcon(iconDef.icon);
      }

      this.command = {
        command: "claudeSessions.resume",
        title: "Resume Session",
        arguments: [this],
      };
    } else if (itemType === "detail") {
      // Second line: project + message count, no icon, dimmed
      this.iconPath = new vscode.ThemeIcon("blank");
    } else {
      this.iconPath = new vscode.ThemeIcon("folder");
    }
  }
}
