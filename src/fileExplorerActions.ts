// @ts-nocheck
import * as path from 'path';
import * as vscode from 'vscode';

const DRAG_MIME_TYPE = 'application/vnd.code.tree.solutionmanager';
const CLIPBOARD_CONTEXT_KEY = 'solutionManager.hasClipboard';
const PROJECT_AND_SOLUTION_EXTENSIONS = new Set(['.sln', '.slnx', '.csproj', '.fsproj', '.vbproj', '.proj']);

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

    if (!(await this.confirmSolutionAwareOperation([uri], 'rename'))) {
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
    const solutionAware = uris.filter(isProjectOrSolutionFile);
    const detail = solutionAware.length > 0
      ? ` Note: ${solutionAware.map((uri) => path.basename(uri.fsPath)).join(', ')} is a project or solution file; its solution (.sln/.slnx) entries and references in other projects will NOT be updated.`
      : '';
    const confirmation = await vscode.window.showWarningMessage(
      `Are you sure you want to delete ${label}? It will be moved to the trash.${detail}`,
      { modal: true },
      'Move to Trash'
    );

    if (confirmation !== 'Move to Trash') {
      return;
    }

    const errors = [];

    for (const uri of uris) {
      try {
        await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
      } catch (error) {
        errors.push({ uri, error });
      }
    }

    await this.refresh();
    reportTransferErrors(errors);
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

    try {
      const result = await this.transfer(this.clipboard.uris, targetDirectory, operation);

      if (result.cancelled) {
        return;
      }

      if (operation === 'cut') {
        this.setClipboard([], 'copy');
      }

      reportTransferErrors(result.errors);
    } finally {
      await this.refresh();
    }
  }

  async transfer(uris, targetDirectory, operation) {
    if (operation === 'cut' && !(await this.confirmSolutionAwareOperation(uris, 'move'))) {
      return { cancelled: true, succeeded: [], errors: [] };
    }

    const succeeded = [];
    const errors = [];

    for (const uri of uris) {
      if (isSameOrParent(uri, targetDirectory)) {
        continue;
      }

      try {
        const destination = await uniqueDestination(targetDirectory, path.basename(uri.fsPath));

        if (operation === 'cut') {
          await vscode.workspace.fs.rename(uri, destination, { overwrite: false });
        } else {
          await vscode.workspace.fs.copy(uri, destination, { overwrite: false });
        }

        succeeded.push(uri);
      } catch (error) {
        errors.push({ uri, error });
      }
    }

    return { cancelled: false, succeeded, errors };
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

  async confirmSolutionAwareOperation(uris, verb) {
    const affected = uris.filter(isProjectOrSolutionFile);

    if (affected.length === 0) {
      return true;
    }

    const names = affected.map((uri) => path.basename(uri.fsPath)).join(', ');
    const choice = await vscode.window.showWarningMessage(
      `${names} is a project or solution file. Solution Manager will ${verb} it on disk but will NOT update solution (.sln/.slnx) entries or references in other projects. Continue?`,
      { modal: true },
      'Continue'
    );

    return choice === 'Continue';
  }

  createDragAndDropController() {
    return {
      dropMimeTypes: [DRAG_MIME_TYPE],
      dragMimeTypes: [DRAG_MIME_TYPE],
      handleDrag: (source, dataTransfer) => {
        const uris = toUris((source || []).filter(isFileSystemNode)).map((uri) => uri.toString());

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
          const result = await this.transfer(uris, targetDirectory, 'cut');
          reportTransferErrors(result.errors);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(`Solution Manager: ${message}`);
        } finally {
          await this.refresh();
        }
      }
    };
  }
}

function reportTransferErrors(errors) {
  if (!errors || errors.length === 0) {
    return;
  }

  const detail = errors
    .map(({ uri, error }) => `${path.basename(uri.fsPath)}: ${error instanceof Error ? error.message : String(error)}`)
    .join('; ');
  vscode.window.showErrorMessage(
    `Solution Manager: ${errors.length} item(s) could not be processed. ${detail}`
  );
}

function isFileSystemNode(node) {
  return Boolean(node) && (node.kind === 'file' || node.kind === 'directory');
}

function isProjectOrSolutionFile(uri) {
  return PROJECT_AND_SOLUTION_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase());
}

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
  const source = path.resolve(sourceUri.fsPath);
  const target = path.resolve(targetDirectory.fsPath);

  if (source === target || path.dirname(source) === target) {
    return true;
  }

  const relative = path.relative(source, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
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
  } catch {
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

export {
  FileExplorerActions
};
