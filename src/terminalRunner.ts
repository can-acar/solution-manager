import * as vscode from 'vscode';

type CommandCompletion = (exitCode: number | undefined) => void;

type TerminalShellExecutionLike = object;

type TerminalShellIntegrationLike = {
  executeCommand(command: string): TerminalShellExecutionLike;
};

type TerminalWithShellIntegration = vscode.Terminal & {
  readonly shellIntegration?: TerminalShellIntegrationLike;
};

type TerminalShellIntegrationChangeEventLike = {
  readonly terminal: vscode.Terminal;
};

type TerminalShellExecutionEndEventLike = {
  readonly execution: TerminalShellExecutionLike;
  readonly exitCode: number | undefined;
};

type WindowWithShellIntegration = typeof vscode.window & {
  onDidChangeTerminalShellIntegration?: (
    listener: (event: TerminalShellIntegrationChangeEventLike) => unknown
  ) => vscode.Disposable;
  onDidEndTerminalShellExecution?: (
    listener: (event: TerminalShellExecutionEndEventLike) => unknown
  ) => vscode.Disposable;
};

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
    const onComplete = createOnceCompletion(
      typeof options?.onComplete === 'function' ? options.onComplete : undefined
    );

    void this.dispatchCommand(command, onComplete).catch((error) => {
      onComplete?.(undefined);
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Solution Manager: unable to run command. ${message}`);
    });

    return command;
  }

  async dispatchCommand(
    command: string,
    onComplete?: CommandCompletion
  ): Promise<void> {
    const windowWithShellIntegration = vscode.window as WindowWithShellIntegration;

    if (
      typeof windowWithShellIntegration.onDidChangeTerminalShellIntegration === 'function'
      && typeof windowWithShellIntegration.onDidEndTerminalShellExecution === 'function'
    ) {
      const hadReusableTerminal = Boolean(this.terminal && !this.terminal.exitStatus);
      const terminal = this.getTerminal();
      const integration = await waitForShellIntegration(terminal, windowWithShellIntegration);

      if (integration) {
        terminal.show();
        executeWithShellIntegration(
          integration,
          command,
          windowWithShellIntegration.onDidEndTerminalShellExecution.bind(windowWithShellIntegration),
          onComplete
        );
        return;
      }

      if (!hadReusableTerminal && this.terminal === terminal) {
        terminal.dispose();
        this.terminal = undefined;
      }
    }

    await executeAsTask(command, onComplete);
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

function executeWithShellIntegration(
  integration: TerminalShellIntegrationLike,
  command: string,
  onDidEndExecution: (
    listener: (event: TerminalShellExecutionEndEventLike) => unknown
  ) => vscode.Disposable,
  onComplete?: CommandCompletion
): void {
  let execution: TerminalShellExecutionLike | undefined;
  const subscription = onComplete
    ? onDidEndExecution((event) => {
      if (execution && event.execution === execution) {
        subscription?.dispose();
        onComplete(event.exitCode);
      }
    })
    : undefined;

  try {
    execution = integration.executeCommand(command);
  } catch (error) {
    subscription?.dispose();
    throw error;
  }
}

async function executeAsTask(command: string, onComplete?: CommandCompletion): Promise<void> {
  const task = new vscode.Task(
    { type: 'solutionManager.command' },
    vscode.TaskScope.Workspace,
    'Command',
    'Solution Manager',
    new vscode.ShellExecution(command)
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Shared,
    focus: false,
    clear: false
  };

  let taskExecution: vscode.TaskExecution | undefined;
  let processSubscription: vscode.Disposable | undefined;
  let taskSubscription: vscode.Disposable | undefined;
  let taskEndTimer: NodeJS.Timeout | undefined;

  const disposeSubscriptions = () => {
    processSubscription?.dispose();
    taskSubscription?.dispose();

    if (taskEndTimer) {
      clearTimeout(taskEndTimer);
      taskEndTimer = undefined;
    }
  };
  const isTargetExecution = (execution: vscode.TaskExecution) => (
    execution === taskExecution || execution.task === task
  );
  const completeTask = (exitCode: number | undefined) => {
    disposeSubscriptions();
    onComplete?.(exitCode);
  };

  if (onComplete) {
    processSubscription = vscode.tasks.onDidEndTaskProcess((event) => {
      if (isTargetExecution(event.execution)) {
        completeTask(event.exitCode);
      }
    });
    taskSubscription = vscode.tasks.onDidEndTask((event) => {
      if (isTargetExecution(event.execution)) {
        taskEndTimer = setTimeout(() => completeTask(undefined), 0);
      }
    });
  }

  try {
    taskExecution = await vscode.tasks.executeTask(task);
  } catch (error) {
    disposeSubscriptions();
    throw error;
  }
}

function createOnceCompletion(onComplete?: CommandCompletion): CommandCompletion | undefined {
  if (!onComplete) {
    return undefined;
  }

  let completed = false;

  return (exitCode) => {
    if (completed) {
      return;
    }

    completed = true;
    onComplete(exitCode);
  };
}

function waitForShellIntegration(
  terminal: import('vscode').Terminal,
  windowWithShellIntegration: WindowWithShellIntegration,
  timeoutMs = 2000
): Promise<TerminalShellIntegrationLike | undefined> {
  const terminalWithShellIntegration = terminal as TerminalWithShellIntegration;

  if (terminalWithShellIntegration.shellIntegration) {
    return Promise.resolve(terminalWithShellIntegration.shellIntegration);
  }

  const onDidChangeShellIntegration = windowWithShellIntegration.onDidChangeTerminalShellIntegration;

  if (typeof onDidChangeShellIntegration !== 'function') {
    return Promise.resolve(undefined);
  }

  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const subscription = onDidChangeShellIntegration.call(windowWithShellIntegration, (event) => {
      if (event.terminal === terminal && terminalWithShellIntegration.shellIntegration) {
        if (timer) {
          clearTimeout(timer);
        }
        subscription.dispose();
        resolve(terminalWithShellIntegration.shellIntegration);
      }
    });

    timer = setTimeout(() => {
      subscription.dispose();
      resolve(terminalWithShellIntegration.shellIntegration);
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
