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
exports.WorkspaceScanner = void 0;
exports.enrichPackageReferencesWithCentralVersions = enrichPackageReferencesWithCentralVersions;
exports.enrichPackagesWithPackageSourceMappings = enrichPackagesWithPackageSourceMappings;
exports.enrichResolvedDependenciesWithPackageSourceMappings = enrichResolvedDependenciesWithPackageSourceMappings;
exports.enrichImportsWithImplicitDirectoryBuildFiles = enrichImportsWithImplicitDirectoryBuildFiles;
exports.readCentralPackageVersions = readCentralPackageVersions;
exports.readCentralPackageVersionsFromText = readCentralPackageVersionsFromText;
exports.readGlobalJson = readGlobalJson;
exports.readGlobalJsonFromText = readGlobalJsonFromText;
exports.readNuGetConfig = readNuGetConfig;
exports.readNuGetConfigFromText = readNuGetConfigFromText;
exports.readMsBuildFileSummaryFromText = readMsBuildFileSummaryFromText;
exports.readPackageLockFile = readPackageLockFile;
exports.readPackageLockFileFromText = readPackageLockFileFromText;
exports.readPublishProfileFromText = readPublishProfileFromText;
exports.readPublishProfiles = readPublishProfiles;
exports.readProjectMetadataFromText = readProjectMetadataFromText;
exports.readSolutionContentsFromText = readSolutionContentsFromText;
exports.readSolutionProjectReferencesFromText = readSolutionProjectReferencesFromText;
exports.readUserSecrets = readUserSecrets;
exports.readUserSecretsFromText = readUserSecretsFromText;
exports.resolveUserSecretsPath = resolveUserSecretsPath;
// @ts-nocheck
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const projectAssetsReader_1 = require("#src/projectAssetsReader");
const CUSTOM_ITEMS_KEY = 'solutionManager.customItems';
const EXCLUDE_PATTERN = '**/{node_modules,.git,.vs,bin,obj,out,dist,coverage}/**';
const CONTENT_EXCLUDE_NAMES = new Set(['bin', 'obj', 'out', 'dist', 'coverage', 'node_modules', 'packages']);
const PROJECT_EXTENSIONS = new Set(['.csproj', '.fsproj', '.vbproj', '.proj']);
const SOLUTION_EXTENSIONS = new Set(['.sln', '.slnx']);
class WorkspaceScanner {
    constructor(context) {
        this.context = context;
        this.projectCache = new Map();
        this.sharedDirty = false;
        this.registerInvalidationWatchers();
    }
    registerInvalidationWatchers() {
        const markSharedDirty = () => {
            this.sharedDirty = true;
        };
        const sharedWatcher = vscode.workspace.createFileSystemWatcher('**/{Directory.Build.props,Directory.Build.targets,Directory.Packages.props,nuget.config,NuGet.Config,NuGet.config,global.json,packages.lock.json,project.assets.json}');
        sharedWatcher.onDidCreate(markSharedDirty);
        sharedWatcher.onDidChange(markSharedDirty);
        sharedWatcher.onDidDelete(markSharedDirty);
        const projectWatcher = vscode.workspace.createFileSystemWatcher('**/*.{csproj,fsproj,vbproj,proj}');
        const dropProject = (uri) => this.projectCache.delete(normalizePath(uri.fsPath));
        projectWatcher.onDidChange(dropProject);
        projectWatcher.onDidCreate(dropProject);
        projectWatcher.onDidDelete(dropProject);
        const folderListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
            this.projectCache.clear();
            this.sharedDirty = true;
        });
        if (this.context && Array.isArray(this.context.subscriptions)) {
            this.context.subscriptions.push(sharedWatcher, projectWatcher, folderListener);
        }
    }
    async getCachedProjectData(uri) {
        const key = normalizePath(uri.fsPath);
        let mtime = 0;
        try {
            mtime = (await vscode.workspace.fs.stat(uri)).mtime;
        }
        catch {
            mtime = 0;
        }
        const cached = this.projectCache.get(key);
        if (cached && cached.mtime === mtime) {
            return cached;
        }
        const metadata = await readProjectMetadata(uri);
        const entry = {
            mtime,
            metadata,
            isTestProject: metadata.isTestProject,
            contents: await readProjectContents(uri)
        };
        this.projectCache.set(key, entry);
        return entry;
    }
    async scan(options = {}) {
        if (options.force || this.sharedDirty) {
            this.projectCache.clear();
            this.sharedDirty = false;
        }
        const workspaceFolders = vscode.workspace.workspaceFolders || [];
        const solutionUris = workspaceFolders.length
            ? await vscode.workspace.findFiles('**/*.{sln,slnx}', EXCLUDE_PATTERN, 200)
            : [];
        const projectUris = workspaceFolders.length
            ? await vscode.workspace.findFiles('**/*.{csproj,fsproj,vbproj,proj}', EXCLUDE_PATTERN, 500)
            : [];
        const projectItems = sortItems(await Promise.all(projectUris.map(async (uri) => {
            const item = createItem(uri, 'project');
            const cached = await this.getCachedProjectData(uri);
            item.metadata = cached.metadata;
            item.isTestProject = cached.isTestProject;
            item.contents = cached.contents;
            return item;
        })));
        const projectByPath = new Map(projectItems.map((item) => [normalizePath(item.path), item]));
        const solutionItems = sortItems(await Promise.all(solutionUris.map(async (uri) => {
            const item = createItem(uri, 'solution');
            const solutionChildren = await this.getSolutionChildren(uri, projectByPath);
            item.children = solutionChildren.children;
            item.solutionFolders = solutionChildren.solutionFolders;
            item.unloadedCount = solutionChildren.unloadedCount;
            return item;
        })));
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
        await this.context.workspaceState.update(CUSTOM_ITEMS_KEY, existing.filter((value) => value !== uri.toString()));
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
                        item.solutionFolders = solutionChildren.solutionFolders;
                        item.unloadedCount = solutionChildren.unloadedCount;
                    }
                    else {
                        item.metadata = await readProjectMetadata(uri);
                        item.isTestProject = item.metadata.isTestProject;
                        item.contents = await readProjectContents(uri);
                    }
                    items.push(item);
                }
            }
            catch {
                continue;
            }
        }
        return items;
    }
    async getSolutionChildren(solutionUri, projectByPath) {
        const contents = await readSolutionContents(solutionUri);
        const references = contents.references;
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
            }
            else {
                unloadedCount += 1;
            }
        }
        return {
            children: sortItems(children),
            solutionFolders: contents.folders,
            unloadedCount
        };
    }
}
exports.WorkspaceScanner = WorkspaceScanner;
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
    }
    catch {
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
        const metadata = readProjectMetadataFromText(Buffer.from(buffer).toString('utf8'), projectUri.fsPath);
        metadata.centralPackageVersions = await readCentralPackageVersions(projectUri);
        metadata.packageReferences = enrichPackageReferencesWithCentralVersions(metadata.packageReferences, metadata.centralPackageVersions);
        metadata.sourceGenerators = readSourceGenerators(metadata.packageReferences, metadata.analyzerReferences);
        metadata.imports = await enrichImportsWithImplicitDirectoryBuildFiles(projectUri, metadata.imports);
        metadata.resolvedDependencies = await readResolvedDependencies(projectUri);
        metadata.nugetConfig = await readNuGetConfig(projectUri);
        metadata.packageReferences = enrichPackagesWithPackageSourceMappings(metadata.packageReferences, metadata.nugetConfig);
        metadata.resolvedDependencies = enrichResolvedDependenciesWithPackageSourceMappings(metadata.resolvedDependencies, metadata.nugetConfig);
        metadata.publishProfiles = await readPublishProfiles(projectUri);
        metadata.globalJson = await readGlobalJson(projectUri);
        metadata.packageLock = await readPackageLockFile(projectUri, metadata.buildSettings);
        metadata.userSecrets = await readUserSecrets(metadata.buildSettings?.userSecretsId);
        return metadata;
    }
    catch {
        return emptyProjectMetadata(projectUri.fsPath);
    }
}
function readProjectMetadataFromText(text, projectPath = '') {
    const propertyEntries = readPropertyEntries(text);
    const propertyMap = buildPropertyMap(propertyEntries);
    const targetFrameworks = readTargetFrameworks(text);
    const packageReferences = readPackageReferences(text);
    const projectReferences = readProjectReferences(text, projectPath);
    const assemblyReferences = readSimpleIncludeReferences(text, 'Reference');
    const frameworkReferences = readSimpleIncludeReferences(text, 'FrameworkReference');
    const analyzerReferences = readSimpleIncludeReferences(text, 'Analyzer');
    const projectItems = readProjectItems(text, projectPath);
    const rootNamespace = readPropertyValue(propertyMap, 'RootNamespace');
    const assemblyName = readPropertyValue(propertyMap, 'AssemblyName');
    const outputType = readPropertyValue(propertyMap, 'OutputType');
    const nullable = readPropertyValue(propertyMap, 'Nullable');
    const langVersion = readPropertyValue(propertyMap, 'LangVersion');
    const sdk = readProjectSdk(text);
    const projectName = path.basename(projectPath, path.extname(projectPath));
    const isTestProject = detectTestProject(projectPath, projectName, packageReferences);
    const buildSettings = readBuildSettings(propertyMap);
    return {
        analyzerReferences,
        assembly: readAssemblyMetadata(propertyMap),
        assemblyName,
        assemblyReferences,
        frameworkReferences,
        globalJson: undefined,
        langVersion,
        nullable,
        outputType,
        buildEvents: readBuildEvents(propertyMap),
        buildSettings,
        configurations: readConfigurationProperties(propertyEntries),
        centralPackageVersions: [],
        imports: readImports(text, projectPath, sdk),
        nugetConfig: undefined,
        package: readPackageMetadata(propertyMap),
        packageLock: undefined,
        publishProfiles: [],
        projectItems,
        inspections: readInspectionSettings(propertyMap),
        targetFrameworks,
        packageReferences,
        properties: propertyEntries,
        projectReferences,
        rootNamespace,
        resolvedDependencies: {},
        signing: readSigningSettings(propertyMap),
        sdk,
        sourceGenerators: readSourceGenerators(packageReferences, analyzerReferences),
        targets: readTargets(text),
        userSecrets: createUserSecretsMetadata(buildSettings.userSecretsId),
        isTestProject
    };
}
function emptyProjectMetadata(projectPath) {
    return {
        analyzerReferences: [],
        assembly: {},
        assemblyName: undefined,
        assemblyReferences: [],
        buildEvents: {},
        buildSettings: {},
        configurations: [],
        centralPackageVersions: [],
        frameworkReferences: [],
        globalJson: undefined,
        imports: [],
        langVersion: undefined,
        nullable: undefined,
        outputType: undefined,
        nugetConfig: undefined,
        package: {},
        packageLock: undefined,
        publishProfiles: [],
        inspections: {},
        targetFrameworks: [],
        packageReferences: [],
        properties: [],
        projectReferences: [],
        rootNamespace: undefined,
        resolvedDependencies: {},
        signing: {},
        sdk: undefined,
        sourceGenerators: [],
        targets: [],
        userSecrets: createUserSecretsMetadata(),
        isTestProject: detectTestProject(projectPath, path.basename(projectPath, path.extname(projectPath)), [])
    };
}
async function readResolvedDependencies(projectUri) {
    try {
        const assetsUri = vscode.Uri.joinPath(vscode.Uri.file(path.dirname(projectUri.fsPath)), 'obj', 'project.assets.json');
        const buffer = await vscode.workspace.fs.readFile(assetsUri);
        return resolveResolvedDependencyPaths((0, projectAssetsReader_1.readProjectAssetsFromText)(Buffer.from(buffer).toString('utf8')), projectUri.fsPath);
    }
    catch {
        return {};
    }
}
async function readCentralPackageVersions(projectUri) {
    const propsUri = await findNearestCentralPackageProps(projectUri);
    if (!propsUri) {
        return [];
    }
    try {
        const buffer = await vscode.workspace.fs.readFile(propsUri);
        return readCentralPackageVersionsFromText(Buffer.from(buffer).toString('utf8'), propsUri.fsPath);
    }
    catch {
        return [];
    }
}
async function readNuGetConfig(projectUri) {
    const configUri = await findNearestAncestorFile(projectUri, ['NuGet.config', 'nuget.config', 'NuGet.Config']);
    if (!configUri) {
        return undefined;
    }
    try {
        const buffer = await vscode.workspace.fs.readFile(configUri);
        return readNuGetConfigFromText(Buffer.from(buffer).toString('utf8'), configUri.fsPath);
    }
    catch {
        return undefined;
    }
}
async function readPackageLockFile(projectUri, buildSettings = {}) {
    const lockLocation = resolvePackageLockLocation(projectUri, buildSettings.nuGetLockFilePath);
    if (!lockLocation.path) {
        return {
            configuredPath: lockLocation.configuredPath,
            fileName: lockLocation.fileName || 'packages.lock.json',
            exists: false,
            unresolved: true,
            version: undefined,
            targetFrameworks: [],
            packages: []
        };
    }
    try {
        const buffer = await vscode.workspace.fs.readFile(vscode.Uri.file(lockLocation.path));
        return readPackageLockFileFromText(Buffer.from(buffer).toString('utf8'), lockLocation.path);
    }
    catch {
        return {
            path: lockLocation.path,
            configuredPath: lockLocation.configuredPath,
            fileName: path.basename(lockLocation.path),
            exists: false,
            version: undefined,
            targetFrameworks: [],
            packages: []
        };
    }
}
function resolvePackageLockLocation(projectUri, configuredPath) {
    const rawPath = String(configuredPath || '').trim();
    if (rawPath && /[$%]/.test(rawPath)) {
        return {
            configuredPath: rawPath,
            fileName: path.basename(rawPath.replace(/\\/g, '/'))
        };
    }
    const lockPath = rawPath || 'packages.lock.json';
    const normalizedPath = lockPath.replace(/\\/g, path.sep);
    const resolvedPath = path.isAbsolute(normalizedPath)
        ? normalizedPath
        : path.resolve(path.dirname(projectUri.fsPath), normalizedPath);
    return {
        path: resolvedPath,
        configuredPath: rawPath || undefined,
        fileName: path.basename(resolvedPath)
    };
}
function readPackageLockFileFromText(text, lockPath = '') {
    const fileName = lockPath ? path.basename(lockPath) : 'packages.lock.json';
    let data;
    try {
        data = JSON.parse(text || '{}');
    }
    catch (error) {
        return {
            path: lockPath,
            fileName,
            exists: true,
            parseError: getErrorMessage(error),
            version: undefined,
            targetFrameworks: [],
            packages: []
        };
    }
    const dependencyGroups = isObjectRecord(data.dependencies) ? data.dependencies : {};
    const packages = [];
    for (const [targetFramework, dependencies] of Object.entries(dependencyGroups)) {
        if (!isObjectRecord(dependencies)) {
            continue;
        }
        for (const [name, dependency] of Object.entries(dependencies)) {
            const entry = isObjectRecord(dependency) ? dependency : {};
            packages.push({
                targetFramework,
                name,
                type: stringifyOptionalJsonValue(entry.type),
                requested: stringifyOptionalJsonValue(entry.requested),
                resolved: stringifyOptionalJsonValue(entry.resolved),
                contentHash: stringifyOptionalJsonValue(entry.contentHash),
                dependencies: readPackageLockDependencyEntries(entry.dependencies)
            });
        }
    }
    return {
        path: lockPath,
        fileName,
        exists: true,
        version: stringifyOptionalJsonValue(data.version),
        targetFrameworks: Object.keys(dependencyGroups),
        packages,
        directCount: packages.filter((item) => String(item.type || '').toLowerCase() === 'direct').length,
        transitiveCount: packages.filter((item) => String(item.type || '').toLowerCase() !== 'direct').length
    };
}
function readPackageLockDependencyEntries(dependencies) {
    if (!isObjectRecord(dependencies)) {
        return [];
    }
    return Object.entries(dependencies).map(([name, versionRange]) => ({
        name,
        versionRange: stringifyOptionalJsonValue(versionRange)
    }));
}
async function readUserSecrets(userSecretsId) {
    const metadata = createUserSecretsMetadata(userSecretsId);
    if (!metadata.path) {
        return metadata;
    }
    try {
        const buffer = await vscode.workspace.fs.readFile(vscode.Uri.file(metadata.path));
        return readUserSecretsFromText(Buffer.from(buffer).toString('utf8'), metadata.path, metadata.id);
    }
    catch {
        return {
            ...metadata,
            exists: false,
            keys: [],
            keyCount: 0
        };
    }
}
function createUserSecretsMetadata(userSecretsId) {
    const id = String(userSecretsId || '').trim();
    const secretsPath = resolveUserSecretsPath(id);
    return {
        id: id || undefined,
        path: secretsPath,
        fileName: secretsPath ? path.basename(secretsPath) : 'secrets.json',
        exists: undefined,
        keys: [],
        keyCount: 0
    };
}
function readUserSecretsFromText(text, secretsPath = '', userSecretsId = '') {
    const metadata = {
        id: userSecretsId || undefined,
        path: secretsPath,
        fileName: secretsPath ? path.basename(secretsPath) : 'secrets.json',
        exists: true,
        keys: [],
        keyCount: 0
    };
    try {
        const data = JSON.parse(text || '{}');
        const keys = flattenSecretKeys(data);
        return {
            ...metadata,
            keys,
            keyCount: keys.length
        };
    }
    catch (error) {
        return {
            ...metadata,
            parseError: getErrorMessage(error)
        };
    }
}
function resolveUserSecretsPath(userSecretsId) {
    const id = String(userSecretsId || '').trim();
    if (!id) {
        return undefined;
    }
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        return path.join(appData, 'Microsoft', 'UserSecrets', id, 'secrets.json');
    }
    return path.join(os.homedir(), '.microsoft', 'usersecrets', id, 'secrets.json');
}
function flattenSecretKeys(value, prefix = '') {
    if (!isObjectRecord(value)) {
        return prefix ? [prefix] : [];
    }
    const result = [];
    for (const [key, entry] of Object.entries(value)) {
        const nextPrefix = prefix ? `${prefix}:${key}` : key;
        if (isObjectRecord(entry)) {
            result.push(...flattenSecretKeys(entry, nextPrefix));
        }
        else {
            result.push(nextPrefix);
        }
    }
    return result.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
}
async function readGlobalJson(projectUri) {
    const globalJsonUri = await findNearestAncestorFile(projectUri, 'global.json');
    if (!globalJsonUri) {
        return undefined;
    }
    try {
        const buffer = await vscode.workspace.fs.readFile(globalJsonUri);
        return readGlobalJsonFromText(Buffer.from(buffer).toString('utf8'), globalJsonUri.fsPath);
    }
    catch (error) {
        return {
            path: globalJsonUri.fsPath,
            fileName: path.basename(globalJsonUri.fsPath),
            parseError: getErrorMessage(error),
            sdk: {},
            msbuildSdks: {}
        };
    }
}
function readGlobalJsonFromText(text, globalJsonPath = '') {
    const fileName = globalJsonPath ? path.basename(globalJsonPath) : 'global.json';
    let data;
    try {
        data = JSON.parse(text || '{}');
    }
    catch (error) {
        return {
            path: globalJsonPath,
            fileName,
            parseError: getErrorMessage(error),
            sdk: {},
            msbuildSdks: {}
        };
    }
    const sdk = isObjectRecord(data.sdk) ? data.sdk : {};
    const msbuildSdks = isObjectRecord(data['msbuild-sdks'])
        ? Object.fromEntries(Object.entries(data['msbuild-sdks']).map(([name, version]) => [name, stringifyOptionalJsonValue(version) || '']))
        : {};
    return {
        path: globalJsonPath,
        fileName,
        sdk: {
            version: stringifyOptionalJsonValue(sdk.version),
            rollForward: stringifyOptionalJsonValue(sdk.rollForward),
            allowPrerelease: stringifyOptionalJsonValue(sdk.allowPrerelease),
            paths: Array.isArray(sdk.paths) ? sdk.paths.map((value) => String(value)) : []
        },
        msbuildSdks
    };
}
function readNuGetConfigFromText(text, configPath = '') {
    const disabledSources = readNuGetConfigAddItems(text, 'disabledPackageSources')
        .filter((item) => String(item.value).toLowerCase() === 'true')
        .map((item) => item.key);
    const disabled = new Set(disabledSources.map((key) => String(key).toLowerCase()));
    const packageSources = readNuGetConfigAddItems(text, 'packageSources').map((item) => ({
        key: item.key,
        value: item.value,
        protocolVersion: item.protocolVersion,
        disabled: disabled.has(String(item.key).toLowerCase())
    }));
    const packageSourceMappings = readNuGetPackageSourceMappings(text);
    return {
        path: configPath,
        fileName: configPath ? path.basename(configPath) : 'NuGet.config',
        packageSources,
        packageSourceMappings,
        disabledSources
    };
}
function enrichResolvedDependenciesWithPackageSourceMappings(resolvedDependencies = {}, nugetConfig = {}) {
    return Object.fromEntries(Object.entries(resolvedDependencies || {}).map(([framework, dependencies]) => [
        framework,
        {
            ...dependencies,
            packages: enrichPackagesWithPackageSourceMappings(dependencies?.packages || [], nugetConfig)
        }
    ]));
}
function enrichPackagesWithPackageSourceMappings(packages = [], nugetConfig = {}) {
    const mappings = nugetConfig?.packageSourceMappings || [];
    if (!Array.isArray(packages)) {
        return [];
    }
    return packages.map((packageInfo) => {
        const matchedMappings = getMatchingPackageSourceMappings(packageInfo.name || packageInfo.include || packageInfo.packageName, mappings);
        return {
            ...packageInfo,
            packageSourceMappings: matchedMappings,
            packageSourceMappingSources: matchedMappings.map((mapping) => mapping.source),
            packageSourceMappingPatterns: matchedMappings.flatMap((mapping) => mapping.patterns || [])
        };
    });
}
function getMatchingPackageSourceMappings(packageName, mappings = []) {
    if (!packageName || !Array.isArray(mappings) || mappings.length === 0) {
        return [];
    }
    return mappings
        .map((mapping) => ({
        source: mapping.source,
        patterns: (mapping.patterns || []).filter((pattern) => isPackageSourcePatternMatch(pattern, packageName))
    }))
        .filter((mapping) => mapping.source && mapping.patterns.length > 0);
}
function isPackageSourcePatternMatch(pattern, packageName) {
    const text = String(pattern || '').trim();
    if (!text) {
        return false;
    }
    return matchWildcardPattern(text.toLowerCase(), String(packageName || '').toLowerCase());
}
function matchWildcardPattern(pattern, value) {
    const segments = pattern.split('*');
    if (segments.length === 1) {
        return value === pattern;
    }
    let index = 0;
    const first = segments[0];
    if (first) {
        if (!value.startsWith(first)) {
            return false;
        }
        index = first.length;
    }
    for (let position = 1; position < segments.length - 1; position += 1) {
        const segment = segments[position];
        if (!segment) {
            continue;
        }
        const found = value.indexOf(segment, index);
        if (found === -1) {
            return false;
        }
        index = found + segment.length;
    }
    const last = segments[segments.length - 1];
    if (last) {
        return value.length - index >= last.length && value.endsWith(last);
    }
    return true;
}
function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function isObjectRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function stringifyOptionalJsonValue(value) {
    return value === undefined || value === null ? undefined : String(value);
}
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error || 'Unknown error');
}
function readNuGetConfigAddItems(text, sectionName) {
    const sectionPattern = new RegExp(`<${sectionName}\\b[^>]*>([\\s\\S]*?)<\\/${sectionName}>`, 'i');
    const sectionMatch = sectionPattern.exec(text);
    if (!sectionMatch) {
        return [];
    }
    const items = [];
    const addPattern = /<add\b([^>]*)\/?>/gi;
    let match = addPattern.exec(sectionMatch[1]);
    while (match) {
        const attrs = readXmlAttributes(match[1]);
        if (attrs.key && attrs.value) {
            items.push({
                key: attrs.key,
                value: attrs.value,
                protocolVersion: attrs.protocolVersion
            });
        }
        match = addPattern.exec(sectionMatch[1]);
    }
    return items;
}
function readNuGetPackageSourceMappings(text) {
    const sectionPattern = /<packageSourceMapping\b[^>]*>([\s\S]*?)<\/packageSourceMapping>/i;
    const sectionMatch = sectionPattern.exec(text);
    if (!sectionMatch) {
        return [];
    }
    const mappings = [];
    const sourcePattern = /<packageSource\b([^>]*)>([\s\S]*?)<\/packageSource>/gi;
    let sourceMatch = sourcePattern.exec(sectionMatch[1]);
    while (sourceMatch) {
        const sourceAttrs = readXmlAttributes(sourceMatch[1]);
        const sourceKey = sourceAttrs.key;
        const patterns = [];
        const packagePattern = /<package\b([^>]*)\/?>/gi;
        let packageMatch = packagePattern.exec(sourceMatch[2]);
        while (packageMatch) {
            const packageAttrs = readXmlAttributes(packageMatch[1]);
            if (packageAttrs.pattern) {
                patterns.push(packageAttrs.pattern);
            }
            packageMatch = packagePattern.exec(sourceMatch[2]);
        }
        if (sourceKey) {
            mappings.push({
                source: sourceKey,
                patterns
            });
        }
        sourceMatch = sourcePattern.exec(sectionMatch[1]);
    }
    return mappings;
}
async function enrichImportsWithImplicitDirectoryBuildFiles(projectUri, imports) {
    const implicitImports = await readImplicitDirectoryBuildImports(projectUri);
    return enrichImportsWithMsBuildFileSummaries(mergeImports(imports || [], implicitImports));
}
async function readImplicitDirectoryBuildImports(projectUri) {
    const imports = [];
    const propsUri = await findNearestAncestorFile(projectUri, 'Directory.Build.props');
    const targetsUri = await findNearestAncestorFile(projectUri, 'Directory.Build.targets');
    if (propsUri) {
        imports.push(createImplicitDirectoryBuildImport(projectUri, propsUri, 'props'));
    }
    if (targetsUri) {
        imports.push(createImplicitDirectoryBuildImport(projectUri, targetsUri, 'targets'));
    }
    return imports;
}
function createImplicitDirectoryBuildImport(projectUri, importUri, kind) {
    const source = path.relative(path.dirname(projectUri.fsPath), importUri.fsPath) || path.basename(importUri.fsPath);
    return {
        name: path.basename(importUri.fsPath),
        source,
        path: importUri.fsPath,
        implicit: true,
        kind: `directory-build-${kind}`
    };
}
async function enrichImportsWithMsBuildFileSummaries(imports) {
    return Promise.all((imports || []).map(async (item) => {
        if (!shouldReadImportSummary(item)) {
            return item;
        }
        const summary = await readMsBuildFileSummary(item.path);
        if (!summary) {
            return item;
        }
        return {
            ...item,
            properties: summary.properties,
            targets: summary.targets,
            propertyCount: summary.properties.length,
            targetCount: summary.targets.length,
            taskCount: summary.targets.reduce((total, target) => total + (target.tasks || []).length, 0)
        };
    }));
}
function shouldReadImportSummary(item = {}) {
    if (!item.path) {
        return false;
    }
    const fileName = path.basename(item.path).toLowerCase();
    return fileName === 'directory.build.props'
        || fileName === 'directory.build.targets'
        || fileName.endsWith('.props')
        || fileName.endsWith('.targets');
}
async function readMsBuildFileSummary(filePath) {
    try {
        const buffer = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
        return readMsBuildFileSummaryFromText(Buffer.from(buffer).toString('utf8'));
    }
    catch {
        return undefined;
    }
}
function readMsBuildFileSummaryFromText(text) {
    return {
        properties: readPropertyEntries(text).map((property) => ({
            name: property.name,
            value: property.value,
            condition: property.condition,
            groupCondition: property.groupCondition
        })),
        targets: readTargets(text)
    };
}
function mergeImports(imports, implicitImports) {
    const result = [...imports];
    const seen = new Set(result.map((item) => normalizePath(item.path || item.source || item.name || '')));
    for (const item of implicitImports) {
        const key = normalizePath(item.path || item.source || item.name || '');
        if (!seen.has(key)) {
            result.splice(Math.max(result.length - 1, 0), 0, item);
            seen.add(key);
        }
    }
    return result;
}
async function findNearestCentralPackageProps(projectUri) {
    return findNearestAncestorFile(projectUri, 'Directory.Packages.props');
}
async function findNearestAncestorFile(projectUri, fileName) {
    const fileNames = Array.isArray(fileName) ? fileName : [fileName];
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(projectUri);
    const stopDirectory = workspaceFolder?.uri?.fsPath
        ? path.resolve(workspaceFolder.uri.fsPath)
        : path.parse(projectUri.fsPath).root;
    let currentDirectory = path.dirname(projectUri.fsPath);
    while (currentDirectory) {
        for (const name of fileNames) {
            const candidate = vscode.Uri.file(path.join(currentDirectory, name));
            try {
                const stat = await vscode.workspace.fs.stat(candidate);
                if (stat.type & vscode.FileType.File) {
                    return candidate;
                }
            }
            catch {
                // Keep checking candidates and walking toward the workspace root.
            }
        }
        if (normalizePath(currentDirectory) === normalizePath(stopDirectory)) {
            break;
        }
        const parentDirectory = path.dirname(currentDirectory);
        if (parentDirectory === currentDirectory) {
            break;
        }
        currentDirectory = parentDirectory;
    }
    return undefined;
}
function readCentralPackageVersionsFromText(text, propsPath = '') {
    return readItemReferences(text, 'PackageVersion')
        .filter((reference) => (reference.include || reference.name) && reference.version)
        .map((reference) => ({
        ...reference,
        name: reference.name || reference.include,
        include: reference.include || reference.name,
        path: propsPath,
        versionSource: 'Directory.Packages.props'
    }));
}
function enrichPackageReferencesWithCentralVersions(packageReferences, centralPackageVersions) {
    return (packageReferences || []).map((reference) => {
        const explicitVersion = reference.version || reference.versionOverride;
        const centralVersion = chooseCentralPackageVersion(reference, centralPackageVersions || []);
        if (explicitVersion || !centralVersion) {
            return {
                ...reference,
                version: reference.version || reference.versionOverride,
                versionSource: explicitVersion ? (reference.versionOverride && !reference.version ? 'PackageReference VersionOverride' : 'PackageReference') : undefined
            };
        }
        return {
            ...reference,
            version: centralVersion.version,
            centralVersion: centralVersion.version,
            centralPackageVersion: centralVersion,
            versionSource: 'Directory.Packages.props',
            versionSourcePath: centralVersion.path,
            versionSourceCondition: centralVersion.itemCondition || centralVersion.condition || centralVersion.groupCondition
        };
    });
}
function chooseCentralPackageVersion(reference, centralPackageVersions) {
    const name = String(reference.include || reference.name || '').toLowerCase();
    if (!name) {
        return undefined;
    }
    const matches = centralPackageVersions.filter((item) => {
        return String(item.include || item.name || '').toLowerCase() === name;
    });
    return matches.find((item) => !item.itemCondition && !item.condition && !item.groupCondition) || matches[0];
}
async function readPublishProfiles(projectUri) {
    try {
        const profileRoot = vscode.Uri.joinPath(vscode.Uri.file(path.dirname(projectUri.fsPath)), 'Properties', 'PublishProfiles');
        const entries = await vscode.workspace.fs.readDirectory(profileRoot);
        const profiles = [];
        for (const [fileName, fileType] of entries) {
            if (!(fileType & vscode.FileType.File) || path.extname(fileName).toLowerCase() !== '.pubxml') {
                continue;
            }
            const uri = vscode.Uri.joinPath(profileRoot, fileName);
            const buffer = await vscode.workspace.fs.readFile(uri);
            profiles.push(readPublishProfileFromText(Buffer.from(buffer).toString('utf8'), uri.fsPath));
        }
        return profiles.sort((a, b) => a.name.localeCompare(b.name));
    }
    catch {
        return [];
    }
}
function readPublishProfileFromText(text, profilePath = '') {
    const propertyMap = buildPropertyMap(readPropertyEntries(text));
    const fileName = path.basename(profilePath);
    const name = path.basename(profilePath, path.extname(profilePath));
    return {
        name,
        fileName,
        path: profilePath,
        publishMethod: readPropertyValue(propertyMap, 'WebPublishMethod') || readPropertyValue(propertyMap, 'PublishProtocol'),
        publishProvider: readPropertyValue(propertyMap, 'PublishProvider'),
        publishUrl: readPropertyValue(propertyMap, 'PublishUrl'),
        publishDir: readPropertyValue(propertyMap, 'PublishDir'),
        targetFramework: readPropertyValue(propertyMap, 'TargetFramework'),
        runtimeIdentifier: readPropertyValue(propertyMap, 'RuntimeIdentifier'),
        selfContained: readPropertyValue(propertyMap, 'SelfContained'),
        lastUsedBuildConfiguration: readPropertyValue(propertyMap, 'LastUsedBuildConfiguration'),
        lastUsedPlatform: readPropertyValue(propertyMap, 'LastUsedPlatform'),
        launchSiteAfterPublish: readPropertyValue(propertyMap, 'LaunchSiteAfterPublish'),
        deleteExistingFiles: readPropertyValue(propertyMap, 'DeleteExistingFiles'),
        excludeAppData: readPropertyValue(propertyMap, 'ExcludeApp_Data'),
        properties: readPropertyEntries(text)
    };
}
function resolveResolvedDependencyPaths(resolved, projectPath) {
    const result = {};
    for (const [framework, dependencies] of Object.entries(resolved || {})) {
        result[framework] = {
            ...dependencies,
            projects: (dependencies.projects || []).map((reference) => ({
                ...reference,
                path: reference.path ? resolveProjectRelativePath(projectPath, reference.path) : undefined
            }))
        };
    }
    return result;
}
function readTargetFrameworks(text) {
    const propertyMap = buildPropertyMap(readPropertyEntries(text));
    const targetFrameworks = readPropertyValue(propertyMap, 'TargetFrameworks');
    if (targetFrameworks) {
        return targetFrameworks.split(';').map((value) => value.trim()).filter(Boolean);
    }
    const targetFramework = readPropertyValue(propertyMap, 'TargetFramework');
    return targetFramework ? [targetFramework] : [];
}
function readPackageReferences(text) {
    return readItemReferences(text, 'PackageReference').map((reference) => ({
        ...reference,
        version: reference.version || reference.versionOverride
    }));
}
function readProjectReferences(text, projectPath = '') {
    return readItemReferences(text, 'ProjectReference', projectPath).map((reference) => ({
        ...reference,
        path: resolveProjectRelativePath(projectPath, reference.include || reference.name)
    }));
}
function readSimpleIncludeReferences(text, elementName) {
    return readItemReferences(text, elementName);
}
function readProjectItems(text, projectPath = '') {
    return {
        compile: readItemReferences(text, 'Compile', projectPath),
        content: readItemReferences(text, 'Content', projectPath),
        none: readItemReferences(text, 'None', projectPath),
        embeddedResources: readItemReferences(text, 'EmbeddedResource', projectPath),
        additionalFiles: readItemReferences(text, 'AdditionalFiles', projectPath)
    };
}
function readTargets(text) {
    const targets = [];
    const targetPattern = /<Target\b([^>]*)>([\s\S]*?)<\/Target>/gi;
    let match = targetPattern.exec(text);
    while (match) {
        const attrs = readXmlAttributes(match[1]);
        const body = match[2] || '';
        const name = attrs.Name;
        if (name) {
            targets.push({
                name,
                beforeTargets: attrs.BeforeTargets,
                afterTargets: attrs.AfterTargets,
                dependsOnTargets: attrs.DependsOnTargets,
                condition: attrs.Condition,
                inputs: attrs.Inputs,
                outputs: attrs.Outputs,
                keepDuplicateOutputs: attrs.KeepDuplicateOutputs,
                returns: attrs.Returns,
                tasks: readTargetTasks(body),
                body: stripTargetBody(body)
            });
        }
        match = targetPattern.exec(text);
    }
    return targets;
}
function readTargetTasks(body) {
    const tasks = [];
    const taskPattern = /<([A-Za-z_][\w.-]*)\b([^>]*?)(?:\/>|>)/g;
    let match = taskPattern.exec(body || '');
    while (match) {
        const name = match[1];
        if (name !== 'PropertyGroup' && name !== 'ItemGroup') {
            tasks.push({
                name,
                condition: readXmlAttributes(match[2] || '').Condition
            });
        }
        match = taskPattern.exec(body || '');
    }
    return tasks;
}
function stripTargetBody(body) {
    const value = String(body || '').trim();
    return value || undefined;
}
function readItemReferences(text, elementName, projectPath = '') {
    const references = [];
    const itemGroupPattern = /<ItemGroup\b([^>]*)>([\s\S]*?)<\/ItemGroup>/gi;
    let groupMatch = itemGroupPattern.exec(text);
    while (groupMatch) {
        const groupAttrs = readXmlAttributes(groupMatch[1]);
        const itemPattern = new RegExp(`<${elementName}\\b([^>]*)\\/>|<${elementName}\\b([^>]*)>([\\s\\S]*?)<\\/${elementName}>`, 'gi');
        let itemMatch = itemPattern.exec(groupMatch[2]);
        while (itemMatch) {
            const attrs = readXmlAttributes(itemMatch[1] || itemMatch[2] || '');
            const body = itemMatch[3] || '';
            const name = attrs.Include || attrs.Update || attrs.Remove;
            if (name) {
                const identityAttribute = attrs.Include ? 'Include' : attrs.Update ? 'Update' : attrs.Remove ? 'Remove' : 'Include';
                references.push({
                    name,
                    identity: name,
                    identityAttribute,
                    include: attrs.Include,
                    update: attrs.Update,
                    remove: attrs.Remove,
                    version: attrs.Version || readChildXmlValue(body, 'Version'),
                    versionOverride: attrs.VersionOverride || readChildXmlValue(body, 'VersionOverride'),
                    privateAssets: attrs.PrivateAssets || readChildXmlValue(body, 'PrivateAssets'),
                    includeAssets: attrs.IncludeAssets || readChildXmlValue(body, 'IncludeAssets'),
                    excludeAssets: attrs.ExcludeAssets || readChildXmlValue(body, 'ExcludeAssets'),
                    noWarn: attrs.NoWarn || readChildXmlValue(body, 'NoWarn'),
                    condition: attrs.Condition || groupAttrs.Condition,
                    itemCondition: attrs.Condition,
                    groupCondition: groupAttrs.Condition,
                    aliases: attrs.Aliases || readChildXmlValue(body, 'Aliases'),
                    private: attrs.Private || readChildXmlValue(body, 'Private'),
                    hintPath: attrs.HintPath || readChildXmlValue(body, 'HintPath'),
                    copyLocal: attrs.CopyLocal || readChildXmlValue(body, 'CopyLocal'),
                    outputItemType: attrs.OutputItemType || readChildXmlValue(body, 'OutputItemType'),
                    referenceOutputAssembly: attrs.ReferenceOutputAssembly || readChildXmlValue(body, 'ReferenceOutputAssembly'),
                    generatePathProperty: attrs.GeneratePathProperty || readChildXmlValue(body, 'GeneratePathProperty'),
                    copyToOutputDirectory: attrs.CopyToOutputDirectory || readChildXmlValue(body, 'CopyToOutputDirectory'),
                    copyToPublishDirectory: attrs.CopyToPublishDirectory || readChildXmlValue(body, 'CopyToPublishDirectory'),
                    link: attrs.Link || readChildXmlValue(body, 'Link'),
                    logicalName: attrs.LogicalName || readChildXmlValue(body, 'LogicalName'),
                    generator: attrs.Generator || readChildXmlValue(body, 'Generator'),
                    lastGenOutput: attrs.LastGenOutput || readChildXmlValue(body, 'LastGenOutput'),
                    dependentUpon: attrs.DependentUpon || readChildXmlValue(body, 'DependentUpon'),
                    subType: attrs.SubType || readChildXmlValue(body, 'SubType'),
                    path: resolveProjectRelativePath(projectPath, attrs.Include || attrs.Update || '')
                });
            }
            itemMatch = itemPattern.exec(groupMatch[2]);
        }
        groupMatch = itemGroupPattern.exec(text);
    }
    return references;
}
function readPropertyEntries(text) {
    const entries = [];
    const groupPattern = /<PropertyGroup\b([^>]*)>([\s\S]*?)<\/PropertyGroup>/gi;
    let groupMatch = groupPattern.exec(text);
    while (groupMatch) {
        const groupAttrs = readXmlAttributes(groupMatch[1]);
        const body = groupMatch[2];
        const propertyPattern = /<([A-Za-z_][\w.-]*)\b([^>]*)>([\s\S]*?)<\/\1>/g;
        let propertyMatch = propertyPattern.exec(body);
        while (propertyMatch) {
            const attrs = readXmlAttributes(propertyMatch[2]);
            const value = stripXmlValue(propertyMatch[3]);
            if (value !== undefined) {
                entries.push({
                    name: propertyMatch[1],
                    value,
                    condition: attrs.Condition,
                    groupCondition: groupAttrs.Condition
                });
            }
            propertyMatch = propertyPattern.exec(body);
        }
        groupMatch = groupPattern.exec(text);
    }
    return entries;
}
function buildPropertyMap(entries) {
    const map = new Map();
    for (const entry of entries) {
        const key = entry.name.toLowerCase();
        const existing = map.get(key);
        if (!existing || (!entry.condition && !entry.groupCondition && (existing.condition || existing.groupCondition))) {
            map.set(key, entry);
        }
    }
    return map;
}
function readPropertyValue(propertyMap, name) {
    return propertyMap.get(name.toLowerCase())?.value;
}
function readSigningSettings(propertyMap) {
    return {
        signAssembly: readPropertyValue(propertyMap, 'SignAssembly'),
        keyFile: readPropertyValue(propertyMap, 'AssemblyOriginatorKeyFile'),
        delaySign: readPropertyValue(propertyMap, 'DelaySign'),
        publicSign: readPropertyValue(propertyMap, 'PublicSign')
    };
}
function readBuildEvents(propertyMap) {
    return {
        preBuildEvent: readPropertyValue(propertyMap, 'PreBuildEvent'),
        postBuildEvent: readPropertyValue(propertyMap, 'PostBuildEvent'),
        runPostBuildEvent: readPropertyValue(propertyMap, 'RunPostBuildEvent')
    };
}
function readBuildSettings(propertyMap) {
    return {
        outputPath: readPropertyValue(propertyMap, 'OutputPath'),
        baseOutputPath: readPropertyValue(propertyMap, 'BaseOutputPath'),
        intermediateOutputPath: readPropertyValue(propertyMap, 'IntermediateOutputPath'),
        targetFrameworkIdentifier: readPropertyValue(propertyMap, 'TargetFrameworkIdentifier'),
        targetFrameworkVersion: readPropertyValue(propertyMap, 'TargetFrameworkVersion'),
        targetFrameworkProfile: readPropertyValue(propertyMap, 'TargetFrameworkProfile'),
        targetPlatformIdentifier: readPropertyValue(propertyMap, 'TargetPlatformIdentifier'),
        targetPlatformVersion: readPropertyValue(propertyMap, 'TargetPlatformVersion'),
        targetPlatformMinVersion: readPropertyValue(propertyMap, 'TargetPlatformMinVersion'),
        supportedOSPlatformVersion: readPropertyValue(propertyMap, 'SupportedOSPlatformVersion'),
        appendTargetFrameworkToOutputPath: readPropertyValue(propertyMap, 'AppendTargetFrameworkToOutputPath'),
        appendRuntimeIdentifierToOutputPath: readPropertyValue(propertyMap, 'AppendRuntimeIdentifierToOutputPath'),
        copyLocalLockFileAssemblies: readPropertyValue(propertyMap, 'CopyLocalLockFileAssemblies'),
        restorePackagesWithLockFile: readPropertyValue(propertyMap, 'RestorePackagesWithLockFile'),
        restoreLockedMode: readPropertyValue(propertyMap, 'RestoreLockedMode'),
        nuGetLockFilePath: readPropertyValue(propertyMap, 'NuGetLockFilePath'),
        restoreUseStaticGraphEvaluation: readPropertyValue(propertyMap, 'RestoreUseStaticGraphEvaluation'),
        generateDocumentationFile: readPropertyValue(propertyMap, 'GenerateDocumentationFile'),
        documentationFile: readPropertyValue(propertyMap, 'DocumentationFile'),
        optimize: readPropertyValue(propertyMap, 'Optimize'),
        debugType: readPropertyValue(propertyMap, 'DebugType'),
        debugSymbols: readPropertyValue(propertyMap, 'DebugSymbols'),
        defineConstants: readPropertyValue(propertyMap, 'DefineConstants'),
        treatWarningsAsErrors: readPropertyValue(propertyMap, 'TreatWarningsAsErrors'),
        warningsAsErrors: readPropertyValue(propertyMap, 'WarningsAsErrors'),
        noWarn: readPropertyValue(propertyMap, 'NoWarn'),
        warningLevel: readPropertyValue(propertyMap, 'WarningLevel'),
        allowUnsafeBlocks: readPropertyValue(propertyMap, 'AllowUnsafeBlocks'),
        implicitUsings: readPropertyValue(propertyMap, 'ImplicitUsings'),
        platformTarget: readPropertyValue(propertyMap, 'PlatformTarget'),
        startupObject: readPropertyValue(propertyMap, 'StartupObject'),
        applicationIcon: readPropertyValue(propertyMap, 'ApplicationIcon'),
        userSecretsId: readPropertyValue(propertyMap, 'UserSecretsId'),
        useWpf: readPropertyValue(propertyMap, 'UseWPF'),
        useWindowsForms: readPropertyValue(propertyMap, 'UseWindowsForms'),
        runtimeIdentifier: readPropertyValue(propertyMap, 'RuntimeIdentifier'),
        runtimeIdentifiers: readPropertyValue(propertyMap, 'RuntimeIdentifiers'),
        runtimeFrameworkVersion: readPropertyValue(propertyMap, 'RuntimeFrameworkVersion'),
        rollForward: readPropertyValue(propertyMap, 'RollForward'),
        selfContained: readPropertyValue(propertyMap, 'SelfContained'),
        useAppHost: readPropertyValue(propertyMap, 'UseAppHost'),
        targetLatestRuntimePatch: readPropertyValue(propertyMap, 'TargetLatestRuntimePatch'),
        invariantGlobalization: readPropertyValue(propertyMap, 'InvariantGlobalization'),
        publishDir: readPropertyValue(propertyMap, 'PublishDir'),
        publishUrl: readPropertyValue(propertyMap, 'PublishUrl'),
        publishSingleFile: readPropertyValue(propertyMap, 'PublishSingleFile'),
        publishTrimmed: readPropertyValue(propertyMap, 'PublishTrimmed'),
        publishReadyToRun: readPropertyValue(propertyMap, 'PublishReadyToRun'),
        publishAot: readPropertyValue(propertyMap, 'PublishAot'),
        includeNativeLibrariesForSelfExtract: readPropertyValue(propertyMap, 'IncludeNativeLibrariesForSelfExtract'),
        enableCompressionInSingleFile: readPropertyValue(propertyMap, 'EnableCompressionInSingleFile'),
        deterministic: readPropertyValue(propertyMap, 'Deterministic'),
        continuousIntegrationBuild: readPropertyValue(propertyMap, 'ContinuousIntegrationBuild'),
        produceReferenceAssembly: readPropertyValue(propertyMap, 'ProduceReferenceAssembly'),
        emitCompilerGeneratedFiles: readPropertyValue(propertyMap, 'EmitCompilerGeneratedFiles'),
        compilerGeneratedFilesOutputPath: readPropertyValue(propertyMap, 'CompilerGeneratedFilesOutputPath'),
        checkForOverflowUnderflow: readPropertyValue(propertyMap, 'CheckForOverflowUnderflow')
    };
}
function readAssemblyMetadata(propertyMap) {
    return {
        title: readPropertyValue(propertyMap, 'AssemblyTitle'),
        version: readPropertyValue(propertyMap, 'AssemblyVersion'),
        fileVersion: readPropertyValue(propertyMap, 'FileVersion'),
        informationalVersion: readPropertyValue(propertyMap, 'InformationalVersion'),
        neutralLanguage: readPropertyValue(propertyMap, 'NeutralLanguage'),
        copyright: readPropertyValue(propertyMap, 'Copyright'),
        trademark: readPropertyValue(propertyMap, 'Trademark'),
        generateAssemblyInfo: readPropertyValue(propertyMap, 'GenerateAssemblyInfo'),
        comVisible: readPropertyValue(propertyMap, 'ComVisible'),
        guid: readPropertyValue(propertyMap, 'Guid'),
        clsCompliant: readPropertyValue(propertyMap, 'CLSCompliant')
    };
}
function readPackageMetadata(propertyMap) {
    return {
        packageId: readPropertyValue(propertyMap, 'PackageId'),
        version: readPropertyValue(propertyMap, 'Version'),
        packageVersion: readPropertyValue(propertyMap, 'PackageVersion'),
        authors: readPropertyValue(propertyMap, 'Authors'),
        company: readPropertyValue(propertyMap, 'Company'),
        product: readPropertyValue(propertyMap, 'Product'),
        description: readPropertyValue(propertyMap, 'Description'),
        releaseNotes: readPropertyValue(propertyMap, 'PackageReleaseNotes'),
        repositoryUrl: readPropertyValue(propertyMap, 'RepositoryUrl'),
        repositoryType: readPropertyValue(propertyMap, 'RepositoryType'),
        repositoryBranch: readPropertyValue(propertyMap, 'RepositoryBranch'),
        repositoryCommit: readPropertyValue(propertyMap, 'RepositoryCommit'),
        publishRepositoryUrl: readPropertyValue(propertyMap, 'PublishRepositoryUrl'),
        projectUrl: readPropertyValue(propertyMap, 'PackageProjectUrl') || readPropertyValue(propertyMap, 'ProjectUrl'),
        tags: readPropertyValue(propertyMap, 'PackageTags'),
        licenseExpression: readPropertyValue(propertyMap, 'PackageLicenseExpression'),
        licenseFile: readPropertyValue(propertyMap, 'PackageLicenseFile'),
        licenseUrl: readPropertyValue(propertyMap, 'PackageLicenseUrl'),
        readmeFile: readPropertyValue(propertyMap, 'PackageReadmeFile'),
        icon: readPropertyValue(propertyMap, 'PackageIcon'),
        iconUrl: readPropertyValue(propertyMap, 'PackageIconUrl'),
        requireLicenseAcceptance: readPropertyValue(propertyMap, 'PackageRequireLicenseAcceptance'),
        generatePackageOnBuild: readPropertyValue(propertyMap, 'GeneratePackageOnBuild'),
        isPackable: readPropertyValue(propertyMap, 'IsPackable'),
        includeSymbols: readPropertyValue(propertyMap, 'IncludeSymbols'),
        includeSource: readPropertyValue(propertyMap, 'IncludeSource'),
        symbolPackageFormat: readPropertyValue(propertyMap, 'SymbolPackageFormat'),
        packageOutputPath: readPropertyValue(propertyMap, 'PackageOutputPath'),
        includeBuildOutput: readPropertyValue(propertyMap, 'IncludeBuildOutput'),
        includeContentInPack: readPropertyValue(propertyMap, 'IncludeContentInPack'),
        contentTargetFolders: readPropertyValue(propertyMap, 'ContentTargetFolders'),
        developmentDependency: readPropertyValue(propertyMap, 'DevelopmentDependency'),
        serviceable: readPropertyValue(propertyMap, 'Serviceable'),
        minClientVersion: readPropertyValue(propertyMap, 'MinClientVersion'),
        packageType: readPropertyValue(propertyMap, 'PackageType'),
        packageValidationBaselineVersion: readPropertyValue(propertyMap, 'PackageValidationBaselineVersion'),
        packageValidationBaselineName: readPropertyValue(propertyMap, 'PackageValidationBaselineName'),
        embedUntrackedSources: readPropertyValue(propertyMap, 'EmbedUntrackedSources')
    };
}
function readInspectionSettings(propertyMap) {
    return {
        enableNetAnalyzers: readPropertyValue(propertyMap, 'EnableNETAnalyzers'),
        analysisLevel: readPropertyValue(propertyMap, 'AnalysisLevel'),
        analysisMode: readPropertyValue(propertyMap, 'AnalysisMode'),
        enforceCodeStyleInBuild: readPropertyValue(propertyMap, 'EnforceCodeStyleInBuild'),
        codeAnalysisTreatWarningsAsErrors: readPropertyValue(propertyMap, 'CodeAnalysisTreatWarningsAsErrors'),
        runAnalyzersDuringBuild: readPropertyValue(propertyMap, 'RunAnalyzersDuringBuild'),
        runAnalyzersDuringLiveAnalysis: readPropertyValue(propertyMap, 'RunAnalyzersDuringLiveAnalysis')
    };
}
function readConfigurationProperties(entries) {
    const configurations = new Map();
    for (const entry of entries) {
        const condition = entry.groupCondition || entry.condition;
        const configuration = parseConfigurationCondition(condition);
        if (!configuration) {
            continue;
        }
        const key = `${configuration.configuration}|${configuration.platform}`;
        const item = configurations.get(key) || {
            configuration: configuration.configuration,
            platform: configuration.platform,
            condition,
            properties: {}
        };
        item.properties[entry.name] = entry.value;
        configurations.set(key, item);
    }
    return [...configurations.values()].sort((left, right) => `${left.configuration}|${left.platform}`.localeCompare(`${right.configuration}|${right.platform}`));
}
function parseConfigurationCondition(condition) {
    if (!condition) {
        return undefined;
    }
    const match = /Configuration\)\|\$\(Platform\).*?['"]([^|'"]+)\|([^'"]+)['"]/i.exec(condition);
    if (!match) {
        return undefined;
    }
    return {
        configuration: match[1],
        platform: match[2]
    };
}
function readImports(text, projectPath, sdk) {
    const imports = [
        {
            name: 'Sdk.props',
            source: sdk || 'Project SDK',
            implicit: true,
            kind: 'sdk'
        }
    ];
    const importPattern = /<Import\b([^>]*)\/?>/gi;
    let match = importPattern.exec(text);
    while (match) {
        const attrs = readXmlAttributes(match[1]);
        const project = attrs.Project;
        if (project) {
            imports.push({
                name: getImportLabel(project),
                source: project,
                condition: attrs.Condition,
                label: attrs.Label,
                path: resolveProjectRelativePath(projectPath, project),
                implicit: false,
                kind: 'explicit'
            });
        }
        match = importPattern.exec(text);
    }
    imports.push({
        name: 'Sdk.targets',
        source: sdk || 'Project SDK',
        implicit: true,
        kind: 'sdk'
    });
    return imports;
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
        ...reference,
        name: reference.name,
        version: reference.version,
        source: 'package'
    }));
    const analyzerGenerators = analyzerReferences
        .filter((reference) => /generator|sourcegenerator/i.test(reference.name))
        .map((reference) => ({
        ...reference,
        name: reference.name,
        version: reference.version,
        source: 'analyzer'
    }));
    return [...packageGenerators, ...analyzerGenerators];
}
function readChildXmlValue(text, elementName) {
    const pattern = new RegExp(`<${elementName}\\b[^>]*>\\s*([\\s\\S]*?)\\s*<\\/${elementName}>`, 'i');
    const match = pattern.exec(text);
    return match ? stripXmlValue(match[1]) : undefined;
}
function stripXmlValue(value) {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) {
        return undefined;
    }
    return trimmed
        .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/i, '$1')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .trim();
}
function resolveProjectRelativePath(projectPath, value) {
    if (!projectPath || !value || /[$%*?]/.test(value)) {
        return undefined;
    }
    const normalizedValue = value.replace(/\\/g, path.sep);
    if (path.isAbsolute(normalizedValue)) {
        return normalizedValue;
    }
    return path.resolve(path.dirname(projectPath), normalizedValue);
}
function getImportLabel(value) {
    if (!value) {
        return 'Import';
    }
    const normalized = value.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    return parts[parts.length - 1] || value;
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
    }
    catch {
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
    const contents = await readSolutionContents(solutionUri);
    return contents.references;
}
async function readSolutionContents(solutionUri) {
    try {
        const buffer = await vscode.workspace.fs.readFile(solutionUri);
        const text = Buffer.from(buffer).toString('utf8');
        return readSolutionContentsFromText(text, solutionUri.fsPath);
    }
    catch {
        return {
            references: [],
            folders: []
        };
    }
}
function readSolutionProjectReferencesFromText(text, solutionPath) {
    return readSolutionContentsFromText(text, solutionPath).references;
}
function readSolutionContentsFromText(text, solutionPath) {
    const solutionDir = path.dirname(solutionPath);
    const extension = path.extname(solutionPath).toLowerCase();
    if (extension === '.sln') {
        return readSlnContents(text, solutionDir);
    }
    return readSlnxContents(text, solutionDir);
}
function readSlnProjectReferences(text, solutionDir) {
    return readSlnContents(text, solutionDir).references;
}
function readSlnContents(text, solutionDir) {
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
        }
        else if (typeGuid === '{2150e333-8fdc-42a3-9474-1a3956d46de8}' || !extension) {
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
    return {
        references: [...projectsByGuid.entries()].map(([guid, project]) => ({
            ...project,
            solutionFolders: getSolutionFolderPath(guid, foldersByGuid, parentByGuid)
        })),
        folders: [...foldersByGuid.keys()]
            .map((guid) => ({
            path: getSolutionFolderPathIncludingSelf(guid, foldersByGuid, parentByGuid)
        }))
            .filter((folder) => folder.path.length > 0)
    };
}
function readSlnxProjectReferences(text, solutionDir) {
    return readSlnxContents(text, solutionDir).references;
}
function readSlnxContents(text, solutionDir) {
    const references = [];
    const folders = [];
    const lines = text.split(/\r?\n/);
    const folderStack = [];
    for (const line of lines) {
        const folderOpen = line.match(/<Folder\b[^>]*(?:Name|name)=["']([^"']+)["'][^>]*>/);
        if (folderOpen) {
            folderStack.push(parseSlnxFolderName(folderOpen[1]));
            folders.push({
                path: folderStack.flat()
            });
        }
        const projectMatch = line.match(/<(?:Project|project)\b[^>]*(?:Path|path)=["']([^"']+\.(?:csproj|fsproj|vbproj|proj))["']/);
        if (projectMatch) {
            references.push({
                path: resolveSolutionPath(solutionDir, projectMatch[1]),
                solutionFolders: folderStack.flat()
            });
        }
        if (/\/>\s*$/.test(line) && folderOpen && folderStack.length > 0) {
            folderStack.pop();
            continue;
        }
        if (/<\/Folder>/i.test(line) && folderStack.length > 0) {
            folderStack.pop();
        }
    }
    return {
        references: uniqueReferences(references),
        folders: uniqueFolderPaths(folders)
    };
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
function getSolutionFolderPathIncludingSelf(guid, foldersByGuid, parentByGuid) {
    const parts = getSolutionFolderPath(guid, foldersByGuid, parentByGuid);
    const folderName = foldersByGuid.get(guid);
    if (folderName) {
        parts.push(folderName);
    }
    return parts;
}
function uniqueFolderPaths(folders) {
    const result = [];
    const seen = new Set();
    for (const folder of folders) {
        const pathParts = Array.isArray(folder.path) ? folder.path.filter(Boolean) : [];
        const key = pathParts.join('/').toLowerCase();
        if (!key || seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push({
            path: pathParts
        });
    }
    return result;
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
//# sourceMappingURL=workspaceScanner.js.map