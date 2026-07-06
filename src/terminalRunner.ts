import * as vscode from 'vscode';

class TerminalRunner {
  terminal?: import('vscode').Terminal;

  constructor() {
    this.terminal = undefined;
  }

  run(action: string, item: { path?: string }) {
    if (!item || !item.path) {
      throw new Error('A solution or project path is required.');
    }

    const command = `dotnet ${action} ${quoteForShell(item.path)}`;
    this.runCommand(command);
    return command;
  }

  runCommand(command: string) {
    this.getTerminal().show();
    this.getTerminal().sendText(command);
    return command;
  }

  getTerminal(): import('vscode').Terminal {
    if (!this.terminal || this.terminal.exitStatus) {
      this.terminal = vscode.window.createTerminal({
        name: 'Solution Manager'
      });
    }

    return this.terminal;
  }
}

function quoteForShell(value: string) {
  if (process.platform === 'win32') {
    return `"${value.replace(/"/g, '\\"')}"`;
  }

  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export {
  TerminalRunner,
  quoteForShell
};
