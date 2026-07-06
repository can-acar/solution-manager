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
exports.__test = void 0;
exports.showProjectProperties = showProjectProperties;
// @ts-nocheck
const vscode = __importStar(require("vscode"));
const launchSettingsEditor_1 = require("#src/launchSettingsEditor");
const projectFileEditor_1 = require("#src/projectFileEditor");
const workspaceScanner_1 = require("#src/workspaceScanner");
const CONFIGURATION_EDITOR_PROPERTIES = [
    'OutputPath',
    'BaseOutputPath',
    'IntermediateOutputPath',
    'Optimize',
    'DefineConstants',
    'AllowUnsafeBlocks',
    'CheckForOverflowUnderflow',
    'DebugType',
    'DebugSymbols',
    'GenerateDocumentationFile',
    'DocumentationFile',
    'TreatWarningsAsErrors',
    'WarningsAsErrors',
    'NoWarn',
    'WarningLevel',
    'PlatformTarget',
    'RuntimeIdentifier',
    'SelfContained'
];
function showProjectProperties(context, project, metadata, onDidSave, onAction) {
    const panel = vscode.window.createWebviewPanel('solutionManager.projectProperties', `Project Properties - ${project.name}`, vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true
    });
    const nonce = getNonce();
    panel.webview.onDidReceiveMessage(async (message) => {
        if (message && message.command === 'close') {
            panel.dispose();
            return;
        }
        if (message && (message.command === 'applyProperties' || message.command === 'saveAndClose')) {
            try {
                let nextText = await (0, projectFileEditor_1.updateProjectProperties)(project.path, message.values || {});
                const packageReferenceOperations = createPackageReferenceOperations(message.values?.packageReferences || []);
                if (packageReferenceOperations.length > 0) {
                    nextText = await (0, projectFileEditor_1.updateProjectItemReferences)(project.path, packageReferenceOperations);
                }
                const referenceOperations = createReferenceOperations(message.values?.references || []);
                if (referenceOperations.length > 0) {
                    nextText = await (0, projectFileEditor_1.updateProjectItemReferences)(project.path, referenceOperations);
                }
                const projectItemOperations = createProjectItemOperations(message.values?.projectItems || []);
                if (projectItemOperations.length > 0) {
                    nextText = await (0, projectFileEditor_1.updateProjectItemReferences)(project.path, projectItemOperations);
                }
                await (0, launchSettingsEditor_1.updateProjectLaunchSettings)(project.path, message.values?.launchProfiles || []);
                const nextMetadata = (0, workspaceScanner_1.readProjectMetadataFromText)(nextText, project.path);
                nextMetadata.launchSettings = await (0, launchSettingsEditor_1.readProjectLaunchSettings)(project.path);
                panel.webview.html = getProjectPropertiesHtml(project, nextMetadata, getNonce(), 'Project properties saved.');
                vscode.window.setStatusBarMessage('Solution Manager: project properties saved.', 2500);
                if (onDidSave) {
                    await onDidSave();
                }
                if (message.command === 'saveAndClose') {
                    panel.dispose();
                }
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Solution Manager: ${errorMessage}`);
                panel.webview.postMessage({ command: 'saveFailed', message: errorMessage });
            }
        }
        if (message && message.command === 'projectAction' && onAction) {
            try {
                const result = await onAction(message);
                if (result?.refreshProperties) {
                    const buffer = await vscode.workspace.fs.readFile(vscode.Uri.file(project.path));
                    const nextMetadata = (0, workspaceScanner_1.readProjectMetadataFromText)(Buffer.from(buffer).toString('utf8'), project.path);
                    nextMetadata.launchSettings = await (0, launchSettingsEditor_1.readProjectLaunchSettings)(project.path);
                    panel.webview.html = getProjectPropertiesHtml(project, nextMetadata, getNonce(), result.message || 'Action completed.');
                    return;
                }
                panel.webview.postMessage({
                    command: 'actionCompleted',
                    message: result?.message || 'Action completed.'
                });
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Solution Manager: ${errorMessage}`);
                panel.webview.postMessage({ command: 'saveFailed', message: errorMessage });
            }
        }
    }, undefined, context.subscriptions);
    panel.webview.html = getProjectPropertiesHtml(project, metadata, nonce);
}
function getProjectPropertiesHtml(project, metadata, nonce, notice = '') {
    const targetFrameworks = metadata.targetFrameworks || [];
    const targetFramework = targetFrameworks[0] || 'Not specified';
    const assemblyName = metadata.assemblyName || project.name;
    const rootNamespace = metadata.rootNamespace || project.name;
    const outputType = formatOutputType(metadata.outputType);
    const languageVersion = metadata.langVersion || inferLanguageVersion(targetFramework);
    const nullable = formatNullable(metadata.nullable);
    const packageReferences = metadata.packageReferences || [];
    const projectReferences = metadata.projectReferences || [];
    const projectItems = metadata.projectItems || {};
    const assemblyReferences = metadata.assemblyReferences || [];
    const frameworkReferences = metadata.frameworkReferences || [];
    const analyzerReferences = metadata.analyzerReferences || [];
    const sourceGenerators = metadata.sourceGenerators || [];
    const signing = metadata.signing || {};
    const buildEvents = metadata.buildEvents || {};
    const buildSettings = metadata.buildSettings || {};
    const targets = metadata.targets || [];
    const publishProfiles = metadata.publishProfiles || [];
    const configurations = metadata.configurations || [];
    const imports = metadata.imports || [];
    const packageMetadata = metadata.package || {};
    const centralPackageVersions = metadata.centralPackageVersions || [];
    const nugetConfig = metadata.nugetConfig || {};
    const packageLock = metadata.packageLock || {};
    const userSecrets = metadata.userSecrets || {};
    const globalJson = metadata.globalJson || {};
    const globalSdk = globalJson.sdk || {};
    const assemblyMetadata = metadata.assembly || {};
    const inspectionSettings = metadata.inspections || {};
    const diagnosticProperties = metadata.properties || [];
    const resolvedPackages = getAllResolvedPackages(metadata);
    const directResolvedPackages = resolvedPackages.filter((item) => item.direct);
    const transitiveResolvedPackages = resolvedPackages.filter((item) => !item.direct);
    const sdk = metadata.sdk || 'Microsoft.NET.Sdk';
    const relativePath = project.relativePath || vscode.workspace.asRelativePath(project.path, false);
    const displayConfigurations = getDisplayConfigurations(configurations);
    const configurationNavItems = displayConfigurations.map((configuration) => navItem(configuration.id, configuration.label, outputType, countConfigurationProperties(configuration.source)));
    const configurationPaneMarkup = displayConfigurations.map((configuration) => configurationPane(configuration, outputType, targetFramework)).join('');
    const frameworkPropertyName = targetFrameworks.length > 1 ? 'TargetFrameworks' : 'TargetFramework';
    const frameworkPropertyValue = targetFrameworks.length > 1 ? targetFrameworks.join(';') : targetFramework;
    const launchSettings = metadata.launchSettings || {};
    const launchProfiles = getDisplayLaunchProfiles(project, launchSettings);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Project Properties - ${escapeHtml(project.name)}</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: dark;
      --bg: #18191c;
      --line: #34383e;
      --text: #d4d7dd;
      --muted: #9a9ca3;
      --field: #1f2227;
      --field-line: #454a52;
      --accent: #31518d;
      --accent-strong: #3f6fcb;
      --button: #3478e5;
    }

    * {
      box-sizing: border-box;
    }

    html,
    body {
      height: 100%;
      margin: 0;
      color: var(--text);
      background: var(--bg);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: 14px;
    }

    .window {
      display: grid;
      grid-template-rows: 46px minmax(0, 1fr) 72px;
      min-height: 100vh;
    }

    .titlebar {
      display: flex;
      align-items: center;
      gap: 14px;
      min-width: 0;
      padding: 0 18px;
      border-bottom: 1px solid #25282d;
      color: var(--muted);
      font-size: 15px;
      font-weight: 700;
    }

    .title {
      min-width: 0;
      overflow: hidden;
      color: var(--text);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .title-path {
      min-width: 0;
      overflow: hidden;
      color: var(--muted);
      font-weight: 500;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .content {
      display: grid;
      grid-template-columns: 310px minmax(0, 1fr);
      min-height: 0;
    }

    .sidebar {
      overflow-y: auto;
      padding: 16px 12px;
      border-right: 1px solid #282c32;
    }

    .group-title {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
      align-items: center;
      gap: 8px;
      margin: 0 0 8px;
      color: var(--muted);
      font-style: italic;
      font-weight: 700;
    }

    .group-title::before,
    .group-title::after {
      content: "";
      height: 1px;
      background: var(--line);
    }

    .nav {
      display: grid;
      gap: 3px;
      margin: 0 0 18px;
      padding: 0;
      list-style: none;
    }

    .nav-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      width: 100%;
      min-height: 34px;
      padding: 6px 12px 6px 54px;
      color: var(--muted);
      background: transparent;
      border: 0;
      border-radius: 5px;
      font: inherit;
      text-align: left;
    }

    .nav-item:hover {
      color: var(--text);
      background: #24272d;
    }

    .nav-item.active {
      color: var(--text);
      background: var(--accent);
    }

    .nav-label,
    .nav-detail {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .nav-main {
      display: grid;
      gap: 1px;
      min-width: 0;
    }

    .nav-detail {
      color: #b6bbc5;
      font-size: 12px;
    }

    .badge {
      min-width: 24px;
      height: 20px;
      padding: 1px 7px;
      color: #dbe6ff;
      background: #263852;
      border: 1px solid #3b5680;
      border-radius: 10px;
      font-size: 12px;
      line-height: 16px;
      text-align: center;
    }

    .main {
      min-width: 0;
      overflow: auto;
      padding: 24px 30px;
    }

    .pane {
      display: none;
      max-width: 980px;
    }

    .pane.active {
      display: block;
    }

    .section {
      margin-bottom: 28px;
    }

    .section-title {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: 12px;
      margin-bottom: 14px;
      font-size: 16px;
    }

    .section-title::after {
      content: "";
      height: 1px;
      background: var(--line);
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 0 0 14px;
    }

    .action-button {
      min-height: 28px;
      padding: 4px 10px;
      color: var(--text);
      background: #24272d;
      border: 1px solid var(--field-line);
      border-radius: 4px;
      font: inherit;
      line-height: 18px;
    }

    .action-button:hover {
      background: #2b3037;
      border-color: #58606c;
    }

    .table-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .table-actions input.field {
      width: 170px;
      max-width: 100%;
    }

    .form-row {
      display: grid;
      grid-template-columns: 230px minmax(260px, 1fr);
      align-items: center;
      gap: 14px;
      min-height: 36px;
      margin-bottom: 8px;
    }

    .label {
      color: var(--text);
      text-align: right;
      font-size: 15px;
    }

    .field,
    .select,
    .textarea {
      min-height: 30px;
      padding: 5px 10px;
      color: var(--text);
      background: var(--field);
      border: 1px solid var(--field-line);
      border-radius: 3px;
      line-height: 20px;
    }

    input.field,
    select.select,
    textarea.textarea {
      width: 100%;
      font: inherit;
    }

    textarea.textarea {
      min-height: 78px;
      resize: vertical;
    }

    .select {
      display: flex;
      justify-content: space-between;
      border-radius: 5px;
    }

    div.select::after {
      content: "\\25BE";
      color: var(--muted);
    }

    select.select {
      appearance: auto;
    }

    .table {
      width: 100%;
      border-collapse: collapse;
      color: var(--text);
      background: var(--field);
      border: 1px solid var(--field-line);
      border-radius: 5px;
      overflow: hidden;
    }

    .table th,
    .table td {
      padding: 8px 10px;
      border-bottom: 1px solid #333740;
      text-align: left;
      vertical-align: top;
    }

    .table th {
      color: #b8bdc8;
      background: #24272d;
      font-weight: 600;
    }

    .table tr:last-child td {
      border-bottom: 0;
    }

    .empty {
      padding: 8px 10px;
      color: var(--muted);
      background: var(--field);
      border: 1px solid var(--field-line);
      border-radius: 5px;
    }

    .footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 14px;
      padding: 14px 18px;
      border-top: 1px solid #282c32;
    }

    .footer button {
      min-width: 96px;
      min-height: 36px;
      color: var(--text);
      background: transparent;
      border: 1px solid var(--field-line);
      border-radius: 5px;
      font: inherit;
    }

    .footer .primary {
      color: white;
      background: var(--button);
      border-color: #6098ff;
      box-shadow: 0 0 0 2px #102f66;
    }

    .footer .status {
      margin-right: auto;
      color: #8fbc8f;
    }
  </style>
</head>
<body>
  <div class="window">
    <header class="titlebar">
      <span class="title">Project Properties - ${escapeHtml(project.name)}</span>
      <span class="title-path">${escapeHtml(relativePath)}</span>
    </header>
    <div class="content">
      <aside class="sidebar">
        ${navGroup('Properties', [
        navItem('application', 'Application', targetFramework, '', true),
        navItem('build', 'Build', 'Compiler and output'),
        navItem('publish', 'Publish', buildSettings.runtimeIdentifier || 'Runtime and output'),
        navItem('nuget', 'NuGet', 'Package references', packageReferences.length),
        navItem('assembly', 'Assembly', 'References and metadata', projectReferences.length + assemblyReferences.length + frameworkReferences.length),
        navItem('resources', 'Resources', 'Project items', countProjectItems(projectItems)),
        navItem('signing', 'Signing', getSigningSummary(signing)),
        navItem('build-events', 'Build Events', getBuildEventSummary(buildEvents))
    ])}
        ${navGroup('IDE', [
        navItem('inspections', 'Inspections', 'Analysis settings')
    ])}
        ${navGroup('Configurations', [
        navItem('configuration-actions', 'Manage Configurations', 'Add or remove'),
        ...configurationNavItems,
        navItem('run-profiles', 'Run Profiles', 'launchSettings.json', launchProfiles.length)
    ])}
        ${navGroup('Diagnostic', [
        navItem('imports', 'Imports', sdk, imports.length),
        navItem('diagnostic-properties', 'Properties', 'Project file values', diagnosticProperties.length)
    ])}
      </aside>
      <main class="main">
        <section class="pane active" data-pane="application" role="tabpanel">
          <div class="section">
            <div class="section-title">General</div>
            ${editableFieldRow('Assembly name:', 'AssemblyName', assemblyName)}
            ${editableFieldRow('Root namespace:', 'RootNamespace', rootNamespace)}
            ${editableFieldRow('Target framework:', frameworkPropertyName, frameworkPropertyValue)}
            ${selectInputRow('Output type:', 'OutputType', metadata.outputType || 'Library', ['Library', 'Exe', 'WinExe'])}
            ${editableFieldRow('Startup object:', 'StartupObject', buildSettings.startupObject || '')}
            ${editableFieldRow('Application icon:', 'ApplicationIcon', buildSettings.applicationIcon || '')}
            ${actionBar([
        actionButton('Browse Application Icon', 'browseProjectProperty', 'ApplicationIcon')
    ])}
            ${selectInputRow('Use WPF:', 'UseWPF', buildSettings.useWpf || '', ['', 'true', 'false'])}
            ${selectInputRow('Use Windows Forms:', 'UseWindowsForms', buildSettings.useWindowsForms || '', ['', 'true', 'false'])}
          </div>
          <div class="section">
            <div class="section-title">Target Platform</div>
            ${editableFieldRow('Target framework identifier:', 'TargetFrameworkIdentifier', buildSettings.targetFrameworkIdentifier || '')}
            ${editableFieldRow('Target framework version:', 'TargetFrameworkVersion', buildSettings.targetFrameworkVersion || '')}
            ${editableFieldRow('Target framework profile:', 'TargetFrameworkProfile', buildSettings.targetFrameworkProfile || '')}
            ${editableFieldRow('Target platform identifier:', 'TargetPlatformIdentifier', buildSettings.targetPlatformIdentifier || '')}
            ${editableFieldRow('Target platform version:', 'TargetPlatformVersion', buildSettings.targetPlatformVersion || '')}
            ${editableFieldRow('Target platform minimum version:', 'TargetPlatformMinVersion', buildSettings.targetPlatformMinVersion || '')}
            ${editableFieldRow('Supported OS platform version:', 'SupportedOSPlatformVersion', buildSettings.supportedOSPlatformVersion || '')}
          </div>
          <div class="section">
            <div class="section-title">User Secrets</div>
            ${editableFieldRow('User secrets id:', 'UserSecretsId', buildSettings.userSecretsId || userSecrets.id || '')}
            ${fieldRow('Secrets file:', formatUserSecretsPath(userSecrets))}
            ${userSecrets.parseError ? fieldRow('Parse error:', userSecrets.parseError) : ''}
            ${fieldRow('Secret keys:', String(userSecrets.keyCount || 0))}
            ${userSecrets.keys && userSecrets.keys.length ? fieldRow('Key names:', userSecrets.keys.join(', ')) : ''}
            ${actionBar([
        actionButton('Open Secrets', 'openUserSecrets', userSecrets.exists ? userSecrets.path || '' : ''),
        actionButton('Copy Secrets Path', 'copyUserSecretsPath', userSecrets.path || ''),
        actionButton('Copy Secrets JSON', 'copyUserSecretsJson', userSecrets.exists ? userSecrets.path || '' : '')
    ])}
          </div>
          <div class="section">
            <div class="section-title">SDK Selection</div>
            ${fieldRow('global.json:', globalJson.path || 'Not found')}
            ${globalJson.parseError ? fieldRow('Parse error:', globalJson.parseError) : ''}
            ${fieldRow('SDK version:', globalSdk.version || 'Not specified')}
            ${fieldRow('Roll forward:', globalSdk.rollForward || 'Not specified')}
            ${fieldRow('Allow prerelease:', globalSdk.allowPrerelease || 'Not specified')}
            ${fieldRow('SDK paths:', (globalSdk.paths || []).join('; ') || 'Not specified')}
            ${fieldRow('MSBuild SDKs:', formatGlobalJsonMsbuildSdks(globalJson.msbuildSdks))}
            ${actionBar([
        actionButton('Open global.json', 'openGlobalJson', globalJson.path || ''),
        actionButton('Copy global.json Path', 'copyGlobalJsonPath', globalJson.path || ''),
        actionButton('Copy global.json JSON', 'copyGlobalJsonJson', globalJson.path || '')
    ])}
          </div>
          <div class="section">
            <div class="section-title">Language</div>
            ${editableFieldRow('Language Version:', 'LangVersion', languageVersion === 'Default' ? '' : languageVersion)}
            ${selectInputRow('Nullable reference types (C# 8.0+):', 'Nullable', metadata.nullable || '', ['', 'enable', 'disable', 'annotations', 'warnings'])}
            ${selectInputRow('Implicit usings:', 'ImplicitUsings', buildSettings.implicitUsings || '', ['', 'enable', 'disable'])}
          </div>
        </section>

        <section class="pane" data-pane="build" role="tabpanel">
          <div class="section">
            <div class="section-title">Build Settings</div>
            ${actionBar([
        actionButton('Copy Build Settings XML', 'copyBuildSettingsXml')
    ])}
          </div>
          <div class="section">
            <div class="section-title">Output</div>
            ${editableFieldRow('Output path:', 'OutputPath', buildSettings.outputPath || '')}
            ${editableFieldRow('Base output path:', 'BaseOutputPath', buildSettings.baseOutputPath || '')}
            ${editableFieldRow('Intermediate output path:', 'IntermediateOutputPath', buildSettings.intermediateOutputPath || '')}
            ${actionBar([
        actionButton('Browse Output Path', 'browseProjectProperty', 'OutputPath'),
        actionButton('Browse Base Output Path', 'browseProjectProperty', 'BaseOutputPath'),
        actionButton('Browse Intermediate Path', 'browseProjectProperty', 'IntermediateOutputPath')
    ])}
            ${selectInputRow('Append target framework to output path:', 'AppendTargetFrameworkToOutputPath', buildSettings.appendTargetFrameworkToOutputPath || '', ['', 'true', 'false'])}
            ${selectInputRow('Append runtime identifier to output path:', 'AppendRuntimeIdentifierToOutputPath', buildSettings.appendRuntimeIdentifierToOutputPath || '', ['', 'true', 'false'])}
            ${selectInputRow('Copy local lock file assemblies:', 'CopyLocalLockFileAssemblies', buildSettings.copyLocalLockFileAssemblies || '', ['', 'true', 'false'])}
          </div>
          <div class="section">
            <div class="section-title">Compiler</div>
            ${selectInputRow('Optimize:', 'Optimize', buildSettings.optimize || '', ['', 'true', 'false'])}
            ${editableFieldRow('Define constants:', 'DefineConstants', buildSettings.defineConstants || '')}
            ${selectInputRow('Allow unsafe blocks:', 'AllowUnsafeBlocks', buildSettings.allowUnsafeBlocks || '', ['', 'true', 'false'])}
            ${selectInputRow('Check arithmetic overflow:', 'CheckForOverflowUnderflow', buildSettings.checkForOverflowUnderflow || '', ['', 'true', 'false'])}
            ${editableFieldRow('Platform target:', 'PlatformTarget', buildSettings.platformTarget || '')}
            ${selectInputRow('Deterministic:', 'Deterministic', buildSettings.deterministic || '', ['', 'true', 'false'])}
            ${selectInputRow('Continuous integration build:', 'ContinuousIntegrationBuild', buildSettings.continuousIntegrationBuild || '', ['', 'true', 'false'])}
          </div>
          <div class="section">
            <div class="section-title">Debugging</div>
            ${selectInputRow('Debug symbols:', 'DebugSymbols', buildSettings.debugSymbols || '', ['', 'true', 'false'])}
            ${selectInputRow('Debug type:', 'DebugType', buildSettings.debugType || '', ['', 'portable', 'embedded', 'full', 'pdbonly', 'none'])}
          </div>
          <div class="section">
            <div class="section-title">Warnings</div>
            ${selectInputRow('Treat warnings as errors:', 'TreatWarningsAsErrors', buildSettings.treatWarningsAsErrors || '', ['', 'true', 'false'])}
            ${editableFieldRow('Warnings as errors:', 'WarningsAsErrors', buildSettings.warningsAsErrors || '')}
            ${editableFieldRow('No warn:', 'NoWarn', buildSettings.noWarn || '')}
            ${editableFieldRow('Warning level:', 'WarningLevel', buildSettings.warningLevel || '')}
          </div>
          <div class="section">
            <div class="section-title">Documentation and Generated Files</div>
            ${selectInputRow('Generate documentation file:', 'GenerateDocumentationFile', buildSettings.generateDocumentationFile || '', ['', 'true', 'false'])}
            ${editableFieldRow('Documentation file:', 'DocumentationFile', buildSettings.documentationFile || '')}
            ${selectInputRow('Produce reference assembly:', 'ProduceReferenceAssembly', buildSettings.produceReferenceAssembly || '', ['', 'true', 'false'])}
            ${selectInputRow('Emit compiler generated files:', 'EmitCompilerGeneratedFiles', buildSettings.emitCompilerGeneratedFiles || '', ['', 'true', 'false'])}
            ${editableFieldRow('Generated files output path:', 'CompilerGeneratedFilesOutputPath', buildSettings.compilerGeneratedFilesOutputPath || '')}
            ${actionBar([
        actionButton('Browse Documentation File', 'browseProjectProperty', 'DocumentationFile'),
        actionButton('Browse Generated Files Path', 'browseProjectProperty', 'CompilerGeneratedFilesOutputPath')
    ])}
          </div>
        </section>

        <section class="pane" data-pane="publish" role="tabpanel">
          <div class="section">
            <div class="section-title">Publish Settings</div>
            ${actionBar([
        actionButton('Copy Publish Settings XML', 'copyPublishSettingsXml')
    ])}
          </div>
          <div class="section">
            <div class="section-title">Publish Profiles</div>
            ${publishProfilesTable(publishProfiles)}
          </div>
          <div class="section">
            <div class="section-title">Runtime</div>
            ${editableFieldRow('Runtime identifier:', 'RuntimeIdentifier', buildSettings.runtimeIdentifier || '')}
            ${editableFieldRow('Runtime identifiers:', 'RuntimeIdentifiers', buildSettings.runtimeIdentifiers || '')}
            ${editableFieldRow('Runtime framework version:', 'RuntimeFrameworkVersion', buildSettings.runtimeFrameworkVersion || '')}
            ${editableFieldRow('Roll forward:', 'RollForward', buildSettings.rollForward || '')}
            ${selectInputRow('Self-contained:', 'SelfContained', buildSettings.selfContained || '', ['', 'true', 'false'])}
            ${selectInputRow('Use app host:', 'UseAppHost', buildSettings.useAppHost || '', ['', 'true', 'false'])}
            ${selectInputRow('Target latest runtime patch:', 'TargetLatestRuntimePatch', buildSettings.targetLatestRuntimePatch || '', ['', 'true', 'false'])}
            ${selectInputRow('Invariant globalization:', 'InvariantGlobalization', buildSettings.invariantGlobalization || '', ['', 'true', 'false'])}
          </div>
          <div class="section">
            <div class="section-title">Output</div>
            ${editableFieldRow('Publish directory:', 'PublishDir', buildSettings.publishDir || '')}
            ${editableFieldRow('Publish URL:', 'PublishUrl', buildSettings.publishUrl || '')}
            ${actionBar([
        actionButton('Browse Publish Directory', 'browseProjectProperty', 'PublishDir'),
        actionButton('Browse Publish URL', 'browseProjectProperty', 'PublishUrl')
    ])}
          </div>
          <div class="section">
            <div class="section-title">Deployment</div>
            ${selectInputRow('Publish single file:', 'PublishSingleFile', buildSettings.publishSingleFile || '', ['', 'true', 'false'])}
            ${selectInputRow('Publish trimmed:', 'PublishTrimmed', buildSettings.publishTrimmed || '', ['', 'true', 'false'])}
            ${selectInputRow('Publish ReadyToRun:', 'PublishReadyToRun', buildSettings.publishReadyToRun || '', ['', 'true', 'false'])}
            ${selectInputRow('Publish AOT:', 'PublishAot', buildSettings.publishAot || '', ['', 'true', 'false'])}
            ${selectInputRow('Include native libraries for self extract:', 'IncludeNativeLibrariesForSelfExtract', buildSettings.includeNativeLibrariesForSelfExtract || '', ['', 'true', 'false'])}
            ${selectInputRow('Enable compression in single file:', 'EnableCompressionInSingleFile', buildSettings.enableCompressionInSingleFile || '', ['', 'true', 'false'])}
          </div>
        </section>

        <section class="pane" data-pane="nuget" role="tabpanel">
          <div class="section">
            <div class="section-title">NuGet</div>
            ${fieldRow('Packages:', String(packageReferences.length))}
            ${fieldRow('Resolved packages:', String(resolvedPackages.length))}
            ${fieldRow('Transitive packages:', String(transitiveResolvedPackages.length))}
            ${actionBar([
        actionButton('Add Package', 'addPackage'),
        actionButton('Remove Package', 'removePackage'),
        actionButton('List Packages', 'listPackages'),
        actionButton('Restore', 'restorePackages'),
        actionButton('Copy Package Metadata XML', 'copyPackageMetadataXml')
    ])}
            ${editableFieldRow('Package id:', 'PackageId', packageMetadata.packageId || '')}
            ${editableFieldRow('Package version:', 'Version', packageMetadata.version || '')}
            ${editableFieldRow('NuGet package version:', 'PackageVersion', packageMetadata.packageVersion || '')}
            ${editableFieldRow('Authors:', 'Authors', packageMetadata.authors || '')}
            ${editableFieldRow('Company:', 'Company', packageMetadata.company || '')}
            ${editableFieldRow('Product:', 'Product', packageMetadata.product || '')}
            ${textareaRow('Description:', 'Description', packageMetadata.description || '')}
            ${textareaRow('Release notes:', 'PackageReleaseNotes', packageMetadata.releaseNotes || '')}
            ${editableFieldRow('Repository URL:', 'RepositoryUrl', packageMetadata.repositoryUrl || '')}
            ${editableFieldRow('Repository type:', 'RepositoryType', packageMetadata.repositoryType || '')}
            ${editableFieldRow('Repository branch:', 'RepositoryBranch', packageMetadata.repositoryBranch || '')}
            ${editableFieldRow('Repository commit:', 'RepositoryCommit', packageMetadata.repositoryCommit || '')}
            ${selectInputRow('Publish repository URL:', 'PublishRepositoryUrl', packageMetadata.publishRepositoryUrl || '', ['', 'true', 'false'])}
            ${editableFieldRow('Project URL:', 'PackageProjectUrl', packageMetadata.projectUrl || '')}
            ${editableFieldRow('Package tags:', 'PackageTags', packageMetadata.tags || '')}
            ${editableFieldRow('License expression:', 'PackageLicenseExpression', packageMetadata.licenseExpression || '')}
            ${editableFieldRow('License file:', 'PackageLicenseFile', packageMetadata.licenseFile || '')}
            ${editableFieldRow('License URL:', 'PackageLicenseUrl', packageMetadata.licenseUrl || '')}
            ${editableFieldRow('Readme file:', 'PackageReadmeFile', packageMetadata.readmeFile || '')}
            ${editableFieldRow('Icon file:', 'PackageIcon', packageMetadata.icon || '')}
            ${editableFieldRow('Icon URL:', 'PackageIconUrl', packageMetadata.iconUrl || '')}
            ${actionBar([
        actionButton('Browse License File', 'browseProjectProperty', 'PackageLicenseFile'),
        actionButton('Browse Readme File', 'browseProjectProperty', 'PackageReadmeFile'),
        actionButton('Browse Package Icon', 'browseProjectProperty', 'PackageIcon')
    ])}
          </div>
          <div class="section">
            <div class="section-title">Pack Behavior</div>
            ${selectInputRow('Is packable:', 'IsPackable', packageMetadata.isPackable || '', ['', 'true', 'false'])}
            ${selectInputRow('Generate package on build:', 'GeneratePackageOnBuild', packageMetadata.generatePackageOnBuild || '', ['', 'true', 'false'])}
            ${selectInputRow('Require license acceptance:', 'PackageRequireLicenseAcceptance', packageMetadata.requireLicenseAcceptance || '', ['', 'true', 'false'])}
            ${selectInputRow('Include build output:', 'IncludeBuildOutput', packageMetadata.includeBuildOutput || '', ['', 'true', 'false'])}
            ${selectInputRow('Include content in pack:', 'IncludeContentInPack', packageMetadata.includeContentInPack || '', ['', 'true', 'false'])}
            ${editableFieldRow('Content target folders:', 'ContentTargetFolders', packageMetadata.contentTargetFolders || '')}
            ${selectInputRow('Development dependency:', 'DevelopmentDependency', packageMetadata.developmentDependency || '', ['', 'true', 'false'])}
            ${selectInputRow('Serviceable:', 'Serviceable', packageMetadata.serviceable || '', ['', 'true', 'false'])}
            ${selectInputRow('Include symbols:', 'IncludeSymbols', packageMetadata.includeSymbols || '', ['', 'true', 'false'])}
            ${selectInputRow('Include source:', 'IncludeSource', packageMetadata.includeSource || '', ['', 'true', 'false'])}
            ${selectInputRow('Symbol package format:', 'SymbolPackageFormat', packageMetadata.symbolPackageFormat || '', ['', 'snupkg', 'symbols.nupkg'])}
            ${selectInputRow('Embed untracked sources:', 'EmbedUntrackedSources', packageMetadata.embedUntrackedSources || '', ['', 'true', 'false'])}
            ${editableFieldRow('Minimum client version:', 'MinClientVersion', packageMetadata.minClientVersion || '')}
            ${editableFieldRow('Package type:', 'PackageType', packageMetadata.packageType || '')}
            ${editableFieldRow('Validation baseline version:', 'PackageValidationBaselineVersion', packageMetadata.packageValidationBaselineVersion || '')}
            ${editableFieldRow('Validation baseline name:', 'PackageValidationBaselineName', packageMetadata.packageValidationBaselineName || '')}
            ${editableFieldRow('Package output path:', 'PackageOutputPath', packageMetadata.packageOutputPath || '')}
            ${actionBar([
        actionButton('Browse Package Output Path', 'browseProjectProperty', 'PackageOutputPath')
    ])}
          </div>
          <div class="section">
            <div class="section-title">Restore Lock</div>
            ${selectInputRow('Restore packages with lock file:', 'RestorePackagesWithLockFile', buildSettings.restorePackagesWithLockFile || '', ['', 'true', 'false'])}
            ${selectInputRow('Restore locked mode:', 'RestoreLockedMode', buildSettings.restoreLockedMode || '', ['', 'true', 'false'])}
            ${selectInputRow('Restore static graph:', 'RestoreUseStaticGraphEvaluation', buildSettings.restoreUseStaticGraphEvaluation || '', ['', 'true', 'false'])}
            ${editableFieldRow('NuGet lock file path:', 'NuGetLockFilePath', buildSettings.nuGetLockFilePath || '')}
            ${fieldRow('Lock file:', formatPackageLockPath(packageLock))}
            ${packageLock.parseError ? fieldRow('Parse error:', packageLock.parseError) : ''}
            ${fieldRow('Lock format version:', packageLock.version || 'Not specified')}
            ${fieldRow('Locked target frameworks:', (packageLock.targetFrameworks || []).join(', ') || 'Not specified')}
            ${fieldRow('Locked packages:', String((packageLock.packages || []).length))}
            ${fieldRow('Direct locked packages:', String(packageLock.directCount || 0))}
            ${fieldRow('Transitive locked packages:', String(packageLock.transitiveCount || 0))}
            ${actionBar([
        actionButton('Open Lock File', 'openPackageLockFile', packageLock.exists ? packageLock.path || '' : ''),
        actionButton('Copy Lock Path', 'copyPackageLockPath', packageLock.path || ''),
        actionButton('Copy Lock JSON', 'copyPackageLockJson', packageLock.exists ? packageLock.path || '' : '')
    ])}
            ${packageLockPackagesTable(packageLock.packages || [])}
          </div>
          <div class="section">
            <div class="section-title">References</div>
            ${actionTable(['Package', 'Version', 'Version Source', 'Source Mapping', 'VersionOverride', 'PrivateAssets', 'IncludeAssets', 'ExcludeAssets', 'OutputItemType', 'ReferenceOutputAssembly', 'GeneratePathProperty', 'Aliases', 'NoWarn', 'Item Condition', 'Group Condition', 'Actions'], packageReferences.map((reference) => [
        reference.name,
        rawCell(packageReferenceField(reference, 'Version', reference.version || '')),
        formatPackageVersionSource(reference),
        formatPackageSourceMappings(reference.packageSourceMappings),
        rawCell(packageReferenceField(reference, 'VersionOverride', reference.versionOverride || '')),
        rawCell(packageReferenceField(reference, 'PrivateAssets', reference.privateAssets || '')),
        rawCell(packageReferenceField(reference, 'IncludeAssets', reference.includeAssets || '')),
        rawCell(packageReferenceField(reference, 'ExcludeAssets', reference.excludeAssets || '')),
        rawCell(packageReferenceField(reference, 'OutputItemType', reference.outputItemType || '')),
        rawCell(packageReferenceField(reference, 'ReferenceOutputAssembly', reference.referenceOutputAssembly || '')),
        rawCell(packageReferenceField(reference, 'GeneratePathProperty', reference.generatePathProperty || '')),
        rawCell(packageReferenceField(reference, 'Aliases', reference.aliases || '')),
        rawCell(packageReferenceField(reference, 'NoWarn', reference.noWarn || '')),
        rawCell(packageReferenceField(reference, 'Condition', reference.itemCondition || '')),
        reference.groupCondition || '',
        rawCell(actionGroup([
            actionButton('Details', 'packageDetails', packageActionValue(reference)),
            actionButton('NuGet', 'openPackage', reference.name),
            actionButton('Folder', 'openPackageFolder', packageActionValue(reference)),
            actionButton('Copy Folder', 'copyPackageFolder', packageActionValue(reference)),
            actionButton('Copy XML', 'copyPackageReference', packageActionValue(reference)),
            actionButton('Update', 'updatePackage', packageActionValue(reference)),
            actionButton('Remove', 'removePackage', packageActionValue(reference))
        ]))
    ]), 'No package references.')}
            ${actionTable(['Resolved package', 'Version', 'Kind', 'Source Mapping', 'Dependencies', 'Actions'], resolvedPackages.map((reference) => [
        reference.name,
        reference.version || '',
        reference.direct ? 'Direct' : 'Transitive',
        formatPackageSourceMappings(reference.packageSourceMappings),
        (reference.dependencies || []).map((item) => `${item.name} ${item.version || ''}`.trim()).join(', '),
        rawCell(actionGroup([
            actionButton('Details', 'packageDetails', packageActionValue(reference)),
            actionButton('NuGet', 'openPackage', reference.name),
            actionButton('Folder', 'openPackageFolder', packageActionValue(reference)),
            actionButton('Copy Folder', 'copyPackageFolder', packageActionValue(reference)),
            actionButton('Copy XML', 'copyPackageReference', packageActionValue(reference)),
            reference.direct ? actionButton('Update', 'updatePackage', packageActionValue(reference)) : ''
        ]))
    ]), 'No restored package graph. Run dotnet restore to generate project.assets.json.')}
          </div>
          <div class="section">
            <div class="section-title">Central Package Versions</div>
            ${centralPackageVersionsTable(centralPackageVersions)}
          </div>
          <div class="section">
            <div class="section-title">NuGet Config</div>
            ${fieldRow('Config file:', nugetConfig.path || 'Not found')}
            ${actionBar([
        actionButton('Open Config', 'openNuGetConfig', nugetConfig.path || ''),
        actionButton('Copy Config Path', 'copyNuGetConfigPath', nugetConfig.path || ''),
        actionButton('Copy Config XML', 'copyNuGetConfigXml', nugetConfig.path || '')
    ])}
            ${nugetPackageSourcesTable(nugetConfig.packageSources || [])}
            ${nugetPackageSourceMappingsTable(nugetConfig.packageSourceMappings || [])}
          </div>
        </section>

        <section class="pane" data-pane="assembly" role="tabpanel">
          <div class="section">
            <div class="section-title">Assembly</div>
            ${fieldRow('Project file:', project.fileName || `${project.name}.csproj`)}
            ${fieldRow('Project path:', project.path)}
            ${fieldRow('SDK:', sdk)}
            ${fieldRow('Target frameworks:', targetFrameworks.length ? targetFrameworks.join(', ') : 'Not specified')}
            ${actionBar([
        actionButton('Open Project File', 'openProjectFile'),
        actionButton('Open Project Folder', 'openProjectFolder'),
        actionButton('Copy Project Path', 'copyProjectPath'),
        actionButton('Copy Assembly XML', 'copyAssemblyMetadataXml')
    ])}
            ${editableFieldRow('Assembly title:', 'AssemblyTitle', assemblyMetadata.title || '')}
            ${editableFieldRow('Assembly version:', 'AssemblyVersion', assemblyMetadata.version || '')}
            ${editableFieldRow('File version:', 'FileVersion', assemblyMetadata.fileVersion || '')}
            ${editableFieldRow('Informational version:', 'InformationalVersion', assemblyMetadata.informationalVersion || '')}
            ${editableFieldRow('Neutral language:', 'NeutralLanguage', assemblyMetadata.neutralLanguage || '')}
            ${selectInputRow('Generate assembly info:', 'GenerateAssemblyInfo', assemblyMetadata.generateAssemblyInfo || '', ['', 'true', 'false'])}
            ${selectInputRow('COM visible:', 'ComVisible', assemblyMetadata.comVisible || '', ['', 'true', 'false'])}
            ${editableFieldRow('Assembly GUID:', 'Guid', assemblyMetadata.guid || '')}
            ${selectInputRow('CLS compliant:', 'CLSCompliant', assemblyMetadata.clsCompliant || '', ['', 'true', 'false'])}
            ${editableFieldRow('Copyright:', 'Copyright', assemblyMetadata.copyright || '')}
            ${editableFieldRow('Trademark:', 'Trademark', assemblyMetadata.trademark || '')}
            ${editableSharedFieldRow('Company:', 'Company', packageMetadata.company || '', 'assembly')}
            ${editableSharedFieldRow('Product:', 'Product', packageMetadata.product || '', 'assembly')}
            ${textareaSharedRow('Description:', 'Description', packageMetadata.description || '', 'assembly')}
          </div>
          <div class="section">
            <div class="section-title">References</div>
            ${actionBar([
        actionButton('Add Project Reference', 'addProjectReference'),
        actionButton('Add Assembly Reference', 'addAssemblyReference'),
        actionButton('Add Framework Reference', 'addFrameworkReference'),
        actionButton('Add Analyzer', 'addAnalyzerReference')
    ])}
            ${actionTable(['Project', 'Metadata', 'Condition', 'Actions'], projectReferences.map((reference) => [
        reference.name,
        rawCell(referenceMetadataFields(reference, 'ProjectReference', [
            ['ReferenceOutputAssembly', reference.referenceOutputAssembly || ''],
            ['OutputItemType', reference.outputItemType || ''],
            ['PrivateAssets', reference.privateAssets || ''],
            ['IncludeAssets', reference.includeAssets || ''],
            ['ExcludeAssets', reference.excludeAssets || '']
        ])),
        rawCell(referenceMetadataField(reference, 'ProjectReference', 'Condition', getReferenceItemCondition(reference))),
        rawCell(actionGroup([
            actionButton('Open', 'openProjectReference', referenceActionValue(reference, 'ProjectReference')),
            actionButton('Folder', 'openProjectReferenceFolder', referenceActionValue(reference, 'ProjectReference')),
            actionButton('Copy Path', 'copyProjectReferencePath', referenceActionValue(reference, 'ProjectReference')),
            actionButton('Copy XML', 'copyProjectReference', referenceActionValue(reference, 'ProjectReference')),
            actionButton('Remove', 'removeProjectReference', referenceActionValue(reference, 'ProjectReference'))
        ]))
    ]), 'No project references.')}
            ${actionTable(['Assembly', 'Metadata', 'Condition', 'Actions'], assemblyReferences.map((reference) => [
        reference.name,
        rawCell(referenceMetadataFields(reference, 'Reference', [
            ['HintPath', reference.hintPath || ''],
            ['Aliases', reference.aliases || ''],
            ['Private', reference.private || '']
        ])),
        rawCell(referenceMetadataField(reference, 'Reference', 'Condition', getReferenceItemCondition(reference))),
        rawCell(actionGroup([
            actionButton('Open', 'openAssemblyReference', referenceActionValue(reference, 'Reference')),
            actionButton('Copy Path', 'copyAssemblyReferencePath', referenceActionValue(reference, 'Reference')),
            actionButton('Copy XML', 'copyAssemblyReference', referenceActionValue(reference, 'Reference')),
            actionButton('Remove', 'removeAssemblyReference', referenceActionValue(reference, 'Reference'))
        ]))
    ]), 'No assembly references.')}
            ${actionTable(['Framework', 'Metadata', 'Condition', 'Actions'], frameworkReferences.map((reference) => [
        reference.name,
        rawCell(referenceMetadataFields(reference, 'FrameworkReference', [
            ['PrivateAssets', reference.privateAssets || ''],
            ['IncludeAssets', reference.includeAssets || ''],
            ['ExcludeAssets', reference.excludeAssets || '']
        ])),
        rawCell(referenceMetadataField(reference, 'FrameworkReference', 'Condition', getReferenceItemCondition(reference))),
        rawCell(actionGroup([
            actionButton('Copy XML', 'copyFrameworkReference', referenceActionValue(reference, 'FrameworkReference')),
            actionButton('Remove', 'removeFrameworkReference', referenceActionValue(reference, 'FrameworkReference'))
        ]))
    ]), 'No framework references.')}
          </div>
        </section>

        <section class="pane" data-pane="resources" role="tabpanel">
          <div class="section">
            <div class="section-title">Resources</div>
            ${actionBar([
        actionButton('Add Content...', 'addProjectItem', 'Content'),
        actionButton('Add None...', 'addProjectItem', 'None'),
        actionButton('Add Embedded Resource...', 'addProjectItem', 'EmbeddedResource'),
        actionButton('Add Additional File...', 'addProjectItem', 'AdditionalFiles'),
        actionButton('Add Compile Item...', 'addProjectItem', 'Compile')
    ])}
            ${fieldRow('Compile items:', String((projectItems.compile || []).length))}
            ${fieldRow('Content items:', String((projectItems.content || []).length))}
            ${fieldRow('None items:', String((projectItems.none || []).length))}
            ${fieldRow('Embedded resources:', String((projectItems.embeddedResources || []).length))}
            ${fieldRow('Additional files:', String((projectItems.additionalFiles || []).length))}
          </div>
          ${projectItemTable('Compile', 'Compile', projectItems.compile || [], 'No explicit compile items.')}
          ${projectItemTable('Content', 'Content', projectItems.content || [], 'No content items.')}
          ${projectItemTable('None', 'None', projectItems.none || [], 'No none items.')}
          ${projectItemTable('EmbeddedResource', 'Embedded Resources', projectItems.embeddedResources || [], 'No embedded resources.')}
          ${projectItemTable('AdditionalFiles', 'Additional Files', projectItems.additionalFiles || [], 'No additional files.')}
        </section>

        <section class="pane" data-pane="signing" role="tabpanel">
          <div class="section">
            <div class="section-title">Signing</div>
            ${selectInputRow('Sign assembly:', 'SignAssembly', signing.signAssembly || '', ['', 'true', 'false'])}
            ${editableFieldRow('Key file:', 'AssemblyOriginatorKeyFile', signing.keyFile || '')}
            ${actionBar([
        actionButton('Browse Key File', 'browseProjectProperty', 'AssemblyOriginatorKeyFile'),
        actionButton('Open Key File', 'openSigningKeyFile'),
        actionButton('Copy Key Path', 'copySigningKeyPath'),
        actionButton('Copy Signing XML', 'copySigningXml')
    ])}
            ${selectInputRow('Delay sign:', 'DelaySign', signing.delaySign || '', ['', 'true', 'false'])}
            ${selectInputRow('Public sign:', 'PublicSign', signing.publicSign || '', ['', 'true', 'false'])}
          </div>
        </section>

        <section class="pane" data-pane="build-events" role="tabpanel">
          <div class="section">
            <div class="section-title">Build Events</div>
            ${actionBar([
        actionButton('Copy Build Events XML', 'copyBuildEventsXml')
    ])}
            ${textareaRow('Pre-build event:', 'PreBuildEvent', buildEvents.preBuildEvent || '')}
            ${actionBar([
        actionButton('Run Pre-build Event', 'runBuildEvent', 'pre'),
        actionButton('Copy Pre-build Event', 'copyBuildEvent', 'pre')
    ])}
            ${textareaRow('Post-build event:', 'PostBuildEvent', buildEvents.postBuildEvent || '')}
            ${actionBar([
        actionButton('Run Post-build Event', 'runBuildEvent', 'post'),
        actionButton('Copy Post-build Event', 'copyBuildEvent', 'post')
    ])}
            ${selectInputRow('Run post-build event:', 'RunPostBuildEvent', buildEvents.runPostBuildEvent || '', ['', 'OnBuildSuccess', 'OnOutputUpdated', 'Always'])}
          </div>
          <div class="section">
            <div class="section-title">MSBuild Targets</div>
            ${msbuildTargetsTable(targets)}
          </div>
        </section>

        <section class="pane" data-pane="inspections" role="tabpanel">
          <div class="section">
            <div class="section-title">Inspections</div>
            ${selectInputRow('Enable .NET analyzers:', 'EnableNETAnalyzers', inspectionSettings.enableNetAnalyzers || '', ['', 'true', 'false'])}
            ${editableFieldRow('Analysis level:', 'AnalysisLevel', inspectionSettings.analysisLevel || '')}
            ${selectInputRow('Analysis mode:', 'AnalysisMode', inspectionSettings.analysisMode || '', ['', 'Default', 'AllEnabledByDefault', 'AllDisabledByDefault', 'Recommended', 'Minimum'])}
            ${selectInputRow('Enforce code style in build:', 'EnforceCodeStyleInBuild', inspectionSettings.enforceCodeStyleInBuild || '', ['', 'true', 'false'])}
            ${selectInputRow('Code analysis warnings as errors:', 'CodeAnalysisTreatWarningsAsErrors', inspectionSettings.codeAnalysisTreatWarningsAsErrors || '', ['', 'true', 'false'])}
            ${selectInputRow('Run analyzers during build:', 'RunAnalyzersDuringBuild', inspectionSettings.runAnalyzersDuringBuild || '', ['', 'true', 'false'])}
            ${selectInputRow('Run analyzers during live analysis:', 'RunAnalyzersDuringLiveAnalysis', inspectionSettings.runAnalyzersDuringLiveAnalysis || '', ['', 'true', 'false'])}
            ${fieldRow('Analyzers:', String(analyzerReferences.length))}
            ${fieldRow('Source generators:', String(sourceGenerators.length))}
            ${actionBar([
        actionButton('Add Analyzer', 'addAnalyzerReference')
    ])}
            ${actionTable(['Analyzer', 'Metadata', 'Condition', 'Actions'], analyzerReferences.map((reference) => [
        reference.name,
        rawCell(referenceMetadataFields(reference, 'Analyzer', [
            ['HintPath', reference.hintPath || reference.path || ''],
            ['PrivateAssets', reference.privateAssets || ''],
            ['IncludeAssets', reference.includeAssets || ''],
            ['ExcludeAssets', reference.excludeAssets || ''],
            ['Aliases', reference.aliases || '']
        ])),
        rawCell(referenceMetadataField(reference, 'Analyzer', 'Condition', getReferenceItemCondition(reference))),
        rawCell(actionGroup([
            actionButton('Open', 'openAnalyzerReference', referenceActionValue(reference, 'Analyzer')),
            actionButton('Copy Path', 'copyAnalyzerReferencePath', referenceActionValue(reference, 'Analyzer')),
            actionButton('Copy XML', 'copyAnalyzerReference', referenceActionValue(reference, 'Analyzer')),
            actionButton('Remove', 'removeAnalyzerReference', referenceActionValue(reference, 'Analyzer'))
        ]))
    ]), 'No analyzer references.')}
            ${actionTable(['Source generator', 'Source', 'Version', 'Actions'], sourceGenerators.map((reference) => [
        reference.name,
        reference.source || '',
        reference.version || '',
        rawCell(actionGroup([
            actionButton('Open', 'openSourceGenerator', sourceGeneratorActionValue(reference)),
            actionButton('Copy Path', 'copySourceGeneratorPath', sourceGeneratorActionValue(reference)),
            actionButton('Copy XML', 'copySourceGeneratorXml', sourceGeneratorActionValue(reference))
        ]))
    ]), 'No source generators detected.')}
          </div>
        </section>

        ${configurationPaneMarkup}

        <section class="pane" data-pane="configuration-actions" role="tabpanel">
          <div class="section">
            <div class="section-title">Configurations</div>
            ${actionBar([
        actionButton('Add Configuration', 'addConfiguration')
    ])}
            ${referenceTable(['Configuration', 'Platform', 'Properties'], displayConfigurations.map((configuration) => [
        configuration.configuration,
        configuration.platform,
        String(countConfigurationProperties(configuration.source))
    ]), 'No configurations.')}
          </div>
        </section>

        <section class="pane" data-pane="run-profiles" role="tabpanel">
          <div class="section">
            <div class="section-title">Run Profiles</div>
            ${fieldRow('launchSettings.json:', launchSettings.path || 'Not configured')}
            ${actionBar([
        actionButton('Add Run Profile', 'addLaunchProfile'),
        actionButton('Open launchSettings.json', 'openLaunchSettings')
    ])}
          </div>
          ${launchProfiles.map((profile, index) => launchProfileEditor(profile, index)).join('')}
        </section>

        <section class="pane" data-pane="imports" role="tabpanel">
          <div class="section">
            <div class="section-title">Imports</div>
            ${actionTable(['Import', 'Source', 'Kind', 'Properties', 'Targets', 'Tasks', 'Condition', 'Actions'], imports.map((item) => [
        item.name,
        item.source || '',
        item.implicit ? 'Implicit' : 'Explicit',
        String(item.propertyCount || 0),
        String(item.targetCount || 0),
        String(item.taskCount || 0),
        item.condition || '',
        rawCell(actionGroup([
            actionButton('Open', 'openImport', importActionValue(item)),
            actionButton('Folder', 'openImportFolder', importActionValue(item)),
            actionButton('Copy Path', 'copyImportPath', importActionValue(item)),
            actionButton('Copy Summary', 'copyImportSummary', importActionValue(item)),
            actionButton('Copy XML', 'copyImportXml', importActionValue(item))
        ]))
    ]), 'No imports.')}
          </div>
        </section>

        <section class="pane" data-pane="diagnostic-properties" role="tabpanel">
          <div class="section">
            <div class="section-title">Properties</div>
            ${actionBar([
        actionButton('Open Project File', 'openProjectFile'),
        actionButton('Copy All XML', 'copyAllDiagnosticPropertiesXml')
    ])}
            ${referenceTable(['Property', 'Value', 'Condition'], [
        ['AssemblyName', assemblyName],
        ['RootNamespace', rootNamespace],
        ['TargetFramework', targetFramework],
        ['TargetFrameworks', targetFrameworks.join('; ') || 'Not specified'],
        ['OutputType', metadata.outputType || 'Library'],
        ['Nullable', metadata.nullable || 'Not specified'],
        ['LangVersion', metadata.langVersion || 'Default'],
        ['Sdk', sdk]
    ].map((row) => [...row, '']), 'No project properties.')}
            ${actionTable(['MSBuild property', 'Value', 'Condition', 'Actions'], diagnosticProperties.map((property, index) => [
        property.name,
        property.value,
        property.condition || property.groupCondition || '',
        rawCell(actionGroup([
            actionButton('Copy Name', 'copyDiagnosticPropertyName', String(index)),
            actionButton('Copy Value', 'copyDiagnosticPropertyValue', String(index)),
            actionButton('Copy XML', 'copyDiagnosticPropertyXml', String(index))
        ]))
    ]), 'No project properties parsed.')}
          </div>
        </section>
      </main>
    </div>
    <footer class="footer">
      <span class="status" data-status>${escapeHtml(notice)}</span>
      <button type="button" data-close>Cancel</button>
      <button type="button" data-apply>Apply</button>
      <button type="button" class="primary" data-ok>OK</button>
    </footer>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const tabs = document.querySelectorAll('[data-tab]');
    const panes = document.querySelectorAll('[data-pane]');
    const status = document.querySelector('[data-status]');

    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.tab;

        tabs.forEach((item) => {
          const selected = item === tab;
          item.classList.toggle('active', selected);
          item.setAttribute('aria-selected', selected ? 'true' : 'false');
        });
        panes.forEach((pane) => pane.classList.toggle('active', pane.dataset.pane === target));
      });
    });

    document.querySelectorAll('[data-close]').forEach((button) => {
      button.addEventListener('click', () => vscode.postMessage({ command: 'close' }));
    });

    document.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => {
        if (status) {
          status.textContent = 'Running...';
        }

        vscode.postMessage({
          command: 'projectAction',
          action: button.dataset.action,
          value: button.dataset.value || ''
        });
      });
    });

    document.querySelectorAll('[data-prop]').forEach((control) => {
      control.addEventListener('input', () => syncPropertyControls(control));
      control.addEventListener('change', () => syncPropertyControls(control));
    });

    document.querySelector('[data-apply]').addEventListener('click', () => {
      postProperties('applyProperties');
    });

    document.querySelector('[data-ok]').addEventListener('click', () => {
      postProperties('saveAndClose');
    });

    window.addEventListener('message', (event) => {
      if (event.data && event.data.command === 'saveFailed' && status) {
        status.textContent = event.data.message || 'Save failed.';
      }

      if (event.data && event.data.command === 'actionCompleted' && status) {
        status.textContent = event.data.message || 'Action completed.';
      }
    });

    function postProperties(command) {
      const values = {
        properties: {},
        configurations: []
      };

      document.querySelectorAll('[data-prop]').forEach((control) => {
        values.properties[control.dataset.prop] = control.value;
      });

      const configurationMap = new Map();

      document.querySelectorAll('[data-config-prop]').forEach((control) => {
        const configuration = control.dataset.configuration;
        const platform = control.dataset.platform || 'AnyCPU';
        const key = configuration + '\\u0000' + platform;

        if (!configurationMap.has(key)) {
          configurationMap.set(key, {
            configuration,
            platform,
            properties: {}
          });
        }

        configurationMap.get(key).properties[control.dataset.configProp] = control.value;
      });

      values.configurations = Array.from(configurationMap.values());

      const packageReferenceMap = new Map();

      document.querySelectorAll('[data-package-prop]').forEach((control) => {
        const include = control.dataset.packageInclude || '';
        const groupCondition = control.dataset.packageGroupCondition || '';

        if (!include) {
          return;
        }

        const key = include + '\\u0000' + groupCondition;

        if (!packageReferenceMap.has(key)) {
          packageReferenceMap.set(key, {
            include,
            groupCondition,
            metadata: {}
          });
        }

        packageReferenceMap.get(key).metadata[control.dataset.packageProp] = control.value;
      });

      values.packageReferences = Array.from(packageReferenceMap.values());

      const referenceMap = new Map();

      document.querySelectorAll('[data-reference-prop]').forEach((control) => {
        const elementName = control.dataset.referenceElement || '';
        const include = control.dataset.referenceInclude || '';
        const groupCondition = control.dataset.referenceGroupCondition || '';

        if (!elementName || !include) {
          return;
        }

        const key = elementName + '\\u0000' + include + '\\u0000' + groupCondition;

        if (!referenceMap.has(key)) {
          referenceMap.set(key, {
            elementName,
            include,
            groupCondition,
            metadata: {}
          });
        }

        referenceMap.get(key).metadata[control.dataset.referenceProp] = control.value;
      });

      values.references = Array.from(referenceMap.values());

      const projectItemMap = new Map();

      document.querySelectorAll('[data-project-item-prop]').forEach((control) => {
        const elementName = control.dataset.projectItemElement || '';
        const identity = control.dataset.projectItemIdentity || '';
        const identityAttribute = control.dataset.projectItemIdentityAttribute || 'Include';
        const groupCondition = control.dataset.projectItemGroupCondition || '';

        if (!elementName || !identity) {
          return;
        }

        const key = elementName + '\\u0000' + identity + '\\u0000' + groupCondition;

        if (!projectItemMap.has(key)) {
          projectItemMap.set(key, {
            elementName,
            identity,
            identityAttribute,
            groupCondition,
            metadata: {}
          });
        }

        projectItemMap.get(key).metadata[control.dataset.projectItemProp] = control.value;
      });

      values.projectItems = Array.from(projectItemMap.values());

      const launchProfileMap = new Map();

      document.querySelectorAll('[data-launch-prop]').forEach((control) => {
        const index = control.dataset.launchProfile || '0';
        const originalName = control.dataset.launchOriginal || '';

        if (!launchProfileMap.has(index)) {
          launchProfileMap.set(index, {
            originalName
          });
        }

        launchProfileMap.get(index)[control.dataset.launchProp] = control.value;
      });

      values.launchProfiles = Array.from(launchProfileMap.values());

      if (status) {
        status.textContent = 'Saving...';
      }

      vscode.postMessage({ command, values });
    }

    function syncPropertyControls(source) {
      const propertyName = source.dataset.prop;

      if (!propertyName) {
        return;
      }

      document.querySelectorAll('[data-prop]').forEach((target) => {
        if (target !== source && target.dataset.prop === propertyName) {
          target.value = source.value;
        }
      });
    }
  </script>
</body>
</html>`;
}
function getSigningSummary(signing) {
    return isTrue(signing.signAssembly) ? 'Strong name enabled' : 'Not signed';
}
function getBuildEventSummary(buildEvents) {
    return buildEvents.preBuildEvent || buildEvents.postBuildEvent ? 'Configured' : 'No events';
}
function getDisplayConfigurations(configurations = []) {
    const byKey = new Map();
    for (const configuration of configurations) {
        if (!configuration?.configuration) {
            continue;
        }
        const platform = configuration.platform || 'AnyCPU';
        const key = `${configuration.configuration}|${platform}`.toLowerCase();
        byKey.set(key, {
            configuration: configuration.configuration,
            platform,
            source: configuration
        });
    }
    ensureConfiguration(byKey, 'Debug', 'AnyCPU');
    ensureConfiguration(byKey, 'Release', 'AnyCPU');
    return [...byKey.values()]
        .sort((left, right) => compareConfigurations(left, right))
        .map((item) => ({
        ...item,
        id: `configuration-${slugifyPaneId(`${item.configuration}-${item.platform}`)}`,
        label: `${item.configuration} | ${item.platform}`
    }));
}
function ensureConfiguration(byKey, configuration, platform) {
    const hasConfiguration = [...byKey.values()].some((item) => item.configuration.toLowerCase() === configuration.toLowerCase());
    if (hasConfiguration) {
        return;
    }
    byKey.set(`${configuration}|${platform}`.toLowerCase(), {
        configuration,
        platform,
        source: {
            configuration,
            platform,
            properties: {}
        }
    });
}
function compareConfigurations(left, right) {
    const rank = (item) => {
        const name = item.configuration.toLowerCase();
        if (name === 'debug') {
            return 0;
        }
        if (name === 'release') {
            return 1;
        }
        return 2;
    };
    const leftRank = rank(left);
    const rightRank = rank(right);
    if (leftRank !== rightRank) {
        return leftRank - rightRank;
    }
    return `${left.configuration}|${left.platform}`.localeCompare(`${right.configuration}|${right.platform}`);
}
function configurationPane(displayConfiguration, outputType, targetFramework) {
    const configuration = displayConfiguration.source;
    const name = displayConfiguration.configuration;
    const platform = displayConfiguration.platform;
    return `<section class="pane" data-pane="${escapeAttribute(displayConfiguration.id)}" role="tabpanel">
    <div class="section">
      <div class="section-title">${escapeHtml(displayConfiguration.label)}</div>
      ${canRemoveConfiguration(displayConfiguration) ? actionBar([
        actionButton('Remove Configuration', 'removeConfiguration', `${name}|${platform}`)
    ]) : ''}
      ${fieldRow('Configuration:', name)}
      ${fieldRow('Platform:', platform)}
      ${fieldRow('Output type:', outputType)}
      ${fieldRow('Target framework:', targetFramework)}
      ${editableConfigFieldRow('Output path:', name, platform, 'OutputPath', getConfigurationProperty(configuration, 'OutputPath'))}
      ${editableConfigFieldRow('Base output path:', name, platform, 'BaseOutputPath', getConfigurationProperty(configuration, 'BaseOutputPath'))}
      ${editableConfigFieldRow('Intermediate output path:', name, platform, 'IntermediateOutputPath', getConfigurationProperty(configuration, 'IntermediateOutputPath'))}
      ${actionBar([
        actionButton('Browse Output Path', 'browseConfigurationProperty', configurationActionValue(name, platform, 'OutputPath')),
        actionButton('Browse Base Output Path', 'browseConfigurationProperty', configurationActionValue(name, platform, 'BaseOutputPath')),
        actionButton('Browse Intermediate Path', 'browseConfigurationProperty', configurationActionValue(name, platform, 'IntermediateOutputPath'))
    ])}
      ${editableConfigFieldRow('Platform target:', name, platform, 'PlatformTarget', getConfigurationProperty(configuration, 'PlatformTarget'))}
      ${editableConfigFieldRow('Runtime identifier:', name, platform, 'RuntimeIdentifier', getConfigurationProperty(configuration, 'RuntimeIdentifier'))}
      ${selectConfigInputRow('Self-contained:', name, platform, 'SelfContained', getConfigurationProperty(configuration, 'SelfContained'), ['', 'true', 'false'])}
    </div>
    <div class="section">
      <div class="section-title">Compiler</div>
      ${selectConfigInputRow('Optimize:', name, platform, 'Optimize', getConfigurationProperty(configuration, 'Optimize'), ['', 'true', 'false'])}
      ${editableConfigFieldRow('Define constants:', name, platform, 'DefineConstants', getConfigurationProperty(configuration, 'DefineConstants'))}
      ${selectConfigInputRow('Allow unsafe blocks:', name, platform, 'AllowUnsafeBlocks', getConfigurationProperty(configuration, 'AllowUnsafeBlocks'), ['', 'true', 'false'])}
      ${selectConfigInputRow('Check arithmetic overflow:', name, platform, 'CheckForOverflowUnderflow', getConfigurationProperty(configuration, 'CheckForOverflowUnderflow'), ['', 'true', 'false'])}
      ${editableConfigFieldRow('Debug type:', name, platform, 'DebugType', getConfigurationProperty(configuration, 'DebugType'))}
      ${selectConfigInputRow('Debug symbols:', name, platform, 'DebugSymbols', getConfigurationProperty(configuration, 'DebugSymbols'), ['', 'true', 'false'])}
      ${selectConfigInputRow('Generate documentation file:', name, platform, 'GenerateDocumentationFile', getConfigurationProperty(configuration, 'GenerateDocumentationFile'), ['', 'true', 'false'])}
      ${editableConfigFieldRow('Documentation file:', name, platform, 'DocumentationFile', getConfigurationProperty(configuration, 'DocumentationFile'))}
      ${actionBar([
        actionButton('Browse Documentation File', 'browseConfigurationProperty', configurationActionValue(name, platform, 'DocumentationFile'))
    ])}
    </div>
    <div class="section">
      <div class="section-title">Warnings</div>
      ${selectConfigInputRow('Treat warnings as errors:', name, platform, 'TreatWarningsAsErrors', getConfigurationProperty(configuration, 'TreatWarningsAsErrors'), ['', 'true', 'false'])}
      ${editableConfigFieldRow('Warnings as errors:', name, platform, 'WarningsAsErrors', getConfigurationProperty(configuration, 'WarningsAsErrors'))}
      ${editableConfigFieldRow('No warn:', name, platform, 'NoWarn', getConfigurationProperty(configuration, 'NoWarn'))}
      ${editableConfigFieldRow('Warning level:', name, platform, 'WarningLevel', getConfigurationProperty(configuration, 'WarningLevel'))}
    </div>
    <div class="section">
      <div class="section-title">Additional Properties</div>
      ${referenceTable(['Property', 'Value'], additionalConfigurationRows(configuration), `No additional ${displayConfiguration.label} properties.`)}
    </div>
  </section>`;
}
function configurationActionValue(configuration, platform, propertyName) {
    return JSON.stringify({
        configuration,
        platform,
        propertyName
    });
}
function formatPackageVersionSource(reference = {}) {
    if (reference.versionSource === 'Directory.Packages.props') {
        const suffix = reference.versionSourcePath ? ` (${getPathBasename(reference.versionSourcePath)})` : '';
        return `Directory.Packages.props${suffix}`;
    }
    return reference.versionSource || (reference.version ? 'PackageReference' : '');
}
function formatPackageSourceMappings(mappings) {
    if (!Array.isArray(mappings) || mappings.length === 0) {
        return 'Not specified';
    }
    return mappings.map((mapping) => {
        const patterns = (mapping.patterns || []).join(', ');
        return patterns ? `${mapping.source}: ${patterns}` : mapping.source;
    }).join('; ');
}
function getPathBasename(value) {
    const parts = String(value || '').replace(/\\/g, '/').split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
}
function centralPackageVersionActionValue(reference = {}) {
    return JSON.stringify({
        name: reference.name || reference.include,
        include: reference.include || reference.name,
        version: reference.version,
        path: reference.path,
        condition: reference.condition,
        itemCondition: reference.itemCondition,
        groupCondition: reference.groupCondition
    });
}
function nugetPackageSourceActionValue(source = {}) {
    return JSON.stringify({
        key: source.key,
        value: source.value,
        protocolVersion: source.protocolVersion,
        disabled: source.disabled
    });
}
function nugetPackageSourceMappingActionValue(mapping = {}) {
    return JSON.stringify({
        source: mapping.source,
        patterns: mapping.patterns || []
    });
}
function packageActionValue(reference = {}) {
    return JSON.stringify({
        name: reference.name || reference.include,
        include: reference.include,
        version: reference.version || reference.resolved || reference.requested,
        versionOverride: reference.versionOverride,
        centralVersion: reference.centralVersion,
        versionSource: reference.versionSource,
        versionSourcePath: reference.versionSourcePath,
        versionSourceCondition: reference.versionSourceCondition,
        packageSourceMappings: reference.packageSourceMappings,
        packageSourceMappingSources: reference.packageSourceMappingSources,
        packageSourceMappingPatterns: reference.packageSourceMappingPatterns,
        requested: reference.requested,
        resolved: reference.resolved,
        packageAssetGroups: reference.packageAssetGroups,
        compile: reference.compile,
        runtime: reference.runtime,
        native: reference.native,
        resource: reference.resource,
        build: reference.build,
        buildMultiTargeting: reference.buildMultiTargeting,
        buildTransitive: reference.buildTransitive,
        contentFiles: reference.contentFiles,
        analyzers: reference.analyzers,
        frameworkAssemblies: reference.frameworkAssemblies,
        runtimeTargets: reference.runtimeTargets,
        path: reference.path,
        direct: reference.direct,
        privateAssets: reference.privateAssets,
        includeAssets: reference.includeAssets,
        excludeAssets: reference.excludeAssets,
        outputItemType: reference.outputItemType,
        referenceOutputAssembly: reference.referenceOutputAssembly,
        generatePathProperty: reference.generatePathProperty,
        aliases: reference.aliases,
        noWarn: reference.noWarn,
        condition: reference.condition,
        itemCondition: reference.itemCondition,
        groupCondition: reference.groupCondition
    });
}
function targetActionValue(target = {}) {
    return JSON.stringify({
        name: target.name,
        beforeTargets: target.beforeTargets,
        afterTargets: target.afterTargets,
        dependsOnTargets: target.dependsOnTargets,
        condition: target.condition,
        inputs: target.inputs,
        outputs: target.outputs,
        keepDuplicateOutputs: target.keepDuplicateOutputs,
        returns: target.returns,
        tasks: target.tasks,
        body: target.body
    });
}
function referenceActionValue(reference = {}, elementName) {
    return JSON.stringify({
        elementName,
        name: reference.name || reference.include || reference.path,
        include: reference.include,
        path: reference.path,
        source: reference.source,
        hintPath: reference.hintPath,
        label: reference.label,
        condition: reference.condition,
        itemCondition: getReferenceItemCondition(reference),
        groupCondition: reference.groupCondition,
        privateAssets: reference.privateAssets,
        includeAssets: reference.includeAssets,
        excludeAssets: reference.excludeAssets,
        referenceOutputAssembly: reference.referenceOutputAssembly,
        outputItemType: reference.outputItemType,
        aliases: reference.aliases,
        private: reference.private
    });
}
function projectItemActionValue(reference = {}, elementName) {
    return JSON.stringify({
        elementName,
        name: reference.name || reference.include || reference.update || reference.remove,
        include: reference.include,
        update: reference.update,
        remove: reference.remove,
        identity: reference.identity || reference.name || reference.include || reference.update || reference.remove,
        identityAttribute: reference.identityAttribute,
        path: reference.path,
        condition: reference.condition,
        itemCondition: reference.itemCondition,
        groupCondition: reference.groupCondition,
        copyToOutputDirectory: reference.copyToOutputDirectory,
        copyToPublishDirectory: reference.copyToPublishDirectory,
        link: reference.link,
        logicalName: reference.logicalName,
        generator: reference.generator,
        lastGenOutput: reference.lastGenOutput,
        dependentUpon: reference.dependentUpon,
        subType: reference.subType
    });
}
function sourceGeneratorActionValue(reference = {}) {
    return JSON.stringify({
        name: reference.name || reference.include,
        include: reference.include,
        version: reference.version,
        source: reference.source,
        path: reference.path,
        hintPath: reference.hintPath,
        condition: reference.condition,
        itemCondition: reference.itemCondition,
        groupCondition: reference.groupCondition,
        privateAssets: reference.privateAssets,
        includeAssets: reference.includeAssets,
        excludeAssets: reference.excludeAssets,
        versionOverride: reference.versionOverride,
        centralVersion: reference.centralVersion,
        versionSource: reference.versionSource,
        versionSourcePath: reference.versionSourcePath,
        outputItemType: reference.outputItemType,
        referenceOutputAssembly: reference.referenceOutputAssembly,
        generatePathProperty: reference.generatePathProperty,
        aliases: reference.aliases,
        noWarn: reference.noWarn
    });
}
function importActionValue(reference = {}) {
    return JSON.stringify({
        name: reference.name || reference.source || reference.path,
        source: reference.source,
        path: reference.path,
        label: reference.label,
        condition: reference.condition,
        implicit: reference.implicit,
        kind: reference.kind,
        propertyCount: reference.propertyCount,
        targetCount: reference.targetCount,
        taskCount: reference.taskCount,
        properties: reference.properties,
        targets: reference.targets
    });
}
function countConfigurationProperties(configuration) {
    return Object.keys(configuration?.properties || {}).length;
}
function countProjectItems(projectItems = {}) {
    return [
        projectItems.compile,
        projectItems.content,
        projectItems.none,
        projectItems.embeddedResources,
        projectItems.additionalFiles
    ].reduce((total, items) => total + (Array.isArray(items) ? items.length : 0), 0);
}
function canRemoveConfiguration(displayConfiguration) {
    return Boolean(displayConfiguration?.source?.condition && countConfigurationProperties(displayConfiguration.source) > 0);
}
function getConfigurationProperty(configuration, name) {
    return configuration?.properties?.[name] || '';
}
function additionalConfigurationRows(configuration) {
    if (!configuration || !configuration.properties) {
        return [];
    }
    const known = new Set(CONFIGURATION_EDITOR_PROPERTIES);
    return Object.entries(configuration.properties)
        .filter(([key]) => !known.has(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, value]);
}
function getDisplayLaunchProfiles(project, launchSettings) {
    const profiles = launchSettings.profiles || [];
    if (profiles.length > 0) {
        return profiles;
    }
    return [
        {
            name: project.name,
            commandName: 'Project',
            executablePath: '',
            commandLineArgs: '',
            workingDirectory: '',
            launchBrowser: '',
            launchUrl: '',
            applicationUrl: '',
            environmentVariables: {},
            virtual: true
        }
    ];
}
function createPackageReferenceOperations(packageReferences) {
    if (!Array.isArray(packageReferences)) {
        return [];
    }
    return packageReferences
        .map((reference) => ({
        action: 'add',
        elementName: 'PackageReference',
        include: reference.include,
        groupCondition: reference.groupCondition,
        metadata: reference.metadata || {}
    }))
        .filter((operation) => operation.include);
}
function createReferenceOperations(references) {
    if (!Array.isArray(references)) {
        return [];
    }
    return references
        .map((reference) => ({
        action: 'add',
        elementName: reference.elementName,
        include: reference.include,
        groupCondition: reference.groupCondition,
        metadata: reference.metadata || {}
    }))
        .filter((operation) => operation.elementName && operation.include);
}
function createProjectItemOperations(items) {
    if (!Array.isArray(items)) {
        return [];
    }
    return items
        .map((item) => ({
        action: 'add',
        elementName: item.elementName,
        include: item.identity,
        identityAttribute: item.identityAttribute,
        groupCondition: item.groupCondition,
        metadata: item.metadata || {}
    }))
        .filter((operation) => operation.elementName && operation.include);
}
function launchProfileEditor(profile, index) {
    const originalName = profile.name || '';
    return `<div class="section">
    <div class="section-title">Profile: ${escapeHtml(profile.name || `Profile ${index + 1}`)}</div>
    ${profile.virtual ? '' : actionBar([
        actionButton('Run', 'runLaunchProfile', originalName),
        actionButton('Copy Command', 'copyLaunchCommand', originalName),
        actionButton('Terminal', 'openLaunchTerminal', originalName),
        actionButton('Duplicate', 'duplicateLaunchProfile', originalName),
        actionButton('Remove', 'removeLaunchProfile', originalName)
    ])}
    ${editableLaunchFieldRow('Profile name:', index, originalName, 'name', profile.name || '')}
    ${selectLaunchInputRow('Command:', index, originalName, 'commandName', profile.commandName || 'Project', ['', 'Project', 'Executable', 'IISExpress'])}
    ${profile.virtual ? '' : actionBar([
        actionButton('Browse Executable', 'browseLaunchExecutable', originalName),
        actionButton('Browse Working Directory', 'browseLaunchWorkingDirectory', originalName)
    ])}
    ${editableLaunchFieldRow('Executable path:', index, originalName, 'executablePath', profile.executablePath || '')}
    ${editableLaunchFieldRow('Command line arguments:', index, originalName, 'commandLineArgs', profile.commandLineArgs || '')}
    ${editableLaunchFieldRow('Working directory:', index, originalName, 'workingDirectory', profile.workingDirectory || '')}
    ${selectLaunchInputRow('Launch browser:', index, originalName, 'launchBrowser', profile.launchBrowser || '', ['', 'true', 'false'])}
    ${editableLaunchFieldRow('Launch URL:', index, originalName, 'launchUrl', profile.launchUrl || '')}
    ${editableLaunchFieldRow('Application URL:', index, originalName, 'applicationUrl', profile.applicationUrl || '')}
    ${textareaLaunchRow('Environment variables:', index, originalName, 'environmentVariables', (0, launchSettingsEditor_1.serializeEnvironmentVariables)(profile.environmentVariables || {}))}
  </div>`;
}
function projectItemTable(elementName, label, items, emptyMessage) {
    return `<div class="section">
    <div class="section-title">${escapeHtml(label)}</div>
    ${actionTable(['Item', 'Metadata', 'Item Condition', 'Group Condition', 'Actions'], items.map((reference) => [
        reference.name,
        rawCell(projectItemMetadataFields(reference, elementName)),
        rawCell(projectItemMetadataField(reference, elementName, 'Condition', reference.itemCondition || '')),
        reference.groupCondition || '',
        rawCell(actionGroup([
            actionButton('Open', 'openProjectItem', projectItemActionValue(reference, elementName)),
            actionButton('Folder', 'openProjectItemFolder', projectItemActionValue(reference, elementName)),
            actionButton('Copy Path', 'copyProjectItemPath', projectItemActionValue(reference, elementName)),
            actionButton('Copy XML', 'copyProjectItemXml', projectItemActionValue(reference, elementName)),
            actionButton('Remove', 'removeProjectItem', projectItemActionValue(reference, elementName))
        ]))
    ]), emptyMessage)}
  </div>`;
}
function projectItemMetadataFields(reference, elementName) {
    return `<div class="table-actions">${[
        ['CopyToOutputDirectory', reference.copyToOutputDirectory || ''],
        ['CopyToPublishDirectory', reference.copyToPublishDirectory || ''],
        ['Link', reference.link || ''],
        ['LogicalName', reference.logicalName || ''],
        ['Generator', reference.generator || ''],
        ['LastGenOutput', reference.lastGenOutput || ''],
        ['DependentUpon', reference.dependentUpon || ''],
        ['SubType', reference.subType || '']
    ]
        .map(([propertyName, value]) => projectItemMetadataField(reference, elementName, propertyName, value))
        .join('')}</div>`;
}
function projectItemMetadataField(reference, elementName, propertyName, value) {
    const identity = reference.identity || reference.name || reference.include || reference.update || reference.remove || '';
    const identityAttribute = reference.identityAttribute || (reference.include ? 'Include' : reference.update ? 'Update' : reference.remove ? 'Remove' : 'Include');
    const id = `project-item-${elementName}-${identity}-${propertyName}`.replace(/[^\w.-]/g, '-');
    return `<input id="${escapeAttribute(id)}" class="field" placeholder="${escapeAttribute(propertyName)}" data-project-item-element="${escapeAttribute(elementName)}" data-project-item-identity="${escapeAttribute(identity)}" data-project-item-identity-attribute="${escapeAttribute(identityAttribute)}" data-project-item-group-condition="${escapeAttribute(reference.groupCondition || '')}" data-project-item-prop="${escapeAttribute(propertyName)}" value="${escapeAttribute(value)}">`;
}
function projectItemMetadataSummary(reference = {}) {
    const parts = [
        ['Identity', reference.identityAttribute],
        ['CopyToOutputDirectory', reference.copyToOutputDirectory],
        ['CopyToPublishDirectory', reference.copyToPublishDirectory],
        ['Link', reference.link],
        ['LogicalName', reference.logicalName],
        ['Generator', reference.generator],
        ['LastGenOutput', reference.lastGenOutput],
        ['DependentUpon', reference.dependentUpon],
        ['SubType', reference.subType]
    ]
        .filter(([, value]) => value)
        .map(([key, value]) => `${key}=${value}`);
    return parts.join('; ');
}
function getAllResolvedPackages(metadata) {
    const dependencies = metadata.resolvedDependencies || {};
    const byKey = new Map();
    for (const framework of Object.values(dependencies)) {
        for (const item of framework.packages || []) {
            const key = `${item.name}/${item.version || ''}`.toLowerCase();
            if (!byKey.has(key) || item.direct) {
                byKey.set(key, item);
            }
        }
    }
    return [...byKey.values()].sort((left, right) => {
        if (left.direct !== right.direct) {
            return left.direct ? -1 : 1;
        }
        return left.name.localeCompare(right.name, undefined, {
            sensitivity: 'base'
        });
    });
}
function formatReferenceMetadata(reference) {
    const parts = [
        ['PrivateAssets', reference.privateAssets],
        ['IncludeAssets', reference.includeAssets],
        ['ExcludeAssets', reference.excludeAssets],
        ['HintPath', reference.hintPath],
        ['Private', reference.private],
        ['ReferenceOutputAssembly', reference.referenceOutputAssembly],
        ['OutputItemType', reference.outputItemType],
        ['Aliases', reference.aliases],
        ['GroupCondition', reference.groupCondition]
    ]
        .filter(([, value]) => value)
        .map(([key, value]) => `${key}=${value}`);
    return parts.join('; ');
}
function getReferenceItemCondition(reference = {}) {
    return reference.itemCondition === undefined ? reference.condition || '' : reference.itemCondition || '';
}
function formatValue(value, fallback = '') {
    return value === undefined || value === '' ? fallback : value;
}
function isTrue(value) {
    return /^true$/i.test(String(value || '').trim());
}
function navGroup(label, items) {
    return `<div class="group-title">${escapeHtml(label)}</div><ul class="nav" role="tablist">${items.join('')}</ul>`;
}
function navItem(id, label, detail = '', count = '', active = false) {
    const countMarkup = count === '' || count === undefined
        ? ''
        : `<span class="badge">${escapeHtml(count)}</span>`;
    return `<li><button type="button" class="nav-item${active ? ' active' : ''}" data-tab="${escapeHtml(id)}" role="tab" aria-selected="${active ? 'true' : 'false'}">
    <span class="nav-main">
      <span class="nav-label">${escapeHtml(label)}</span>
      <span class="nav-detail">${escapeHtml(detail)}</span>
    </span>
    ${countMarkup}
  </button></li>`;
}
function actionBar(buttons) {
    return `<div class="actions">${buttons.join('')}</div>`;
}
function actionGroup(buttons) {
    return `<span class="table-actions">${buttons.join('')}</span>`;
}
function actionButton(label, action, value = '') {
    return `<button type="button" class="action-button" data-action="${escapeAttribute(action)}" data-value="${escapeAttribute(value)}">${escapeHtml(label)}</button>`;
}
function packageReferenceField(reference, propertyName, value) {
    const id = `package-${reference.name}-${propertyName}`.replace(/[^\w.-]/g, '-');
    return `<input id="${escapeAttribute(id)}" class="field" data-package-include="${escapeAttribute(reference.include || reference.name)}" data-package-group-condition="${escapeAttribute(reference.groupCondition || '')}" data-package-prop="${escapeAttribute(propertyName)}" value="${escapeAttribute(value)}">`;
}
function referenceMetadataFields(reference, elementName, fields) {
    return `<div class="table-actions">${fields
        .map(([propertyName, value]) => referenceMetadataField(reference, elementName, propertyName, value))
        .join('')}</div>`;
}
function referenceMetadataField(reference, elementName, propertyName, value) {
    const include = reference.include || reference.name || reference.path || '';
    const id = `reference-${elementName}-${include}-${propertyName}`.replace(/[^\w.-]/g, '-');
    const placeholder = propertyName;
    return `<input id="${escapeAttribute(id)}" class="field" placeholder="${escapeAttribute(placeholder)}" data-reference-element="${escapeAttribute(elementName)}" data-reference-include="${escapeAttribute(include)}" data-reference-group-condition="${escapeAttribute(reference.groupCondition || '')}" data-reference-prop="${escapeAttribute(propertyName)}" value="${escapeAttribute(value)}">`;
}
function fieldRow(label, value) {
    return `<div class="form-row"><div class="label">${escapeHtml(label)}</div><div class="field">${escapeHtml(value)}</div></div>`;
}
function formatGlobalJsonMsbuildSdks(msbuildSdks) {
    const entries = Object.entries(msbuildSdks || {});
    if (entries.length === 0) {
        return 'Not specified';
    }
    return entries.map(([name, version]) => `${name} ${version}`.trim()).join('; ');
}
function selectRow(label, value) {
    return `<div class="form-row"><div class="label">${escapeHtml(label)}</div><div class="select">${escapeHtml(value)}</div></div>`;
}
function editableFieldRow(label, propertyName, value) {
    return `<div class="form-row"><label class="label" for="${escapeAttribute(propertyName)}">${escapeHtml(label)}</label><input id="${escapeAttribute(propertyName)}" class="field" data-prop="${escapeAttribute(propertyName)}" value="${escapeAttribute(value)}"></div>`;
}
function editableSharedFieldRow(label, propertyName, value, idSuffix) {
    const id = `${propertyName}-${idSuffix}`.replace(/[^\w.-]/g, '-');
    return `<div class="form-row"><label class="label" for="${escapeAttribute(id)}">${escapeHtml(label)}</label><input id="${escapeAttribute(id)}" class="field" data-prop="${escapeAttribute(propertyName)}" value="${escapeAttribute(value)}"></div>`;
}
function textareaRow(label, propertyName, value) {
    return `<div class="form-row"><label class="label" for="${escapeAttribute(propertyName)}">${escapeHtml(label)}</label><textarea id="${escapeAttribute(propertyName)}" class="textarea" data-prop="${escapeAttribute(propertyName)}">${escapeHtml(value)}</textarea></div>`;
}
function textareaSharedRow(label, propertyName, value, idSuffix) {
    const id = `${propertyName}-${idSuffix}`.replace(/[^\w.-]/g, '-');
    return `<div class="form-row"><label class="label" for="${escapeAttribute(id)}">${escapeHtml(label)}</label><textarea id="${escapeAttribute(id)}" class="textarea" data-prop="${escapeAttribute(propertyName)}">${escapeHtml(value)}</textarea></div>`;
}
function selectInputRow(label, propertyName, value, options) {
    const normalizedValue = String(value ?? '');
    const optionMarkup = options
        .map((option) => {
        const selected = String(option) === normalizedValue ? ' selected' : '';
        const labelText = option === '' ? 'Not specified' : option;
        return `<option value="${escapeAttribute(option)}"${selected}>${escapeHtml(labelText)}</option>`;
    })
        .join('');
    return `<div class="form-row"><label class="label" for="${escapeAttribute(propertyName)}">${escapeHtml(label)}</label><select id="${escapeAttribute(propertyName)}" class="select" data-prop="${escapeAttribute(propertyName)}">${optionMarkup}</select></div>`;
}
function editableConfigFieldRow(label, configuration, platform, propertyName, value) {
    const id = `${configuration}-${platform}-${propertyName}`.replace(/[^\w.-]/g, '-');
    return `<div class="form-row"><label class="label" for="${escapeAttribute(id)}">${escapeHtml(label)}</label><input id="${escapeAttribute(id)}" class="field" data-configuration="${escapeAttribute(configuration)}" data-platform="${escapeAttribute(platform)}" data-config-prop="${escapeAttribute(propertyName)}" value="${escapeAttribute(value)}"></div>`;
}
function selectConfigInputRow(label, configuration, platform, propertyName, value, options) {
    const id = `${configuration}-${platform}-${propertyName}`.replace(/[^\w.-]/g, '-');
    const normalizedValue = String(value ?? '');
    const optionMarkup = options
        .map((option) => {
        const selected = String(option) === normalizedValue ? ' selected' : '';
        const labelText = option === '' ? 'Not specified' : option;
        return `<option value="${escapeAttribute(option)}"${selected}>${escapeHtml(labelText)}</option>`;
    })
        .join('');
    return `<div class="form-row"><label class="label" for="${escapeAttribute(id)}">${escapeHtml(label)}</label><select id="${escapeAttribute(id)}" class="select" data-configuration="${escapeAttribute(configuration)}" data-platform="${escapeAttribute(platform)}" data-config-prop="${escapeAttribute(propertyName)}">${optionMarkup}</select></div>`;
}
function editableLaunchFieldRow(label, index, originalName, propertyName, value) {
    const id = `launch-${index}-${propertyName}`.replace(/[^\w.-]/g, '-');
    return `<div class="form-row"><label class="label" for="${escapeAttribute(id)}">${escapeHtml(label)}</label><input id="${escapeAttribute(id)}" class="field" data-launch-profile="${escapeAttribute(index)}" data-launch-original="${escapeAttribute(originalName)}" data-launch-prop="${escapeAttribute(propertyName)}" value="${escapeAttribute(value)}"></div>`;
}
function textareaLaunchRow(label, index, originalName, propertyName, value) {
    const id = `launch-${index}-${propertyName}`.replace(/[^\w.-]/g, '-');
    return `<div class="form-row"><label class="label" for="${escapeAttribute(id)}">${escapeHtml(label)}</label><textarea id="${escapeAttribute(id)}" class="textarea" data-launch-profile="${escapeAttribute(index)}" data-launch-original="${escapeAttribute(originalName)}" data-launch-prop="${escapeAttribute(propertyName)}">${escapeHtml(value)}</textarea></div>`;
}
function selectLaunchInputRow(label, index, originalName, propertyName, value, options) {
    const id = `launch-${index}-${propertyName}`.replace(/[^\w.-]/g, '-');
    const normalizedValue = String(value ?? '');
    const optionMarkup = options
        .map((option) => {
        const selected = String(option) === normalizedValue ? ' selected' : '';
        const labelText = option === '' ? 'Not specified' : option;
        return `<option value="${escapeAttribute(option)}"${selected}>${escapeHtml(labelText)}</option>`;
    })
        .join('');
    return `<div class="form-row"><label class="label" for="${escapeAttribute(id)}">${escapeHtml(label)}</label><select id="${escapeAttribute(id)}" class="select" data-launch-profile="${escapeAttribute(index)}" data-launch-original="${escapeAttribute(originalName)}" data-launch-prop="${escapeAttribute(propertyName)}">${optionMarkup}</select></div>`;
}
function publishProfilesTable(profiles) {
    const rows = profiles.map((profile) => [
        profile.name,
        profile.publishMethod || profile.publishProvider || 'Not specified',
        profile.lastUsedBuildConfiguration || 'Not specified',
        profile.targetFramework || 'Not specified',
        profile.runtimeIdentifier || 'Not specified',
        profile.publishUrl || profile.publishDir || 'Not specified',
        rawCell(actionGroup([
            actionButton('Publish', 'publishWithProfile', profile.path),
            actionButton('Open', 'openPublishProfile', profile.path),
            actionButton('Copy Path', 'copyPublishProfilePath', profile.path),
            actionButton('Copy XML', 'copyPublishProfileXml', profile.path)
        ]))
    ]);
    return actionTable(['Name', 'Method', 'Configuration', 'Target', 'Runtime', 'Output', 'Actions'], rows, 'No publish profiles found.');
}
function centralPackageVersionsTable(versions) {
    const rows = versions.map((reference) => [
        reference.name || reference.include,
        reference.version || '',
        reference.itemCondition || reference.condition || '',
        reference.groupCondition || '',
        getPathBasename(reference.path),
        rawCell(actionGroup([
            actionButton('NuGet', 'openPackage', reference.name || reference.include),
            actionButton('Open File', 'openCentralPackageFile', centralPackageVersionActionValue(reference)),
            actionButton('Copy Path', 'copyCentralPackagePath', centralPackageVersionActionValue(reference)),
            actionButton('Copy XML', 'copyCentralPackageVersionXml', centralPackageVersionActionValue(reference))
        ]))
    ]);
    return actionTable(['Package', 'Version', 'Item Condition', 'Group Condition', 'File', 'Actions'], rows, 'No central package versions found.');
}
function nugetPackageSourcesTable(sources) {
    const rows = sources.map((source) => [
        source.key || '',
        source.value || '',
        source.protocolVersion || '',
        source.disabled ? 'Disabled' : 'Enabled',
        rawCell(actionGroup([
            actionButton('Copy URL', 'copyNuGetPackageSource', nugetPackageSourceActionValue(source))
        ]))
    ]);
    return actionTable(['Source', 'URL/Path', 'Protocol', 'Status', 'Actions'], rows, 'No package sources found.');
}
function nugetPackageSourceMappingsTable(mappings) {
    const rows = mappings.map((mapping) => [
        mapping.source || '',
        (mapping.patterns || []).join(', '),
        rawCell(actionGroup([
            actionButton('Copy XML', 'copyNuGetPackageSourceMappingXml', nugetPackageSourceMappingActionValue(mapping))
        ]))
    ]);
    return actionTable(['Mapped Source', 'Package Patterns', 'Actions'], rows, 'No package source mappings found.');
}
function msbuildTargetsTable(targets) {
    const rows = targets.map((target) => [
        target.name || '',
        target.beforeTargets || '',
        target.afterTargets || '',
        target.dependsOnTargets || '',
        target.condition || '',
        (target.tasks || []).map((task) => task.condition ? `${task.name} (${task.condition})` : task.name).join(', '),
        rawCell(actionGroup([
            actionButton('Copy XML', 'copyTargetXml', targetActionValue(target))
        ]))
    ]);
    return actionTable(['Target', 'Before', 'After', 'Depends On', 'Condition', 'Tasks', 'Actions'], rows, 'No custom MSBuild targets found.');
}
function packageLockPackagesTable(packages) {
    const rows = packages.map((reference) => [
        reference.targetFramework || '',
        reference.name || '',
        reference.type || '',
        reference.requested || '',
        reference.resolved || '',
        reference.contentHash || '',
        (reference.dependencies || []).map((item) => `${item.name} ${item.versionRange || ''}`.trim()).join(', ')
    ]);
    return actionTable(['Target', 'Package', 'Type', 'Requested', 'Resolved', 'Content Hash', 'Dependencies'], rows, 'No packages.lock.json entries found.');
}
function formatPackageLockPath(packageLock = {}) {
    if (packageLock.path) {
        return packageLock.exists === false ? `${packageLock.path} (not found)` : packageLock.path;
    }
    if (packageLock.configuredPath) {
        return packageLock.unresolved ? `${packageLock.configuredPath} (unresolved)` : packageLock.configuredPath;
    }
    return 'Not found';
}
function formatUserSecretsPath(userSecrets = {}) {
    if (userSecrets.path) {
        return userSecrets.exists === false ? `${userSecrets.path} (not found)` : userSecrets.path;
    }
    return 'Not configured';
}
function referenceTable(headers, rows, emptyMessage) {
    return actionTable(headers, rows, emptyMessage);
}
function actionTable(headers, rows, emptyMessage) {
    if (!rows.length) {
        return `<div class="empty">${escapeHtml(emptyMessage)}</div>`;
    }
    const headerMarkup = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('');
    const bodyMarkup = rows
        .map((row) => `<tr>${row.map(renderTableCell).join('')}</tr>`)
        .join('');
    return `<table class="table"><thead><tr>${headerMarkup}</tr></thead><tbody>${bodyMarkup}</tbody></table>`;
}
function rawCell(value) {
    return {
        raw: value
    };
}
function renderTableCell(value) {
    if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'raw')) {
        return `<td>${value.raw}</td>`;
    }
    return `<td>${escapeHtml(value)}</td>`;
}
function formatOutputType(value) {
    if (!value) {
        return 'Class library';
    }
    if (/exe/i.test(value)) {
        return 'Console application';
    }
    if (/library/i.test(value)) {
        return 'Class library';
    }
    return value;
}
function formatNullable(value) {
    if (!value) {
        return 'Not specified';
    }
    if (/enable/i.test(value)) {
        return 'Enable';
    }
    if (/disable/i.test(value)) {
        return 'Disable';
    }
    return value;
}
function inferLanguageVersion(targetFramework) {
    const match = /^net(\d+)\./i.exec(targetFramework || '');
    if (!match) {
        return 'Default';
    }
    const major = Number(match[1]);
    if (major >= 10) {
        return 'C# 14.0';
    }
    if (major >= 9) {
        return 'C# 13.0';
    }
    if (major >= 8) {
        return 'C# 12.0';
    }
    return 'Default';
}
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
}
function slugifyPaneId(value) {
    const slug = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug || 'configuration';
}
function getNonce() {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < 32; i += 1) {
        text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return text;
}
const __test = {
    getDisplayConfigurations,
    getProjectPropertiesHtml
};
exports.__test = __test;
