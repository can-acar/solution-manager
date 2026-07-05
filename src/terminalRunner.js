const vscode = require('vscode');

class TerminalRunner {
  constructor() {
    this.terminal = undefined;
  }

  run(action, item) {
    if (!item || !item.path) {
      throw new Error('A solution or project path is required.');
    }

    const command = `dotnet ${action} ${quoteForShell(item.path)}`;
    this.runCommand(command);
    return command;
  }

  runCommand(command) {
    this.getTerminal().show();
    this.getTerminal().sendText(command);
    return command;
  }

  getTerminal() {
    if (!this.terminal || this.terminal.exitStatus) {
      this.terminal = vscode.window.createTerminal({
        name: 'Solution Manager'
      });
    }

    return this.terminal;
  }
}

function quoteForShell(value) {
  if (process.platform === 'win32') {
    return `"${value.replace(/"/g, '\\"')}"`;
  }

  return `'${value.replace(/'/g, `'\\''`)}'`;
}

module.exports = {
  TerminalRunner,
  quoteForShell
};
