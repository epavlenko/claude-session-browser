import * as vscode from "vscode";
import { fetchAllSessions, SessionInfo, encodeProjectPath, renameSession, deleteSession, searchSessionContent } from "./sessionReader";
import { getActiveSessionIds, getSessionStatus, SessionStatus } from "./sessionStatus";

type ViewMode = "all" | "byProject" | "currentProject";
const VIEW_MODES: ViewMode[] = ["all", "byProject", "currentProject"];
const VIEW_MODE_LABELS: Record<ViewMode, string> = {
  all: "All Sessions",
  byProject: "By Project",
  currentProject: "Current Project",
};

type SessionWithMeta = SessionInfo & { status: SessionStatus; age: string; ageOpacity: number; timeBucket: string; isActive: boolean };

export class SessionWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "claudeSessionList";

  private _view?: vscode.WebviewView;
  private _sessions: SessionInfo[] = [];
  private _viewMode: ViewMode = "all";
  private _activeIds = new Set<string>();
  private _activeTerminalSessionId?: string;
  private _searchQuery = "";
  private _filterProject = "";
  private _refreshInterval?: ReturnType<typeof setInterval>;
  private _initialRenderDone = false;

  private static readonly OPEN_SESSIONS_KEY = "claudeSessions.openTerminals";

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext
  ) {
    // Track which terminal is active to highlight current session
    vscode.window.onDidChangeActiveTerminal((terminal) => {
      const prev = this._activeTerminalSessionId;
      this._activeTerminalSessionId = undefined;
      if (terminal) {
        // Find session ID from our map
        for (const [sid, term] of this._terminalSessionMap) {
          if (term === terminal) {
            this._activeTerminalSessionId = sid;
            break;
          }
        }
      }
      if (prev !== this._activeTerminalSessionId) {this.updateWebview();}
    });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    this._initialRenderDone = false;

    // Re-render when webview becomes visible again
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._initialRenderDone = false;
        this.refresh();
      }
    });

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "resume": this.resumeSession(msg.id); break;
        case "rename": this.handleRename(msg.id, msg.newName); break;
        case "delete": this.deleteSessionPrompt(msg.id); break;
        case "search": this.handleSearch(msg.query); break;
        case "newSession": this.newSession(); break;
        case "filterProject":
          this._filterProject = msg.project || "";
          this._initialRenderDone = true;  // incremental to preserve focus
          this.updateWebview();
          break;
        case "copyId":
          vscode.env.clipboard.writeText(msg.id);
          vscode.window.showInformationMessage(`Copied: ${msg.id}`);
          break;
      }
    });

    this.refresh();
    this._refreshInterval = setInterval(() => this.refresh(), 30000);
    webviewView.onDidDispose(() => {
      if (this._refreshInterval) {clearInterval(this._refreshInterval);}
    });
  }

  async refresh() {
    this._activeIds = getActiveSessionIds();
    this._sessions = await fetchAllSessions();
    this._initialRenderDone = false;  // force full re-render
    this.updateWebview();
  }

  get viewMode(): ViewMode {
    return this._viewMode;
  }

  sendToWebview(msg: any) {
    this._view?.webview.postMessage(msg);
  }

  cycleViewMode() {
    const idx = VIEW_MODES.indexOf(this._viewMode);
    this._viewMode = VIEW_MODES[(idx + 1) % VIEW_MODES.length];
    this._initialRenderDone = false; // force full re-render on mode change
    this.updateWebview();
    return VIEW_MODE_LABELS[this._viewMode];
  }

  private _allExpanded = false;
  toggleExpandCollapse() {
    this._allExpanded = !this._allExpanded;
    this.sendToWebview({ type: this._allExpanded ? "expandAll" : "collapseAll" });
  }

  private newSession() {
    const folders = vscode.workspace.workspaceFolders;
    const cwd = folders?.[0]?.uri.fsPath;
    const terminal = vscode.window.createTerminal({
      name: "Claude: new",
      cwd,
      location: vscode.TerminalLocation.Editor,
    });
    terminal.show();
    terminal.sendText("claude");
  }

  // Map session ID → terminal for dedup
  private _terminalSessionMap = new Map<string, vscode.Terminal>();

  private _restoring = false;

  /** Save list of open session IDs to workspaceState */
  private saveOpenSessions() {
    if (this._restoring) {return;}  // Don't overwrite during restore
    const openIds = [...this._terminalSessionMap.keys()];
    this._context.workspaceState.update(SessionWebviewProvider.OPEN_SESSIONS_KEY, openIds);
  }

  /** Register close handler for a terminal */
  private trackTerminalClose(id: string, terminal: vscode.Terminal) {
    const disposable = vscode.window.onDidCloseTerminal((t) => {
      if (t === terminal) {
        this._terminalSessionMap.delete(id);
        this.saveOpenSessions();
        if (this._activeTerminalSessionId === id) {
          this._activeTerminalSessionId = undefined;
          this.updateWebview();
        }
        disposable.dispose();
      }
    });
  }

  /** Restore terminals from previous session.
   *  Strategy: Cursor restores editor terminals as empty shells on the same positions.
   *  We find them by name and re-send claude --resume.
   *  If a terminal isn't found (Cursor didn't restore it), we create a new one.
   */
  async restoreTerminals() {
    const savedIds: string[] = this._context.workspaceState.get(SessionWebviewProvider.OPEN_SESSIONS_KEY, []);
    if (savedIds.length === 0) {return;}

    this._restoring = true;

    // Load sessions if not yet loaded
    if (this._sessions.length === 0) {
      this._sessions = await fetchAllSessions();
    }

    // Wait a bit for Cursor to finish restoring its terminals
    await new Promise((r) => setTimeout(r, 1500));

    const existingTerminals = vscode.window.terminals;

    for (const id of savedIds) {
      const session = this._sessions.find((s) => s.id === id);
      if (!session) {continue;}

      const title = session.title.slice(0, 40).replace(/[^\w\s\u0400-\u04FF.-]/g, "").trim();
      const termName = `Claude: ${title || id.slice(0, 8)}`;

      // Try to find existing terminal restored by Cursor (by name match)
      let terminal = existingTerminals.find((t) =>
        t.name === termName || t.name.startsWith("Claude: " + title.slice(0, 15))
      );

      if (terminal) {
        // Cursor restored this terminal — just re-send claude command
        terminal.sendText(`claude --resume ${id}`);
      } else {
        // Not found — create new terminal
        terminal = vscode.window.createTerminal({
          name: termName,
          cwd: session.cwd,
          location: vscode.TerminalLocation.Editor,
        });
        terminal.sendText(`claude --resume ${id}`);
      }

      this._terminalSessionMap.set(id, terminal);
      this.trackTerminalClose(id, terminal);

      await new Promise((r) => setTimeout(r, 300));
    }

    this._restoring = false;
    this.saveOpenSessions();
  }

  private resumeSession(id: string) {
    const session = this._sessions.find((s) => s.id === id);
    if (!session) {return;}

    // Check if terminal already exists for this session
    const existing = this._terminalSessionMap.get(id);
    if (existing) {
      // Verify terminal is still alive
      if (vscode.window.terminals.includes(existing)) {
        existing.show();
        this._activeTerminalSessionId = id;
        this.updateWebview();
        return;
      }
      this._terminalSessionMap.delete(id);
    }

    const title = session.title.slice(0, 40).replace(/[^\w\s\u0400-\u04FF.-]/g, "").trim();
    const termName = `Claude: ${title || id.slice(0, 8)}`;
    const terminal = vscode.window.createTerminal({
      name: termName,
      cwd: session.cwd,
      location: vscode.TerminalLocation.Editor,
    });
    terminal.show();
    terminal.sendText(`claude --resume ${id}`);
    this._terminalSessionMap.set(id, terminal);
    this._activeTerminalSessionId = id;
    this.saveOpenSessions();
    this.trackTerminalClose(id, terminal);
    this.updateWebview();
  }

  private async handleRename(id: string, newName?: string) {
    const session = this._sessions.find((s) => s.id === id);
    if (!session || !newName || newName === session.title) {return;}
    await renameSession(session.filePath, session.id, newName);

    // If terminal is open, close old and re-map (VS Code can't rename terminals)
    const existingTerminal = this._terminalSessionMap.get(id);
    if (existingTerminal && vscode.window.terminals.includes(existingTerminal)) {
      // Store the fact that this terminal needs a new name on next resume
      this._terminalSessionMap.delete(id);
      // Don't kill the terminal — just forget it so next click creates one with new name
    }

    this.refresh();
  }

  private async deleteSessionPrompt(id: string) {
    const session = this._sessions.find((s) => s.id === id);
    if (!session) {return;}
    const confirm = await vscode.window.showWarningMessage(
      `Delete session "${session.title}"?`, { modal: true }, "Delete"
    );
    if (confirm === "Delete") {
      await deleteSession(session.filePath, session.id);
      this.refresh();
    }
  }

  private async handleSearch(query: string) {
    this._searchQuery = query;
    this._initialRenderDone = true;  // keep incremental to preserve search focus
    if (!query.trim()) {
      this.updateWebview();
      return;
    }

    // First filter by title
    const q = query.toLowerCase();
    const titleMatches = new Set(
      this._sessions.filter((s) => s.title.toLowerCase().includes(q)).map((s) => s.id)
    );

    // Then search content for non-title matches (in parallel, limit to avoid lag)
    const nonTitleSessions = this._sessions.filter((s) => !titleMatches.has(s.id));
    const contentResults = await Promise.all(
      nonTitleSessions.slice(0, 50).map(async (s) => ({
        id: s.id,
        match: await searchSessionContent(s.filePath, q),
      }))
    );
    const contentMatches = new Set(contentResults.filter((r) => r.match).map((r) => r.id));

    const matchIds = new Set([...titleMatches, ...contentMatches]);
    this.updateWebview(matchIds);
  }

  private updateWebview(filterIds?: Set<string>) {
    if (!this._view) {return;}

    let filtered = this._sessions;
    if (this._viewMode === "currentProject") {
      const folders = vscode.workspace.workspaceFolders;
      if (folders && folders.length > 0) {
        const encoded = encodeProjectPath(folders[0].uri.fsPath);
        filtered = filtered.filter((s) => s.projectDir === encoded);
      } else {
        filtered = [];
      }
    }

    if (filterIds) {
      filtered = filtered.filter((s) => filterIds.has(s.id));
    }

    // Project filter (All Sessions mode)
    if (this._filterProject && this._viewMode === "all") {
      filtered = filtered.filter((s) => s.projectName === this._filterProject);
    }

    const sessions: SessionWithMeta[] = filtered.map((s) => ({
      ...s,
      status: getSessionStatus(s.id, s.filePath, this._activeIds),
      age: formatAge(s.lastModified),
      ageOpacity: ageToOpacity(s.lastModified),
      timeBucket: getTimeBucket(s.lastModified),
      isActive: s.id === this._activeTerminalSessionId,
    }));

    // Collect unique project names for filter dropdown
    const projectNames = [...new Set(this._sessions.map((s) => s.projectName))].sort();

    // If already rendered, update only session list via postMessage (preserves search focus)
    if (this._initialRenderDone) {
      const body = this.renderSessionList(sessions);
      this._view.webview.postMessage({
        type: "updateList",
        html: body,
        projects: projectNames,
        filterProject: this._filterProject,
        viewMode: this._viewMode,
      });
    } else {
      this._view.webview.html = this.renderHtml(sessions, projectNames);
      this._initialRenderDone = true;
    }
    this._view.description = VIEW_MODE_LABELS[this._viewMode];
  }

  private renderSessionList(sessions: SessionWithMeta[]): string {
    if (sessions.length === 0) {return '<div class="empty">No sessions found</div>';}

    if (this._viewMode === "byProject") {
      const groups = new Map<string, SessionWithMeta[]>();
      for (const s of sessions) {
        if (!groups.has(s.projectName)) {groups.set(s.projectName, []);}
        groups.get(s.projectName)!.push(s);
      }
      const PAGE_SIZE = 5;
      return Array.from(groups.entries())
        .map(([name, items]) => {
          const groupId = esc(name).replace(/[^a-zA-Z0-9]/g, "_");
          const total = items.length;
          const visible = items.slice(0, PAGE_SIZE);
          const hidden = items.slice(PAGE_SIZE);
          return `<div class="project-group" data-group="${groupId}">
            <div class="group-header collapsible" data-group="${groupId}">
              <span class="chevron">&#9654;</span> ${esc(name)} <span class="group-count">${total}</span>
            </div>
            <div class="group-body collapsed" data-group-body="${groupId}">
              ${visible.map(renderSession).join("")}
              ${hidden.length > 0 ? `
                <div class="hidden-sessions" data-group-hidden="${groupId}" style="display:none">
                  ${hidden.map(renderSession).join("")}
                </div>
                <button class="load-more-btn" data-group-more="${groupId}">Show more (${hidden.length})</button>
              ` : ""}
            </div>
          </div>`;
        }).join("");
    }

    const buckets = new Map<string, SessionWithMeta[]>();
    for (const s of sessions) {
      if (!buckets.has(s.timeBucket)) {buckets.set(s.timeBucket, []);}
      buckets.get(s.timeBucket)!.push(s);
    }
    return Array.from(buckets.entries())
      .map(([bucket, items]) =>
        `<div class="group-header">${esc(bucket)}</div>` +
        items.map(renderSession).join("")
      ).join("");
  }

  private renderHtml(sessions: SessionWithMeta[], projectNames: string[] = []): string {
    const body = this.renderSessionList(sessions);
    const projectOptions = projectNames.map((p) =>
      `<option value="${esc(p)}" ${p === this._filterProject ? "selected" : ""}>${esc(p)}</option>`
    ).join("");
    const showProjectFilter = this._viewMode === "all";

    return `<!DOCTYPE html>
<html>
<head>
<style>
  * { box-sizing: border-box; }
  body {
    padding: 0;
    margin: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-chat-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
  }
  .search-bar {
    display: flex;
    padding: 4px 8px;
    gap: 4px;
    align-items: center;
    border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
    position: sticky;
    top: 0;
    background: var(--vscode-sideBar-background);
    z-index: 10;
  }
  .search-input {
    flex: 1;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
    padding: 3px 8px;
    font-size: 0.9em;
    font-family: inherit;
    outline: none;
  }
  .search-input:focus {
    border-color: var(--vscode-focusBorder);
  }
  .search-input::placeholder {
    color: var(--vscode-input-placeholderForeground);
  }
  .project-filter {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
    padding: 3px 4px;
    font-size: 0.85em;
    font-family: inherit;
    outline: none;
    max-width: 120px;
  }
  .project-filter:focus {
    border-color: var(--vscode-focusBorder);
  }
  .new-btn {
    background: none;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    font-size: 16px;
    padding: 2px 6px;
    border-radius: 4px;
    line-height: 1;
    flex-shrink: 0;
  }
  .new-btn:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }
  .session {
    display: flex;
    padding: 4px 8px;
    cursor: pointer;
    border-radius: 6px;
    align-items: center;
    gap: 8px;
    margin: 1px 0;
  }
  .session:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .session.active {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  .session.active .title {
    color: var(--vscode-list-activeSelectionForeground);
    font-weight: 600;
  }
  .session.active .subtext,
  .session.active .age,
  .session.active .action-btn {
    color: var(--vscode-list-activeSelectionForeground);
    opacity: 0.8;
  }
  .status-bar {
    width: 9px;
    min-width: 9px;
    align-self: stretch;
    border-radius: 2px;
    flex-shrink: 0;
  }
  .session-content {
    display: flex;
    flex-direction: column;
    flex: 1;
    gap: 2px;
    min-width: 0;
  }
  .session-row {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .title {
    color: var(--vscode-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    font-size: 1em;
  }
  .title.editing {
    outline: 1px solid var(--vscode-focusBorder);
    border-radius: 3px;
    padding: 0 2px;
    cursor: text;
    overflow: visible;
    text-overflow: unset;
  }
  .actions {
    display: flex;
    gap: 1px;
    flex-shrink: 0;
  }
  .action-btn {
    background: none;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    font-size: 13px;
    padding: 2px 4px;
    border-radius: 4px;
    line-height: 1;
    opacity: 0.7;
  }
  .action-btn:hover {
    background: var(--vscode-toolbar-hoverBackground);
    color: var(--vscode-foreground);
    opacity: 1;
  }
  .action-btn.danger:hover {
    color: var(--vscode-errorForeground);
  }
  .age {
    opacity: 0.7;
    flex-shrink: 0;
    margin-left: auto;
    font-size: 0.9em;
    color: var(--vscode-descriptionForeground);
  }
  .subtext {
    color: var(--vscode-descriptionForeground);
    opacity: 0.7;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.85em;
  }
  .group-header {
    padding: 8px 8px 4px;
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
    opacity: 0.8;
  }
  .group-header.collapsible {
    cursor: pointer;
    user-select: none;
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 1em;
    font-weight: 600;
    opacity: 1;
    padding: 10px 8px 4px;
  }
  .group-header.collapsible:hover {
    opacity: 1;
  }
  .chevron {
    font-size: 0.7em;
    transition: transform 0.15s;
    display: inline-block;
  }
  .group-header.expanded .chevron {
    transform: rotate(90deg);
  }
  .group-body.collapsed {
    display: none;
  }
  .group-count {
    opacity: 0.6;
  }
  .load-more-btn {
    background: none;
    border: none;
    color: var(--vscode-textLink-foreground, #3794ff);
    cursor: pointer;
    font-size: 0.85em;
    padding: 4px 8px 4px 24px;
    font-family: inherit;
    opacity: 0.8;
  }
  .load-more-btn:hover {
    opacity: 1;
    text-decoration: underline;
  }
  .empty {
    padding: 20px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
  }
</style>
</head>
<body>
  <div class="search-bar">
    <input class="search-input" type="text" placeholder="Search sessions..." value="${esc(this._searchQuery)}" />
    <select class="project-filter" id="project-filter" style="${showProjectFilter ? "" : "display:none"}">
      <option value="">All projects</option>
      ${projectOptions}
    </select>
    <button class="new-btn" title="New Session">+</button>
  </div>
  <div id="session-list">${body}</div>
  <script>
    const vscode = acquireVsCodeApi();
    const listContainer = document.getElementById('session-list');

    const projectFilter = document.getElementById('project-filter');

    // Listen for list updates from extension (preserves search focus)
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'updateList') {
        listContainer.innerHTML = msg.html;
        // Update project filter dropdown
        if (msg.projects && projectFilter) {
          const current = projectFilter.value;
          projectFilter.innerHTML = '<option value="">All projects</option>' +
            msg.projects.map(p => '<option value="' + p + '"' + (p === (msg.filterProject || '') ? ' selected' : '') + '>' + p + '</option>').join('');
          projectFilter.style.display = msg.viewMode === 'all' ? '' : 'none';
        }
      }
      if (msg.type === 'expandAll') {
        document.querySelectorAll('.group-body.collapsed').forEach(b => b.classList.remove('collapsed'));
        document.querySelectorAll('.group-header.collapsible').forEach(h => h.classList.add('expanded'));
      }
      if (msg.type === 'collapseAll') {
        document.querySelectorAll('.group-body').forEach(b => b.classList.add('collapsed'));
        document.querySelectorAll('.group-header.collapsible').forEach(h => h.classList.remove('expanded'));
      }
    });

    let searchTimeout;
    const searchInput = document.querySelector('.search-input');
    searchInput.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        vscode.postMessage({ type: 'search', query: e.target.value });
      }, 300);
    });

    document.querySelector('.new-btn').addEventListener('click', () => {
      vscode.postMessage({ type: 'newSession' });
    });

    projectFilter.addEventListener('change', (e) => {
      vscode.postMessage({ type: 'filterProject', project: e.target.value });
    });

    let isEditing = false;

    document.addEventListener('click', (e) => {
      // Collapse/expand project group
      const header = e.target.closest('.group-header.collapsible');
      if (header) {
        const groupId = header.dataset.group;
        const body = document.querySelector('[data-group-body="' + groupId + '"]');
        if (body) {
          body.classList.toggle('collapsed');
          header.classList.toggle('expanded');
        }
        return;
      }

      // Load more sessions
      const loadMore = e.target.closest('.load-more-btn');
      if (loadMore) {
        const groupId = loadMore.dataset.groupMore;
        const hidden = document.querySelector('[data-group-hidden="' + groupId + '"]');
        if (hidden) {
          // Show next 5
          const items = hidden.querySelectorAll('.session');
          let shown = 0;
          for (const item of items) {
            if (item.parentElement === hidden && !item.dataset.shown) {
              item.dataset.shown = '1';
              hidden.parentElement.insertBefore(item, loadMore);
              shown++;
              if (shown >= 5) break;
            }
          }
          // If no more hidden items, remove button
          if (hidden.querySelectorAll('.session:not([data-shown])').length === 0) {
            loadMore.remove();
            hidden.remove();
          } else {
            const remaining = hidden.querySelectorAll('.session:not([data-shown])').length;
            loadMore.textContent = 'Show more (' + remaining + ')';
          }
        }
        return;
      }

      // Expand/Collapse All
      const expandAll = e.target.closest('#expand-all');
      if (expandAll) {
        document.querySelectorAll('.group-body.collapsed').forEach(b => b.classList.remove('collapsed'));
        document.querySelectorAll('.group-header.collapsible').forEach(h => h.classList.add('expanded'));
        return;
      }
      const collapseAll = e.target.closest('#collapse-all');
      if (collapseAll) {
        document.querySelectorAll('.group-body').forEach(b => b.classList.add('collapsed'));
        document.querySelectorAll('.group-header.collapsible').forEach(h => h.classList.remove('expanded'));
        return;
      }

      const btn = e.target.closest('.action-btn');
      if (btn) {
        e.stopPropagation();
        const action = btn.dataset.action;
        const id = btn.dataset.id;

        if (action === 'rename') {
          // Inline rename: make title editable
          const session = btn.closest('.session');
          const titleEl = session.querySelector('.title');
          if (!titleEl || titleEl.contentEditable === 'true') return;

          const originalText = titleEl.textContent;
          isEditing = true;
          titleEl.contentEditable = 'true';
          titleEl.classList.add('editing');
          titleEl.focus();

          // Select all text
          const range = document.createRange();
          range.selectNodeContents(titleEl);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);

          const finishEdit = () => {
            titleEl.contentEditable = 'false';
            titleEl.classList.remove('editing');
            const newName = titleEl.textContent.trim();
            if (newName && newName !== originalText) {
              vscode.postMessage({ type: 'rename', id: id, newName: newName });
            } else {
              titleEl.textContent = originalText;
            }
            // Delay clearing flag so click event from blur doesn't trigger resume
            setTimeout(() => { isEditing = false; }, 200);
          };

          titleEl.addEventListener('keydown', (ke) => {
            if (ke.key === 'Enter') { ke.preventDefault(); titleEl.blur(); }
            if (ke.key === 'Escape') { titleEl.textContent = originalText; titleEl.blur(); }
          }, { once: false });
          titleEl.addEventListener('blur', finishEdit, { once: true });
          return;
        }

        vscode.postMessage({ type: action, id: id });
        return;
      }
      const session = e.target.closest('.session');
      if (session && !isEditing) {
        vscode.postMessage({ type: 'resume', id: session.dataset.id });
      }
    });
  </script>
</body>
</html>`;
  }
}

function renderSession(s: SessionWithMeta): string {
  const statusColor: Record<SessionStatus, string> = {
    closed: "transparent",
    open: "var(--vscode-disabledForeground)",
    active: "var(--vscode-charts-blue, #3794ff)",
    awaiting_review: "var(--vscode-charts-green, #89d185)",
  };
  const statusBorder = s.status === "closed" ? "border: 1px solid var(--vscode-disabledForeground); background: transparent;" : "";
  const statusTitle: Record<SessionStatus, string> = {
    closed: "Closed", open: "Open", active: "Agent working", awaiting_review: "Awaiting review",
  };
  const msgs = s.messageCount > 0 ? `${s.messageCount} messages` : "";
  const detail = [s.projectName, msgs].filter(Boolean).join(" \u00b7 ");
  const activeClass = s.isActive ? " active" : "";

  return `
    <div class="session${activeClass}" data-id="${s.id}">
      <span class="status-bar" title="${statusTitle[s.status]}" style="background:${statusColor[s.status]};${statusBorder}"></span>
      <div class="session-content">
        <div class="session-row">
          <span class="title" title="${esc(s.title)}">${esc(truncate(s.title, 65))}</span>
          <span class="actions">
            <button class="action-btn" title="Rename" data-action="rename" data-id="${s.id}">&#9998;</button>
            <button class="action-btn danger" title="Delete" data-action="delete" data-id="${s.id}">&times;</button>
          </span>
          <span class="age" style="opacity:${s.ageOpacity}">${s.age}</span>
        </div>
        <div class="subtext">${esc(detail)}</div>
      </div>
    </div>`;
}

function formatAge(lastModified: number): string {
  const diffMs = Date.now() - lastModified;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) {return "now";}
  if (diffMins < 60) {return `${diffMins}m`;}
  if (diffHours < 24) {return `${diffHours}h`;}
  if (diffDays < 30) {return `${diffDays}d`;}
  return new Date(lastModified).toLocaleDateString();
}

function getTimeBucket(lastModified: number): string {
  const now = new Date();
  const date = new Date(lastModified);

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayOfWeek = startOfToday.getDay() || 7;
  const startOfThisWeek = new Date(startOfToday.getTime() - (dayOfWeek - 1) * 86400000);
  const startOfLastWeek = new Date(startOfThisWeek.getTime() - 7 * 86400000);
  const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  if (date >= startOfToday) {return "Today";}
  if (date >= startOfThisWeek) {return "This Week";}
  if (date >= startOfLastWeek) {return "Last Week";}
  if (date >= startOfThisMonth) {return "This Month";}
  if (date >= startOfLastMonth) {return "Last Month";}
  return "Earlier";
}

function ageToOpacity(lastModified: number): number {
  const hoursAgo = (Date.now() - lastModified) / 3600000;
  if (hoursAgo < 1) {return 1.0;}
  if (hoursAgo < 24) {return 0.85;}
  if (hoursAgo < 72) {return 0.7;}
  if (hoursAgo < 168) {return 0.55;}
  return 0.4;
}

function truncate(s: string, len: number): string {
  return s.length <= len ? s : s.slice(0, len - 1) + "\u2026";
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
