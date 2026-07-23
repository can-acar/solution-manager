"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TerminalRunner = void 0;
exports.quoteForShell = quoteForShell;
exports.assertValidPackageId = assertValidPackageId;
exports.assertValidPackageVersion = assertValidPackageVersion;
exports.assertValidMigrationName = assertValidMigrationName;
const vscode = __importStar(require("vscode"));
class TerminalRunner {
    terminal;
    constructor() {
        this.terminal = undefined;
    }
    run(action, item, options) {
        if (!item || !item.path) {
            throw new Error('A solution or project path is required.');
        }
        const command = `dotnet ${action} ${quoteForShell(item.path)}`;
        this.runCommand(command, options);
        return command;
    }
    runCommand(command, options) {
        const onComplete = createOnceCompletion(typeof options?.onComplete === 'function' ? options.onComplete : undefined);
        void this.dispatchCommand(command, onComplete).catch((error) => {
            onComplete?.(undefined);
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Solution Manager: unable to run command. ${message}`);
        });
        return command;
    }
    async dispatchCommand(command, onComplete) {
        const windowWithShellIntegration = vscode.window;
        if (typeof windowWithShellIntegration.onDidChangeTerminalShellIntegration === 'function'
            && typeof windowWithShellIntegration.onDidEndTerminalShellExecution === 'function') {
            const hadReusableTerminal = Boolean(this.terminal && !this.terminal.exitStatus);
            const terminal = this.getTerminal();
            const integration = await waitForShellIntegration(terminal, windowWithShellIntegration);
            if (integration) {
                terminal.show();
                executeWithShellIntegration(integration, command, windowWithShellIntegration.onDidEndTerminalShellExecution.bind(windowWithShellIntegration), onComplete);
                return;
            }
            if (!hadReusableTerminal && this.terminal === terminal) {
                terminal.dispose();
                this.terminal = undefined;
            }
        }
        await executeAsTask(command, onComplete);
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
exports.TerminalRunner = TerminalRunner;
function executeWithShellIntegration(integration, command, onDidEndExecution, onComplete) {
    let execution;
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
    }
    catch (error) {
        subscription?.dispose();
        throw error;
    }
}
async function executeAsTask(command, onComplete) {
    const task = new vscode.Task({ type: 'solutionManager.command' }, vscode.TaskScope.Workspace, 'Command', 'Solution Manager', new vscode.ShellExecution(command));
    task.presentationOptions = {
        reveal: vscode.TaskRevealKind.Always,
        panel: vscode.TaskPanelKind.Shared,
        focus: false,
        clear: false
    };
    let taskExecution;
    let processSubscription;
    let taskSubscription;
    let taskEndTimer;
    const disposeSubscriptions = () => {
        processSubscription?.dispose();
        taskSubscription?.dispose();
        if (taskEndTimer) {
            clearTimeout(taskEndTimer);
            taskEndTimer = undefined;
        }
    };
    const isTargetExecution = (execution) => (execution === taskExecution || execution.task === task);
    const completeTask = (exitCode) => {
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
    }
    catch (error) {
        disposeSubscriptions();
        throw error;
    }
}
function createOnceCompletion(onComplete) {
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
function waitForShellIntegration(terminal, windowWithShellIntegration, timeoutMs = 2000) {
    const terminalWithShellIntegration = terminal;
    if (terminalWithShellIntegration.shellIntegration) {
        return Promise.resolve(terminalWithShellIntegration.shellIntegration);
    }
    const onDidChangeShellIntegration = windowWithShellIntegration.onDidChangeTerminalShellIntegration;
    if (typeof onDidChangeShellIntegration !== 'function') {
        return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
        let timer;
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
function quoteForShell(value) {
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
function assertValidPackageId(value) {
    if (!value || !NUGET_PACKAGE_ID_PATTERN.test(value)) {
        throw new Error(`Invalid NuGet package id: ${value}`);
    }
    return value;
}
function assertValidPackageVersion(value) {
    if (!value || !NUGET_PACKAGE_VERSION_PATTERN.test(value)) {
        throw new Error(`Invalid NuGet package version: ${value}`);
    }
    return value;
}
function assertValidMigrationName(value) {
    if (!value || !MIGRATION_NAME_PATTERN.test(value)) {
        throw new Error(`Invalid migration name: ${value}`);
    }
    return value;
}
//# sourceMappingURL=terminalRunner.js.map