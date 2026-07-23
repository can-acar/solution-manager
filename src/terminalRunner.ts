import * as vscode from 'vscode';

class TerminalRunner {
  terminal?: import('vscode').Terminal;

  constructor() {
    this.terminal = undefined;
  }

  run(action: string, item: { path?: string }, options?: { onComplete?: (exitCode: number | undefined) => void }) {
    if (!item || !item.path) {
      throw new Error('A solution or project path is required.');
    }

    const command = `dotnet ${action} ${quoteForShell(item.path)}`;
    this.runCommand(command, options);
    return command;
  }

  runCommand(command: string, options?: { onComplete?: (exitCode: number | undefined) => void }) {
    const terminal = this.getTerminal();
    terminal.show();

    const onComplete = typeof options?.onComplete === 'function' ? options.onComplete : undefined;
    void this.dispatchCommand(terminal, command, onComplete);
    return command;
  }

  async dispatchCommand(
    terminal: import('vscode').Terminal,
    command: string,
    onComplete?: (exitCode: number | undefined) => void
  ) {
    const integration = await waitForShellIntegration(terminal);

    if (integration) {
      const execution = integration.executeCommand(command);

      if (onComplete) {
        const subscription = vscode.window.onDidEndTerminalShellExecution((event) => {
          if (event.execution === execution) {
            subscription.dispose();
            onComplete(event.exitCode);
          }
        });
      }

      return;
    }

    terminal.sendText(command);
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

function waitForShellIntegration(
  terminal: import('vscode').Terminal,
  timeoutMs = 2000
): Promise<import('vscode').TerminalShellIntegration | undefined> {
  if (terminal.shellIntegration) {
    return Promise.resolve(terminal.shellIntegration);
  }

  return new Promise((resolve) => {
    const subscription = vscode.window.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal === terminal && terminal.shellIntegration) {
        clearTimeout(timer);
        subscription.dispose();
        resolve(terminal.shellIntegration);
      }
    });

    const timer = setTimeout(() => {
      subscription.dispose();
      resolve(terminal.shellIntegration);
    }, timeoutMs);
  });
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
