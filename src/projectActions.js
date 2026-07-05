const path = require('path');
const vscode = require('vscode');
const { quoteForShell } = require('./terminalRunner');
const { showProjectProperties } = require('./projectPropertiesView');
const { readProjectMetadataFromText } = require('./workspaceScanner');

class ProjectActions {
  constructor(context, terminalRunner, refresh, getState) {
    this.context = context;
    this.terminalRunner = terminalRunner;
    this.refresh = refresh;
    this.getState = getState;
  }

  async addNewCSharpClass(node) {
    const project = getProjectItem(node);
    const name = await vscode.window.showInputBox({
      title: 'New C# Class',
      prompt: 'Class name or relative path',
      placeHolder: 'Models/Customer.cs',
      validateInput: validateRelativeCsPath
    });

    if (!name) {
      return;
    }

    const relativePath = ensureExtension(name.trim(), '.cs');
    const uri = createChildUri(project, relativePath);
    const className = sanitizeIdentifier(path.basename(relativePath, '.cs')) || 'NewClass';
    const namespaceName = getNamespace(project, relativePath);
    const content = `namespace ${namespaceName};\n\npublic class ${className}\n{\n}\n`;

    await writeNewFile(uri, content);
    await vscode.window.showTextDocument(uri, { preview: false });
    await this.refresh({ userVisible: true });
  }

  async addNewFile(node) {
    const project = getProjectItem(node);
    const name = await vscode.window.showInputBox({
      title: 'New File',
      prompt: 'File name or relative path',
      placeHolder: 'Folder/file.txt',
      validateInput: validateRelativePath
    });

    if (!name) {
      return;
    }

    const uri = createChildUri(project, name.trim());
    await writeNewFile(uri, '');
    await vscode.window.showTextDocument(uri, { preview: false });
    await this.refresh({ userVisible: true });
  }

  async addNewFolder(node) {
    const project = getProjectItem(node);
    const name = await vscode.window.showInputBox({
      title: 'New Folder',
      prompt: 'Folder name or relative path',
      placeHolder: 'Models',
      validateInput: validateRelativePath
    });

    if (!name) {
      return;
    }

    const uri = createChildUri(project, name.trim());
    await vscode.workspace.fs.createDirectory(uri);
    await this.refresh({ userVisible: true });
  }

  async addProjectReference(node) {
    const project = getProjectItem(node);
    const state = await this.getState();
    const candidates = collectProjects(state).filter((candidate) => candidate.uri !== project.uri);

    if (candidates.length === 0) {
      vscode.window.showInformationMessage('Solution Manager: no other projects were found.');
      return;
    }

    const pick = await vscode.window.showQuickPick(
      candidates.map((candidate) => ({
        label: candidate.name,
        description: candidate.relativePath,
        item: candidate
      })),
      {
        title: 'Add Project Reference',
        placeHolder: 'Select a project to reference'
      }
    );

    if (!pick) {
      return;
    }

    this.terminalRunner.runCommand(`dotnet add ${quoteForShell(project.path)} reference ${quoteForShell(pick.item.path)}`);
  }

  async manageNuGetPackages(node) {
    const action = await vscode.window.showQuickPick(
      [
        { label: 'Add Package', action: 'add' },
        { label: 'Remove Package', action: 'remove' },
        { label: 'List Packages', action: 'list' }
      ],
      {
        title: 'Manage NuGet Packages'
      }
    );

    if (!action) {
      return;
    }

    if (action.action === 'add') {
      await this.addNuGetPackage(node);
      return;
    }

    if (action.action === 'remove') {
      await this.removeNuGetPackage(node);
      return;
    }

    const project = getProjectItem(node);
    this.terminalRunner.runCommand(`dotnet list ${quoteForShell(project.path)} package`);
  }

  async addNuGetPackage(node) {
    const project = getProjectItem(node);
    const packageName = await vscode.window.showInputBox({
      title: 'Add NuGet Package',
      prompt: 'Package id',
      placeHolder: 'Microsoft.EntityFrameworkCore',
      validateInput: (value) => value.trim() ? undefined : 'Package id is required.'
    });

    if (!packageName) {
      return;
    }

    const version = await vscode.window.showInputBox({
      title: 'Add NuGet Package',
      prompt: 'Optional version',
      placeHolder: '8.0.0'
    });
    const versionArg = version && version.trim() ? ` --version ${quoteForShell(version.trim())}` : '';
    this.terminalRunner.runCommand(`dotnet add ${quoteForShell(project.path)} package ${quoteForShell(packageName.trim())}${versionArg}`);
  }

  async removeNuGetPackage(node) {
    const project = getProjectItem(node);
    const metadata = await readProjectMetadata(project.path);
    const packageRefs = metadata.packageReferences || [];
    let packageName;

    if (packageRefs.length > 0) {
      const pick = await vscode.window.showQuickPick(
        packageRefs.map((reference) => ({
          label: reference.name,
          description: reference.version,
          reference
        })),
        {
          title: 'Remove NuGet Package'
        }
      );

      packageName = pick?.reference.name;
    } else {
      packageName = await vscode.window.showInputBox({
        title: 'Remove NuGet Package',
        prompt: 'Package id',
        validateInput: (value) => value.trim() ? undefined : 'Package id is required.'
      });
    }

    if (!packageName) {
      return;
    }

    this.terminalRunner.runCommand(`dotnet remove ${quoteForShell(project.path)} package ${quoteForShell(packageName.trim())}`);
  }

  async runEfAction(action, node) {
    const project = getProjectItem(node);

    if (action === 'addMigration') {
      const migrationName = await vscode.window.showInputBox({
        title: 'Add EF Core Migration',
        prompt: 'Migration name',
        placeHolder: 'AddCustomerTable',
        validateInput: (value) => value.trim() ? undefined : 'Migration name is required.'
      });

      if (!migrationName) {
        return;
      }

      this.terminalRunner.runCommand(`dotnet ef migrations add ${quoteForShell(migrationName.trim())} --project ${quoteForShell(project.path)}`);
      return;
    }

    if (action === 'removeMigration') {
      this.terminalRunner.runCommand(`dotnet ef migrations remove --project ${quoteForShell(project.path)}`);
      return;
    }

    if (action === 'updateDatabase') {
      this.terminalRunner.runCommand(`dotnet ef database update --project ${quoteForShell(project.path)}`);
      return;
    }

    this.terminalRunner.runCommand(`dotnet ef migrations script --project ${quoteForShell(project.path)}`);
  }

  runDotnetAction(action, node) {
    const project = getProjectItem(node);
    this.terminalRunner.runCommand(`dotnet ${action} ${quoteForShell(project.path)}`);
  }

  runGitAction(action, node) {
    const project = getProjectItem(node);
    const projectDirectory = path.dirname(project.path);

    if (action === 'status') {
      this.terminalRunner.runCommand(`git -C ${quoteForShell(projectDirectory)} status --short`);
      return;
    }

    if (action === 'diff') {
      this.terminalRunner.runCommand(`git -C ${quoteForShell(projectDirectory)} diff -- .`);
      return;
    }

    this.terminalRunner.runCommand(`git -C ${quoteForShell(projectDirectory)} log --oneline --decorate --max-count=30 -- .`);
  }

  async copyValue(kind, node) {
    const project = getProjectItem(node);
    let value;

    if (kind === 'fullPath') {
      value = project.path;
    } else if (kind === 'relativePath') {
      value = vscode.workspace.asRelativePath(project.path, false);
    } else if (kind === 'projectName') {
      value = project.name;
    } else {
      value = `<ProjectReference Include="${vscode.workspace.asRelativePath(project.path, false)}" />`;
    }

    await vscode.env.clipboard.writeText(value);
    vscode.window.setStatusBarMessage('Solution Manager: copied to clipboard.', 2000);
  }

  async openIn(kind, node) {
    const project = getProjectItem(node);
    const projectUri = vscode.Uri.file(project.path);
    const projectDirectoryUri = vscode.Uri.file(path.dirname(project.path));

    if (kind === 'editor') {
      await vscode.window.showTextDocument(projectUri, { preview: false });
      return;
    }

    if (kind === 'explorer') {
      await vscode.commands.executeCommand('revealFileInOS', projectUri);
      return;
    }

    vscode.window.createTerminal({
      name: project.name,
      cwd: projectDirectoryUri
    }).show();
  }

  async showProperties(node) {
    const project = getProjectItem(node);
    const metadata = await readProjectMetadata(project.path);
    showProjectProperties(this.context, project, metadata);
  }
}

function getProjectItem(node) {
  if (!node || !node.item || node.kind !== 'project') {
    throw new Error('A project node is required.');
  }

  return node.item;
}

async function readProjectMetadata(projectPath) {
  try {
    const buffer = await vscode.workspace.fs.readFile(vscode.Uri.file(projectPath));
    return readProjectMetadataFromText(Buffer.from(buffer).toString('utf8'), projectPath);
  } catch {
    return {
      targetFrameworks: [],
      packageReferences: [],
      projectReferences: [],
      rootNamespace: undefined,
      isTestProject: false
    };
  }
}

function collectProjects(state) {
  const byUri = new Map();

  for (const project of state.projects || []) {
    byUri.set(project.uri, project);
  }

  for (const solution of state.solutions || []) {
    for (const project of solution.children || []) {
      byUri.set(project.uri, project);
    }
  }

  for (const item of state.customItems || []) {
    if (item.kind === 'project') {
      byUri.set(item.uri, item);
    }
  }

  return [...byUri.values()].sort((left, right) => left.name.localeCompare(right.name, undefined, {
    sensitivity: 'base'
  }));
}

function createChildUri(project, relativePath) {
  const projectDirectory = path.dirname(project.path);
  const targetPath = path.resolve(projectDirectory, relativePath);
  const normalizedDirectory = normalizePath(projectDirectory);
  const normalizedTarget = normalizePath(targetPath);

  if (!normalizedTarget.startsWith(`${normalizedDirectory}${path.sep}`)) {
    throw new Error('Path must stay inside the project directory.');
  }

  return vscode.Uri.file(targetPath);
}

async function writeNewFile(uri, content) {
  try {
    await vscode.workspace.fs.stat(uri);
    throw new Error(`${path.basename(uri.fsPath)} already exists.`);
  } catch (error) {
    if (error instanceof Error && error.message.endsWith('already exists.')) {
      throw error;
    }
  }

  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
}

function validateRelativeCsPath(value) {
  const baseValidation = validateRelativePath(value);

  if (baseValidation) {
    return baseValidation;
  }

  const extension = path.extname(value.trim());
  return extension && extension.toLowerCase() !== '.cs' ? 'C# class files must use .cs extension.' : undefined;
}

function validateRelativePath(value) {
  const trimmed = value.trim();

  if (!trimmed) {
    return 'A path is required.';
  }

  if (path.isAbsolute(trimmed)) {
    return 'Use a relative path.';
  }

  if (trimmed.split(/[\\/]/).includes('..')) {
    return 'Parent directory segments are not allowed.';
  }

  return undefined;
}

function ensureExtension(value, extension) {
  return path.extname(value) ? value : `${value}${extension}`;
}

function getNamespace(project, relativePath) {
  const baseNamespace = sanitizeNamespace(project.metadata?.rootNamespace || project.name);
  const directory = path.dirname(relativePath);

  if (!directory || directory === '.') {
    return baseNamespace;
  }

  const suffix = directory
    .split(/[\\/]/)
    .map(sanitizeIdentifier)
    .filter(Boolean)
    .join('.');

  return suffix ? `${baseNamespace}.${suffix}` : baseNamespace;
}

function sanitizeNamespace(value) {
  return value
    .split('.')
    .map(sanitizeIdentifier)
    .filter(Boolean)
    .join('.') || 'SolutionManager';
}

function sanitizeIdentifier(value) {
  const clean = value.replace(/[^A-Za-z0-9_]/g, '_');
  const prefixed = /^[A-Za-z_]/.test(clean) ? clean : `_${clean}`;
  return prefixed.replace(/_+/g, '_');
}

function normalizePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'linux' ? resolved : resolved.toLowerCase();
}

module.exports = {
  ProjectActions
};
