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
exports.FileExplorerActions = void 0;
// @ts-nocheck
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const DRAG_MIME_TYPE = 'application/vnd.code.tree.solutionmanager';
const CLIPBOARD_CONTEXT_KEY = 'solutionManager.hasClipboard';
class FileExplorerActions {
    constructor(refresh) {
        this.refresh = refresh;
        this.clipboard = null;
    }
    async rename(node) {
        const uri = nodeUri(node);
        if (!uri) {
            return;
        }
        const oldName = path.basename(uri.fsPath);
        const newName = await vscode.window.showInputBox({
            title: 'Rename',
            value: oldName,
            valueSelection: [0, path.basename(oldName, path.extname(oldName)).length],
            validateInput: validateFileName
        });
        if (!newName || newName.trim() === oldName) {
            return;
        }
        const target = vscode.Uri.file(path.join(path.dirname(uri.fsPath), newName.trim()));
        if (await pathExists(target)) {
            throw new Error(`A file or folder named '${newName.trim()}' already exists.`);
        }
        await vscode.workspace.fs.rename(uri, target, { overwrite: false });
        await this.refresh();
    }
    async delete(nodes) {
        const uris = toUris(nodes);
        if (uris.length === 0) {
            return;
        }
        const label = uris.length === 1
            ? `'${path.basename(uris[0].fsPath)}'`
            : `${uris.length} items`;
        const confirmation = await vscode.window.showWarningMessage(`Are you sure you want to delete ${label}? It will be moved to the trash.`, { modal: true }, 'Move to Trash');
        if (confirmation !== 'Move to Trash') {
            return;
        }
        for (const uri of uris) {
            await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
        }
        await this.refresh();
    }
    cut(nodes) {
        this.setClipboard(toUris(nodes), 'cut');
    }
    copy(nodes) {
        this.setClipboard(toUris(nodes), 'copy');
    }
    async paste(node) {
        if (!this.clipboard || this.clipboard.uris.length === 0) {
            return;
        }
        const targetDirectory = resolveDirectoryUri(node);
        if (!targetDirectory) {
            return;
        }
        const operation = this.clipboard.operation;
        await this.transfer(this.clipboard.uris, targetDirectory, operation);
        if (operation === 'cut') {
            this.setClipboard([], 'copy');
        }
        await this.refresh();
    }
    async transfer(uris, targetDirectory, operation) {
        for (const uri of uris) {
            if (isSameOrParent(uri, targetDirectory)) {
                continue;
            }
            const destination = await uniqueDestination(targetDirectory, path.basename(uri.fsPath));
            if (operation === 'cut') {
                await vscode.workspace.fs.rename(uri, destination, { overwrite: false });
            }
            else {
                await vscode.workspace.fs.copy(uri, destination, { overwrite: false });
            }
        }
    }
    async revealInOS(node) {
        const uri = nodeUri(node);
        if (uri) {
            await vscode.commands.executeCommand('revealFileInOS', uri);
        }
    }
    async openToSide(node) {
        const uri = nodeUri(node);
        if (uri) {
            await vscode.commands.executeCommand('vscode.open', uri, vscode.ViewColumn.Beside);
        }
    }
    async copyPath(node) {
        const uri = nodeUri(node);
        if (uri) {
            await vscode.env.clipboard.writeText(uri.fsPath);
        }
    }
    async copyRelativePath(node) {
        const uri = nodeUri(node);
        if (uri) {
            await vscode.env.clipboard.writeText(vscode.workspace.asRelativePath(uri, false));
        }
    }
    setClipboard(uris, operation) {
        this.clipboard = uris.length > 0 ? { uris, operation } : null;
        vscode.commands.executeCommand('setContext', CLIPBOARD_CONTEXT_KEY, Boolean(this.clipboard));
    }
    createDragAndDropController() {
        return {
            dropMimeTypes: [DRAG_MIME_TYPE],
            dragMimeTypes: [DRAG_MIME_TYPE],
            handleDrag: (source, dataTransfer) => {
                const uris = toUris(source).map((uri) => uri.toString());
                if (uris.length > 0) {
                    dataTransfer.set(DRAG_MIME_TYPE, new vscode.DataTransferItem(uris.join('\n')));
                }
            },
            handleDrop: async (target, dataTransfer) => {
                const item = dataTransfer.get(DRAG_MIME_TYPE);
                if (!item) {
                    return;
                }
                const value = await item.asString();
                const uris = value.split(/\r?\n/).filter(Boolean).map((entry) => vscode.Uri.parse(entry));
                const targetDirectory = resolveDirectoryUri(target);
                if (!targetDirectory || uris.length === 0) {
                    return;
                }
                try {
                    await this.transfer(uris, targetDirectory, 'cut');
                    await this.refresh();
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    vscode.window.showErrorMessage(`Solution Manager: ${message}`);
                }
            }
        };
    }
}
exports.FileExplorerActions = FileExplorerActions;
function nodeUri(node) {
    if (!node) {
        return undefined;
    }
    if (node.uri) {
        return node.uri instanceof vscode.Uri ? node.uri : vscode.Uri.parse(node.uri);
    }
    const filePath = node.item?.path || node.path;
    return filePath ? vscode.Uri.file(filePath) : undefined;
}
function toUris(nodes) {
    const list = Array.isArray(nodes) ? nodes : [nodes];
    const uris = [];
    const seen = new Set();
    for (const node of list) {
        const uri = nodeUri(node);
        if (uri && !seen.has(uri.toString())) {
            seen.add(uri.toString());
            uris.push(uri);
        }
    }
    return uris;
}
function resolveDirectoryUri(node) {
    if (!node) {
        return undefined;
    }
    if (node.kind === 'directory') {
        return node.uri instanceof vscode.Uri ? node.uri : vscode.Uri.parse(node.uri);
    }
    const uri = nodeUri(node);
    if (!uri) {
        return undefined;
    }
    return vscode.Uri.file(path.dirname(uri.fsPath));
}
function isSameOrParent(sourceUri, targetDirectory) {
    const source = sourceUri.fsPath;
    const target = targetDirectory.fsPath;
    return source === target || path.dirname(source) === target;
}
async function uniqueDestination(targetDirectory, name) {
    const extension = path.extname(name);
    const base = path.basename(name, extension);
    let candidate = vscode.Uri.joinPath(targetDirectory, name);
    let index = 1;
    while (await pathExists(candidate)) {
        const suffix = index === 1 ? ' copy' : ` copy ${index}`;
        candidate = vscode.Uri.joinPath(targetDirectory, `${base}${suffix}${extension}`);
        index += 1;
    }
    return candidate;
}
async function pathExists(uri) {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    }
    catch {
        return false;
    }
}
function validateFileName(value) {
    const text = String(value || '').trim();
    if (!text) {
        return 'A name is required.';
    }
    if (/[\\/:*?"<>|]/.test(text)) {
        return 'The name contains characters that are not allowed.';
    }
    return undefined;
}
