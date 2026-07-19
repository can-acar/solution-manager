// @ts-nocheck
import * as path from 'path';
import * as vscode from 'vscode';
import { quoteForShell } from '#src/terminalRunner';
import {
  addProjectToSolutionFile,
  addSolutionFolderToSolutionFile,
  saveSolutionAs
} from '#src/solutionFileEditor';
import { openScopedFindInFiles, openScopedQuickOpen } from '#src/searchActions';
import {
  applySolutionConfigurationChange,
  readSolutionConfigurationModel
} from '#src/solutionConfigurationEditor';
import { showSolutionProperties } from '#src/solutionPropertiesView';

const PROJECT_FILE_EXTENSIONS = new Set(['.csproj', '.fsproj', '.vbproj', '.proj']);
const PROJECT_TEMPLATES = [
  {
    label: 'C# Class Library',
    description: 'Microsoft.NET.Sdk',
    fileName: (name) => `${name}.csproj`,
    createFiles: createClassLibraryFiles
  },
  {
    label: 'C# Console App',
    description: 'Executable console project',
    fileName: (name) => `${name}.csproj`,
    createFiles: createConsoleFiles
  },
  {
    label: 'ASP.NET Core Empty',
    description: 'Microsoft.NET.Sdk.Web',
    fileName: (name) => `${name}.csproj`,
    createFiles: createWebFiles
  }
];

class SolutionActions {
  constructor(context, terminalRunner, callbacks) {
    this.context = context;
    this.terminalRunner = terminalRunner;
    this.refresh = callbacks.refresh;
    this.getState = callbacks.getState;
    this.openUri = callbacks.openUri;
    this.addCustomItems = callbacks.addCustomItems;
    this.runProjectAction = callbacks.runProjectAction;
    this.getUnloadedProjectUris = callbacks.getUnloadedProjectUris;
    this.setUnloadedProjectUris = callbacks.setUnloadedProjectUris;
  }

  async run(action, node) {
    const solution = getSolutionItem(node);

    switch (action) {
      case 'addNewProject':
        await this.addNewProject(solution);
        break;
      case 'addSolutionFolder':
        await this.addSolutionFolder(solution);
        break;
      case 'addDockerComposeFile':
        await this.addDockerComposeFile(solution);
        break;
      case 'addAspireOrchestration':
        await this.addAspireOrchestration(solution);
        break;
      case 'addExistingProject':
        await this.addExistingProject(solution);
        break;
      case 'addExistingFolder':
        await this.addExistingFolder(solution);
        break;
      case 'manageNuGetPackages':
        await this.runProjectAction('manageNuGetPackages', node);
        break;
      case 'unloadProjects':
        await this.unloadProjects(solution);
        break;
      case 'loadProjects':
        await this.loadProjects(solution, false);
        break;
      case 'loadProjectsWithDependencies':
        await this.loadProjects(solution, true);
        break;
      case 'reloadAllProjects':
        await this.reloadAllProjects(solution);
        break;
      case 'saveAs':
        await this.saveAs(solution);
        break;
      case 'efAddMigration':
        await this.runProjectSelectionAction(solution, 'efAddMigration', 'Add Migration');
        break;
      case 'efRemoveMigration':
        await this.runProjectSelectionAction(solution, 'efRemoveMigration', 'Remove Last Migration');
        break;
      case 'efUpdateDatabase':
        await this.runProjectSelectionAction(solution, 'efUpdateDatabase', 'Update Database');
        break;
      case 'efScriptMigration':
        await this.runProjectSelectionAction(solution, 'efScriptMigration', 'Script Migration');
        break;
      case 'buildSolution':
        this.runDotnetAction(solution, 'build');
        break;
      case 'runMultipleProjects':
        await this.runMultipleProjects(solution);
        break;
      case 'runUnitTests':
        this.runDotnetAction(solution, 'test');
        break;
      case 'publish':
        await this.runProjectSelectionAction(solution, 'publishProject', 'Publish');
        break;
      case 'restore':
        this.runDotnetAction(solution, 'restore');
        break;
      case 'clean':
        this.runDotnetAction(solution, 'clean');
        break;
      case 'rebuild':
        this.runDotnetAction(solution, 'clean');
        this.runDotnetAction(solution, 'build');
        break;
      case 'pack':
        this.runDotnetAction(solution, 'pack');
        break;
      case 'gitStatus':
        this.runGitAction(solution, 'status');
        break;
      case 'gitDiff':
        this.runGitAction(solution, 'diff');
        break;
      case 'gitLog':
        this.runGitAction(solution, 'log');
        break;
      case 'editSolutionFile':
      case 'openInEditor':
        await this.openUri(vscode.Uri.file(solution.path));
        break;
      case 'copyFullPath':
        await this.copyValue(solution.path);
        break;
      case 'copyRelativePath':
        await this.copyValue(vscode.workspace.asRelativePath(solution.path, false));
        break;
      case 'copySolutionName':
        await this.copyValue(solution.name);
        break;
      case 'openInExplorer':
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(solution.path));
        break;
      case 'openInTerminal':
        vscode.window.createTerminal({
          name: solution.name,
          cwd: vscode.Uri.file(path.dirname(solution.path))
        }).show();
        break;
      case 'findInFiles':
        await openScopedFindInFiles(path.dirname(solution.path), false);
        break;
      case 'replaceInFiles':
        await openScopedFindInFiles(path.dirname(solution.path), true);
        break;
      case 'findFile':
        await openScopedQuickOpen(path.dirname(solution.path));
        break;
      case 'showProperties':
        await this.showProperties(solution);
        break;
      default:
        break;
    }
  }

  async addNewProject(solution) {
    const template = await vscode.window.showQuickPick(PROJECT_TEMPLATES, {
      title: 'Solution Manager: New Project',
      placeHolder: 'Select project template'
    });

    if (!template) {
      return;
    }

    const projectName = await vscode.window.showInputBox({
      title: 'Solution Manager: New Project',
      prompt: 'Project name',
      placeHolder: 'MyCompany.MyProject',
      validateInput: validateProjectName
    });

    if (!projectName) {
      return;
    }

    const relativeFolder = await vscode.window.showInputBox({
      title: 'Solution Manager: New Project',
      prompt: 'Project folder relative to the solution file',
      value: projectName.trim(),
      validateInput: validateRelativePath
    });

    if (!relativeFolder) {
      return;
    }

    const solutionFolder = await this.pickSolutionFolder(solution, 'Solution folder for the new project');
    const targetFramework = inferTargetFramework(solution);
    const projectDirectory = path.resolve(path.dirname(solution.path), relativeFolder.trim());
    const projectPath = path.join(projectDirectory, template.fileName(projectName.trim()));

    await template.createFiles(projectPath, projectName.trim(), targetFramework);
    await addProjectToSolutionFile(solution.path, projectPath, {
      name: projectName.trim(),
      solutionFolder
    });
    await this.refresh({ userVisible: true });
    await this.openUri(vscode.Uri.file(projectPath));
  }

  async addSolutionFolder(solution) {
    const folderPath = await vscode.window.showInputBox({
      title: 'Solution Manager: New Solution Folder',
      prompt: 'Solution folder name or path',
      placeHolder: 'Clients/Core',
      validateInput: validateSolutionFolderPath
    });

    if (!folderPath) {
      return;
    }

    const result = await addSolutionFolderToSolutionFile(solution.path, folderPath.trim());

    if (!result.changed) {
      vscode.window.showInformationMessage(`Solution Manager: ${folderPath.trim()} already exists.`);
      return;
    }

    await this.refresh({ userVisible: true });
  }

  async addDockerComposeFile(solution) {
    const composeUri = vscode.Uri.file(path.join(path.dirname(solution.path), 'docker-compose.yml'));
    const exists = await fileExists(composeUri);

    if (!exists) {
      await vscode.workspace.fs.writeFile(composeUri, Buffer.from(createDockerComposeContent(), 'utf8'));
    }

    await this.openUri(composeUri);
    vscode.window.setStatusBarMessage(
      exists ? 'Solution Manager: docker-compose.yml opened.' : 'Solution Manager: docker-compose.yml created.',
      2500
    );
  }

  async addAspireOrchestration(solution) {
    const appHostName = await vscode.window.showInputBox({
      title: 'Solution Manager: Aspire Orchestration',
      prompt: 'Aspire AppHost project name',
      value: `${solution.name}.AppHost`,
      validateInput: validateProjectName
    });

    if (!appHostName) {
      return;
    }

    const relativeFolder = await vscode.window.showInputBox({
      title: 'Solution Manager: Aspire Orchestration',
      prompt: 'AppHost folder relative to the solution file',
      value: appHostName.trim(),
      validateInput: validateRelativePath
    });

    if (!relativeFolder) {
      return;
    }

    const projectDirectory = path.resolve(path.dirname(solution.path), relativeFolder.trim());
    const projectPath = path.join(projectDirectory, `${appHostName.trim()}.csproj`);
    const projectUri = vscode.Uri.file(projectPath);

    if (await fileExists(projectUri)) {
      vscode.window.showWarningMessage(`Solution Manager: ${path.basename(projectPath)} already exists.`);
      return;
    }

    this.terminalRunner.runCommand(`dotnet new aspire -n ${quoteForShell(appHostName.trim())} -o ${quoteForShell(projectDirectory)}`);

    const created = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Solution Manager: waiting for the Aspire AppHost project to be created…',
        cancellable: true
      },
      (_progress, token) => waitForFile(projectUri, 120000, 500, token)
    );

    if (!created) {
      vscode.window.showWarningMessage(
        `Solution Manager: ${path.basename(projectPath)} was not created. Once the terminal command finishes, use "Add Existing Project" to add it to the solution.`
      );
      return;
    }

    await addProjectToSolutionFile(solution.path, projectPath, {
      name: appHostName.trim()
    });
    await this.refresh({ userVisible: true });
    vscode.window.showInformationMessage('Solution Manager: Aspire AppHost project was created and added to the solution.');
  }

  async addExistingProject(solution) {
    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      defaultUri: vscode.Uri.file(path.dirname(solution.path)),
      openLabel: 'Add Existing Project',
      filters: {
        'Project files': ['csproj', 'fsproj', 'vbproj', 'proj']
      }
    });

    if (!selection || selection.length === 0) {
      return;
    }

    const solutionFolder = await this.pickSolutionFolder(solution, 'Solution folder for the selected project(s)');
    let changed = false;

    for (const uri of selection) {
      const result = await addProjectToSolutionFile(solution.path, uri.fsPath, {
        solutionFolder
      });
      changed = changed || result.changed;
    }

    if (changed) {
      await this.refresh({ userVisible: true });
    } else {
      vscode.window.showInformationMessage('Solution Manager: selected project already exists in the solution.');
    }
  }

  async addExistingFolder(solution) {
    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(path.dirname(solution.path)),
      openLabel: 'Add Existing Folder'
    });

    if (!selection || selection.length === 0) {
      return;
    }

    const relative = path.relative(path.dirname(solution.path), selection[0].fsPath) || path.basename(selection[0].fsPath);
    const result = await addSolutionFolderToSolutionFile(solution.path, relative);

    if (!result.changed) {
      vscode.window.showInformationMessage(`Solution Manager: ${relative} already exists.`);
      return;
    }

    await this.refresh({ userVisible: true });
  }

  async runProjectSelectionAction(solution, action, title) {
    const project = await this.pickProject(solution, {
      title: `Solution Manager: ${title}`
    });

    if (project) {
      await this.runProjectAction(action, createProjectNode(project));
    }
  }

  async unloadProjects(solution) {
    const projects = await this.pickProjects(solution, {
      title: 'Solution Manager: Unload Projects',
      loadedOnly: true
    });

    if (projects.length === 0) {
      return;
    }

    const unloaded = this.getUnloadedProjectUris();

    for (const project of projects) {
      unloaded.add(project.uri);
    }

    await this.setUnloadedProjectUris(unloaded);
    await this.refresh({ userVisible: true });
  }

  async loadProjects(solution, includeDependencies) {
    const projects = await this.pickProjects(solution, {
      title: includeDependencies ? 'Solution Manager: Load Projects with Dependencies' : 'Solution Manager: Load Projects',
      unloadedOnly: true
    });

    if (projects.length === 0) {
      return;
    }

    const unloaded = this.getUnloadedProjectUris();
    const projectsToLoad = includeDependencies
      ? collectProjectsWithDependencies(solution, projects)
      : projects;

    for (const project of projectsToLoad) {
      unloaded.delete(project.uri);
    }

    await this.setUnloadedProjectUris(unloaded);
    await this.refresh({ userVisible: true });
  }

  async reloadAllProjects(solution) {
    const unloaded = this.getUnloadedProjectUris();

    for (const project of getSolutionProjects(solution)) {
      unloaded.delete(project.uri);
    }

    await this.setUnloadedProjectUris(unloaded);
    await this.refresh({ userVisible: true });
  }

  async saveAs(solution) {
    const targetUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(path.dirname(solution.path), `${solution.name}${solution.extension || '.sln'}`)),
      filters: {
        'Solution files': ['sln', 'slnx']
      },
      saveLabel: 'Save Solution As'
    });

    if (!targetUri) {
      return;
    }

    await saveSolutionAs(solution.path, targetUri.fsPath);
    await this.addCustomItems([targetUri]);
    await this.refresh({ userVisible: true });
    await this.openUri(targetUri);
  }

  runDotnetAction(solution, action) {
    this.terminalRunner.runCommand(`dotnet ${action} ${quoteForShell(solution.path)}`);
  }

  async runMultipleProjects(solution) {
    const projects = await this.pickProjects(solution, {
      title: 'Solution Manager: Run Multiple Projects',
      loadedOnly: true
    });

    for (const project of projects) {
      this.terminalRunner.runCommand(`dotnet run --project ${quoteForShell(project.path)}`);
    }
  }

  runGitAction(solution, action) {
    const solutionDirectory = path.dirname(solution.path);

    if (action === 'status') {
      this.terminalRunner.runCommand(`git -C ${quoteForShell(solutionDirectory)} status --short`);
      return;
    }

    if (action === 'diff') {
      this.terminalRunner.runCommand(`git -C ${quoteForShell(solutionDirectory)} diff -- .`);
      return;
    }

    this.terminalRunner.runCommand(`git -C ${quoteForShell(solutionDirectory)} log --oneline --decorate --max-count=30 -- .`);
  }

  async copyValue(value) {
    await vscode.env.clipboard.writeText(value);
    vscode.window.setStatusBarMessage('Solution Manager: copied to clipboard.', 2000);
  }

  async showProperties(solution) {
    if (!solution?.path) {
      vscode.window.showInformationMessage('Solution Manager: no solution file is available.');
      return;
    }

    const attachDependencyCounts = (model) => {
      const byPath = new Map(getSolutionProjects(solution).map((project) => [
        normalizePath(project.path),
        (project.metadata?.projectReferences || []).length
      ]));

      for (const project of model.projects) {
        project.dependencyCount = byPath.get(normalizePath(project.absolutePath)) ?? 0;
      }

      return model;
    };

    const model = attachDependencyCounts(await readSolutionConfigurationModel(solution.path));
    showSolutionProperties(this.context, solution, model, async (change) => {
      await applySolutionConfigurationChange(solution.path, change);
      return attachDependencyCounts(await readSolutionConfigurationModel(solution.path));
    });
  }

  async pickProject(solution, options = {}) {
    const projects = await this.pickProjects(solution, {
      ...options,
      canPickMany: false
    });

    return projects[0];
  }

  async pickProjects(solution, options = {}) {
    const unloaded = this.getUnloadedProjectUris();
    let projects = getSolutionProjects(solution);

    if (options.loadedOnly) {
      projects = projects.filter((project) => !unloaded.has(project.uri));
    }

    if (options.unloadedOnly) {
      projects = projects.filter((project) => unloaded.has(project.uri));
    }

    if (projects.length === 0) {
      vscode.window.showInformationMessage('Solution Manager: no matching projects were found.');
      return [];
    }

    const picked = await vscode.window.showQuickPick(
      projects.map((project) => ({
        label: project.name,
        description: project.relativePath,
        detail: project.path,
        project
      })),
      {
        title: options.title,
        canPickMany: options.canPickMany !== false,
        placeHolder: 'Select project'
      }
    );

    if (!picked) {
      return [];
    }

    return Array.isArray(picked) ? picked.map((item) => item.project) : [picked.project];
  }

  async pickSolutionFolder(solution, title) {
    const folders = getSolutionFolders(solution);
    const items = [
      {
        label: 'Root',
        description: 'Add at solution root',
        value: ''
      },
      ...folders.map((folder) => ({
        label: folder.path.join('/'),
        value: folder.path.join('/')
      })),
      {
        label: 'New solution folder...',
        value: '__new__'
      }
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title,
      placeHolder: 'Select solution folder'
    });

    if (!pick || pick.value === '') {
      return '';
    }

    if (pick.value !== '__new__') {
      return pick.value;
    }

    const folderPath = await vscode.window.showInputBox({
      title: 'Solution Manager: Solution Folder',
      prompt: 'Solution folder name or path',
      validateInput: validateSolutionFolderPath
    });

    return folderPath ? folderPath.trim() : '';
  }
}

async function createClassLibraryFiles(projectPath, projectName, targetFramework) {
  const namespace = sanitizeNamespace(projectName);
  await writeProjectFile(projectPath, createSdkProjectXml('Microsoft.NET.Sdk', targetFramework));
  await writeTextFile(path.join(path.dirname(projectPath), 'Class1.cs'), [
    `namespace ${namespace};`,
    '',
    'public class Class1',
    '{',
    '}',
    ''
  ].join('\n'));
}

async function createConsoleFiles(projectPath, projectName, targetFramework) {
  await writeProjectFile(projectPath, createSdkProjectXml('Microsoft.NET.Sdk', targetFramework, '<OutputType>Exe</OutputType>'));
  await writeTextFile(path.join(path.dirname(projectPath), 'Program.cs'), [
    'Console.WriteLine("Hello, World!");',
    ''
  ].join('\n'));
}

async function createWebFiles(projectPath, projectName, targetFramework) {
  await writeProjectFile(projectPath, createSdkProjectXml('Microsoft.NET.Sdk.Web', targetFramework));
  await writeTextFile(path.join(path.dirname(projectPath), 'Program.cs'), [
    'var builder = WebApplication.CreateBuilder(args);',
    'var app = builder.Build();',
    '',
    'app.MapGet("/", () => "Hello, World!");',
    '',
    'app.Run();',
    ''
  ].join('\n'));
}

async function writeProjectFile(projectPath, content) {
  const projectUri = vscode.Uri.file(projectPath);

  if (await fileExists(projectUri)) {
    throw new Error(`${path.basename(projectPath)} already exists.`);
  }

  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(projectPath)));
  await vscode.workspace.fs.writeFile(projectUri, Buffer.from(content, 'utf8'));
}

async function writeTextFile(filePath, content) {
  const fileUri = vscode.Uri.file(filePath);

  if (await fileExists(fileUri)) {
    throw new Error(`${path.basename(filePath)} already exists.`);
  }

  await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));
}

async function fileExists(uri) {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(uri, timeoutMs, intervalMs, token) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (token?.isCancellationRequested) {
      return false;
    }

    if (await fileExists(uri)) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return await fileExists(uri);
}

function createSdkProjectXml(sdk, targetFramework, extraProperty = '') {
  const extra = extraProperty ? `    ${extraProperty}\n` : '';

  return [
    `<Project Sdk="${sdk}">`,
    '  <PropertyGroup>',
    extra.trimEnd(),
    `    <TargetFramework>${targetFramework}</TargetFramework>`,
    '    <ImplicitUsings>enable</ImplicitUsings>',
    '    <Nullable>enable</Nullable>',
    '  </PropertyGroup>',
    '</Project>',
    ''
  ].filter((line) => line !== '').join('\n');
}

function createDockerComposeContent() {
  return [
    'services:',
    '  app:',
    '    image: ${DOCKER_REGISTRY-}app',
    '    build:',
    '      context: .',
    '      dockerfile: Dockerfile',
    ''
  ].join('\n');
}

function createSolutionPropertiesMarkdown(solution, projects, folders, unloaded) {
  const lines = [
    `# ${solution.name}`,
    '',
    `- Path: \`${solution.path}\``,
    `- Projects: ${projects.length}`,
    `- Unloaded: ${projects.filter((project) => unloaded.has(project.uri)).length}`,
    `- Solution folders: ${folders.length}`,
    '',
    '## Projects',
    ''
  ];

  if (projects.length === 0) {
    lines.push('- No projects');
  } else {
    for (const project of projects) {
      const state = unloaded.has(project.uri) ? 'unloaded' : 'loaded';
      lines.push(`- ${project.name} (${state}) - \`${project.relativePath || project.path}\``);
    }
  }

  if (folders.length > 0) {
    lines.push('', '## Solution Folders', '');
    for (const folder of folders) {
      lines.push(`- ${folder.path.join('/')}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function inferTargetFramework(solution) {
  for (const project of getSolutionProjects(solution)) {
    const targetFrameworks = project.metadata?.targetFrameworks || [];

    if (targetFrameworks.length > 0) {
      return targetFrameworks[0];
    }

    const targetFramework = project.metadata?.buildSettings?.targetFramework;

    if (targetFramework) {
      return targetFramework;
    }
  }

  return 'net8.0';
}

function collectProjectsWithDependencies(solution, selectedProjects) {
  const byPath = new Map(getSolutionProjects(solution).map((project) => [normalizePath(project.path), project]));
  const selected = new Map(selectedProjects.map((project) => [project.uri, project]));
  const queue = [...selectedProjects];

  while (queue.length > 0) {
    const project = queue.shift();
    const references = project.metadata?.projectReferences || [];

    for (const reference of references) {
      const dependency = byPath.get(normalizePath(reference.path));

      if (dependency && !selected.has(dependency.uri)) {
        selected.set(dependency.uri, dependency);
        queue.push(dependency);
      }
    }
  }

  return [...selected.values()];
}

function getSolutionItem(node) {
  if (!node || !node.item || node.item.kind !== 'solution') {
    throw new Error('A solution node is required.');
  }

  return node.item;
}

function getSolutionProjects(solution) {
  return Array.isArray(solution.children)
    ? solution.children.filter((item) => item.kind === 'project')
    : [];
}

function getSolutionFolders(solution) {
  return Array.isArray(solution.solutionFolders)
    ? solution.solutionFolders.filter((folder) => Array.isArray(folder.path) && folder.path.length > 0)
    : [];
}

function createProjectNode(project) {
  return {
    id: project.id,
    kind: 'project',
    label: project.name,
    item: project
  };
}

function validateProjectName(value) {
  const trimmed = String(value || '').trim();

  if (!trimmed) {
    return 'Project name is required.';
  }

  if (/[\\/:*?"<>|]/.test(trimmed)) {
    return 'Project name contains invalid file name characters.';
  }

  return undefined;
}

function validateRelativePath(value) {
  const trimmed = String(value || '').trim();

  if (!trimmed) {
    return 'Relative path is required.';
  }

  if (path.isAbsolute(trimmed) || trimmed.split(/[\\/]/).includes('..')) {
    return 'Path must stay inside the solution directory.';
  }

  return undefined;
}

function validateSolutionFolderPath(value) {
  const trimmed = String(value || '').trim();

  if (!trimmed) {
    return 'Solution folder is required.';
  }

  if (trimmed.split(/[\\/]/).some((part) => !part.trim())) {
    return 'Solution folder path contains an empty segment.';
  }

  return undefined;
}

function sanitizeNamespace(value) {
  const sanitized = String(value || 'Project')
    .split('.')
    .map((part) => part.replace(/[^a-zA-Z0-9_]/g, '_'))
    .filter(Boolean)
    .join('.');

  return sanitized || 'Project';
}

function normalizePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'linux' ? resolved : resolved.toLowerCase();
}

export {
  SolutionActions
};
