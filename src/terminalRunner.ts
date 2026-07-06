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
    if (/[`"$%\r\n]/.test(value)) {
      throw new Error('Value contains characters that cannot be safely used in a terminal command.');
    }

    return `"${value}"`;
  }

  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const NUGET_PACKAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NUGET_PACKAGE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.\-+*\[\]() ,]*$/;
const MIGRATION_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertValidPackageId(value: string) {
  if (!value || !NUGET_PACKAGE_ID_PATTERN.test(value)) {
    throw new Error(`Invalid NuGet package id: ${value}`);
  }

  return value;
}

function assertValidPackageVersion(value: string) {
  if (!value || !NUGET_PACKAGE_VERSION_PATTERN.test(value)) {
    throw new Error(`Invalid NuGet package version: ${value}`);
  }

  return value;
}

function assertValidMigrationName(value: string) {
  if (!value || !MIGRATION_NAME_PATTERN.test(value)) {
    throw new Error(`Invalid migration name: ${value}`);
  }

  return value;
}

export {
  TerminalRunner,
  quoteForShell,
  assertValidPackageId,
  assertValidPackageVersion,
  assertValidMigrationName
};
