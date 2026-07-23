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
        const terminal = this.getTerminal();
        terminal.show();
        const onComplete = typeof options?.onComplete === 'function' ? options.onComplete : undefined;
        void this.dispatchCommand(terminal, command, onComplete);
        return command;
    }
    async dispatchCommand(terminal, command, onComplete) {
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
function waitForShellIntegration(terminal, timeoutMs = 2000) {
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