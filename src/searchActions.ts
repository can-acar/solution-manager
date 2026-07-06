import * as vscode from 'vscode';

function toSearchScope(folderPath: string): string {
  const relative = vscode.workspace.asRelativePath(folderPath, false);

  if (!relative || relative === folderPath) {
    return '';
  }

  return `${relative.replace(/\\/g, '/').replace(/\/+$/, '')}/`;
}

async function openScopedFindInFiles(folderPath: string, replace: boolean): Promise<void> {
  const args: Record<string, unknown> = {
    filesToInclude: toSearchScope(folderPath),
    triggerSearch: false
  };

  if (replace) {
    args.replace = '';
  }

  await vscode.commands.executeCommand('workbench.action.findInFiles', args);
}

async function openScopedQuickOpen(folderPath: string): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.quickOpen', toSearchScope(folderPath));
}

export {
  openScopedFindInFiles,
  openScopedQuickOpen
};
