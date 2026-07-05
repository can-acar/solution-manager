const path = require('path');
const vscode = require('vscode');

const CUSTOM_ITEMS_KEY = 'solutionManager.customItems';
const EXCLUDE_PATTERN = '**/{node_modules,.git,.vs,bin,obj,out,dist,coverage}/**';
const CONTENT_EXCLUDE_NAMES = new Set(['bin', 'obj', 'out', 'dist', 'coverage', 'node_modules', 'packages']);
const PROJECT_EXTENSIONS = new Set(['.csproj', '.fsproj', '.vbproj', '.proj']);
const SOLUTION_EXTENSIONS = new Set(['.sln', '.slnx']);

class WorkspaceScanner {
  constructor(context) {
    this.context = context;
  }

  async scan() {
    const workspaceFolders = vscode.workspace.workspaceFolders || [];
    const solutionUris = workspaceFolders.length
      ? await vscode.workspace.findFiles('**/*.{sln,slnx}', EXCLUDE_PATTERN, 200)
      : [];
    const projectUris = workspaceFolders.length
      ? await vscode.workspace.findFiles('**/*.{csproj,fsproj,vbproj,proj}', EXCLUDE_PATTERN, 500)
      : [];

    const projectItems = sortItems(await Promise.all(
      projectUris.map(async (uri) => {
        const item = createItem(uri, 'project');
        item.metadata = await readProjectMetadata(uri);
        item.isTestProject = item.metadata.isTestProject;
        item.contents = await readProjectContents(uri);
        return item;
      })
    ));
    const projectByPath = new Map(projectItems.map((item) => [normalizePath(item.path), item]));
    const solutionItems = sortItems(await Promise.all(
      solutionUris.map(async (uri) => {
        const item = createItem(uri, 'solution');
        const solutionChildren = await this.getSolutionChildren(uri, projectByPath);
        item.children = solutionChildren.children;
        item.unloadedCount = solutionChildren.unloadedCount;
        return item;
      })
    ));

    const customItems = sortItems(await this.getCustomItems());

    return {
      hasWorkspace: workspaceFolders.length > 0,
      workspace: {
        name: vscode.workspace.name || workspaceFolders.map((folder) => folder.name).join(', ') || 'No workspace',
        folders: workspaceFolders.map((folder) => ({
          name: folder.name,
          uri: folder.uri.toString(),
          path: folder.uri.fsPath
        }))
      },
      scannedAt: new Date().toISOString(),
      counts: {
        solutions: solutionItems.length,
        projects: projectItems.length,
        pinned: customItems.length
      },
      solutions: solutionItems,
      projects: projectItems,
      customItems
    };
  }

  async addCustomItems(uris) {
    const existing = new Set(this.context.workspaceState.get(CUSTOM_ITEMS_KEY, []));

    for (const uri of uris) {
      if (isSupportedFile(uri)) {
        existing.add(uri.toString());
      }
    }

    await this.context.workspaceState.update(CUSTOM_ITEMS_KEY, [...existing]);
  }

  async removeCustomItem(uri) {
    const existing = this.context.workspaceState.get(CUSTOM_ITEMS_KEY, []);
    await this.context.workspaceState.update(
      CUSTOM_ITEMS_KEY,
      existing.filter((value) => value !== uri.toString())
    );
  }

  async getCustomItems() {
    const values = this.context.workspaceState.get(CUSTOM_ITEMS_KEY, []);
    const items = [];

    for (const value of values) {
      try {
        const uri = vscode.Uri.parse(value);
        const stat = await vscode.workspace.fs.stat(uri);

        if (stat.type & vscode.FileType.File && isSupportedFile(uri)) {
          const kind = getKind(uri);
          const item = createItem(uri, kind, true);

          if (kind === 'solution') {
            const solutionChildren = await this.getSolutionChildren(uri, new Map());
            item.children = solutionChildren.children;
            item.unloadedCount = solutionChildren.unloadedCount;
          } else {
            item.metadata = await readProjectMetadata(uri);
            item.isTestProject = item.metadata.isTestProject;
            item.contents = await readProjectContents(uri);
          }

          items.push(item);
        }
      } catch {
        continue;
      }
    }

    return items;
  }

  async getSolutionChildren(solutionUri, projectByPath) {
    const references = await readSolutionProjectReferences(solutionUri);
    const children = [];
    let unloadedCount = 0;

    for (const reference of references) {
      const item = projectByPath.get(normalizePath(reference.path)) || await createReferencedProjectItem(reference);
      if (item) {
        children.push({
          id: item.id,
          name: item.name,
          fileName: item.fileName,
          path: item.path,
          relativePath: item.relativePath,
          uri: item.uri,
          kind: item.kind,
          solutionFolders: reference.solutionFolders,
          metadata: item.metadata,
          isTestProject: item.isTestProject,
          contents: item.contents || []
        });
      } else {
        unloadedCount += 1;
      }
    }

    return {
      children: sortItems(children),
      unloadedCount
    };
  }
}

function createItem(uri, kind, pinned = false) {
  const extension = path.extname(uri.fsPath).toLowerCase();
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);

  return {
    id: `${kind}:${uri.toString()}`,
    kind,
    name: path.basename(uri.fsPath, extension),
    fileName: path.basename(uri.fsPath),
    extension,
    path: uri.fsPath,
    uri: uri.toString(),
    relativePath: workspaceFolder ? vscode.workspace.asRelativePath(uri, false) : uri.fsPath,
    workspaceFolder: workspaceFolder ? workspaceFolder.name : undefined,
    pinned,
    children: [],
    contents: []
  };
}

async function createReferencedProjectItem(reference) {
  const uri = vscode.Uri.file(reference.path);

  try {
    const stat = await vscode.workspace.fs.stat(uri);

    if (!(stat.type & vscode.FileType.File)) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  const item = createItem(uri, 'project');
  item.metadata = await readProjectMetadata(uri);
  item.isTestProject = item.metadata.isTestProject;

  if (reference.name) {
    item.name = reference.name;
  }

  return item;
}

async function readProjectMetadata(projectUri) {
  try {
    const buffer = await vscode.workspace.fs.readFile(projectUri);
    return readProjectMetadataFromText(Buffer.from(buffer).toString('utf8'), projectUri.fsPath);
  } catch {
    return emptyProjectMetadata(projectUri.fsPath);
  }
}

function readProjectMetadataFromText(text, projectPath = '') {
  const targetFrameworks = readTargetFrameworks(text);
  const packageReferences = readPackageReferences(text);
  const projectReferences = readProjectReferences(text);
  const assemblyReferences = readSimpleIncludeReferences(text, 'Reference');
  const frameworkReferences = readSimpleIncludeReferences(text, 'FrameworkReference');
  const analyzerReferences = readSimpleIncludeReferences(text, 'Analyzer');
  const rootNamespace = readSingleXmlValue(text, 'RootNamespace');
  const assemblyName = readSingleXmlValue(text, 'AssemblyName');
  const outputType = readSingleXmlValue(text, 'OutputType');
  const nullable = readSingleXmlValue(text, 'Nullable');
  const langVersion = readSingleXmlValue(text, 'LangVersion');
  const sdk = readProjectSdk(text);
  const projectName = path.basename(projectPath, path.extname(projectPath));
  const isTestProject = detectTestProject(projectPath, projectName, packageReferences);

  return {
    analyzerReferences,
    assemblyName,
    assemblyReferences,
    frameworkReferences,
    langVersion,
    nullable,
    outputType,
    targetFrameworks,
    packageReferences,
    projectReferences,
    rootNamespace,
    sdk,
    sourceGenerators: readSourceGenerators(packageReferences, analyzerReferences),
    isTestProject
  };
}

function emptyProjectMetadata(projectPath) {
  return {
    analyzerReferences: [],
    assemblyName: undefined,
    assemblyReferences: [],
    frameworkReferences: [],
    langVersion: undefined,
    nullable: undefined,
    outputType: undefined,
    targetFrameworks: [],
    packageReferences: [],
    projectReferences: [],
    rootNamespace: undefined,
    sdk: undefined,
    sourceGenerators: [],
    isTestProject: detectTestProject(projectPath, path.basename(projectPath, path.extname(projectPath)), [])
  };
}

function readTargetFrameworks(text) {
  const targetFrameworks = readSingleXmlValue(text, 'TargetFrameworks');

  if (targetFrameworks) {
    return targetFrameworks.split(';').map((value) => value.trim()).filter(Boolean);
  }

  const targetFramework = readSingleXmlValue(text, 'TargetFramework');
  return targetFramework ? [targetFramework] : [];
}

function readPackageReferences(text) {
  const references = [];
  const tagPattern = /<PackageReference\b([^>]*)\/?>/gi;
  let match = tagPattern.exec(text);

  while (match) {
    const attrs = readXmlAttributes(match[1]);

    if (attrs.Include || attrs.Update) {
      references.push({
        name: attrs.Include || attrs.Update,
        version: attrs.Version
      });
    }

    match = tagPattern.exec(text);
  }

  return references;
}

function readProjectReferences(text) {
  const references = [];
  const tagPattern = /<ProjectReference\b([^>]*)\/?>/gi;
  let match = tagPattern.exec(text);

  while (match) {
    const attrs = readXmlAttributes(match[1]);

    if (attrs.Include) {
      references.push({
        name: attrs.Include,
        version: undefined
      });
    }

    match = tagPattern.exec(text);
  }

  return references;
}

function readSimpleIncludeReferences(text, elementName) {
  const references = [];
  const tagPattern = new RegExp(`<${elementName}\\b([^>]*)\\/?>`, 'gi');
  let match = tagPattern.exec(text);

  while (match) {
    const attrs = readXmlAttributes(match[1]);

    if (attrs.Include) {
      references.push({
        name: attrs.Include,
        version: attrs.Version
      });
    }

    match = tagPattern.exec(text);
  }

  return references;
}

function readProjectSdk(text) {
  const projectMatch = /<Project\b([^>]*)>/i.exec(text);

  if (projectMatch) {
    const attrs = readXmlAttributes(projectMatch[1]);

    if (attrs.Sdk) {
      return attrs.Sdk;
    }
  }

  const sdkMatch = /<Sdk\b([^>]*)\/?>/i.exec(text);

  if (sdkMatch) {
    const attrs = readXmlAttributes(sdkMatch[1]);
    return attrs.Name || attrs.Sdk;
  }

  return undefined;
}

function readSourceGenerators(packageReferences, analyzerReferences) {
  const packageGenerators = packageReferences
    .filter((reference) => /generator|sourcegenerator/i.test(reference.name))
    .map((reference) => ({
      name: reference.name,
      version: reference.version
    }));
  const analyzerGenerators = analyzerReferences
    .filter((reference) => /generator|sourcegenerator/i.test(reference.name))
    .map((reference) => ({
      name: reference.name,
      version: reference.version
    }));

  return [...packageGenerators, ...analyzerGenerators];
}

function readSingleXmlValue(text, elementName) {
  const pattern = new RegExp(`<${elementName}>\\s*([^<]+?)\\s*<\\/${elementName}>`, 'i');
  const match = pattern.exec(text);
  return match ? match[1].trim() : undefined;
}

function readXmlAttributes(value) {
  const attrs = {};
  const attrPattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match = attrPattern.exec(value);

  while (match) {
    attrs[match[1]] = match[2] || match[3] || '';
    match = attrPattern.exec(value);
  }

  return attrs;
}

function detectTestProject(projectPath, projectName, packageReferences) {
  const normalized = `${projectPath} ${projectName}`.toLowerCase();

  if (normalized.includes('test')) {
    return true;
  }

  return packageReferences.some((reference) => {
    const name = reference.name.toLowerCase();
    return name === 'microsoft.net.test.sdk'
      || name.startsWith('xunit')
      || name.startsWith('nunit')
      || name.startsWith('mstest.');
  });
}

async function readProjectContents(projectUri) {
  try {
    const projectDirectory = vscode.Uri.file(path.dirname(projectUri.fsPath));
    const entries = await vscode.workspace.fs.readDirectory(projectDirectory);
    const folders = [];
    const files = [];

    for (const [name, type] of entries) {
      if (shouldSkipContentName(name)) {
        continue;
      }

      const childUri = vscode.Uri.joinPath(projectDirectory, name);

      if (type & vscode.FileType.Directory) {
        folders.push(createContentItem(childUri, 'folder'));
        continue;
      }

      if ((type & vscode.FileType.File) && path.extname(name).toLowerCase() === '.cs') {
        files.push(createContentItem(childUri, 'csharp'));
      }
    }

    return [
      ...sortItems(folders),
      ...sortItems(files)
    ];
  } catch {
    return [];
  }
}

function createContentItem(uri, kind) {
  const extension = path.extname(uri.fsPath).toLowerCase();
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);

  return {
    id: `${kind}:${uri.toString()}`,
    kind,
    name: extension ? path.basename(uri.fsPath, extension) : path.basename(uri.fsPath),
    fileName: path.basename(uri.fsPath),
    extension,
    path: uri.fsPath,
    uri: uri.toString(),
    relativePath: workspaceFolder ? vscode.workspace.asRelativePath(uri, false) : uri.fsPath,
    workspaceFolder: workspaceFolder ? workspaceFolder.name : undefined,
    children: []
  };
}

function shouldSkipContentName(name) {
  return name.startsWith('.') || CONTENT_EXCLUDE_NAMES.has(name.toLowerCase());
}

async function readSolutionProjectReferences(solutionUri) {
  try {
    const buffer = await vscode.workspace.fs.readFile(solutionUri);
    const text = Buffer.from(buffer).toString('utf8');
    return readSolutionProjectReferencesFromText(text, solutionUri.fsPath);
  } catch {
    return [];
  }
}

function readSolutionProjectReferencesFromText(text, solutionPath) {
  const solutionDir = path.dirname(solutionPath);
  const extension = path.extname(solutionPath).toLowerCase();

  if (extension === '.sln') {
    return readSlnProjectReferences(text, solutionDir);
  }

  return readSlnxProjectReferences(text, solutionDir);
}

function readSlnProjectReferences(text, solutionDir) {
  const foldersByGuid = new Map();
  const projectsByGuid = new Map();
  const parentByGuid = new Map();
  const projectPattern = /^Project\("([^"]+)"\)\s*=\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)"/gmi;
  let match = projectPattern.exec(text);

  while (match) {
    const typeGuid = normalizeGuid(match[1]);
    const name = match[2];
    const relativePath = match[3];
    const guid = normalizeGuid(match[4]);
    const extension = path.extname(relativePath).toLowerCase();

    if (PROJECT_EXTENSIONS.has(extension)) {
      projectsByGuid.set(guid, {
        name,
        path: resolveSolutionPath(solutionDir, relativePath)
      });
    } else if (typeGuid === '{2150e333-8fdc-42a3-9474-1a3956d46de8}' || !extension) {
      foldersByGuid.set(guid, name);
    }

    match = projectPattern.exec(text);
  }

  const nestedSection = /GlobalSection\(NestedProjects\)\s*=\s*preSolution([\s\S]*?)EndGlobalSection/i.exec(text);

  if (nestedSection) {
    const nestedPattern = /(\{[0-9a-f-]+\})\s*=\s*(\{[0-9a-f-]+\})/gi;
    let nestedMatch = nestedPattern.exec(nestedSection[1]);

    while (nestedMatch) {
      parentByGuid.set(normalizeGuid(nestedMatch[1]), normalizeGuid(nestedMatch[2]));
      nestedMatch = nestedPattern.exec(nestedSection[1]);
    }
  }

  return [...projectsByGuid.entries()].map(([guid, project]) => ({
    ...project,
    solutionFolders: getSolutionFolderPath(guid, foldersByGuid, parentByGuid)
  }));
}

function readSlnxProjectReferences(text, solutionDir) {
  const references = [];
  const lines = text.split(/\r?\n/);
  const folderStack = [];

  for (const line of lines) {
    const folderOpen = line.match(/<Folder\b[^>]*(?:Name|name)=["']([^"']+)["'][^>]*>/);
    if (folderOpen) {
      folderStack.push(parseSlnxFolderName(folderOpen[1]));
    }

    const projectMatch = line.match(/<(?:Project|project)\b[^>]*(?:Path|path)=["']([^"']+\.(?:csproj|fsproj|vbproj|proj))["']/);
    if (projectMatch) {
      references.push({
        path: resolveSolutionPath(solutionDir, projectMatch[1]),
        solutionFolders: folderStack.flat()
      });
    }

    if (/<\/Folder>/i.test(line) && folderStack.length > 0) {
      folderStack.pop();
    }
  }

  return uniqueReferences(references);
}

function parseSlnxFolderName(value) {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
}

function getSolutionFolderPath(guid, foldersByGuid, parentByGuid) {
  const parts = [];
  const seen = new Set();
  let current = parentByGuid.get(guid);

  while (current && !seen.has(current)) {
    seen.add(current);

    if (foldersByGuid.has(current)) {
      parts.unshift(foldersByGuid.get(current));
    }

    current = parentByGuid.get(current);
  }

  return parts;
}

function uniqueReferences(references) {
  const result = [];
  const seen = new Set();

  for (const reference of references) {
    const key = normalizePath(reference.path);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(reference);
  }

  return result;
}

function resolveSolutionPath(solutionDir, relativePath) {
  return path.resolve(solutionDir, relativePath.replace(/\\/g, path.sep));
}

function normalizeGuid(value) {
  return value.toLowerCase();
}

function getKind(uri) {
  const extension = path.extname(uri.fsPath).toLowerCase();

  if (SOLUTION_EXTENSIONS.has(extension)) {
    return 'solution';
  }

  return 'project';
}

function isSupportedFile(uri) {
  const extension = path.extname(uri.fsPath).toLowerCase();
  return SOLUTION_EXTENSIONS.has(extension) || PROJECT_EXTENSIONS.has(extension);
}

function sortItems(items) {
  return [...items].sort((left, right) => {
    const byName = left.fileName.localeCompare(right.fileName, undefined, {
      sensitivity: 'base'
    });

    if (byName !== 0) {
      return byName;
    }

    return left.relativePath.localeCompare(right.relativePath, undefined, {
      sensitivity: 'base'
    });
  });
}

function normalizePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'linux' ? resolved : resolved.toLowerCase();
}

module.exports = {
  WorkspaceScanner,
  readProjectMetadataFromText,
  readSolutionProjectReferencesFromText
};
