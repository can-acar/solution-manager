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
exports.TerminalRunner = TerminalRunner;
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
