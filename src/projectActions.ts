// @ts-nocheck
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { quoteForShell } from '#src/terminalRunner';
import {
  addProjectLaunchProfile,
  duplicateProjectLaunchProfile,
  ensureLaunchSettingsFile,
  readProjectLaunchSettings,
  removeProjectLaunchProfile,
  updateProjectLaunchSettings
} from '#src/launchSettingsEditor';
import {
  removeProjectConfiguration,
  updateProjectItemReferences,
  updateProjectProperties
} from '#src/projectFileEditor';
import { showProjectProperties } from '#src/projectPropertiesView';
import { NuGetManagerView } from '#src/nugetManagerView';
import {
  PACKAGE_ASSET_GROUPS,
  readProjectAssetsFromText
} from '#src/projectAssetsReader';
import {
  enrichImportsWithImplicitDirectoryBuildFiles,
  enrichPackageReferencesWithCentralVersions,
  enrichPackagesWithPackageSourceMappings,
  enrichResolvedDependenciesWithPackageSourceMappings,
  readCentralPackageVersions,
  readGlobalJson,
  readNuGetConfig,
  readPackageLockFile,
  readProjectMetadataFromText,
  readPublishProfiles,
  readUserSecrets
} from '#src/workspaceScanner';

const PROJECT_PROPERTY_BROWSE_CONFIG = {
  ApplicationIcon: {
    kind: 'file',
    openLabel: 'Select Application Icon',
    filters: {
      'Icon files': ['ico', 'png'],
      'All files': ['*']
    }
  },
  OutputPath: {
    kind: 'folder',
    openLabel: 'Select Output Path'
  },
  BaseOutputPath: {
    kind: 'folder',
    openLabel: 'Select Base Output Path'
  },
  IntermediateOutputPath: {
    kind: 'folder',
    openLabel: 'Select Intermediate Output Path'
  },
  DocumentationFile: {
    kind: 'file',
    openLabel: 'Select Documentation File',
    filters: {
      'XML files': ['xml'],
      'All files': ['*']
    }
  },
  CompilerGeneratedFilesOutputPath: {
    kind: 'folder',
    openLabel: 'Select Generated Files Output Path'
  },
  PackageLicenseFile: {
    kind: 'file',
    openLabel: 'Select Package License File',
    filters: {
      'License files': ['txt', 'md', 'license'],
      'All files': ['*']
    }
  },
  PackageReadmeFile: {
    kind: 'file',
    openLabel: 'Select Package Readme File',
    filters: {
      'Markdown files': ['md', 'markdown'],
      'All files': ['*']
    }
  },
  PackageIcon: {
    kind: 'file',
    openLabel: 'Select Package Icon',
    filters: {
      'Image files': ['png', 'jpg', 'jpeg', 'ico', 'svg'],
      'All files': ['*']
    }
  },
  PackageOutputPath: {
    kind: 'folder',
    openLabel: 'Select Package Output Path'
  },
  PublishDir: {
    kind: 'folder',
    openLabel: 'Select Publish Directory'
  },
  PublishUrl: {
    kind: 'folder',
    openLabel: 'Select Publish URL Directory'
  },
  AssemblyOriginatorKeyFile: {
    kind: 'file',
    openLabel: 'Select Strong Name Key File',
    filters: {
      'Strong name keys': ['snk', 'pfx'],
      'All files': ['*']
    }
  }
};

const CONFIGURATION_PROPERTY_BROWSE_CONFIG = {
  OutputPath: {
    kind: 'folder',
    openLabel: 'Select Configuration Output Path'
  },
  BaseOutputPath: {
    kind: 'folder',
    openLabel: 'Select Configuration Base Output Path'
  },
  IntermediateOutputPath: {
    kind: 'folder',
    openLabel: 'Select Configuration Intermediate Output Path'
  },
  DocumentationFile: {
    kind: 'file',
    openLabel: 'Select Configuration Documentation File',
    filters: {
      'XML files': ['xml'],
      'All files': ['*']
    }
  }
};

const PROJECT_ITEM_ELEMENT_NAMES = new Set([
  'Compile',
  'Content',
  'None',
  'EmbeddedResource',
  'AdditionalFiles'
]);

class ProjectActions {
  constructor(context, terminalRunner, refresh, getState) {
    this.context = context;
    this.terminalRunner = terminalRunner;
    this.refresh = refresh;
    this.getState = getState;
    this.nugetManagerView = new NuGetManagerView(context, terminalRunner, getState, refresh);
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

  async addAssemblyReference(node) {
    const project = getProjectItem(node);
    const mode = await vscode.window.showQuickPick(
      [
        { label: 'Browse DLL...', value: 'browse' },
        { label: 'Type Assembly Name...', value: 'name' }
      ],
      {
        title: 'Add Assembly Reference',
        placeHolder: 'Choose how to add the assembly reference'
      }
    );

    if (!mode) {
      return;
    }

    let include = '';
    let metadata = {};

    if (mode.value === 'browse') {
      const selection = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Add Assembly Reference',
        filters: {
          'Assemblies': ['dll', 'exe', 'winmd'],
          'All files': ['*']
        }
      });

      if (!selection || selection.length === 0) {
        return;
      }

      const assemblyPath = selection[0].fsPath;
      include = path.basename(assemblyPath, path.extname(assemblyPath));
      metadata = {
        HintPath: vscode.workspace.asRelativePath(assemblyPath, false)
      };
    } else {
      include = await vscode.window.showInputBox({
        title: 'Add Assembly Reference',
        prompt: 'Assembly name',
        placeHolder: 'System.Data',
        validateInput: (input) => input.trim() ? undefined : 'Assembly name is required.'
      }) || '';
    }

    if (!include.trim()) {
      return;
    }

    await updateProjectItemReferences(project.path, [{
      action: 'add',
      elementName: 'Reference',
      include: include.trim(),
      metadata
    }]);
    await this.refresh({ userVisible: true });
  }

  async addFrameworkReference(node) {
    const project = getProjectItem(node);
    const pick = await vscode.window.showQuickPick(
      [
        'Microsoft.AspNetCore.App',
        'Microsoft.WindowsDesktop.App',
        'Microsoft.NETCore.App',
        'Type custom framework reference...'
      ],
      {
        title: 'Add Framework Reference',
        placeHolder: 'Select or type a framework reference'
      }
    );

    if (!pick) {
      return;
    }

    const include = pick === 'Type custom framework reference...'
      ? await vscode.window.showInputBox({
        title: 'Add Framework Reference',
        prompt: 'Framework reference name',
        placeHolder: 'Microsoft.AspNetCore.App',
        validateInput: (input) => input.trim() ? undefined : 'Framework reference name is required.'
      })
      : pick;

    if (!include || !include.trim()) {
      return;
    }

    await updateProjectItemReferences(project.path, [{
      action: 'add',
      elementName: 'FrameworkReference',
      include: include.trim()
    }]);
    await this.refresh({ userVisible: true });
  }

  async addAnalyzerReference(node) {
    const project = getProjectItem(node);
    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Add Analyzer',
      filters: {
        'Analyzer assemblies': ['dll'],
        'All files': ['*']
      }
    });

    if (!selection || selection.length === 0) {
      return;
    }

    await updateProjectItemReferences(project.path, [{
      action: 'add',
      elementName: 'Analyzer',
      include: vscode.workspace.asRelativePath(selection[0].fsPath, false)
    }]);
    await this.refresh({ userVisible: true });
  }

  async removeDependencyReference(node) {
    const project = getProjectItem(node);
    const elementName = getReferenceElementName(node.groupKind);
    const include = node.reference?.include || node.reference?.name || node.label;

    if (!elementName || !include) {
      throw new Error('This dependency reference cannot be removed from the project file.');
    }

    const answer = await vscode.window.showWarningMessage(
      `Remove ${node.label || include} from ${project.name}?`,
      { modal: true },
      'Remove'
    );

    if (answer !== 'Remove') {
      return;
    }

    await updateProjectItemReferences(project.path, [{
      action: 'remove',
      elementName,
      include,
      groupCondition: node.reference?.groupCondition
    }]);
    await this.refresh({ userVisible: true });
  }

  async manageNuGetPackages(node) {
    await this.nugetManagerView.show(node);
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

  async addPackageReference(node) {
    const project = getProjectItem(node);
    const packageName = await vscode.window.showInputBox({
      title: 'Add PackageReference',
      prompt: 'Package id',
      placeHolder: 'Microsoft.EntityFrameworkCore',
      validateInput: (value) => value.trim() ? undefined : 'Package id is required.'
    });

    if (!packageName) {
      return;
    }

    const version = await vscode.window.showInputBox({
      title: 'Add PackageReference',
      prompt: 'Optional version',
      placeHolder: '8.0.0'
    });
    const metadata = {};

    if (version && version.trim()) {
      metadata.Version = version.trim();
    }

    await updateProjectItemReferences(project.path, [{
      action: 'add',
      elementName: 'PackageReference',
      include: packageName.trim(),
      metadata
    }]);
    await this.refresh({ userVisible: true });
  }

  async removePackageReference(node) {
    const project = getProjectItem(node);
    const metadata = await readProjectMetadata(project.path);
    const packageRefs = metadata.packageReferences || [];

    if (packageRefs.length === 0) {
      vscode.window.showInformationMessage('Solution Manager: no PackageReference items were found.');
      return;
    }

    const pick = await vscode.window.showQuickPick(
      packageRefs.map((reference) => ({
        label: reference.name,
        description: reference.version,
        reference
      })),
      {
        title: 'Remove PackageReference'
      }
    );

    if (!pick) {
      return;
    }

    await updateProjectItemReferences(project.path, [{
      action: 'remove',
      elementName: 'PackageReference',
      include: pick.reference.include || pick.reference.name
    }]);
    await this.refresh({ userVisible: true });
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
    metadata.launchSettings = await readProjectLaunchSettings(project.path);
    showProjectProperties(this.context, project, metadata, async () => {
      await this.refresh({ userVisible: false });
    }, (message) => this.runProjectPropertiesAction(message, node));
  }

  async addConfiguration(project) {
    const configuration = await vscode.window.showInputBox({
      title: 'Add Configuration',
      prompt: 'Configuration name',
      placeHolder: 'Staging',
      validateInput: validateConfigurationPart
    });

    if (!configuration) {
      return;
    }

    const platform = await vscode.window.showInputBox({
      title: 'Add Configuration',
      prompt: 'Platform name',
      value: 'AnyCPU',
      placeHolder: 'AnyCPU',
      validateInput: validateConfigurationPart
    });

    if (!platform) {
      return;
    }

    await updateProjectProperties(project.path, {
      configurations: [
        {
          configuration: configuration.trim(),
          platform: platform.trim(),
          properties: {
            OutputPath: `bin\\${configuration.trim()}\\`,
            DefineConstants: configuration.trim().toUpperCase()
          }
        }
      ]
    });
    await this.refresh({ userVisible: true });
  }

  async removeConfiguration(project, value) {
    const parsed = parseConfigurationValue(value);

    if (!parsed) {
      throw new Error('A configuration and platform are required.');
    }

    const answer = await vscode.window.showWarningMessage(
      `Remove configuration "${parsed.configuration} | ${parsed.platform}" from ${project.name}?`,
      { modal: true },
      'Remove'
    );

    if (answer !== 'Remove') {
      return;
    }

    await removeProjectConfiguration(project.path, parsed.configuration, parsed.platform);
    await this.refresh({ userVisible: true });
  }

  async browseProjectProperty(project, propertyName) {
    const config = PROJECT_PROPERTY_BROWSE_CONFIG[propertyName];

    if (!config) {
      throw new Error('This project property cannot be browsed.');
    }

    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: config.kind === 'file',
      canSelectFolders: config.kind === 'folder',
      canSelectMany: false,
      openLabel: config.openLabel,
      filters: config.filters
    });

    if (!selection || selection.length === 0) {
      return;
    }

    const value = vscode.workspace.asRelativePath(selection[0].fsPath, false);

    await updateProjectProperties(project.path, {
      properties: {
        [propertyName]: value
      }
    });
    await this.refresh({ userVisible: true });
  }

  async pickProjectItemPath(project, elementName) {
    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: `Add ${elementName}`,
      defaultUri: vscode.Uri.file(path.dirname(project.path)),
      filters: getProjectItemFileFilters(elementName)
    });

    if (!selection || selection.length === 0) {
      return undefined;
    }

    return vscode.workspace.asRelativePath(selection[0].fsPath, false);
  }

  async promptProjectItemMetadata(elementName) {
    if (elementName !== 'Content' && elementName !== 'None') {
      return {};
    }

    const outputPick = await vscode.window.showQuickPick(
      ['Not specified', 'Never', 'PreserveNewest', 'Always'],
      {
        title: `${elementName}: CopyToOutputDirectory`
      }
    );

    if (!outputPick) {
      return {};
    }

    const publishPick = await vscode.window.showQuickPick(
      ['Not specified', 'Never', 'PreserveNewest', 'Always'],
      {
        title: `${elementName}: CopyToPublishDirectory`
      }
    );
    const metadata = {};

    if (outputPick !== 'Not specified') {
      metadata.CopyToOutputDirectory = outputPick;
    }

    if (publishPick && publishPick !== 'Not specified') {
      metadata.CopyToPublishDirectory = publishPick;
    }

    return metadata;
  }

  async browseConfigurationProperty(project, value) {
    const parsed = parseConfigurationPropertyValue(value);
    const config = parsed ? CONFIGURATION_PROPERTY_BROWSE_CONFIG[parsed.propertyName] : undefined;

    if (!parsed || !config) {
      throw new Error('This configuration property cannot be browsed.');
    }

    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: config.kind === 'file',
      canSelectFolders: config.kind === 'folder',
      canSelectMany: false,
      openLabel: config.openLabel,
      filters: config.filters
    });

    if (!selection || selection.length === 0) {
      return;
    }

    const selectedPath = vscode.workspace.asRelativePath(selection[0].fsPath, false);

    await updateProjectProperties(project.path, {
      configurations: [
        {
          configuration: parsed.configuration,
          platform: parsed.platform,
          properties: {
            [parsed.propertyName]: selectedPath
          }
        }
      ]
    });
    await this.refresh({ userVisible: true });
  }

  async runProjectPropertiesAction(message, node) {
    const project = getProjectItem(node);
    const action = message?.action;
    const value = message?.value;

    if (action === 'addPackage') {
      await this.addPackageReference(node);
      return { message: 'PackageReference added.', refreshProperties: true };
    }

    if (action === 'removePackage') {
      if (value) {
        const packageInfo = parsePackageActionValue(value);
        const packageName = packageInfo.name || packageInfo.include || value;

        await updateProjectItemReferences(project.path, [{
          action: 'remove',
          elementName: 'PackageReference',
          include: packageName,
          groupCondition: packageInfo.groupCondition
        }]);
        await this.refresh({ userVisible: true });
        return { message: `PackageReference ${packageName} removed.`, refreshProperties: true };
      }

      await this.removePackageReference(node);
      return { message: 'PackageReference removed.', refreshProperties: true };
    }

    if (action === 'listPackages') {
      this.terminalRunner.runCommand(`dotnet list ${quoteForShell(project.path)} package --include-transitive`);
      return { message: 'NuGet list command sent to terminal.' };
    }

    if (action === 'restorePackages') {
      this.terminalRunner.runCommand(`dotnet restore ${quoteForShell(project.path)}`);
      return { message: 'Restore command sent to terminal.' };
    }

    if (action === 'updatePackage') {
      const metadata = await readProjectMetadata(project.path);
      const packageInfo = getProjectPackageInfo(metadata, value);

      if (!packageInfo?.name) {
        throw new Error('A package is required.');
      }

      if (!packageInfo.packageReference && packageInfo.direct === false) {
        throw new Error('Only direct PackageReference items can be updated from Project Properties.');
      }

      const version = await vscode.window.showInputBox({
        title: 'Update PackageReference',
        prompt: `Version for ${packageInfo.name}`,
        value: packageInfo.version || packageInfo.requested || packageInfo.resolved || '',
        placeHolder: 'Leave empty to omit the Version attribute'
      });

      if (version === undefined) {
        return { message: 'Update package canceled.' };
      }

      await updateProjectItemReferences(project.path, [{
        action: 'add',
        elementName: 'PackageReference',
        include: packageInfo.include || packageInfo.name,
        groupCondition: packageInfo.groupCondition,
        metadata: createPackageReferenceMetadata(packageInfo, version.trim())
      }]);
      await this.refresh({ userVisible: true });
      return { message: `PackageReference ${packageInfo.name} updated.`, refreshProperties: true };
    }

    if (action === 'openPackage') {
      if (!value) {
        throw new Error('A package id is required.');
      }

      await vscode.env.openExternal(vscode.Uri.parse(`https://www.nuget.org/packages/${encodeURIComponent(value)}`));
      return { message: `Opened ${value} on NuGet.org.` };
    }

    if (action === 'openNuGetConfig' || action === 'copyNuGetConfigPath' || action === 'copyNuGetConfigXml') {
      const configPath = String(value || '').trim();

      if (!configPath) {
        return { message: 'NuGet.config was not found.' };
      }

      if (action === 'copyNuGetConfigPath') {
        await vscode.env.clipboard.writeText(configPath);
        return { message: 'NuGet.config path copied.' };
      }

      if (action === 'copyNuGetConfigXml') {
        const buffer = await vscode.workspace.fs.readFile(vscode.Uri.file(configPath));
        await vscode.env.clipboard.writeText(Buffer.from(buffer).toString('utf8'));
        return { message: 'NuGet.config XML copied.' };
      }

      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(configPath), { preview: false });
      return { message: 'NuGet.config opened.' };
    }

    if (action === 'openGlobalJson' || action === 'copyGlobalJsonPath' || action === 'copyGlobalJsonJson') {
      const globalJsonPath = String(value || '').trim();

      if (!globalJsonPath) {
        return { message: 'global.json was not found.' };
      }

      if (action === 'copyGlobalJsonPath') {
        await vscode.env.clipboard.writeText(globalJsonPath);
        return { message: 'global.json path copied.' };
      }

      if (action === 'copyGlobalJsonJson') {
        const buffer = await vscode.workspace.fs.readFile(vscode.Uri.file(globalJsonPath));
        await vscode.env.clipboard.writeText(Buffer.from(buffer).toString('utf8'));
        return { message: 'global.json copied.' };
      }

      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(globalJsonPath), { preview: false });
      return { message: 'global.json opened.' };
    }

    if (action === 'openUserSecrets' || action === 'copyUserSecretsPath' || action === 'copyUserSecretsJson') {
      const secretsPath = String(value || '').trim();

      if (!secretsPath) {
        return { message: 'User secrets are not configured.' };
      }

      if (action === 'copyUserSecretsPath') {
        await vscode.env.clipboard.writeText(secretsPath);
        return { message: 'User secrets path copied.' };
      }

      if (action === 'copyUserSecretsJson') {
        const buffer = await vscode.workspace.fs.readFile(vscode.Uri.file(secretsPath));
        await vscode.env.clipboard.writeText(Buffer.from(buffer).toString('utf8'));
        return { message: 'User secrets JSON copied.' };
      }

      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(secretsPath), { preview: false });
      return { message: 'User secrets opened.' };
    }

    if (action === 'openPackageLockFile' || action === 'copyPackageLockPath' || action === 'copyPackageLockJson') {
      const lockPath = String(value || '').trim();

      if (!lockPath) {
        return { message: 'packages.lock.json was not found.' };
      }

      if (action === 'copyPackageLockPath') {
        await vscode.env.clipboard.writeText(lockPath);
        return { message: 'packages.lock.json path copied.' };
      }

      if (action === 'copyPackageLockJson') {
        const buffer = await vscode.workspace.fs.readFile(vscode.Uri.file(lockPath));
        await vscode.env.clipboard.writeText(Buffer.from(buffer).toString('utf8'));
        return { message: 'packages.lock.json copied.' };
      }

      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(lockPath), { preview: false });
      return { message: 'packages.lock.json opened.' };
    }

    if (action === 'copyNuGetPackageSource') {
      const source = parseNuGetPackageSourceActionValue(value);

      if (!source.value) {
        throw new Error('A NuGet package source URL or path is required.');
      }

      await vscode.env.clipboard.writeText(source.value);
      return { message: `${source.key || 'NuGet source'} copied.` };
    }

    if (action === 'copyNuGetPackageSourceMappingXml') {
      const mapping = parseNuGetPackageSourceMappingActionValue(value);

      if (!mapping.source) {
        throw new Error('A NuGet package source mapping is required.');
      }

      await vscode.env.clipboard.writeText(createNuGetPackageSourceMappingXml(mapping));
      return { message: `${mapping.source} package source mapping XML copied.` };
    }

    if (action === 'packageDetails' || action === 'openPackageFolder' || action === 'copyPackageFolder') {
      const metadata = await readProjectMetadata(project.path);
      const packageInfo = getProjectPackageInfo(metadata, value);

      if (!packageInfo?.name) {
        throw new Error('A package is required.');
      }

      if (action === 'packageDetails') {
        await showProjectPackageDetails(packageInfo, project);
        return { message: `Package details opened for ${packageInfo.name}.` };
      }

      const packageFolderPath = getProjectPackageFolderPath(packageInfo);

      if (!packageFolderPath) {
        return { message: `${packageInfo.name} does not have a resolvable NuGet package folder.` };
      }

      if (action === 'copyPackageFolder') {
        await vscode.env.clipboard.writeText(packageFolderPath);
        return { message: 'Package folder copied.' };
      }

      const opened = await openPackageFolderPath(packageFolderPath, packageInfo.name);
      return { message: opened ? 'Package folder opened.' : 'Package folder was not found.' };
    }

    if (action === 'copyPackageReference') {
      const metadata = await readProjectMetadata(project.path);
      const packageInfo = getProjectPackageInfo(metadata, value);

      if (!packageInfo?.name) {
        throw new Error('A package is required.');
      }

      const xml = createPackageReferenceXml(packageInfo.packageReference || packageInfo);
      await vscode.env.clipboard.writeText(xml);
      return { message: 'PackageReference XML copied.' };
    }

    if (action === 'openCentralPackageFile' || action === 'copyCentralPackagePath' || action === 'copyCentralPackageVersionXml') {
      const centralPackageInfo = parseCentralPackageVersionActionValue(value);

      if (!centralPackageInfo?.name) {
        throw new Error('A central package version is required.');
      }

      if (action === 'copyCentralPackageVersionXml') {
        await vscode.env.clipboard.writeText(createCentralPackageVersionXml(centralPackageInfo));
        return { message: 'PackageVersion XML copied.' };
      }

      if (!centralPackageInfo.path) {
        return { message: `${centralPackageInfo.name} does not have a resolvable Directory.Packages.props path.` };
      }

      if (action === 'copyCentralPackagePath') {
        await vscode.env.clipboard.writeText(centralPackageInfo.path);
        return { message: 'Central package file path copied.' };
      }

      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(centralPackageInfo.path), { preview: false });
      return { message: 'Central package file opened.' };
    }

    if (action === 'addProjectItem') {
      const elementName = String(value || '').trim();

      if (!PROJECT_ITEM_ELEMENT_NAMES.has(elementName)) {
        throw new Error('This project item type is not supported.');
      }

      const include = await this.pickProjectItemPath(project, elementName);

      if (!include) {
        return { message: 'Add project item canceled.' };
      }

      const metadata = await this.promptProjectItemMetadata(elementName);

      await updateProjectItemReferences(project.path, [{
        action: 'add',
        elementName,
        include,
        metadata
      }]);
      await this.refresh({ userVisible: true });
      return { message: `${elementName} item added.`, refreshProperties: true };
    }

    if (action === 'openProjectItem' || action === 'openProjectItemFolder' || action === 'copyProjectItemPath' || action === 'copyProjectItemXml' || action === 'removeProjectItem') {
      const itemInfo = parseProjectItemActionValue(value);

      if (!itemInfo?.elementName || !itemInfo.identity) {
        throw new Error('A project item is required.');
      }

      if (action === 'copyProjectItemXml') {
        await vscode.env.clipboard.writeText(createProjectItemXml(itemInfo));
        return { message: 'Project item XML copied.' };
      }

      if (action === 'removeProjectItem') {
        const answer = await vscode.window.showWarningMessage(
          `Remove ${itemInfo.identity} from ${project.name}?`,
          { modal: true },
          'Remove'
        );

        if (answer !== 'Remove') {
          return { message: 'Remove canceled.' };
        }

        await updateProjectItemReferences(project.path, [{
          action: 'remove',
          elementName: itemInfo.elementName,
          include: itemInfo.identity,
          identityAttribute: itemInfo.identityAttribute,
          groupCondition: itemInfo.groupCondition
        }]);
        await this.refresh({ userVisible: true });
        return { message: `${itemInfo.identity} removed from project file.`, refreshProperties: true };
      }

      const itemPath = getProjectItemFilePath(project.path, itemInfo);

      if (!itemPath) {
        return { message: `${itemInfo.identity} does not have a resolvable local file path.` };
      }

      if (action === 'copyProjectItemPath') {
        await vscode.env.clipboard.writeText(itemPath);
        return { message: 'Project item path copied.' };
      }

      if (action === 'openProjectItemFolder') {
        const opened = await revealPathInOs(itemPath, 'project item');
        return { message: opened ? 'Project item folder opened.' : 'Project item was not found.' };
      }

      await vscode.window.showTextDocument(vscode.Uri.file(itemPath), { preview: false });
      return { message: 'Project item opened.' };
    }

    if (action === 'openImport') {
      const metadata = await readProjectMetadata(project.path);
      const reference = findReference(metadata.imports, value);

      if (!reference?.path) {
        return { message: 'Import does not have a resolvable local file path.' };
      }

      await vscode.window.showTextDocument(vscode.Uri.file(reference.path), { preview: false });
      return { message: 'Import opened.' };
    }

    if (action === 'openImportFolder') {
      const metadata = await readProjectMetadata(project.path);
      const reference = findReference(metadata.imports, value);

      if (!reference?.path) {
        return { message: 'Import does not have a resolvable local file path.' };
      }

      const opened = await revealPathInOs(reference.path, 'import file');
      return { message: opened ? 'Import folder opened.' : 'Import file was not found.' };
    }

    if (action === 'copyImportPath') {
      const metadata = await readProjectMetadata(project.path);
      const reference = findReference(metadata.imports, value) || { source: value, path: value, name: value };
      await vscode.env.clipboard.writeText(reference.path || reference.source || reference.name || value);
      return { message: 'Import path copied.' };
    }

    if (action === 'copyImportXml') {
      const metadata = await readProjectMetadata(project.path);
      const reference = findReference(metadata.imports, value) || { source: value, path: value, name: value };
      await vscode.env.clipboard.writeText(createImportXml(reference));
      return { message: 'Import XML copied.' };
    }

    if (action === 'copyImportSummary') {
      const metadata = await readProjectMetadata(project.path);
      const reference = findReference(metadata.imports, value) || parseReferenceActionValue(value);
      await vscode.env.clipboard.writeText(createImportSummaryMarkdown(reference));
      return { message: 'Import summary copied.' };
    }

    if (action === 'openProjectFile') {
      await vscode.window.showTextDocument(vscode.Uri.file(project.path), { preview: false });
      return { message: 'Project file opened.' };
    }

    if (action === 'openProjectFolder') {
      const opened = await revealPathInOs(project.path, 'project file');
      return { message: opened ? 'Project folder opened.' : 'Project file was not found.' };
    }

    if (action === 'copyProjectPath') {
      await vscode.env.clipboard.writeText(project.path);
      return { message: 'Project path copied.' };
    }

    if (action === 'copyAssemblyMetadataXml') {
      const metadata = await readProjectMetadata(project.path);
      await vscode.env.clipboard.writeText(createAssemblyMetadataXml(metadata));
      return { message: 'Assembly metadata XML copied.' };
    }

    if (action === 'copyAllDiagnosticPropertiesXml') {
      const metadata = await readProjectMetadata(project.path);
      const properties = metadata.properties || [];

      if (properties.length === 0) {
        return { message: 'No diagnostic properties were parsed.' };
      }

      await vscode.env.clipboard.writeText(properties.map(createDiagnosticPropertyXml).join('\n'));
      return { message: 'All diagnostic property XML copied.' };
    }

    if (action === 'copyDiagnosticPropertyName' || action === 'copyDiagnosticPropertyValue' || action === 'copyDiagnosticPropertyXml') {
      const metadata = await readProjectMetadata(project.path);
      const property = getDiagnosticProperty(metadata, value);

      if (!property) {
        throw new Error('A diagnostic property is required.');
      }

      if (action === 'copyDiagnosticPropertyName') {
        await vscode.env.clipboard.writeText(property.name);
        return { message: 'Property name copied.' };
      }

      if (action === 'copyDiagnosticPropertyValue') {
        await vscode.env.clipboard.writeText(property.value || '');
        return { message: 'Property value copied.' };
      }

      await vscode.env.clipboard.writeText(createDiagnosticPropertyXml(property));
      return { message: 'Property XML copied.' };
    }

    if (action === 'openSigningKeyFile' || action === 'copySigningKeyPath' || action === 'copySigningXml') {
      const metadata = await readProjectMetadata(project.path);
      const signing = metadata.signing || {};

      if (action === 'copySigningXml') {
        await vscode.env.clipboard.writeText(createSigningXml(signing));
        return { message: 'Signing XML copied.' };
      }

      const keyPath = resolveProjectFilePath(project.path, signing.keyFile);

      if (!keyPath) {
        return { message: 'Signing key file is not configured or cannot be resolved.' };
      }

      if (action === 'copySigningKeyPath') {
        await vscode.env.clipboard.writeText(keyPath);
        return { message: 'Signing key path copied.' };
      }

      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(keyPath), { preview: false });
      return { message: 'Signing key file opened.' };
    }

    if (action === 'copyBuildSettingsXml' || action === 'copyPublishSettingsXml') {
      const metadata = await readProjectMetadata(project.path);
      const buildSettings = metadata.buildSettings || {};
      const xml = action === 'copyBuildSettingsXml'
        ? createBuildSettingsXml(buildSettings)
        : createPublishSettingsXml(buildSettings);
      await vscode.env.clipboard.writeText(xml);
      return { message: action === 'copyBuildSettingsXml' ? 'Build settings XML copied.' : 'Publish settings XML copied.' };
    }

    if (action === 'publishWithProfile' || action === 'openPublishProfile' || action === 'copyPublishProfilePath' || action === 'copyPublishProfileXml') {
      const profilePath = resolvePublishProfilePath(project.path, value);

      if (!profilePath) {
        throw new Error('A publish profile is required.');
      }

      if (action === 'publishWithProfile') {
        const profileName = path.basename(profilePath, path.extname(profilePath));
        this.terminalRunner.runCommand(`dotnet publish ${quoteForShell(project.path)} /p:PublishProfile=${quoteForShell(profileName)}`);
        return { message: `Publish profile ${profileName} sent to terminal.` };
      }

      if (action === 'copyPublishProfilePath') {
        await vscode.env.clipboard.writeText(profilePath);
        return { message: 'Publish profile path copied.' };
      }

      if (action === 'copyPublishProfileXml') {
        const buffer = await vscode.workspace.fs.readFile(vscode.Uri.file(profilePath));
        await vscode.env.clipboard.writeText(Buffer.from(buffer).toString('utf8'));
        return { message: 'Publish profile XML copied.' };
      }

      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(profilePath), { preview: false });
      return { message: 'Publish profile opened.' };
    }

    if (action === 'copyPackageMetadataXml') {
      const metadata = await readProjectMetadata(project.path);
      await vscode.env.clipboard.writeText(createPackageMetadataXml(metadata.package || {}));
      return { message: 'Package metadata XML copied.' };
    }

    if (action === 'copyBuildEventsXml') {
      const metadata = await readProjectMetadata(project.path);
      await vscode.env.clipboard.writeText(createBuildEventsXml(metadata.buildEvents || {}));
      return { message: 'Build events XML copied.' };
    }

    if (action === 'copyTargetXml') {
      const metadata = await readProjectMetadata(project.path);
      const requestedTarget = parseTargetActionValue(value);
      const target = findTarget(metadata.targets || [], requestedTarget) || requestedTarget;

      if (!target?.name) {
        throw new Error('An MSBuild target is required.');
      }

      await vscode.env.clipboard.writeText(createTargetXml(target));
      return { message: `${target.name} target XML copied.` };
    }

    if (action === 'runBuildEvent' || action === 'copyBuildEvent') {
      const metadata = await readProjectMetadata(project.path);
      const eventInfo = getBuildEventInfo(metadata, value);

      if (!eventInfo?.command) {
        return { message: 'Build event is not configured.' };
      }

      if (action === 'copyBuildEvent') {
        await vscode.env.clipboard.writeText(eventInfo.command);
        return { message: `${eventInfo.label} copied.` };
      }

      this.terminalRunner.runCommand(createProjectDirectoryCommand(project.path, eventInfo.command));
      return { message: `${eventInfo.label} sent to terminal.` };
    }

    if (action === 'browseProjectProperty') {
      await this.browseProjectProperty(project, value);
      return { message: 'Project property path updated.', refreshProperties: true };
    }

    if (action === 'browseConfigurationProperty') {
      await this.browseConfigurationProperty(project, value);
      return { message: 'Configuration property path updated.', refreshProperties: true };
    }

    if (action === 'addConfiguration') {
      await this.addConfiguration(project);
      return { message: 'Configuration added.', refreshProperties: true };
    }

    if (action === 'removeConfiguration') {
      await this.removeConfiguration(project, value);
      return { message: 'Configuration removed.', refreshProperties: true };
    }

    if (action === 'addProjectReference') {
      await this.addProjectReference(node);
      return { message: 'Project reference command sent to terminal.' };
    }

    if (action === 'addAssemblyReference') {
      await this.addAssemblyReference(node);
      return { message: 'Assembly reference added.', refreshProperties: true };
    }

    if (action === 'addFrameworkReference') {
      await this.addFrameworkReference(node);
      return { message: 'Framework reference added.', refreshProperties: true };
    }

    if (action === 'addAnalyzerReference') {
      await this.addAnalyzerReference(node);
      return { message: 'Analyzer reference added.', refreshProperties: true };
    }

    if (action === 'removeProjectReference') {
      const metadata = await readProjectMetadata(project.path);
      const referenceInfo = findReference(metadata.projectReferences, value) || parseReferenceActionValue(value);
      const include = referenceInfo.include || referenceInfo.path || referenceInfo.name;

      if (!include) {
        throw new Error('A project reference path is required.');
      }

      await updateProjectItemReferences(project.path, [{
        action: 'remove',
        elementName: 'ProjectReference',
        include,
        groupCondition: referenceInfo.groupCondition
      }]);
      await this.refresh({ userVisible: true });
      return { message: 'Project reference removed.', refreshProperties: true };
    }

    if (action === 'removeAssemblyReference' || action === 'removeFrameworkReference' || action === 'removeAnalyzerReference') {
      const elementName = getProjectPropertiesElementName(action);
      const metadata = await readProjectMetadata(project.path);
      const referenceInfo = findReference(getProjectPropertiesReferences(metadata, action), value) || parseReferenceActionValue(value);
      const include = referenceInfo.include || referenceInfo.name || referenceInfo.path || referenceInfo.hintPath || value;

      if (!include || !elementName) {
        throw new Error('A dependency reference is required.');
      }

      await updateProjectItemReferences(project.path, [{
        action: 'remove',
        elementName,
        include,
        groupCondition: referenceInfo.groupCondition
      }]);
      await this.refresh({ userVisible: true });
      return { message: 'Reference removed.', refreshProperties: true };
    }

    if (action === 'openProjectReference') {
      const metadata = await readProjectMetadata(project.path);
      const referenceInfo = findReference(metadata.projectReferences, value) || parseReferenceActionValue(value);
      const referencePath = await this.resolveProjectReferencePath(
        project,
        referenceInfo.path || referenceInfo.include || referenceInfo.name || value
      );

      if (!referencePath) {
        throw new Error('A project reference path is required.');
      }

      await vscode.window.showTextDocument(vscode.Uri.file(referencePath), { preview: false });
      return { message: 'Project reference opened.' };
    }

    if (action === 'openProjectReferenceFolder' || action === 'copyProjectReferencePath') {
      const metadata = await readProjectMetadata(project.path);
      const referenceInfo = findReference(metadata.projectReferences, value) || parseReferenceActionValue(value);
      const referencePath = await this.resolveProjectReferencePath(
        project,
        referenceInfo.path || referenceInfo.include || referenceInfo.name || value
      );

      if (!referencePath) {
        throw new Error('A project reference path is required.');
      }

      if (action === 'copyProjectReferencePath') {
        await vscode.env.clipboard.writeText(referencePath);
        return { message: 'Project reference path copied.' };
      }

      const opened = await revealPathInOs(referencePath, 'project reference');
      return { message: opened ? 'Project reference folder opened.' : 'Project reference was not found.' };
    }

    if (action === 'copyProjectReference') {
      const metadata = await readProjectMetadata(project.path);
      const reference = findReference(metadata.projectReferences, value) || parseReferenceActionValue(value);
      const xml = createProjectReferenceXml(reference);
      await vscode.env.clipboard.writeText(xml);
      return { message: 'ProjectReference XML copied.' };
    }

    if (action === 'openAssemblyReference' || action === 'copyAssemblyReferencePath' || action === 'openAnalyzerReference' || action === 'copyAnalyzerReferencePath') {
      const metadata = await readProjectMetadata(project.path);
      const reference = findReference(getProjectPropertiesReferences(metadata, action), value) || parseReferenceActionValue(value);
      const referencePath = getProjectPropertiesReferencePath(project.path, reference);

      if (!referencePath) {
        return { message: 'Reference does not have a resolvable file path.' };
      }

      if (action === 'copyAssemblyReferencePath' || action === 'copyAnalyzerReferencePath') {
        await vscode.env.clipboard.writeText(referencePath);
        return { message: 'Reference path copied.' };
      }

      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(referencePath), { preview: false });
      return { message: 'Reference opened.' };
    }

    if (action === 'copyAssemblyReference' || action === 'copyFrameworkReference' || action === 'copyAnalyzerReference') {
      const metadata = await readProjectMetadata(project.path);
      const reference = findReference(getProjectPropertiesReferences(metadata, action), value) || parseReferenceActionValue(value);
      const xml = createProjectPropertiesReferenceXml(action, reference);
      await vscode.env.clipboard.writeText(xml);
      return { message: 'Reference XML copied.' };
    }

    if (action === 'openSourceGenerator' || action === 'copySourceGeneratorPath' || action === 'copySourceGeneratorXml') {
      const metadata = await readProjectMetadata(project.path);
      const reference = getSourceGeneratorReference(metadata, value);

      if (!reference?.name) {
        throw new Error('A source generator is required.');
      }

      if (action === 'copySourceGeneratorXml') {
        await vscode.env.clipboard.writeText(createSourceGeneratorXml(reference));
        return { message: 'Source generator XML copied.' };
      }

      if (reference.source === 'package') {
        if (action === 'openSourceGenerator') {
          await vscode.env.openExternal(vscode.Uri.parse(`https://www.nuget.org/packages/${encodeURIComponent(reference.name)}`));
          return { message: `Opened ${reference.name} on NuGet.org.` };
        }

        const packageInfo = getProjectPackageInfo(metadata, JSON.stringify(reference));
        const packageFolderPath = getProjectPackageFolderPath(packageInfo);

        if (!packageFolderPath) {
          return { message: `${reference.name} does not have a resolvable NuGet package folder.` };
        }

        await vscode.env.clipboard.writeText(packageFolderPath);
        return { message: 'Source generator package folder copied.' };
      }

      const referencePath = getProjectPropertiesReferencePath(project.path, reference);

      if (!referencePath) {
        return { message: 'Source generator does not have a resolvable file path.' };
      }

      if (action === 'copySourceGeneratorPath') {
        await vscode.env.clipboard.writeText(referencePath);
        return { message: 'Source generator path copied.' };
      }

      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(referencePath), { preview: false });
      return { message: 'Source generator opened.' };
    }

    if (action === 'openLaunchSettings') {
      const launchPath = await ensureLaunchSettingsFile(project.path, project.name);
      await vscode.window.showTextDocument(vscode.Uri.file(launchPath), { preview: false });
      return { message: 'launchSettings.json opened.' };
    }

    if (action === 'addLaunchProfile') {
      const profileName = await vscode.window.showInputBox({
        title: 'Add Run Profile',
        prompt: 'Run profile name',
        placeHolder: `${project.name}.Local`,
        validateInput: (input) => input.trim() ? undefined : 'Profile name is required.'
      });

      if (!profileName) {
        return { message: 'Add run profile cancelled.' };
      }

      await addProjectLaunchProfile(project.path, profileName.trim());
      return {
        message: `Run profile ${profileName.trim()} added.`,
        refreshProperties: true
      };
    }

    if (action === 'removeLaunchProfile') {
      if (!value) {
        throw new Error('A run profile name is required.');
      }

      const answer = await vscode.window.showWarningMessage(
        `Remove run profile "${value}"?`,
        { modal: true },
        'Remove'
      );

      if (answer !== 'Remove') {
        return { message: 'Remove run profile cancelled.' };
      }

      await removeProjectLaunchProfile(project.path, value);
      return {
        message: `Run profile ${value} removed.`,
        refreshProperties: true
      };
    }

    if (action === 'duplicateLaunchProfile') {
      if (!value) {
        throw new Error('A run profile name is required.');
      }

      await duplicateProjectLaunchProfile(project.path, value);
      return {
        message: `Run profile ${value} duplicated.`,
        refreshProperties: true
      };
    }

    if (action === 'browseLaunchExecutable' || action === 'browseLaunchWorkingDirectory') {
      if (!value) {
        throw new Error('A run profile name is required.');
      }

      const selection = action === 'browseLaunchExecutable'
        ? await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          openLabel: 'Select Executable'
        })
        : await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: 'Select Working Directory'
        });

      if (!selection || selection.length === 0) {
        return { message: 'Browse cancelled.' };
      }

      await updateProjectLaunchSettings(project.path, [{
        originalName: value,
        name: value,
        [action === 'browseLaunchExecutable' ? 'executablePath' : 'workingDirectory']: selection[0].fsPath
      }]);

      return {
        message: 'Run profile path updated.',
        refreshProperties: true
      };
    }

    if (action === 'runLaunchProfile') {
      if (!value) {
        throw new Error('A run profile name is required.');
      }

      this.terminalRunner.runCommand(createLaunchProfileRunCommand(project, value));
      return { message: `Run profile ${value} started.` };
    }

    if (action === 'copyLaunchCommand') {
      if (!value) {
        throw new Error('A run profile name is required.');
      }

      await vscode.env.clipboard.writeText(createLaunchProfileRunCommand(project, value));
      return { message: `Run command for ${value} copied.` };
    }

    if (action === 'openLaunchTerminal') {
      if (!value) {
        throw new Error('A run profile name is required.');
      }

      const cwd = await getLaunchProfileTerminalCwd(project, value);
      const terminal = vscode.window.createTerminal({
        name: `Solution Manager: ${value}`,
        cwd
      });
      terminal.show();
      return { message: `Terminal opened for ${value}.` };
    }

    throw new Error(`Unknown project properties action: ${action || 'none'}.`);
  }

  async resolveProjectReferencePath(project, value) {
    if (value) {
      return resolveReferencePath(project.path, value);
    }

    const metadata = await readProjectMetadata(project.path);
    const references = metadata.projectReferences || [];

    if (references.length === 0) {
      return undefined;
    }

    const pick = await vscode.window.showQuickPick(
      references.map((reference) => ({
        label: reference.name,
        description: reference.include || reference.path,
        reference
      })),
      {
        title: 'Remove Project Reference'
      }
    );

    return resolveReferencePath(
      project.path,
      pick?.reference.path || pick?.reference.include || pick?.reference.name
    );
  }
}

function getProjectItem(node) {
  if (!node || !node.item || !node.item.path) {
    throw new Error('A project node is required.');
  }

  return node.item;
}

async function readProjectMetadata(projectPath) {
  try {
    const buffer = await vscode.workspace.fs.readFile(vscode.Uri.file(projectPath));
    const metadata = readProjectMetadataFromText(Buffer.from(buffer).toString('utf8'), projectPath);
    metadata.centralPackageVersions = await readCentralPackageVersions(vscode.Uri.file(projectPath));
    metadata.packageReferences = enrichPackageReferencesWithCentralVersions(metadata.packageReferences, metadata.centralPackageVersions);
    metadata.sourceGenerators = enrichSourceGeneratorsWithPackageReferences(metadata);
    metadata.imports = await enrichImportsWithImplicitDirectoryBuildFiles(vscode.Uri.file(projectPath), metadata.imports);
    metadata.resolvedDependencies = await readResolvedDependencies(projectPath);
    metadata.nugetConfig = await readNuGetConfig(vscode.Uri.file(projectPath));
    metadata.packageReferences = enrichPackagesWithPackageSourceMappings(metadata.packageReferences, metadata.nugetConfig);
    metadata.resolvedDependencies = enrichResolvedDependenciesWithPackageSourceMappings(metadata.resolvedDependencies, metadata.nugetConfig);
    metadata.publishProfiles = await readPublishProfiles(vscode.Uri.file(projectPath));
    metadata.globalJson = await readGlobalJson(vscode.Uri.file(projectPath));
    metadata.packageLock = await readPackageLockFile(vscode.Uri.file(projectPath), metadata.buildSettings);
    metadata.userSecrets = await readUserSecrets(metadata.buildSettings?.userSecretsId);
    return metadata;
  } catch {
    return {
      targetFrameworks: [],
      packageReferences: [],
      projectReferences: [],
      resolvedDependencies: {},
      rootNamespace: undefined,
      isTestProject: false
    };
  }
}

async function readResolvedDependencies(projectPath) {
  try {
    const assetsUri = vscode.Uri.file(path.join(path.dirname(projectPath), 'obj', 'project.assets.json'));
    const buffer = await vscode.workspace.fs.readFile(assetsUri);
    return readProjectAssetsFromText(Buffer.from(buffer).toString('utf8'));
  } catch {
    return {};
  }
}

function enrichSourceGeneratorsWithPackageReferences(metadata) {
  return (metadata.sourceGenerators || []).map((sourceGenerator) => {
    if (sourceGenerator.source !== 'package') {
      return sourceGenerator;
    }

    const packageReference = (metadata.packageReferences || []).find((reference) => {
      return String(reference.name || reference.include || '').toLowerCase() === String(sourceGenerator.name || sourceGenerator.include || '').toLowerCase();
    });

    if (!packageReference) {
      return sourceGenerator;
    }

    return {
      ...sourceGenerator,
      version: sourceGenerator.version || packageReference.version,
      centralVersion: packageReference.centralVersion,
      versionSource: packageReference.versionSource,
      versionSourcePath: packageReference.versionSourcePath
    };
  });
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

function findReference(references = [], value) {
  const requested = parseReferenceActionValue(value);
  const requestedValues = [
    requested.name,
    requested.include,
    requested.path,
    requested.source,
    requested.hintPath,
    requested.label
  ].filter(Boolean);

  return references.find((reference) => {
    if (requested.elementName && reference.elementName && requested.elementName !== reference.elementName) {
      return false;
    }

    if (requested.hasGroupCondition && String(reference.groupCondition || '').trim() !== String(requested.groupCondition || '').trim()) {
      return false;
    }

    if (requested.hasItemCondition) {
      const currentItemCondition = reference.itemCondition === undefined ? reference.condition : reference.itemCondition;

      if (String(currentItemCondition || '').trim() !== String(requested.itemCondition || '').trim()) {
        return false;
      }
    }

    const values = [
      reference.name,
      reference.include,
      reference.path,
      reference.source,
      reference.hintPath,
      reference.label
    ].filter(Boolean);

    return requestedValues.some((candidate) => values.includes(candidate));
  });
}

function parseReferenceActionValue(value) {
  const text = String(value || '').trim();

  if (!text) {
    return {};
  }

  if (!text.startsWith('{')) {
    return {
      name: text,
      include: text
    };
  }

  try {
    const parsed = JSON.parse(text);
    const hasGroupCondition = Object.prototype.hasOwnProperty.call(parsed, 'groupCondition');
    const hasItemCondition = Object.prototype.hasOwnProperty.call(parsed, 'itemCondition');

    return {
      elementName: parsed.elementName,
      name: parsed.name || parsed.include || parsed.path || parsed.hintPath,
      include: parsed.include,
      path: parsed.path,
      source: parsed.source,
      hintPath: parsed.hintPath,
      label: parsed.label,
      implicit: parsed.implicit,
      kind: parsed.kind,
      condition: parsed.condition,
      itemCondition: parsed.itemCondition,
      groupCondition: parsed.groupCondition,
      hasGroupCondition,
      hasItemCondition,
      privateAssets: parsed.privateAssets,
      includeAssets: parsed.includeAssets,
      excludeAssets: parsed.excludeAssets,
      referenceOutputAssembly: parsed.referenceOutputAssembly,
      outputItemType: parsed.outputItemType,
      aliases: parsed.aliases,
      private: parsed.private
    };
  } catch {
    return {
      name: text,
      include: text
    };
  }
}

function createImportXml(reference) {
  if (reference.implicit && reference.kind !== 'directory-build-props' && reference.kind !== 'directory-build-targets') {
    return `<!-- ${escapeXmlComment(reference.name || 'Import')} is imported implicitly by ${escapeXmlComment(reference.source || 'the project SDK')} -->`;
  }

  return createSelfClosingXml('Import', [
    ['Project', reference.source || reference.path || reference.name],
    ['Condition', reference.condition],
    ['Label', reference.label]
  ]);
}

function createImportSummaryMarkdown(reference = {}) {
  const properties = reference.properties || [];
  const targets = reference.targets || [];

  return [
    `# ${reference.name || 'Import'}`,
    '',
    `- Source: ${formatDetail(reference.source)}`,
    `- Path: ${formatDetail(reference.path)}`,
    `- Kind: ${formatDetail(reference.kind)}`,
    `- Properties: ${properties.length}`,
    `- Targets: ${targets.length}`,
    `- Tasks: ${targets.reduce((total, target) => total + (target.tasks || []).length, 0)}`,
    '',
    '## Properties',
    ...(properties.length ? properties.map((property) => `- ${property.name}: ${formatDetail(property.value)}${property.condition ? ` (${property.condition})` : ''}`) : ['- None']),
    '',
    '## Targets',
    ...(targets.length ? targets.map((target) => `- ${target.name}${target.beforeTargets ? ` before ${target.beforeTargets}` : ''}${target.afterTargets ? ` after ${target.afterTargets}` : ''}`) : ['- None'])
  ].join('\n');
}

function getDiagnosticProperty(metadata, value) {
  const properties = metadata.properties || [];
  const index = Number(value);

  if (Number.isInteger(index) && index >= 0 && index < properties.length) {
    return properties[index];
  }

  return properties.find((property) => property.name === value);
}

function parseConfigurationValue(value) {
  const parts = String(value || '').split('|');

  if (parts.length !== 2) {
    return undefined;
  }

  const configuration = parts[0].trim();
  const platform = parts[1].trim();

  if (validateConfigurationPart(configuration) || validateConfigurationPart(platform)) {
    return undefined;
  }

  return {
    configuration,
    platform
  };
}

function parseConfigurationPropertyValue(value) {
  let parsed;

  try {
    parsed = JSON.parse(String(value || '{}'));
  } catch {
    return undefined;
  }

  const configuration = String(parsed.configuration || '').trim();
  const platform = String(parsed.platform || 'AnyCPU').trim();
  const propertyName = String(parsed.propertyName || '').trim();

  if (
    validateConfigurationPart(configuration)
    || validateConfigurationPart(platform)
    || !Object.prototype.hasOwnProperty.call(CONFIGURATION_PROPERTY_BROWSE_CONFIG, propertyName)
  ) {
    return undefined;
  }

  return {
    configuration,
    platform,
    propertyName
  };
}

function validateConfigurationPart(value) {
  const text = String(value || '').trim();

  if (!text) {
    return 'Value is required.';
  }

  return /['"<>&|]/.test(text) ? 'Do not use quotes, XML markup, ampersands, or pipe characters.' : undefined;
}

function createPropertyGroupXml(entries) {
  const properties = entries.filter(([, value]) => value !== undefined && value !== '');

  if (properties.length === 0) {
    return '<PropertyGroup />';
  }

  return [
    '<PropertyGroup>',
    ...properties.map(([name, value]) => `  <${name}>${escapeXmlText(value)}</${name}>`),
    '</PropertyGroup>'
  ].join('\n');
}

function createDiagnosticPropertyXml(property) {
  const propertyXml = property.condition
    ? `<${property.name} Condition="${escapeXmlAttribute(property.condition)}">${escapeXmlText(property.value || '')}</${property.name}>`
    : `<${property.name}>${escapeXmlText(property.value || '')}</${property.name}>`;

  if (!property.groupCondition) {
    return propertyXml;
  }

  return [
    `<PropertyGroup Condition="${escapeXmlAttribute(property.groupCondition)}">`,
    `  ${propertyXml}`,
    '</PropertyGroup>'
  ].join('\n');
}

function createSigningXml(signing = {}) {
  const properties = [
    ['SignAssembly', signing.signAssembly],
    ['AssemblyOriginatorKeyFile', signing.keyFile],
    ['DelaySign', signing.delaySign],
    ['PublicSign', signing.publicSign]
  ].filter(([, value]) => value !== undefined && value !== '');

  if (properties.length === 0) {
    return '<PropertyGroup />';
  }

  return [
    '<PropertyGroup>',
    ...properties.map(([name, value]) => `  <${name}>${escapeXmlText(value)}</${name}>`),
    '</PropertyGroup>'
  ].join('\n');
}

function createAssemblyMetadataXml(metadata = {}) {
  const assembly = metadata.assembly || {};
  const properties = [
    ['AssemblyName', metadata.assemblyName],
    ['RootNamespace', metadata.rootNamespace],
    ['AssemblyTitle', assembly.title],
    ['AssemblyVersion', assembly.version],
    ['FileVersion', assembly.fileVersion],
    ['InformationalVersion', assembly.informationalVersion],
    ['NeutralLanguage', assembly.neutralLanguage],
    ['GenerateAssemblyInfo', assembly.generateAssemblyInfo],
    ['ComVisible', assembly.comVisible],
    ['Guid', assembly.guid],
    ['CLSCompliant', assembly.clsCompliant],
    ['Copyright', assembly.copyright],
    ['Trademark', assembly.trademark]
  ].filter(([, value]) => value !== undefined && value !== '');

  if (properties.length === 0) {
    return '<PropertyGroup />';
  }

  return [
    '<PropertyGroup>',
    ...properties.map(([name, value]) => `  <${name}>${escapeXmlText(value)}</${name}>`),
    '</PropertyGroup>'
  ].join('\n');
}

function createBuildSettingsXml(buildSettings = {}) {
  return createPropertyGroupXml([
    ['OutputPath', buildSettings.outputPath],
    ['BaseOutputPath', buildSettings.baseOutputPath],
    ['IntermediateOutputPath', buildSettings.intermediateOutputPath],
    ['TargetFrameworkIdentifier', buildSettings.targetFrameworkIdentifier],
    ['TargetFrameworkVersion', buildSettings.targetFrameworkVersion],
    ['TargetFrameworkProfile', buildSettings.targetFrameworkProfile],
    ['TargetPlatformIdentifier', buildSettings.targetPlatformIdentifier],
    ['TargetPlatformVersion', buildSettings.targetPlatformVersion],
    ['TargetPlatformMinVersion', buildSettings.targetPlatformMinVersion],
    ['SupportedOSPlatformVersion', buildSettings.supportedOSPlatformVersion],
    ['AppendTargetFrameworkToOutputPath', buildSettings.appendTargetFrameworkToOutputPath],
    ['AppendRuntimeIdentifierToOutputPath', buildSettings.appendRuntimeIdentifierToOutputPath],
    ['CopyLocalLockFileAssemblies', buildSettings.copyLocalLockFileAssemblies],
    ['UserSecretsId', buildSettings.userSecretsId],
    ['RestorePackagesWithLockFile', buildSettings.restorePackagesWithLockFile],
    ['RestoreLockedMode', buildSettings.restoreLockedMode],
    ['NuGetLockFilePath', buildSettings.nuGetLockFilePath],
    ['RestoreUseStaticGraphEvaluation', buildSettings.restoreUseStaticGraphEvaluation],
    ['Optimize', buildSettings.optimize],
    ['DefineConstants', buildSettings.defineConstants],
    ['AllowUnsafeBlocks', buildSettings.allowUnsafeBlocks],
    ['CheckForOverflowUnderflow', buildSettings.checkForOverflowUnderflow],
    ['PlatformTarget', buildSettings.platformTarget],
    ['Deterministic', buildSettings.deterministic],
    ['ContinuousIntegrationBuild', buildSettings.continuousIntegrationBuild],
    ['DebugSymbols', buildSettings.debugSymbols],
    ['DebugType', buildSettings.debugType],
    ['TreatWarningsAsErrors', buildSettings.treatWarningsAsErrors],
    ['WarningsAsErrors', buildSettings.warningsAsErrors],
    ['NoWarn', buildSettings.noWarn],
    ['WarningLevel', buildSettings.warningLevel],
    ['GenerateDocumentationFile', buildSettings.generateDocumentationFile],
    ['DocumentationFile', buildSettings.documentationFile],
    ['ProduceReferenceAssembly', buildSettings.produceReferenceAssembly],
    ['EmitCompilerGeneratedFiles', buildSettings.emitCompilerGeneratedFiles],
    ['CompilerGeneratedFilesOutputPath', buildSettings.compilerGeneratedFilesOutputPath]
  ]);
}

function createPublishSettingsXml(buildSettings = {}) {
  return createPropertyGroupXml([
    ['RuntimeIdentifier', buildSettings.runtimeIdentifier],
    ['RuntimeIdentifiers', buildSettings.runtimeIdentifiers],
    ['RuntimeFrameworkVersion', buildSettings.runtimeFrameworkVersion],
    ['RollForward', buildSettings.rollForward],
    ['SelfContained', buildSettings.selfContained],
    ['UseAppHost', buildSettings.useAppHost],
    ['TargetLatestRuntimePatch', buildSettings.targetLatestRuntimePatch],
    ['InvariantGlobalization', buildSettings.invariantGlobalization],
    ['PublishDir', buildSettings.publishDir],
    ['PublishUrl', buildSettings.publishUrl],
    ['PublishSingleFile', buildSettings.publishSingleFile],
    ['PublishTrimmed', buildSettings.publishTrimmed],
    ['PublishReadyToRun', buildSettings.publishReadyToRun],
    ['PublishAot', buildSettings.publishAot],
    ['IncludeNativeLibrariesForSelfExtract', buildSettings.includeNativeLibrariesForSelfExtract],
    ['EnableCompressionInSingleFile', buildSettings.enableCompressionInSingleFile]
  ]);
}

function createPackageMetadataXml(packageMetadata = {}) {
  return createPropertyGroupXml([
    ['PackageId', packageMetadata.packageId],
    ['Version', packageMetadata.version],
    ['PackageVersion', packageMetadata.packageVersion],
    ['Authors', packageMetadata.authors],
    ['Company', packageMetadata.company],
    ['Product', packageMetadata.product],
    ['Description', packageMetadata.description],
    ['PackageReleaseNotes', packageMetadata.releaseNotes],
    ['RepositoryUrl', packageMetadata.repositoryUrl],
    ['RepositoryType', packageMetadata.repositoryType],
    ['RepositoryBranch', packageMetadata.repositoryBranch],
    ['RepositoryCommit', packageMetadata.repositoryCommit],
    ['PublishRepositoryUrl', packageMetadata.publishRepositoryUrl],
    ['PackageProjectUrl', packageMetadata.projectUrl],
    ['PackageTags', packageMetadata.tags],
    ['PackageLicenseExpression', packageMetadata.licenseExpression],
    ['PackageLicenseFile', packageMetadata.licenseFile],
    ['PackageLicenseUrl', packageMetadata.licenseUrl],
    ['PackageReadmeFile', packageMetadata.readmeFile],
    ['PackageIcon', packageMetadata.icon],
    ['PackageIconUrl', packageMetadata.iconUrl],
    ['IsPackable', packageMetadata.isPackable],
    ['GeneratePackageOnBuild', packageMetadata.generatePackageOnBuild],
    ['PackageRequireLicenseAcceptance', packageMetadata.requireLicenseAcceptance],
    ['IncludeBuildOutput', packageMetadata.includeBuildOutput],
    ['IncludeContentInPack', packageMetadata.includeContentInPack],
    ['ContentTargetFolders', packageMetadata.contentTargetFolders],
    ['DevelopmentDependency', packageMetadata.developmentDependency],
    ['Serviceable', packageMetadata.serviceable],
    ['IncludeSymbols', packageMetadata.includeSymbols],
    ['IncludeSource', packageMetadata.includeSource],
    ['SymbolPackageFormat', packageMetadata.symbolPackageFormat],
    ['EmbedUntrackedSources', packageMetadata.embedUntrackedSources],
    ['MinClientVersion', packageMetadata.minClientVersion],
    ['PackageType', packageMetadata.packageType],
    ['PackageValidationBaselineVersion', packageMetadata.packageValidationBaselineVersion],
    ['PackageValidationBaselineName', packageMetadata.packageValidationBaselineName],
    ['PackageOutputPath', packageMetadata.packageOutputPath]
  ]);
}

function getBuildEventInfo(metadata, value) {
  const buildEvents = metadata.buildEvents || {};

  if (value === 'pre') {
    return {
      label: 'Pre-build event',
      command: buildEvents.preBuildEvent
    };
  }

  if (value === 'post') {
    return {
      label: 'Post-build event',
      command: buildEvents.postBuildEvent
    };
  }

  return undefined;
}

function createBuildEventsXml(buildEvents = {}) {
  const properties = [
    ['PreBuildEvent', buildEvents.preBuildEvent],
    ['PostBuildEvent', buildEvents.postBuildEvent],
    ['RunPostBuildEvent', buildEvents.runPostBuildEvent]
  ].filter(([, value]) => value !== undefined && value !== '');

  if (properties.length === 0) {
    return '<PropertyGroup />';
  }

  return [
    '<PropertyGroup>',
    ...properties.map(([name, value]) => `  <${name}>${escapeXmlText(value)}</${name}>`),
    '</PropertyGroup>'
  ].join('\n');
}

function createTargetXml(target = {}) {
  const attributes = [
    ['Name', target.name],
    ['BeforeTargets', target.beforeTargets],
    ['AfterTargets', target.afterTargets],
    ['DependsOnTargets', target.dependsOnTargets],
    ['Condition', target.condition],
    ['Inputs', target.inputs],
    ['Outputs', target.outputs],
    ['KeepDuplicateOutputs', target.keepDuplicateOutputs],
    ['Returns', target.returns]
  ].filter(([, entry]) => entry !== undefined && entry !== '');
  const attributeMarkup = attributes.map(([name, entry]) => `${name}="${escapeXmlAttribute(entry)}"`).join(' ');

  if (!target.body) {
    return attributeMarkup ? `<Target ${attributeMarkup} />` : '<Target />';
  }

  return [
    attributeMarkup ? `<Target ${attributeMarkup}>` : '<Target>',
    indentXmlBlock(target.body),
    '</Target>'
  ].join('\n');
}

function indentXmlBlock(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join('\n');
}

function createProjectDirectoryCommand(projectPath, command) {
  const projectDirectory = path.dirname(projectPath);

  if (process.platform === 'win32') {
    return `cd /d ${quoteForShell(projectDirectory)} && ${command}`;
  }

  return `cd ${quoteForShell(projectDirectory)} && ${command}`;
}

function createLaunchProfileRunCommand(project, profileName) {
  return `dotnet run --project ${quoteForShell(project.path)} --launch-profile ${quoteForShell(profileName)}`;
}

async function getLaunchProfileTerminalCwd(project, profileName) {
  const launchSettings = await readProjectLaunchSettings(project.path);
  const profile = (launchSettings.profiles || []).find((item) => item.name === profileName);
  const workingDirectory = resolveProjectFilePath(project.path, profile?.workingDirectory);

  return workingDirectory || path.dirname(project.path);
}

function createPackageReferenceXml(reference) {
  const attributes = [
    ['Include', reference.include || reference.name],
    ['Version', isCentralPackageVersion(reference) ? undefined : reference.version],
    ['VersionOverride', reference.versionOverride],
    ['PrivateAssets', reference.privateAssets],
    ['IncludeAssets', reference.includeAssets],
    ['ExcludeAssets', reference.excludeAssets],
    ['OutputItemType', reference.outputItemType],
    ['ReferenceOutputAssembly', reference.referenceOutputAssembly],
    ['GeneratePathProperty', reference.generatePathProperty],
    ['Aliases', reference.aliases],
    ['NoWarn', reference.noWarn],
    ['Condition', getPackageReferenceItemCondition(reference)]
  ];

  return createSelfClosingXml('PackageReference', attributes);
}

function createCentralPackageVersionXml(reference) {
  return createSelfClosingXml('PackageVersion', [
    ['Include', reference.include || reference.name],
    ['Version', reference.version],
    ['Condition', getPackageReferenceItemCondition(reference)]
  ]);
}

function createNuGetPackageSourceMappingXml(mapping) {
  const patterns = mapping.patterns || [];

  if (patterns.length === 0) {
    return createSelfClosingXml('packageSource', [
      ['key', mapping.source]
    ]);
  }

  return [
    `<packageSource key="${escapeXmlAttribute(mapping.source)}">`,
    ...patterns.map((pattern) => `  <package pattern="${escapeXmlAttribute(pattern)}" />`),
    '</packageSource>'
  ].join('\n');
}

function isCentralPackageVersion(reference = {}) {
  return reference.versionSource === 'Directory.Packages.props' || reference.centralVersion;
}

function createPackageReferenceMetadata(reference, version) {
  return {
    Version: version,
    VersionOverride: reference.versionOverride,
    PrivateAssets: reference.privateAssets,
    IncludeAssets: reference.includeAssets,
    ExcludeAssets: reference.excludeAssets,
    OutputItemType: reference.outputItemType,
    ReferenceOutputAssembly: reference.referenceOutputAssembly,
    GeneratePathProperty: reference.generatePathProperty,
    Aliases: reference.aliases,
    NoWarn: reference.noWarn,
    Condition: getPackageReferenceItemCondition(reference)
  };
}

function getPackageReferenceItemCondition(reference = {}) {
  return reference.itemCondition === undefined ? reference.condition : reference.itemCondition;
}

function getProjectPackageInfo(metadata, value) {
  const requested = parsePackageActionValue(value);
  const requestedName = requested.name || value;
  const packageReferences = metadata.packageReferences || [];
  const resolvedPackages = getAllResolvedPackages(metadata);
  const directReference = findReference(packageReferences, value || requestedName);
  const resolvedReference = resolvedPackages.find((reference) => {
    if (!isSamePackageName(reference.name, requestedName)) {
      return false;
    }

    if (requested.path && reference.path && requested.path !== reference.path) {
      return false;
    }

    if (requested.version && reference.version && requested.version !== reference.version) {
      return false;
    }

    return true;
  }) || resolvedPackages.find((reference) => isSamePackageName(reference.name, requestedName));
  const requestedOverrides = compactObject(requested);

  return {
    ...(directReference || {}),
    ...(resolvedReference || {}),
    ...requestedOverrides,
    name: requested.name || resolvedReference?.name || directReference?.name || directReference?.include || requestedName,
    include: requested.include || directReference?.include || requested.name || requestedName,
    packageReference: directReference
  };
}

function compactObject(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function parsePackageActionValue(value) {
  const text = String(value || '').trim();

  if (!text) {
    return {};
  }

  if (!text.startsWith('{')) {
    return {
      name: text
    };
  }

  try {
    const parsed = JSON.parse(text);
    return {
      name: parsed.name || parsed.include,
      include: parsed.include,
      version: parsed.version,
      versionOverride: parsed.versionOverride,
      centralVersion: parsed.centralVersion,
      versionSource: parsed.versionSource,
      versionSourcePath: parsed.versionSourcePath,
      versionSourceCondition: parsed.versionSourceCondition,
      requested: parsed.requested,
      resolved: parsed.resolved,
      path: parsed.path,
      direct: parsed.direct,
      privateAssets: parsed.privateAssets,
      includeAssets: parsed.includeAssets,
      excludeAssets: parsed.excludeAssets,
      generatePathProperty: parsed.generatePathProperty,
      aliases: parsed.aliases,
      noWarn: parsed.noWarn,
      condition: parsed.condition,
      itemCondition: parsed.itemCondition,
      groupCondition: parsed.groupCondition
    };
  } catch {
    return {
      name: text
    };
  }
}

function parseTargetActionValue(value) {
  const text = String(value || '').trim();

  if (!text) {
    return {};
  }

  if (!text.startsWith('{')) {
    return {
      name: text
    };
  }

  try {
    const parsed = JSON.parse(text);

    return {
      name: parsed.name,
      beforeTargets: parsed.beforeTargets,
      afterTargets: parsed.afterTargets,
      dependsOnTargets: parsed.dependsOnTargets,
      condition: parsed.condition,
      inputs: parsed.inputs,
      outputs: parsed.outputs,
      keepDuplicateOutputs: parsed.keepDuplicateOutputs,
      returns: parsed.returns,
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      body: parsed.body
    };
  } catch {
    return {
      name: text
    };
  }
}

function findTarget(targets, requestedTarget = {}) {
  if (!requestedTarget.name) {
    return undefined;
  }

  return (targets || []).find((target) => target.name === requestedTarget.name);
}

function parseCentralPackageVersionActionValue(value) {
  const text = String(value || '').trim();

  if (!text.startsWith('{')) {
    return {
      name: text,
      include: text
    };
  }

  try {
    const parsed = JSON.parse(text);
    return {
      name: parsed.name || parsed.include,
      include: parsed.include || parsed.name,
      version: parsed.version,
      path: parsed.path,
      condition: parsed.condition,
      itemCondition: parsed.itemCondition,
      groupCondition: parsed.groupCondition
    };
  } catch {
    return {
      name: text,
      include: text
    };
  }
}

function parseNuGetPackageSourceActionValue(value) {
  const text = String(value || '').trim();

  if (!text.startsWith('{')) {
    return {
      value: text
    };
  }

  try {
    const parsed = JSON.parse(text);
    return {
      key: parsed.key,
      value: parsed.value,
      protocolVersion: parsed.protocolVersion,
      disabled: parsed.disabled
    };
  } catch {
    return {
      value: text
    };
  }
}

function parseNuGetPackageSourceMappingActionValue(value) {
  const text = String(value || '').trim();

  if (!text.startsWith('{')) {
    return {
      source: text,
      patterns: []
    };
  }

  try {
    const parsed = JSON.parse(text);
    return {
      source: parsed.source,
      patterns: Array.isArray(parsed.patterns) ? parsed.patterns : []
    };
  } catch {
    return {
      source: text,
      patterns: []
    };
  }
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

  return [...byKey.values()];
}

function getProjectPackageFolderPath(packageInfo = {}) {
  const libraryPath = packageInfo.path;

  if (libraryPath && isNuGetPackageLibraryPath(libraryPath)) {
    if (path.isAbsolute(libraryPath)) {
      return libraryPath;
    }

    return path.join(getNuGetGlobalPackagesPath(), normalizePackageRelativePath(libraryPath));
  }

  const name = packageInfo.name || packageInfo.include;
  const version = normalizeNuGetPackageVersion(packageInfo.resolved || packageInfo.version || packageInfo.requested);

  if (!name || !version) {
    return undefined;
  }

  return path.join(getNuGetGlobalPackagesPath(), String(name).toLowerCase(), version.toLowerCase());
}

async function openPackageFolderPath(packageFolderPath, packageName) {
  const uri = vscode.Uri.file(packageFolderPath);

  try {
    const stat = await vscode.workspace.fs.stat(uri);

    if (!(stat.type & vscode.FileType.Directory)) {
      vscode.window.showInformationMessage(`Solution Manager: ${packageFolderPath} is not a package folder.`);
      return false;
    }

    await vscode.commands.executeCommand('revealFileInOS', uri);
    return true;
  } catch {
    vscode.window.showInformationMessage(`Solution Manager: package folder was not found for ${packageName}: ${packageFolderPath}`);
    return false;
  }
}

async function revealPathInOs(filePath, label) {
  const uri = vscode.Uri.file(filePath);

  try {
    await vscode.workspace.fs.stat(uri);
    await vscode.commands.executeCommand('revealFileInOS', uri);
    return true;
  } catch {
    vscode.window.showInformationMessage(`Solution Manager: ${label} was not found: ${filePath}`);
    return false;
  }
}

async function showProjectPackageDetails(packageInfo, project) {
  const packageFolderPath = getProjectPackageFolderPath(packageInfo);
  const packageAssetGroups = getProjectPackageAssetGroups(packageInfo);
  const lines = [
    `# ${packageInfo.name}`,
    '',
    `- Version: ${formatDetail(packageInfo.version)}`,
    `- Requested: ${formatDetail(packageInfo.requested)}`,
    `- Resolved: ${formatDetail(packageInfo.resolved)}`,
    `- Kind: ${packageInfo.direct === false ? 'Transitive' : 'Direct or project reference'}`,
    `- Project: ${formatDetail(project?.name)}`,
    `- Path: ${formatDetail(packageInfo.path)}`,
    `- Package Folder: ${formatDetail(packageFolderPath)}`,
    `- PrivateAssets: ${formatDetail(packageInfo.privateAssets)}`,
    `- IncludeAssets: ${formatDetail(packageInfo.includeAssets)}`,
    `- ExcludeAssets: ${formatDetail(packageInfo.excludeAssets)}`,
    `- VersionOverride: ${formatDetail(packageInfo.versionOverride)}`,
    `- GeneratePathProperty: ${formatDetail(packageInfo.generatePathProperty)}`,
    `- Aliases: ${formatDetail(packageInfo.aliases)}`,
    `- NoWarn: ${formatDetail(packageInfo.noWarn)}`,
    `- Package Source Mapping: ${formatDetail(formatPackageSourceMappings(packageInfo.packageSourceMappings))}`,
    `- Asset Group Count: ${packageAssetGroups.length}`,
    `- Item Condition: ${formatDetail(packageInfo.itemCondition)}`,
    `- Group Condition: ${formatDetail(packageInfo.groupCondition)}`,
    '',
    '## Dependencies',
    ...formatPackageDependencies(packageInfo.dependencies),
    '',
    ...formatProjectPackageAssetGroupSections(packageAssetGroups),
    '',
    '## XML',
    '```xml',
    createPackageReferenceXml(packageInfo),
    '```'
  ];
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: lines.join('\n')
  });

  await vscode.window.showTextDocument(document, { preview: false });
}

function formatDetail(value) {
  return value === undefined || value === '' ? 'Not specified' : String(value);
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

function formatPackageDependencies(dependencies) {
  if (!dependencies || dependencies.length === 0) {
    return ['- None'];
  }

  return dependencies.map((dependency) => `- ${dependency.name}${dependency.version ? ` (${dependency.version})` : ''}`);
}

function formatPackageAssets(assets) {
  if (!assets || assets.length === 0) {
    return ['- None'];
  }

  return assets.map((asset) => `- ${asset}`);
}

function getProjectPackageAssetGroups(packageInfo = {}) {
  if (Array.isArray(packageInfo.packageAssetGroups) && packageInfo.packageAssetGroups.length > 0) {
    return packageInfo.packageAssetGroups.filter((group) => Array.isArray(group.assets) && group.assets.length > 0);
  }

  return PACKAGE_ASSET_GROUPS.map(([key, label]) => ({
    key,
    label,
    assets: Array.isArray(packageInfo[key]) ? packageInfo[key] : []
  })).filter((group) => group.assets.length > 0);
}

function formatProjectPackageAssetGroupSections(groups) {
  if (!Array.isArray(groups) || groups.length === 0) {
    return [
      '## Package Assets',
      '- None'
    ];
  }

  return groups.flatMap((group) => [
    `## ${group.label}`,
    ...formatPackageAssets(group.assets),
    ''
  ]).slice(0, -1);
}

function getNuGetGlobalPackagesPath() {
  return process.env.NUGET_PACKAGES || path.join(os.homedir(), '.nuget', 'packages');
}

function isNuGetPackageLibraryPath(value) {
  const text = String(value || '').trim();

  if (!text || text.startsWith('..') || text.startsWith('.')) {
    return false;
  }

  if (path.isAbsolute(text)) {
    return true;
  }

  return text.split(/[\\/]/).length >= 2;
}

function normalizePackageRelativePath(value) {
  return String(value)
    .trim()
    .replace(/^[/\\]+/, '')
    .replace(/[\\/]+/g, path.sep);
}

function normalizeNuGetPackageVersion(value) {
  const text = value === undefined || value === null ? '' : String(value).trim();

  if (!text || /[\s,[\]()<>]/.test(text)) {
    return undefined;
  }

  return text;
}

function isSamePackageName(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase();
}

function createProjectReferenceXml(reference) {
  const attributes = [
    ['Include', reference.include || reference.name || reference.path],
    ['ReferenceOutputAssembly', reference.referenceOutputAssembly],
    ['OutputItemType', reference.outputItemType],
    ['PrivateAssets', reference.privateAssets],
    ['IncludeAssets', reference.includeAssets],
    ['ExcludeAssets', reference.excludeAssets],
    ['Condition', getReferenceItemCondition(reference)]
  ];

  return createSelfClosingXml('ProjectReference', attributes);
}

function createProjectPropertiesReferenceXml(action, reference) {
  switch (action) {
    case 'copyAssemblyReference':
      return createSelfClosingXml('Reference', [
        ['Include', reference.include || reference.name],
        ['HintPath', reference.hintPath],
        ['Aliases', reference.aliases],
        ['Private', reference.private],
        ['Condition', getReferenceItemCondition(reference)]
      ]);
    case 'copyFrameworkReference':
      return createSelfClosingXml('FrameworkReference', [
        ['Include', reference.include || reference.name],
        ['PrivateAssets', reference.privateAssets],
        ['IncludeAssets', reference.includeAssets],
        ['ExcludeAssets', reference.excludeAssets],
        ['Condition', getReferenceItemCondition(reference)]
      ]);
    case 'copyAnalyzerReference':
      return createSelfClosingXml('Analyzer', [
        ['Include', reference.include || reference.name],
        ['HintPath', reference.hintPath],
        ['PrivateAssets', reference.privateAssets],
        ['IncludeAssets', reference.includeAssets],
        ['ExcludeAssets', reference.excludeAssets],
        ['Aliases', reference.aliases],
        ['Condition', getReferenceItemCondition(reference)]
      ]);
    default:
      return createSelfClosingXml('Reference', [
        ['Include', reference.include || reference.name]
      ]);
  }
}

function getReferenceItemCondition(reference = {}) {
  return reference.itemCondition === undefined ? reference.condition : reference.itemCondition;
}

function getProjectPropertiesElementName(action) {
  switch (action) {
    case 'removeAssemblyReference':
      return 'Reference';
    case 'removeFrameworkReference':
      return 'FrameworkReference';
    case 'removeAnalyzerReference':
      return 'Analyzer';
    default:
      return undefined;
  }
}

function getProjectPropertiesReferences(metadata, action) {
  switch (action) {
    case 'openAssemblyReference':
    case 'copyAssemblyReferencePath':
    case 'copyAssemblyReference':
    case 'removeAssemblyReference':
      return metadata.assemblyReferences || [];
    case 'copyFrameworkReference':
    case 'removeFrameworkReference':
      return metadata.frameworkReferences || [];
    case 'openAnalyzerReference':
    case 'copyAnalyzerReferencePath':
    case 'copyAnalyzerReference':
    case 'removeAnalyzerReference':
      return metadata.analyzerReferences || [];
    default:
      return [];
  }
}

function getSourceGeneratorReference(metadata, value) {
  const requested = parseSourceGeneratorActionValue(value);
  const generators = metadata.sourceGenerators || [];
  const match = generators.find((generator) => {
    if (requested.source && generator.source && requested.source !== generator.source) {
      return false;
    }

    if (requested.groupCondition !== undefined && String(generator.groupCondition || '') !== String(requested.groupCondition || '')) {
      return false;
    }

    if (requested.itemCondition !== undefined) {
      const generatorItemCondition = generator.itemCondition === undefined ? generator.condition : generator.itemCondition;

      if (String(generatorItemCondition || '') !== String(requested.itemCondition || '')) {
        return false;
      }
    }

    return [generator.name, generator.include, generator.path, generator.hintPath]
      .filter(Boolean)
      .some((candidate) => candidate === requested.name || candidate === requested.include || candidate === requested.path);
  });

  return {
    ...(match || {}),
    ...requested,
    name: requested.name || match?.name || match?.include
  };
}

function parseSourceGeneratorActionValue(value) {
  const text = String(value || '').trim();

  if (!text.startsWith('{')) {
    return {
      name: text
    };
  }

  try {
    const parsed = JSON.parse(text);
    return {
      name: parsed.name || parsed.include,
      include: parsed.include,
      version: parsed.version,
      source: parsed.source,
      path: parsed.path,
      hintPath: parsed.hintPath,
      condition: parsed.condition,
      itemCondition: parsed.itemCondition,
      groupCondition: parsed.groupCondition,
      privateAssets: parsed.privateAssets,
      includeAssets: parsed.includeAssets,
      excludeAssets: parsed.excludeAssets,
      versionOverride: parsed.versionOverride,
      centralVersion: parsed.centralVersion,
      versionSource: parsed.versionSource,
      versionSourcePath: parsed.versionSourcePath,
      outputItemType: parsed.outputItemType,
      referenceOutputAssembly: parsed.referenceOutputAssembly,
      generatePathProperty: parsed.generatePathProperty,
      aliases: parsed.aliases,
      noWarn: parsed.noWarn
    };
  } catch {
    return {
      name: text
    };
  }
}

function createSourceGeneratorXml(reference) {
  if (reference.source === 'package') {
    return createPackageReferenceXml({
      include: reference.include || reference.name,
      name: reference.name,
      version: reference.version,
      versionOverride: reference.versionOverride,
      centralVersion: reference.centralVersion,
      versionSource: reference.versionSource,
      versionSourcePath: reference.versionSourcePath,
      privateAssets: reference.privateAssets || 'all',
      includeAssets: reference.includeAssets,
      excludeAssets: reference.excludeAssets,
      outputItemType: reference.outputItemType || 'Analyzer',
      referenceOutputAssembly: reference.referenceOutputAssembly,
      generatePathProperty: reference.generatePathProperty,
      aliases: reference.aliases,
      noWarn: reference.noWarn,
      condition: reference.condition,
      itemCondition: reference.itemCondition
    });
  }

  return createProjectPropertiesReferenceXml('copyAnalyzerReference', {
    include: reference.include || reference.path || reference.hintPath || reference.name,
    name: reference.name,
    hintPath: reference.hintPath,
    condition: reference.condition,
    itemCondition: reference.itemCondition,
    privateAssets: reference.privateAssets,
    includeAssets: reference.includeAssets,
    excludeAssets: reference.excludeAssets,
    aliases: reference.aliases
  });
}

function parseProjectItemActionValue(value) {
  const text = String(value || '').trim();

  if (!text.startsWith('{')) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(text);
    const elementName = String(parsed.elementName || '').trim();
    const identity = parsed.identity || parsed.include || parsed.update || parsed.remove || parsed.name;

    if (!PROJECT_ITEM_ELEMENT_NAMES.has(elementName) || !identity) {
      return undefined;
    }

    return {
      elementName,
      name: parsed.name || identity,
      include: parsed.include,
      update: parsed.update,
      remove: parsed.remove,
      identity,
      identityAttribute: parsed.identityAttribute || (parsed.include ? 'Include' : parsed.update ? 'Update' : parsed.remove ? 'Remove' : 'Include'),
      path: parsed.path,
      condition: parsed.condition,
      itemCondition: parsed.itemCondition,
      groupCondition: parsed.groupCondition,
      copyToOutputDirectory: parsed.copyToOutputDirectory,
      copyToPublishDirectory: parsed.copyToPublishDirectory,
      link: parsed.link,
      logicalName: parsed.logicalName,
      generator: parsed.generator,
      lastGenOutput: parsed.lastGenOutput,
      dependentUpon: parsed.dependentUpon,
      subType: parsed.subType
    };
  } catch {
    return undefined;
  }
}

function getProjectItemFilePath(projectPath, itemInfo) {
  if (itemInfo.remove) {
    return undefined;
  }

  return resolveProjectFilePath(projectPath, itemInfo.path || itemInfo.include || itemInfo.update || itemInfo.identity);
}

function createProjectItemXml(itemInfo) {
  const identityAttribute = ['Include', 'Update', 'Remove'].includes(itemInfo.identityAttribute)
    ? itemInfo.identityAttribute
    : 'Include';

  return createSelfClosingXml(itemInfo.elementName, [
    [identityAttribute, itemInfo.identity],
    ['CopyToOutputDirectory', itemInfo.copyToOutputDirectory],
    ['CopyToPublishDirectory', itemInfo.copyToPublishDirectory],
    ['Link', itemInfo.link],
    ['LogicalName', itemInfo.logicalName],
    ['Generator', itemInfo.generator],
    ['LastGenOutput', itemInfo.lastGenOutput],
    ['DependentUpon', itemInfo.dependentUpon],
    ['SubType', itemInfo.subType],
    ['Condition', itemInfo.condition]
  ]);
}

function getProjectItemFileFilters(elementName) {
  switch (elementName) {
    case 'Compile':
      return {
        'Source files': ['cs', 'fs', 'vb'],
        'All files': ['*']
      };
    case 'EmbeddedResource':
      return {
        'Resource files': ['resx', 'resources'],
        'All files': ['*']
      };
    case 'AdditionalFiles':
      return {
        'Analyzer additional files': ['json', 'editorconfig', 'globalconfig', 'txt'],
        'All files': ['*']
      };
    case 'Content':
    case 'None':
    default:
      return {
        'All files': ['*']
      };
  }
}

function getProjectPropertiesReferencePath(projectPath, reference = {}) {
  if (reference.hintPath) {
    return resolveProjectFilePath(projectPath, reference.hintPath);
  }

  const rawValue = reference.include || reference.name;

  if (!isPathLikeReferenceValue(rawValue)) {
    return undefined;
  }

  return resolveProjectFilePath(projectPath, reference.path || rawValue);
}

function isPathLikeReferenceValue(value) {
  if (!value) {
    return false;
  }

  const text = String(value);
  return path.isAbsolute(text)
    || /[\\/]/.test(text)
    || Boolean(path.extname(text));
}

function getReferenceElementName(groupKind) {
  switch (groupKind) {
    case 'assemblies':
      return 'Reference';
    case 'frameworks':
      return 'FrameworkReference';
    case 'analyzers':
      return 'Analyzer';
    default:
      return undefined;
  }
}

function createSelfClosingXml(elementName, attributes) {
  const markup = attributes
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([name, value]) => `${name}="${escapeXmlAttribute(value)}"`)
    .join(' ');

  return markup ? `<${elementName} ${markup} />` : `<${elementName} />`;
}

function escapeXmlAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlComment(value) {
  return String(value).replace(/--/g, '- -');
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

function resolveReferencePath(projectPath, value) {
  if (!value || /[$%*?]/.test(value)) {
    return value;
  }

  const normalizedValue = value.replace(/\\/g, path.sep);

  if (path.isAbsolute(normalizedValue)) {
    return normalizedValue;
  }

  return path.resolve(path.dirname(projectPath), normalizedValue);
}

function resolveProjectFilePath(projectPath, value) {
  if (!value || /[$%*?]/.test(value)) {
    return undefined;
  }

  const normalizedValue = value.replace(/\\/g, path.sep);

  if (path.isAbsolute(normalizedValue)) {
    return normalizedValue;
  }

  return path.resolve(path.dirname(projectPath), normalizedValue);
}

function resolvePublishProfilePath(projectPath, value) {
  const resolvedPath = resolveProjectFilePath(projectPath, value);

  if (!resolvedPath || path.extname(resolvedPath).toLowerCase() !== '.pubxml') {
    return undefined;
  }

  return resolvedPath;
}

const __test = {
  createAssemblyMetadataXml,
  createBuildSettingsXml,
  createBuildEventsXml,
  createDiagnosticPropertyXml,
  createCentralPackageVersionXml,
  createImportXml,
  createNuGetPackageSourceMappingXml,
  createPackageMetadataXml,
  createPublishSettingsXml,
  createProjectPropertiesReferenceXml,
  createSigningXml,
  createSourceGeneratorXml,
  createPackageReferenceMetadata,
  createPackageReferenceXml,
  getProjectPackageInfo
};

export {
  ProjectActions,
  __test
};
