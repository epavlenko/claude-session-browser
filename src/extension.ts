import * as vscode from "vscode";
import { SessionWebviewProvider } from "./webviewProvider";

export function activate(context: vscode.ExtensionContext) {
  const provider = new SessionWebviewProvider(context.extensionUri, context);

  // Set initial context
  vscode.commands.executeCommand("setContext", "claudeSessions.viewMode", "all");

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SessionWebviewProvider.viewType,
      provider
    ),

    vscode.commands.registerCommand("claudeSessions.refresh", () => {
      provider.refresh();
    }),

    vscode.commands.registerCommand("claudeSessions.toggleViewMode", () => {
      const mode = provider.cycleViewMode();
      vscode.commands.executeCommand("setContext", "claudeSessions.viewMode", provider.viewMode);
    }),

    vscode.commands.registerCommand("claudeSessions.toggleExpandCollapse", () => {
      provider.toggleExpandCollapse();
    })
  );

  // Restore terminals from previous session
  provider.restoreTerminals();
}

export function deactivate() {}
