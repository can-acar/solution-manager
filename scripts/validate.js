const { execFileSync } = require('child_process');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const files = [
  'dist/extension.js',
  'dist/launchSettingsEditor.js',
  'dist/projectActions.js',
  'dist/projectAssetsReader.js',
  'dist/projectFileEditor.js',
  'dist/projectPropertiesView.js',
  'dist/nugetManagerView.js',
  'dist/nugetProtocolHost.js',
  'dist/solutionActions.js',
  'dist/solutionFileEditor.js',
  'dist/solutionTreeProvider.js',
  'dist/terminalRunner.js',
  'dist/workspaceScanner.js',
  'scripts/validate.js'
];

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  execFileSync('npx', ['tsc', '-p', path.join(process.cwd(), 'tsconfig.json')], {
    stdio: 'inherit'
  });
  execFileSync('dotnet', [
    'publish',
    path.join(process.cwd(), 'src/protocol-host/CanNugetGallery.ProtocolHost.csproj'),
    '-c',
    'Release',
    '-o',
    path.join(process.cwd(), 'dist/protocol-host'),
    '--nologo'
  ], {
    stdio: 'inherit'
  });

  assert(
    fs.existsSync(path.join(process.cwd(), 'dist/protocol-host/CanNugetGallery.ProtocolHost.dll')),
    'NuGet protocol host was not published.'
  );

  for (const file of files) {
    execFileSync(process.execPath, ['--check', path.join(process.cwd(), file)], {
      stdio: 'inherit'
    });
  }

  validateManifest();
  validateProjectAssetsParser();
  validateNuGetManagerView();
  validateDependencyPackagePathResolution();
  validateLaunchSettingsEditor();
  await validateProjectMetadataParser();
  validateProjectPropertiesView();
  validateProjectActions();
  validateProjectPropertyEditor();
  validateSolutionFileEditor();

  console.log(`Validated ${files.length} JavaScript files.`);
}

function validateManifest() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  const extensionSource = fs.readFileSync(path.join(process.cwd(), 'src/extension.ts'), 'utf8');
  const contributedCommands = new Set(packageJson.contributes.commands.map((command) => command.command));
  const registeredCommands = new Set([...extensionSource.matchAll(/registerCommand\('([^']+)'/g)].map((match) => match[1]));
  const missingRegistrations = [...contributedCommands].filter((command) => !registeredCommands.has(command));
  const activationCommands = new Set((packageJson.activationEvents || [])
    .map((event) => /^onCommand:(.+)$/.exec(event)?.[1])
    .filter(Boolean));

  if (missingRegistrations.length > 0) {
    throw new Error(`Commands are contributed but not registered: ${missingRegistrations.join(', ')}`);
  }

  const missingActivationEvents = [...contributedCommands].filter((command) => !activationCommands.has(command));

  if (missingActivationEvents.length > 0) {
    throw new Error(`Commands are contributed but do not have activation events: ${missingActivationEvents.join(', ')}`);
  }

  const submenuIds = new Set((packageJson.contributes.submenus || []).map((submenu) => submenu.id));
  const menus = packageJson.contributes.menus || {};
  const configurationProperties = packageJson.contributes.configuration?.properties || {};

  assert(
    configurationProperties['solutionManager.nuget.sources'],
    'NuGet Manager sources setting is not contributed.'
  );
  assert(
    configurationProperties['solutionManager.nuget.skipRestore'],
    'NuGet Manager skip restore setting is not contributed.'
  );

  for (const [location, entries] of Object.entries(menus)) {
    for (const entry of entries) {
      if (entry.command && !contributedCommands.has(entry.command)) {
        throw new Error(`Menu ${location} references an unknown command: ${entry.command}`);
      }

      if (entry.submenu && !submenuIds.has(entry.submenu)) {
        throw new Error(`Menu ${location} references an unknown submenu: ${entry.submenu}`);
      }
    }
  }

  const viewItemMenus = menus['view/item/context'] || [];
  assert(
    hasMenuSubmenu(viewItemMenus, 'solutionManager.solution.add', 'solution'),
    'Solution root does not expose Add submenu.'
  );
  assert(
    hasMenuCommand(viewItemMenus, 'solutionManager.solutionManageNuGetPackages', 'solution'),
    'Solution root does not expose Manage NuGet Packages.'
  );
  assert(
    hasMenuCommand(viewItemMenus, 'solutionManager.solutionUnloadProjects', 'solution'),
    'Solution root does not expose Unload Projects.'
  );
  assert(
    hasMenuCommand(viewItemMenus, 'solutionManager.solutionLoadProjectsWithDependencies', 'solution'),
    'Solution root does not expose Load Projects with Dependencies.'
  );
  assert(
    hasMenuSubmenu(viewItemMenus, 'solutionManager.solution.ef', 'solution'),
    'Solution root does not expose Entity Framework Core submenu.'
  );
  assert(
    hasMenuCommand(viewItemMenus, 'solutionManager.solutionBuild', 'solution'),
    'Solution root does not expose Build Solution.'
  );
  assert(
    hasMenuCommand(viewItemMenus, 'solutionManager.solutionRunMultipleProjects', 'solution'),
    'Solution root does not expose Run Multiple Projects.'
  );
  assert(
    hasMenuCommand(viewItemMenus, 'solutionManager.solutionRunUnitTests', 'solution'),
    'Solution root does not expose Run Unit Tests.'
  );
  assert(
    hasMenuSubmenu(viewItemMenus, 'solutionManager.solution.advancedBuild', 'solution'),
    'Solution root does not expose Advanced Build Actions submenu.'
  );
  assert(
    hasMenuSubmenu(viewItemMenus, 'solutionManager.solution.git', 'solution'),
    'Solution root does not expose Git submenu.'
  );
  assert(
    hasMenuSubmenu(viewItemMenus, 'solutionManager.solution.copy', 'solution'),
    'Solution root does not expose Copy Path/Reference submenu.'
  );
  assert(
    hasMenuSubmenu(viewItemMenus, 'solutionManager.solution.openIn', 'solution'),
    'Solution root does not expose Open In submenu.'
  );
  assert(
    hasMenuCommand(viewItemMenus, 'solutionManager.solutionProperties', 'solution'),
    'Solution root does not expose Properties.'
  );
  assert(
    hasMenuCommand(menus['solutionManager.solution.add'] || [], 'solutionManager.solutionAddNewProject'),
    'Solution Add submenu does not expose New Project.'
  );
  assert(
    hasMenuCommand(menus['solutionManager.solution.add'] || [], 'solutionManager.solutionAddExistingProject'),
    'Solution Add submenu does not expose Existing Project.'
  );
  assert(
    !packageJson.contributes.commands.some((command) => [
      'Show Local History',
      'Refactor This...',
      'Inspect Code...',
      'Reformat and Cleanup...',
      'Diagrams',
      'Tools',
      'Manage .NET SDK...'
    ].includes(command.title)),
    'Unsupported Rider-only solution actions should not be contributed.'
  );
  assert(
    hasMenuCommand(viewItemMenus, 'solutionManager.dependencyGroupDetails', 'dependencyGroup.packages'),
    'Packages dependency group does not expose Dependency Details.'
  );
  assert(
    hasMenuCommand(viewItemMenus, 'solutionManager.addPackageReference', 'dependencyGroup.packages'),
    'Packages dependency group does not expose Add PackageReference.'
  );
  assert(
    hasMenuCommand(viewItemMenus, 'solutionManager.manageNuGetPackages', 'dependencyGroup.packages'),
    'Packages dependency group does not expose Manage NuGet Packages.'
  );
  assert(
    hasMenuCommand(viewItemMenus, 'solutionManager.dependencyListPackages', 'dependencyGroup.packages'),
    'Packages dependency group does not expose List Packages.'
  );
  assert(
    hasMenuCommand(viewItemMenus, 'solutionManager.addProjectReference', 'dependencyGroup.projects'),
    'Projects dependency group does not expose Add Project Reference.'
  );
  assert(
    hasMenuCommand(viewItemMenus, 'solutionManager.dependencyGroupDetails', 'dependencies'),
    'Dependencies root node does not expose Dependency Details.'
  );
  assert(
    hasMenuCommand(viewItemMenus, 'solutionManager.manageNuGetPackages', 'dependencies'),
    'Dependencies root node does not expose Manage NuGet Packages.'
  );
  assert(
    hasMenuCommand(viewItemMenus, 'solutionManager.restoreProject', 'dependencies'),
    'Dependencies root node does not expose Restore.'
  );
  assert(
    hasMenuCommand(viewItemMenus, 'solutionManager.dependencyListPackages', 'dependencies'),
    'Dependencies root node does not expose List Packages.'
  );
  assert(
    hasMenuCommand(viewItemMenus, 'solutionManager.showProperties', 'dependencies'),
    'Dependencies root node does not expose Project Properties.'
  );
  assert(
    hasMenuCommand(viewItemMenus, 'solutionManager.dependencyGroupDetails', 'dependencyImports'),
    'Imports dependency node does not expose Dependency Details.'
  );
  assert(
    hasMenuCommand(viewItemMenus, 'solutionManager.dependencyFrameworkDetails', 'dependencyFramework'),
    'Target framework dependency node does not expose Target Framework Details.'
  );
  assert(
    hasMenuCommand(viewItemMenus, 'solutionManager.dependencyBuildFramework', 'dependencyFramework'),
    'Target framework dependency node does not expose Build Target Framework.'
  );
  assert(
    hasMenuCommand(viewItemMenus, 'solutionManager.dependencyTestFramework', 'dependencyFramework'),
    'Target framework dependency node does not expose Test Target Framework.'
  );
  assert(
    hasMenuCommand(viewItemMenus, 'solutionManager.dependencyCopyFramework', 'dependencyFramework'),
    'Target framework dependency node does not expose Copy Target Framework.'
  );
}

function hasMenuCommand(entries, command, contextValue) {
  return entries.some((entry) => entry.command === command && (!contextValue || String(entry.when || '').includes(`viewItem == ${contextValue}`)));
}

function hasMenuSubmenu(entries, submenu, contextValue) {
  return entries.some((entry) => entry.submenu === submenu && (!contextValue || String(entry.when || '').includes(`viewItem == ${contextValue}`)));
}

function runtimeModulePath(fileName) {
  return path.join(process.cwd(), 'dist', fileName);
}

function validateProjectAssetsParser() {
  const { readProjectAssetsFromText } = require(runtimeModulePath('projectAssetsReader.js'));
  const assets = {
    version: 3,
    targets: {
      'net10.0': {
        'Newtonsoft.Json/13.0.3': {
          type: 'package',
          dependencies: {
            'System.Text.Json': '10.0.0'
          },
          compile: {
            'lib/netstandard2.0/Newtonsoft.Json.dll': {},
            '_._': {}
          },
          runtime: {
            'lib/netstandard2.0/Newtonsoft.Json.dll': {}
          },
          native: {
            'runtimes/osx-arm64/native/Newtonsoft.Json.dylib': {}
          },
          resource: {
            'lib/netstandard2.0/fr/Newtonsoft.Json.resources.dll': {}
          },
          build: {
            'build/Newtonsoft.Json.props': {}
          },
          buildTransitive: {
            'buildTransitive/Newtonsoft.Json.targets': {}
          },
          contentFiles: {
            'contentFiles/any/net10.0/appsettings.json': {}
          },
          analyzers: {
            'analyzers/dotnet/cs/Newtonsoft.Json.Analyzer.dll': {}
          },
          runtimeTargets: {
            'runtimes/osx-arm64/lib/net10.0/Newtonsoft.Json.dll': {
              assetType: 'runtime',
              rid: 'osx-arm64'
            }
          }
        },
        'System.Text.Json/10.0.0': {
          type: 'package'
        },
        'Core/1.0.0': {
          type: 'project'
        }
      }
    },
    libraries: {
      'Newtonsoft.Json/13.0.3': {
        type: 'package',
        path: 'newtonsoft.json/13.0.3'
      },
      'System.Text.Json/10.0.0': {
        type: 'package'
      },
      'Core/1.0.0': {
        type: 'project'
      }
    },
    project: {
      frameworks: {
        'net10.0': {
          topLevelPackages: [
            {
              id: 'Newtonsoft.Json',
              version: '13.0.3'
            }
          ],
          frameworkReferences: {
            'Microsoft.AspNetCore.App': {}
          }
        }
      }
    }
  };
  const result = readProjectAssetsFromText(JSON.stringify(assets));
  const net10 = result['net10.0'];

  assert(net10, 'Assets parser did not create net10.0 target.');
  assert(net10.packages.length === 2, 'Assets parser did not read packages.');
  assert(net10.packages.find((item) => item.name === 'Newtonsoft.Json')?.direct === true, 'Direct package was not detected.');
  assert(net10.packages.find((item) => item.name === 'System.Text.Json')?.direct === false, 'Transitive package was not detected.');
  assert(net10.packages[0].dependencies[0].name === 'System.Text.Json', 'Package dependencies were not read.');
  assert(net10.packages[0].compile.length === 1, 'Compile assets were not filtered correctly.');
  assert(net10.packages[0].runtime.length === 1, 'Runtime assets were not read.');
  assert(net10.packages[0].native.length === 1, 'Native assets were not read.');
  assert(net10.packages[0].resource.length === 1, 'Resource assets were not read.');
  assert(net10.packages[0].build.length === 1, 'Build assets were not read.');
  assert(net10.packages[0].buildTransitive.length === 1, 'BuildTransitive assets were not read.');
  assert(net10.packages[0].contentFiles.length === 1, 'ContentFiles assets were not read.');
  assert(net10.packages[0].analyzers.length === 1, 'Analyzer assets were not read.');
  assert(net10.packages[0].runtimeTargets.length === 1, 'Runtime target assets were not read.');
  assert(net10.packages[0].packageAssetGroups.length >= 8, 'Package asset groups were not created.');
  assert(net10.projects.length === 1, 'Project assets project references were not read.');
  assert(net10.frameworkReferences.length === 1, 'Framework references were not read from assets.');
}

function validateNuGetManagerView() {
  const originalLoad = Module._load;
  const vscodeMock = {
    FileType: {
      File: 1
    },
    Uri: {
      file: (fsPath) => ({ fsPath })
    },
    workspace: {
      getConfiguration: () => ({
        get: (key) => {
          if (key === 'sources') {
            return ['{"name":"nuget.org","url":"https://api.nuget.org/v3/index.json"}'];
          }

          if (key === 'skipRestore') {
            return false;
          }

          return undefined;
        },
        update: async () => {}
      }),
      getWorkspaceFolder: () => undefined,
      workspaceFolders: [],
      fs: {
        readFile: async () => Buffer.from(''),
        stat: async () => ({ type: 1 })
      }
    },
    window: {
      showWarningMessage: () => {},
      showErrorMessage: () => {},
      setStatusBarMessage: () => {}
    }
  };

  Module._load = function loadWithVscodeMock(request, parent, isMain) {
    if (request === 'vscode') {
      return vscodeMock;
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const { __test } = require(runtimeModulePath('nugetManagerView.js'));
    const nugetManagerSource = fs.readFileSync(path.join(process.cwd(), 'src/nugetManagerView.ts'), 'utf8');
    assert(nugetManagerSource.includes('>All Solution</option>'), 'NuGet Manager project selector does not expose All Solution.');
    assert(!nugetManagerSource.includes('state.selectedProjectPath = state.projects[0].path'), 'NuGet Manager should not default to the first project.');
    assert(nugetManagerSource.includes('Paketler'), 'NuGet Manager does not expose the packages tab.');
    assert(nugetManagerSource.includes('Kaynaklar'), 'NuGet Manager does not expose the sources tab.');
    assert(nugetManagerSource.includes('activePackageTab'), 'NuGet Manager does not expose package browse/installed tab state.');
    assert(nugetManagerSource.includes('renderInstalledPackageDetails'), 'NuGet Manager does not render installed package project details.');
    assert(nugetManagerSource.includes('installedProjects'), 'NuGet Manager installed package grouping does not keep project ownership.');

    const packageInfo = __test.mapProtocolPackage({
      Id: 'Newtonsoft.Json',
      Name: 'Newtonsoft.Json',
      Authors: ['James Newton-King'],
      Description: 'Json.NET',
      TotalDownloads: 10,
      Version: '13.0.4',
      Versions: [{ Version: '13.0.4', Id: '13.0.4' }],
      Tags: ['json']
    }, 'https://api.nuget.org/v3/index.json');

    assert(packageInfo.id === 'Newtonsoft.Json', 'NuGet protocol package ID was not mapped.');
    assert(packageInfo.authors === 'James Newton-King', 'NuGet protocol package authors were not mapped.');
    assert(packageInfo.versions[0].version === '13.0.4', 'NuGet protocol package versions were not mapped.');

    const groups = __test.mapProtocolDependencyGroups({
      Dependencies: {
        Frameworks: {
          'net8.0': [{ Package: 'System.Text.Json', VersionRange: '[8.0.0, )' }]
        }
      }
    });

    assert(groups[0].targetFramework === 'net8.0', 'NuGet dependency framework was not mapped.');
    assert(groups[0].dependencies[0].id === 'System.Text.Json', 'NuGet dependency package was not mapped.');

    const sources = __test.getPackageSources([
      {
        name: 'App',
        path: '/repo/App.csproj',
        metadata: {
          nugetConfig: {
            packageSources: [
              { key: 'private', value: 'https://example.test/v3/index.json' }
            ]
          }
        }
      }
    ], [
      { name: 'global', url: 'file:///Users/test/.nuget/packages', editable: false, origin: 'nuget-config' }
    ]);

    assert(sources.some((source) => source.name === 'private'), 'Project NuGet.config source was not included.');
    assert(sources.some((source) => source.name === 'global'), 'Protocol host NuGet source was not included.');
  } finally {
    Module._load = originalLoad;
  }
}

function validateDependencyPackagePathResolution() {
  const originalLoad = Module._load;
  const originalNuGetPackages = process.env.NUGET_PACKAGES;
  const cacheRoot = path.join('/tmp', 'nuget-cache');

  Module._load = function loadWithVscodeMock(request, parent, isMain) {
    if (request === 'vscode') {
      return {};
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  process.env.NUGET_PACKAGES = cacheRoot;

  try {
    const { __test } = require(runtimeModulePath('solutionTreeProvider.js'));
    const packageFolder = path.join(cacheRoot, 'newtonsoft.json', '13.0.3');
    const assetPath = path.join(packageFolder, 'lib', 'netstandard2.0', 'Newtonsoft.Json.dll');

    assert(
      __test.getPackageFolderPath({ name: 'Newtonsoft.Json', version: '13.0.3' }) === packageFolder,
      'NuGet package folder was not resolved from package id/version.'
    );
    assert(
      __test.getPackageFolderPath({ path: 'newtonsoft.json/13.0.3', type: 'package' }) === packageFolder,
      'NuGet package folder was not resolved from project.assets.json library path.'
    );
    assert(
      __test.getPackageAssetPath({ path: 'newtonsoft.json/13.0.3', type: 'package' }, 'lib/netstandard2.0/Newtonsoft.Json.dll') === assetPath,
      'NuGet package asset path was not resolved.'
    );
    assert(
      __test.createPackageReferenceXml({
        name: 'Newtonsoft.Json',
        version: '13.0.3',
        versionOverride: '13.0.4',
        privateAssets: 'all',
        generatePathProperty: 'true',
        aliases: 'global',
        noWarn: 'NU1605',
        condition: "'$(TargetFramework)'=='net10.0'"
      }) === '<PackageReference Include="Newtonsoft.Json" Version="13.0.3" VersionOverride="13.0.4" PrivateAssets="all" GeneratePathProperty="true" Aliases="global" NoWarn="NU1605" Condition="\'$(TargetFramework)\'==\'net10.0\'" />',
      'PackageReference XML did not preserve package metadata.'
    );
    assert(
      __test.createPackageReferenceXml({
        name: 'Central.Package',
        include: 'Central.Package',
        version: '9.1.0',
        centralVersion: '9.1.0',
        versionSource: 'Directory.Packages.props'
      }) === '<PackageReference Include="Central.Package" />',
      'Central PackageReference XML should not duplicate the central Version attribute.'
    );
    const mergedPackage = __test.mergeResolvedPackageReference(
      {
        name: 'Conditional.Package',
        version: '2.0.0',
        direct: true,
        type: 'package'
      },
      [
        {
          name: 'Conditional.Package',
          include: 'Conditional.Package',
          version: '1.5.0',
          privateAssets: 'all',
          includeAssets: 'runtime; build',
          excludeAssets: 'native',
          versionOverride: '2.0.1',
          outputItemType: 'Analyzer',
          referenceOutputAssembly: 'false',
          generatePathProperty: 'true',
          aliases: 'global',
          noWarn: 'NU1605',
          itemCondition: "'$(TargetFramework)'=='net10.0'",
          groupCondition: "'$(Configuration)'=='Debug'"
        }
      ],
      'net10.0'
    );

    assert(mergedPackage.version === '1.5.0', 'Resolved package did not inherit requested PackageReference version.');
    assert(mergedPackage.versionOverride === '2.0.1', 'Resolved package did not inherit VersionOverride metadata.');
    assert(mergedPackage.outputItemType === 'Analyzer', 'Resolved package did not inherit OutputItemType metadata.');
    assert(mergedPackage.referenceOutputAssembly === 'false', 'Resolved package did not inherit ReferenceOutputAssembly metadata.');
    assert(mergedPackage.groupCondition === "'$(Configuration)'=='Debug'", 'Resolved package did not inherit group condition metadata.');
    assert(mergedPackage.itemCondition === "'$(TargetFramework)'=='net10.0'", 'Resolved package did not inherit item condition metadata.');
    const centralMergedPackage = __test.mergeResolvedPackageReference(
      {
        name: 'Central.Package',
        version: '9.1.0',
        direct: true,
        type: 'package'
      },
      [
        {
          name: 'Central.Package',
          include: 'Central.Package',
          version: '9.1.0',
          centralVersion: '9.1.0',
          versionSource: 'Directory.Packages.props',
          versionSourcePath: path.join('/tmp', 'Directory.Packages.props')
        }
      ],
      'net10.0'
    );
    assert(centralMergedPackage.version === '9.1.0', 'Resolved package did not preserve central version for display.');
    assert(centralMergedPackage.centralVersion === '9.1.0', 'Resolved package did not inherit centralVersion metadata.');
    assert(centralMergedPackage.versionSource === 'Directory.Packages.props', 'Resolved package did not inherit central version source.');
    assert(
      __test.createPackageReferenceXml(centralMergedPackage) === '<PackageReference Include="Central.Package" />',
      'Merged central PackageReference XML should not duplicate the central Version attribute.'
    );
    assert(
      __test.createPackageReferenceXml(mergedPackage) === '<PackageReference Include="Conditional.Package" Version="1.5.0" VersionOverride="2.0.1" PrivateAssets="all" IncludeAssets="runtime; build" ExcludeAssets="native" OutputItemType="Analyzer" ReferenceOutputAssembly="false" GeneratePathProperty="true" Aliases="global" NoWarn="NU1605" Condition="\'$(TargetFramework)\'==\'net10.0\'" />',
      'Merged PackageReference XML did not preserve condition-aware metadata.'
    );
    assert(
      __test.createPackageReferenceMetadata(mergedPackage, '2.1.0').Condition === "'$(TargetFramework)'=='net10.0'",
      'PackageReference update metadata copied the wrong condition.'
    );
    assert(
      __test.createPackageReferenceMetadata(mergedPackage, '2.1.0').OutputItemType === 'Analyzer',
      'PackageReference update metadata did not preserve OutputItemType.'
    );
    assert(
      __test.createPackageReferenceMetadata(mergedPackage, '2.1.0').ReferenceOutputAssembly === 'false',
      'PackageReference update metadata did not preserve ReferenceOutputAssembly.'
    );
    assert(
      __test.createDependencyReferenceXml({
        groupKind: 'import',
        name: 'Directory.Build.props',
        reference: {
          name: 'Directory.Build.props',
          source: '../Directory.Build.props',
          implicit: true,
          kind: 'directory-build-props'
        }
      }) === '<Import Project="../Directory.Build.props" />',
      'Dependency implicit Directory.Build import XML did not render a reusable Import.'
    );
    assert(
      __test.createDependencyReferenceXml({
        groupKind: 'assemblies',
        name: 'Legacy.Client',
        reference: {
          include: 'Legacy.Client',
          hintPath: 'lib/Legacy.Client.dll',
          aliases: 'global',
          private: 'false',
          copyLocal: 'true',
          itemCondition: "'$(TargetFramework)'=='net10.0'",
          groupCondition: "'$(Configuration)'=='Release'"
        }
      }) === '<Reference Include="Legacy.Client" HintPath="lib/Legacy.Client.dll" Aliases="global" Private="false" CopyLocal="true" Condition="\'$(TargetFramework)\'==\'net10.0\'" />',
      'Dependency Reference XML did not preserve assembly metadata.'
    );
    assert(
      !__test.createDependencyReferenceXml({
        groupKind: 'assemblies',
        name: 'Legacy.Client',
        reference: {
          include: 'Legacy.Client',
          itemCondition: "'$(TargetFramework)'=='net10.0'",
          groupCondition: "'$(Configuration)'=='Release'"
        }
      }).includes('Release'),
      'Dependency Reference XML copied group condition onto the item.'
    );
    const packageDetails = __test.createDependencyPackageDetailsMarkdown({
      ...mergedPackage,
      project: {
        name: 'Kivi.Client'
      },
      packageFolderPath: '/tmp/.nuget/packages/conditional.package/1.5.0',
      packageSourceMappings: [
        {
          source: 'nuget.org',
          patterns: ['Conditional.*']
        }
      ],
      dependencies: [
        {
          name: 'System.Text.Json',
          version: '10.0.0'
        }
      ],
      compile: [
        'lib/net10.0/Conditional.Package.dll'
      ],
      runtime: [
        'runtimes/osx-arm64/native/Conditional.Package.dylib'
      ],
      buildTransitive: [
        'buildTransitive/Conditional.Package.targets'
      ],
      contentFiles: [
        'contentFiles/any/net10.0/readme.txt'
      ],
      packageAssetGroups: [
        {
          key: 'compile',
          label: 'Compile Assets',
          assets: ['lib/net10.0/Conditional.Package.dll']
        },
        {
          key: 'runtime',
          label: 'Runtime Assets',
          assets: ['runtimes/osx-arm64/native/Conditional.Package.dylib']
        },
        {
          key: 'buildTransitive',
          label: 'Build Transitive Assets',
          assets: ['buildTransitive/Conditional.Package.targets']
        },
        {
          key: 'contentFiles',
          label: 'Content Files',
          assets: ['contentFiles/any/net10.0/readme.txt']
        }
      ],
      reference: mergedPackage
    });
    assert(packageDetails.includes('## Summary'), 'Package details did not render a summary section.');
    assert(packageDetails.includes('- Effective Include: Conditional.Package'), 'Package details did not render effective include.');
    assert(packageDetails.includes('- Dependency Count: 1'), 'Package details did not render dependency count.');
    assert(packageDetails.includes('- Compile Asset Count: 1'), 'Package details did not render compile asset count.');
    assert(packageDetails.includes('- Runtime Asset Count: 1'), 'Package details did not render runtime asset count.');
    assert(packageDetails.includes('- Asset Group Count: 4'), 'Package details did not render asset group count.');
    assert(packageDetails.includes('- OutputItemType: Analyzer'), 'Package details did not render OutputItemType metadata.');
    assert(packageDetails.includes('- ReferenceOutputAssembly: false'), 'Package details did not render ReferenceOutputAssembly metadata.');
    assert(packageDetails.includes('- Version Source: Not specified'), 'Package details did not render version source metadata.');
    assert(packageDetails.includes('- Package Source Mapping: nuget.org: Conditional.*'), 'Package details did not render package source mapping metadata.');
    assert(packageDetails.includes('## Build Transitive Assets'), 'Package details did not render build transitive assets.');
    assert(packageDetails.includes('## Content Files'), 'Package details did not render content files assets.');
    assert(packageDetails.includes('## XML'), 'Package details did not render XML section.');
    assert(
      packageDetails.includes('<PackageReference Include="Conditional.Package" Version="1.5.0" VersionOverride="2.0.1" PrivateAssets="all" IncludeAssets="runtime; build" ExcludeAssets="native" OutputItemType="Analyzer" ReferenceOutputAssembly="false" GeneratePathProperty="true" Aliases="global" NoWarn="NU1605" Condition="\'$(TargetFramework)\'==\'net10.0\'" />'),
      'Package details XML did not preserve PackageReference metadata.'
    );
    assert(
      __test.createPackageSourceMappingXml({
        packageSourceMappings: [
          {
            source: 'nuget.org',
            patterns: ['Conditional.*']
          }
        ]
      }).includes('<package pattern="Conditional.*" />'),
      'Package source mapping XML was not created.'
    );
    const centralPackageDetails = __test.createDependencyPackageDetailsMarkdown({
      ...centralMergedPackage,
      project: {
        name: 'Kivi.Client'
      },
      reference: centralMergedPackage
    });
    assert(centralPackageDetails.includes('- Version Source: Directory.Packages.props'), 'Central package details did not render version source.');
    assert(centralPackageDetails.includes('- Central Package Version: 9.1.0'), 'Central package details did not render central version.');
    assert(centralPackageDetails.includes('<PackageReference Include="Central.Package" />'), 'Central package details XML duplicated Version metadata.');

    const frameworkDetails = __test.createDependencyFrameworkDetailsMarkdown(
      {
        name: 'Kivi.Client',
        path: path.join('/tmp', 'Kivi.Client', 'Kivi.Client.csproj'),
        metadata: {
          packageReferences: [
            mergedPackage
          ],
          projectReferences: [
            {
              name: 'Kivi.Core',
              include: '../Kivi.Core/Kivi.Core.csproj'
            }
          ],
          assemblyReferences: [
            {
              name: 'Legacy.Client',
              include: 'Legacy.Client'
            }
          ],
          analyzerReferences: [
            {
              name: 'analyzers/Generator.dll',
              include: 'analyzers/Generator.dll'
            }
          ],
          frameworkReferences: [
            {
              name: 'Microsoft.AspNetCore.App'
            }
          ],
          sourceGenerators: [
            {
              name: 'Kivi.SourceGenerator',
              version: '1.0.0'
            }
          ],
          packageLock: {
            packages: [
              {
                targetFramework: 'net10.0',
                name: 'Conditional.Package',
                type: 'Direct',
                resolved: '1.5.0'
              }
            ]
          },
          resolvedDependencies: {
            'net10.0': {
              packages: [
                {
                  ...mergedPackage,
                  direct: true,
                  compile: ['lib/net10.0/Conditional.Package.dll'],
                  runtime: ['lib/net10.0/Conditional.Package.dll']
                },
                {
                  name: 'Transitive.Package',
                  version: '3.0.0',
                  direct: false,
                  compile: ['lib/net10.0/Transitive.Package.dll'],
                  runtime: []
                }
              ],
              projects: [
                {
                  name: 'Kivi.Core',
                  path: '../Kivi.Core/obj/project.assets.json'
                }
              ],
              frameworkReferences: [
                {
                  name: 'Microsoft.AspNetCore.App'
                }
              ]
            }
          }
        }
      },
      'net10.0'
    );
    assert(frameworkDetails.includes('# .NET 10.0'), 'Framework details did not render formatted framework title.');
    assert(frameworkDetails.includes('- Direct Packages: 1'), 'Framework details did not count direct packages.');
    assert(frameworkDetails.includes('- Transitive Packages: 1'), 'Framework details did not count transitive packages.');
    assert(frameworkDetails.includes('- Locked Packages: 1'), 'Framework details did not count locked packages.');
    assert(frameworkDetails.includes('- Project References: 1'), 'Framework details did not count project references.');
    assert(frameworkDetails.includes('- Assembly References: 1'), 'Framework details did not count assembly references.');
    assert(frameworkDetails.includes('- Framework References: 1'), 'Framework details did not count framework references.');
    assert(frameworkDetails.includes('- Source Generators: 1'), 'Framework details did not count source generators.');
    assert(frameworkDetails.includes('## Locked Packages'), 'Framework details did not render locked package section.');
    assert(frameworkDetails.includes('- Compile Assets: 2'), 'Framework details did not count compile assets.');
    assert(frameworkDetails.includes('- Runtime Assets: 1'), 'Framework details did not count runtime assets.');
    assert(frameworkDetails.includes('- Package Assets: 3'), 'Framework details did not count package assets.');
    assert(frameworkDetails.includes('## Transitive Packages'), 'Framework details did not render transitive package section.');
    assert(frameworkDetails.includes('- Transitive.Package (3.0.0)'), 'Framework details did not render transitive package name.');

    const dependencyProject = {
      name: 'Kivi.Client',
      path: path.join('/tmp', 'Kivi.Client', 'Kivi.Client.csproj'),
      metadata: {
        targetFrameworks: ['net10.0'],
        imports: [
          {
            name: 'Directory.Build.props',
            source: 'Directory.Build.props',
            condition: "Exists('Directory.Build.props')",
            propertyCount: 1,
            targetCount: 0,
            taskCount: 0,
            properties: [
              {
                name: 'ManagePackageVersionsCentrally',
                value: 'true'
              }
            ],
            targets: []
          }
        ],
        packageReferences: [
          mergedPackage
        ],
        projectReferences: [
          {
            name: 'Kivi.Core',
            include: '../Kivi.Core/Kivi.Core.csproj'
          }
        ],
        assemblyReferences: [
          {
            name: 'Legacy.Client',
            include: 'Legacy.Client'
          }
        ],
        analyzerReferences: [
          {
            name: 'analyzers/Generator.dll',
            include: 'analyzers/Generator.dll'
          }
        ],
        frameworkReferences: [
          {
            name: 'Microsoft.AspNetCore.App'
          }
        ],
        sourceGenerators: [
          {
            name: 'Kivi.SourceGenerator',
            version: '1.0.0'
          }
        ],
        targets: [
          {
            name: 'GenerateClient'
          }
        ],
        packageLock: {
          path: path.join('/tmp', 'Kivi.Client', 'packages.lock.json'),
          exists: true,
          packages: [
            {
              targetFramework: 'net10.0',
              name: 'Conditional.Package',
              type: 'Direct',
              resolved: '1.5.0'
            }
          ]
        },
        resolvedDependencies: {
          'net10.0': {
            packages: [
              {
                ...mergedPackage,
                direct: true,
                compile: ['lib/net10.0/Conditional.Package.dll'],
                runtime: ['lib/net10.0/Conditional.Package.dll']
              },
              {
                name: 'Transitive.Package',
                version: '3.0.0',
                direct: false
              }
            ],
            projects: [
              {
                name: 'Kivi.Core',
                path: '../Kivi.Core/obj/project.assets.json'
              }
            ],
            frameworkReferences: [
              {
                name: 'Microsoft.AspNetCore.App'
              }
            ]
          }
        }
      }
    };
    const dependencyRootDetails = __test.createDependencyNodeDetailsMarkdown({
      kind: 'dependencies',
      item: dependencyProject
    });
    assert(dependencyRootDetails.includes('# Dependencies - Kivi.Client'), 'Dependency root details did not render title.');
    assert(dependencyRootDetails.includes('- Target Frameworks: 1'), 'Dependency root details did not count target frameworks.');
    assert(dependencyRootDetails.includes('- Package References: 1'), 'Dependency root details did not count package references.');
    assert(dependencyRootDetails.includes('- Package Lock File: /tmp/Kivi.Client/packages.lock.json'), 'Dependency root details did not render package lock path.');
    assert(dependencyRootDetails.includes('- Locked Packages: 1'), 'Dependency root details did not render package lock count.');
    assert(dependencyRootDetails.includes('- MSBuild Targets: 1'), 'Dependency root details did not count MSBuild targets.');
    assert(dependencyRootDetails.includes('.NET 10.0: 1 direct packages, 1 transitive packages'), 'Dependency root details did not render framework summary.');

    const dependencyImportsDetails = __test.createDependencyNodeDetailsMarkdown({
      kind: 'dependencyImports',
      item: dependencyProject
    });
    assert(dependencyImportsDetails.includes('# Imports - Kivi.Client'), 'Dependency imports details did not render title.');
    assert(dependencyImportsDetails.includes('- Imports: 1'), 'Dependency imports details did not count imports.');
    assert(dependencyImportsDetails.includes('- Imported Properties: 1'), 'Dependency imports details did not count imported properties.');
    assert(dependencyImportsDetails.includes('- Directory.Build.props: Directory.Build.props | 1 properties'), 'Dependency imports details did not render import summary item.');

    const dependencyGroupDetails = __test.createDependencyNodeDetailsMarkdown({
      kind: 'dependencyGroup',
      label: 'Packages',
      groupKind: 'packages',
      framework: 'net10.0',
      item: dependencyProject,
      children: [
        {
          label: 'Conditional.Package',
          description: '1.5.0 direct',
          reference: {
            ...mergedPackage,
            direct: true,
            compile: ['lib/net10.0/Conditional.Package.dll'],
            runtime: ['lib/net10.0/Conditional.Package.dll']
          }
        }
      ]
    });
    assert(dependencyGroupDetails.includes('# Packages'), 'Dependency group details did not render title.');
    assert(dependencyGroupDetails.includes('- Target Framework: net10.0'), 'Dependency group details did not render framework.');
    assert(dependencyGroupDetails.includes('- Items: 1'), 'Dependency group details did not count items.');
    assert(dependencyGroupDetails.includes('- Direct Packages: 1'), 'Dependency group details did not count direct packages.');
    assert(dependencyGroupDetails.includes('- Compile Assets: 1'), 'Dependency group details did not count compile assets.');
    assert(dependencyGroupDetails.includes('- Conditional.Package: 1.5.0 direct'), 'Dependency group details did not render item list.');
    assert(
      __test.createDependencyReferenceXml({
        groupKind: 'projects',
        name: 'Kivi.Core',
        reference: {
          name: 'Kivi.Core',
          include: '../Core/Core.csproj',
          referenceOutputAssembly: 'false',
          privateAssets: 'all',
          includeAssets: 'runtime; build',
          excludeAssets: 'native',
          itemCondition: "'$(TargetFramework)'=='net10.0'",
          groupCondition: "'$(Configuration)'=='Release'"
        }
      }) === '<ProjectReference Include="../Core/Core.csproj" ReferenceOutputAssembly="false" PrivateAssets="all" IncludeAssets="runtime; build" ExcludeAssets="native" Condition="\'$(TargetFramework)\'==\'net10.0\'" />',
      'Dependency ProjectReference XML did not preserve condition-aware metadata.'
    );
    assert(
      !__test.createDependencyReferenceXml({
        groupKind: 'projects',
        name: 'Kivi.Core',
        reference: {
          include: '../Core/Core.csproj',
          itemCondition: "'$(TargetFramework)'=='net10.0'",
          groupCondition: "'$(Configuration)'=='Release'"
        }
      }).includes('Release'),
      'Dependency ProjectReference XML copied group condition onto the item.'
    );
    const mergedProject = __test.mergeResolvedProjectReference(
      {
        name: 'Kivi.Core',
        key: 'Kivi.Core/1.0.0',
        type: 'project',
        path: '../Core/obj/project.assets.json'
      },
      [
        {
          name: 'Kivi.Core',
          include: '../Core/Core.csproj',
          path: path.join('/tmp', 'Core', 'Core.csproj'),
          referenceOutputAssembly: 'false',
          outputItemType: 'Analyzer',
          privateAssets: 'all',
          includeAssets: 'runtime; build',
          excludeAssets: 'native',
          itemCondition: "'$(TargetFramework)'=='net10.0'",
          groupCondition: "'$(Configuration)'=='Release'"
        }
      ],
      'net10.0'
    );

    assert(mergedProject.include === '../Core/Core.csproj', 'Resolved project dependency did not inherit ProjectReference include.');
    assert(mergedProject.path === path.join('/tmp', 'Core', 'Core.csproj'), 'Resolved project dependency did not inherit ProjectReference path.');
    assert(mergedProject.referenceOutputAssembly === 'false', 'Resolved project dependency did not inherit ReferenceOutputAssembly metadata.');
    assert(mergedProject.groupCondition === "'$(Configuration)'=='Release'", 'Resolved project dependency did not inherit group condition metadata.');
    assert(
      __test.createDependencyReferenceXml({
        groupKind: 'projects',
        name: mergedProject.name,
        reference: mergedProject
      }) === '<ProjectReference Include="../Core/Core.csproj" ReferenceOutputAssembly="false" OutputItemType="Analyzer" PrivateAssets="all" IncludeAssets="runtime; build" ExcludeAssets="native" Condition="\'$(TargetFramework)\'==\'net10.0\'" />',
      'Merged project dependency XML did not preserve ProjectReference metadata.'
    );
    const mergedFramework = __test.mergeResolvedFrameworkReference(
      {
        name: 'Microsoft.AspNetCore.App'
      },
      [
        {
          name: 'Microsoft.AspNetCore.App',
          include: 'Microsoft.AspNetCore.App',
          privateAssets: 'none',
          itemCondition: "'$(TargetFramework)'=='net8.0'",
          groupCondition: "'$(Configuration)'=='Debug'"
        },
        {
          name: 'Microsoft.AspNetCore.App',
          include: 'Microsoft.AspNetCore.App',
          privateAssets: 'all',
          includeAssets: 'runtime; build',
          excludeAssets: 'native',
          itemCondition: "'$(TargetFramework)'=='net10.0'",
          groupCondition: "'$(Configuration)'=='Release'"
        }
      ],
      'net10.0'
    );

    assert(mergedFramework.privateAssets === 'all', 'Resolved framework dependency did not choose target framework specific metadata.');
    assert(mergedFramework.groupCondition === "'$(Configuration)'=='Release'", 'Resolved framework dependency did not inherit group condition metadata.');
    assert(
      __test.createDependencyReferenceXml({
        groupKind: 'frameworks',
        name: mergedFramework.name,
        reference: mergedFramework
      }) === '<FrameworkReference Include="Microsoft.AspNetCore.App" PrivateAssets="all" IncludeAssets="runtime; build" ExcludeAssets="native" Condition="\'$(TargetFramework)\'==\'net10.0\'" />',
      'Merged FrameworkReference XML did not preserve condition-aware metadata.'
    );
    assert(
      !__test.createDependencyReferenceXml({
        groupKind: 'frameworks',
        name: mergedFramework.name,
        reference: mergedFramework
      }).includes('Release'),
      'Dependency FrameworkReference XML copied group condition onto the item.'
    );
    assert(
      __test.createDependencyReferenceXml({
        groupKind: 'analyzers',
        name: 'analyzers/Generator.dll',
        reference: {
          include: 'analyzers/Generator.dll',
          hintPath: 'analyzers/Generator.dll',
          privateAssets: 'all',
          includeAssets: 'runtime; build',
          excludeAssets: 'native',
          aliases: 'global',
          itemCondition: "'$(TargetFramework)'=='net10.0'",
          groupCondition: "'$(Configuration)'=='Release'"
        }
      }) === '<Analyzer Include="analyzers/Generator.dll" HintPath="analyzers/Generator.dll" PrivateAssets="all" IncludeAssets="runtime; build" ExcludeAssets="native" Aliases="global" Condition="\'$(TargetFramework)\'==\'net10.0\'" />',
      'Analyzer dependency XML did not preserve metadata.'
    );
    assert(
      __test.createDependencyReferenceXml({
        groupKind: 'sourceGenerators',
        name: 'Kivi.SourceGenerator',
        reference: {
          name: 'Kivi.SourceGenerator',
          version: '1.0.0',
          versionOverride: '1.0.1',
          privateAssets: 'all',
          includeAssets: 'runtime; build; native; contentfiles; analyzers; buildtransitive',
          excludeAssets: 'compile',
          outputItemType: 'Analyzer',
          referenceOutputAssembly: 'false',
          generatePathProperty: 'true',
          aliases: 'global',
          noWarn: 'NU1605',
          itemCondition: "'$(TargetFramework)'=='net10.0'",
          groupCondition: "'$(Configuration)'=='Release'",
          source: 'package'
        }
      }) === '<PackageReference Include="Kivi.SourceGenerator" Version="1.0.0" VersionOverride="1.0.1" PrivateAssets="all" IncludeAssets="runtime; build; native; contentfiles; analyzers; buildtransitive" ExcludeAssets="compile" OutputItemType="Analyzer" ReferenceOutputAssembly="false" GeneratePathProperty="true" Aliases="global" NoWarn="NU1605" Condition="\'$(TargetFramework)\'==\'net10.0\'" />',
      'Package source generator XML did not preserve PackageReference metadata.'
    );
    assert(
      __test.createDependencyReferenceXml({
        groupKind: 'sourceGenerators',
        name: 'Central.SourceGenerator',
        reference: {
          name: 'Central.SourceGenerator',
          version: '3.0.0',
          centralVersion: '3.0.0',
          versionSource: 'Directory.Packages.props',
          source: 'package'
        }
      }) === '<PackageReference Include="Central.SourceGenerator" PrivateAssets="all" OutputItemType="Analyzer" />',
      'Dependency central source generator XML should not duplicate Version metadata.'
    );
    assert(
      __test.createDependencyReferenceXml({
        groupKind: 'sourceGenerators',
        name: 'analyzers/Generator.dll',
        reference: {
          include: 'analyzers/Generator.dll',
          path: path.join('/tmp', 'analyzers', 'Generator.dll'),
          hintPath: 'analyzers/Generator.dll',
          privateAssets: 'all',
          includeAssets: 'runtime; build',
          aliases: 'global',
          itemCondition: "'$(TargetFramework)'=='net10.0'",
          groupCondition: "'$(Configuration)'=='Release'",
          source: 'analyzer'
        }
      }) === '<Analyzer Include="analyzers/Generator.dll" HintPath="analyzers/Generator.dll" PrivateAssets="all" IncludeAssets="runtime; build" Aliases="global" Condition="\'$(TargetFramework)\'==\'net10.0\'" />',
      'Analyzer source generator XML did not preserve Analyzer metadata.'
    );
    assert(
      !__test.createDependencyReferenceXml({
        groupKind: 'sourceGenerators',
        name: 'Kivi.SourceGenerator',
        reference: {
          name: 'Kivi.SourceGenerator',
          version: '1.0.0',
          itemCondition: "'$(TargetFramework)'=='net10.0'",
          groupCondition: "'$(Configuration)'=='Release'",
          source: 'package'
        }
      }).includes('Release'),
      'Source generator XML copied group condition onto the item.'
    );
    assert(
      __test.getPackageFolderPath({ name: 'Range.Package', version: '[1.0.0, )' }) === undefined,
      'Version ranges should not resolve to a concrete NuGet package folder.'
    );
  } finally {
    if (originalNuGetPackages === undefined) {
      delete process.env.NUGET_PACKAGES;
    } else {
      process.env.NUGET_PACKAGES = originalNuGetPackages;
    }

    Module._load = originalLoad;
  }
}

function validateLaunchSettingsEditor() {
  const originalLoad = Module._load;

  Module._load = function loadWithVscodeMock(request, parent, isMain) {
    if (request === 'vscode') {
      return {
        Uri: {
          file: (value) => ({ fsPath: value })
        },
        workspace: {
          fs: {}
        }
      };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const {
      addLaunchProfileToData,
      duplicateLaunchProfileInData,
      parseEnvironmentVariables,
      readProjectLaunchSettingsFromText,
      removeLaunchProfileFromData,
      serializeEnvironmentVariables,
      updateLaunchSettingsData
    } = require(runtimeModulePath('launchSettingsEditor.js'));
    const launchSettings = readProjectLaunchSettingsFromText(JSON.stringify({
      profiles: {
        Kivi: {
          commandName: 'Project',
          commandLineArgs: '--seed',
          launchBrowser: true,
          applicationUrl: 'https://localhost:7001;http://localhost:5000',
          environmentVariables: {
            ASPNETCORE_ENVIRONMENT: 'Development'
          }
        }
      }
    }), '/tmp/Properties/launchSettings.json');

    assert(launchSettings.profiles.length === 1, 'Launch profile was not parsed.');
    assert(launchSettings.profiles[0].launchBrowser === 'true', 'Launch browser boolean was not normalized.');
    assert(
      serializeEnvironmentVariables(launchSettings.profiles[0].environmentVariables) === 'ASPNETCORE_ENVIRONMENT=Development',
      'Launch environment variables were not serialized.'
    );
    assert(parseEnvironmentVariables('A=1\nB=two').B === 'two', 'Launch environment variables were not parsed.');

    const next = updateLaunchSettingsData(launchSettings.raw, [
      {
        originalName: 'Kivi',
        name: 'Kivi.Local',
        commandName: 'Project',
        commandLineArgs: '--local',
        launchBrowser: 'false',
        applicationUrl: 'http://localhost:5050',
        environmentVariables: 'ASPNETCORE_ENVIRONMENT=Local'
      }
    ]);

    assert(!next.profiles.Kivi, 'Renamed launch profile left the old key behind.');
    assert(next.profiles['Kivi.Local'].commandLineArgs === '--local', 'Launch profile commandLineArgs was not updated.');
    assert(next.profiles['Kivi.Local'].launchBrowser === false, 'Launch profile boolean was not updated.');
    assert(next.profiles['Kivi.Local'].environmentVariables.ASPNETCORE_ENVIRONMENT === 'Local', 'Launch profile env vars were not updated.');

    const withAddedProfile = addLaunchProfileToData(next, 'Kivi.Local');
    assert(withAddedProfile.profiles['Kivi.Local 2'], 'Duplicate launch profile name was not made unique.');

    const withDuplicatedProfile = duplicateLaunchProfileInData(withAddedProfile, 'Kivi.Local');
    assert(withDuplicatedProfile.profiles['Kivi.Local Copy'], 'Launch profile was not duplicated.');
    assert(withDuplicatedProfile.profiles['Kivi.Local Copy'].commandLineArgs === '--local', 'Duplicated launch profile did not preserve values.');

    const withRemovedProfile = removeLaunchProfileFromData(withAddedProfile, 'Kivi.Local');
    assert(!withRemovedProfile.profiles['Kivi.Local'], 'Launch profile was not removed.');
    assert(withRemovedProfile.profiles['Kivi.Local 2'], 'Removing one launch profile removed the wrong profile.');
  } finally {
    Module._load = originalLoad;
  }
}

async function validateProjectMetadataParser() {
  const originalLoad = Module._load;

  Module._load = function loadWithVscodeMock(request, parent, isMain) {
    if (request === 'vscode') {
      return {
        FileType: {
          File: 1
        },
        Uri: {
          file: (value) => ({ fsPath: value })
        },
        workspace: {
          asRelativePath: (value) => String(value),
          fs: {
            stat: async (uri) => {
              if (String(uri.fsPath).endsWith('Directory.Build.props') || String(uri.fsPath).endsWith('Directory.Build.targets')) {
                return { type: 1 };
              }

              throw new Error('not found');
            },
            readFile: async (uri) => {
              if (String(uri.fsPath).endsWith('Directory.Build.props')) {
                return Buffer.from([
                  '<Project>',
                  '<PropertyGroup>',
                  '<ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>',
                  '</PropertyGroup>',
                  '</Project>'
                ].join(''));
              }

              if (String(uri.fsPath).endsWith('Directory.Build.targets')) {
                return Buffer.from([
                  '<Project>',
                  '<Target Name="AfterCommonBuild" AfterTargets="Build">',
                  '<Message Text="done" />',
                  '</Target>',
                  '</Project>'
                ].join(''));
              }

              throw new Error('not found');
            }
          },
          getWorkspaceFolder: () => undefined
        }
      };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve(runtimeModulePath('workspaceScanner.js'))];
    const {
      enrichImportsWithImplicitDirectoryBuildFiles,
      enrichPackageReferencesWithCentralVersions,
      enrichPackagesWithPackageSourceMappings,
      enrichResolvedDependenciesWithPackageSourceMappings,
      readCentralPackageVersionsFromText,
      readGlobalJsonFromText,
      readMsBuildFileSummaryFromText,
      readNuGetConfigFromText,
      readPackageLockFileFromText,
      readProjectMetadataFromText,
      readPublishProfileFromText,
      readUserSecretsFromText,
      resolveUserSecretsPath
    } = require(runtimeModulePath('workspaceScanner.js'));
    const xml = [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '<PropertyGroup>',
      '<TargetFramework>net10.0</TargetFramework>',
      '<AssemblyName>Kivi.BankApiClient</AssemblyName>',
      '<RootNamespace>Kivi.BankApiClient</RootNamespace>',
      '<SignAssembly>true</SignAssembly>',
      '<AssemblyOriginatorKeyFile>key.snk</AssemblyOriginatorKeyFile>',
      '<PreBuildEvent>echo pre</PreBuildEvent>',
      '<PackageId>Kivi.Client</PackageId>',
      '<PackageVersion>1.2.3</PackageVersion>',
      '<PackageLicenseExpression>MIT</PackageLicenseExpression>',
      '<PackageLicenseUrl>https://licenses.example/kivi</PackageLicenseUrl>',
      '<PackageReleaseNotes>Initial package</PackageReleaseNotes>',
      '<RepositoryUrl>https://github.com/kivi/client</RepositoryUrl>',
      '<RepositoryType>git</RepositoryType>',
      '<RepositoryBranch>main</RepositoryBranch>',
      '<RepositoryCommit>abc123</RepositoryCommit>',
      '<PublishRepositoryUrl>true</PublishRepositoryUrl>',
      '<PackageIconUrl>https://cdn.example/icon.png</PackageIconUrl>',
      '<IsPackable>true</IsPackable>',
      '<GeneratePackageOnBuild>true</GeneratePackageOnBuild>',
      '<IncludeBuildOutput>true</IncludeBuildOutput>',
      '<IncludeContentInPack>false</IncludeContentInPack>',
      '<ContentTargetFolders>content;contentFiles</ContentTargetFolders>',
      '<DevelopmentDependency>false</DevelopmentDependency>',
      '<Serviceable>true</Serviceable>',
      '<IncludeSymbols>true</IncludeSymbols>',
      '<IncludeSource>true</IncludeSource>',
      '<SymbolPackageFormat>snupkg</SymbolPackageFormat>',
      '<EmbedUntrackedSources>true</EmbedUntrackedSources>',
      '<MinClientVersion>6.0.0</MinClientVersion>',
      '<PackageType>Dependency</PackageType>',
      '<PackageValidationBaselineVersion>1.0.0</PackageValidationBaselineVersion>',
      '<PackageValidationBaselineName>Kivi.Client</PackageValidationBaselineName>',
      '<PackageOutputPath>artifacts/packages</PackageOutputPath>',
      '<AssemblyTitle>Kivi Client</AssemblyTitle>',
      '<AssemblyVersion>1.2.3.0</AssemblyVersion>',
      '<ComVisible>false</ComVisible>',
      '<Guid>11111111-1111-1111-1111-111111111111</Guid>',
      '<CLSCompliant>true</CLSCompliant>',
      '<EnableNETAnalyzers>true</EnableNETAnalyzers>',
      '<AnalysisLevel>latest</AnalysisLevel>',
      '<ImplicitUsings>enable</ImplicitUsings>',
      '<StartupObject>Kivi.Program</StartupObject>',
      '<ApplicationIcon>app.ico</ApplicationIcon>',
      '<UserSecretsId>kivi-bank-api-client</UserSecretsId>',
      '<TargetFrameworkIdentifier>.NETCoreApp</TargetFrameworkIdentifier>',
      '<TargetFrameworkVersion>v10.0</TargetFrameworkVersion>',
      '<TargetFrameworkProfile>Profile7</TargetFrameworkProfile>',
      '<TargetPlatformIdentifier>ios</TargetPlatformIdentifier>',
      '<TargetPlatformVersion>18.0</TargetPlatformVersion>',
      '<TargetPlatformMinVersion>17.0</TargetPlatformMinVersion>',
      '<SupportedOSPlatformVersion>17.0</SupportedOSPlatformVersion>',
      '<AppendRuntimeIdentifierToOutputPath>false</AppendRuntimeIdentifierToOutputPath>',
      '<CopyLocalLockFileAssemblies>true</CopyLocalLockFileAssemblies>',
      '<RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>',
      '<RestoreLockedMode>true</RestoreLockedMode>',
      '<NuGetLockFilePath>packages.lock.json</NuGetLockFilePath>',
      '<RestoreUseStaticGraphEvaluation>true</RestoreUseStaticGraphEvaluation>',
      '<RuntimeIdentifier>osx-arm64</RuntimeIdentifier>',
      '<RuntimeIdentifiers>osx-arm64;linux-x64</RuntimeIdentifiers>',
      '<RuntimeFrameworkVersion>10.0.0</RuntimeFrameworkVersion>',
      '<RollForward>LatestMinor</RollForward>',
      '<SelfContained>true</SelfContained>',
      '<UseAppHost>true</UseAppHost>',
      '<TargetLatestRuntimePatch>true</TargetLatestRuntimePatch>',
      '<InvariantGlobalization>false</InvariantGlobalization>',
      '<PublishDir>artifacts/publish</PublishDir>',
      '<PublishUrl>artifacts/webdeploy</PublishUrl>',
      '<PublishSingleFile>true</PublishSingleFile>',
      '<PublishTrimmed>true</PublishTrimmed>',
      '<PublishReadyToRun>true</PublishReadyToRun>',
      '<PublishAot>false</PublishAot>',
      '<IncludeNativeLibrariesForSelfExtract>true</IncludeNativeLibrariesForSelfExtract>',
      '<EnableCompressionInSingleFile>true</EnableCompressionInSingleFile>',
      '<Deterministic>true</Deterministic>',
      '<ContinuousIntegrationBuild>true</ContinuousIntegrationBuild>',
      '<DebugSymbols>true</DebugSymbols>',
      '<DebugType>portable</DebugType>',
      '<ProduceReferenceAssembly>true</ProduceReferenceAssembly>',
      '<EmitCompilerGeneratedFiles>true</EmitCompilerGeneratedFiles>',
      '<CompilerGeneratedFilesOutputPath>generated</CompilerGeneratedFilesOutputPath>',
      '<CheckForOverflowUnderflow>true</CheckForOverflowUnderflow>',
      '<TreatWarningsAsErrors>true</TreatWarningsAsErrors>',
      '<WarningsAsErrors>CS1591</WarningsAsErrors>',
      '<NoWarn>CS0168</NoWarn>',
      '<WarningLevel>5</WarningLevel>',
      '</PropertyGroup>',
      '<PropertyGroup Condition="\'$(Configuration)|$(Platform)\'==\'Debug|AnyCPU\'">',
      '<DefineConstants>DEBUG;TRACE</DefineConstants>',
      '<Optimize>false</Optimize>',
      '<DebugSymbols>true</DebugSymbols>',
      '</PropertyGroup>',
      '<ItemGroup>',
      '<PackageReference Include="Newtonsoft.Json" Version="13.0.3" VersionOverride="13.0.4" PrivateAssets="all" GeneratePathProperty="true" Aliases="global" NoWarn="NU1605" Condition="\'$(TargetFramework)\'==\'net10.0\'" />',
      '<PackageReference Include="Kivi.SourceGenerator" Version="1.0.0" PrivateAssets="all" />',
      '<ProjectReference Include="../Core/Core.csproj" ReferenceOutputAssembly="false" />',
      '<Analyzer Include="analyzers/Generator.dll" />',
      '<Content Include="appsettings.json" CopyToOutputDirectory="PreserveNewest" CopyToPublishDirectory="Always" />',
      '<None Update="README.md" CopyToOutputDirectory="Never" />',
      '<EmbeddedResource Include="Resources.resx" LogicalName="Kivi.Resources" />',
      '<AdditionalFiles Include="stylecop.json" />',
      '</ItemGroup>',
      '<ItemGroup Condition="\'$(Configuration)\'==\'ResourceDebug\'">',
      '<PackageReference Include="DebugOnly.Package" Version="1.0.0" />',
      '<Content Include="debugsettings.json" CopyToOutputDirectory="Always" />',
      '</ItemGroup>',
      '<Import Project="Directory.Build.props" Condition="Exists(\'Directory.Build.props\')" />',
      '<Target Name="GenerateClient" BeforeTargets="BeforeBuild" DependsOnTargets="Restore" Condition="\'$(Configuration)\'==\'Debug\'">',
      '<Message Text="Generating client" Importance="High" />',
      '<Exec Command="dotnet tool run generate-client" />',
      '</Target>',
      '</Project>'
    ].join('');
    const metadata = readProjectMetadataFromText(xml, path.join('/tmp', 'src', 'App', 'App.csproj'));

    assert(metadata.targetFrameworks[0] === 'net10.0', 'Target framework was not parsed.');
    assert(metadata.signing.signAssembly === 'true', 'Signing metadata was not parsed.');
    assert(metadata.buildEvents.preBuildEvent === 'echo pre', 'Build event metadata was not parsed.');
    assert(
      metadata.buildSettings.implicitUsings === 'enable',
      `Build settings metadata was not parsed: ${JSON.stringify(metadata.buildSettings)} from ${JSON.stringify(metadata.properties)}`
    );
    assert(metadata.configurations.length === 1, 'Configuration-specific properties were not parsed.');
    assert(metadata.configurations[0].properties.DebugSymbols === 'true', 'Configuration DebugSymbols was not parsed.');
    assert(metadata.packageReferences[0].privateAssets === 'all', 'PackageReference metadata was not parsed.');
    assert(metadata.packageReferences[0].versionOverride === '13.0.4', 'PackageReference VersionOverride was not parsed.');
    assert(metadata.packageReferences[0].generatePathProperty === 'true', 'PackageReference GeneratePathProperty was not parsed.');
    assert(metadata.packageReferences[0].aliases === 'global', 'PackageReference Aliases was not parsed.');
    assert(metadata.packageReferences[0].noWarn === 'NU1605', 'PackageReference NoWarn was not parsed.');
    assert(metadata.packageReferences[0].condition === "'$(TargetFramework)'=='net10.0'", 'PackageReference condition was not parsed.');
    assert(metadata.packageReferences[0].itemCondition === "'$(TargetFramework)'=='net10.0'", 'PackageReference item condition was not parsed.');
    assert(metadata.packageReferences[1].groupCondition === undefined, 'Unconditional PackageReference should not have group condition.');
    assert(metadata.packageReferences[2].condition === "'$(Configuration)'=='ResourceDebug'", 'PackageReference group condition was not used as effective condition.');
    assert(metadata.packageReferences[2].itemCondition === undefined, 'Group-conditioned PackageReference should not have item condition.');
    assert(metadata.packageReferences[2].groupCondition === "'$(Configuration)'=='ResourceDebug'", 'PackageReference group condition was not parsed.');
    assert(metadata.sourceGenerators.some((reference) => reference.name === 'Kivi.SourceGenerator' && reference.source === 'package'), 'Package source generator was not detected.');
    assert(metadata.sourceGenerators.some((reference) => reference.name === 'analyzers/Generator.dll' && reference.source === 'analyzer'), 'Analyzer source generator was not detected.');
    assert(metadata.package.packageVersion === '1.2.3', 'PackageVersion metadata was not parsed.');
    assert(metadata.package.licenseExpression === 'MIT', 'Package license metadata was not parsed.');
    assert(metadata.package.licenseUrl === 'https://licenses.example/kivi', 'Package license URL metadata was not parsed.');
    assert(metadata.package.releaseNotes === 'Initial package', 'Package release notes were not parsed.');
    assert(metadata.package.repositoryUrl === 'https://github.com/kivi/client', 'RepositoryUrl metadata was not parsed.');
    assert(metadata.package.repositoryType === 'git', 'RepositoryType metadata was not parsed.');
    assert(metadata.package.repositoryBranch === 'main', 'RepositoryBranch metadata was not parsed.');
    assert(metadata.package.repositoryCommit === 'abc123', 'RepositoryCommit metadata was not parsed.');
    assert(metadata.package.publishRepositoryUrl === 'true', 'PublishRepositoryUrl metadata was not parsed.');
    assert(metadata.package.iconUrl === 'https://cdn.example/icon.png', 'PackageIconUrl metadata was not parsed.');
    assert(metadata.package.isPackable === 'true', 'IsPackable metadata was not parsed.');
    assert(metadata.package.generatePackageOnBuild === 'true', 'Package generation metadata was not parsed.');
    assert(metadata.package.includeBuildOutput === 'true', 'IncludeBuildOutput metadata was not parsed.');
    assert(metadata.package.includeContentInPack === 'false', 'IncludeContentInPack metadata was not parsed.');
    assert(metadata.package.contentTargetFolders === 'content;contentFiles', 'ContentTargetFolders metadata was not parsed.');
    assert(metadata.package.developmentDependency === 'false', 'DevelopmentDependency metadata was not parsed.');
    assert(metadata.package.serviceable === 'true', 'Serviceable metadata was not parsed.');
    assert(metadata.package.includeSymbols === 'true', 'Package symbols metadata was not parsed.');
    assert(metadata.package.includeSource === 'true', 'Package source metadata was not parsed.');
    assert(metadata.package.symbolPackageFormat === 'snupkg', 'Symbol package format was not parsed.');
    assert(metadata.package.embedUntrackedSources === 'true', 'EmbedUntrackedSources metadata was not parsed.');
    assert(metadata.package.minClientVersion === '6.0.0', 'MinClientVersion metadata was not parsed.');
    assert(metadata.package.packageType === 'Dependency', 'PackageType metadata was not parsed.');
    assert(metadata.package.packageValidationBaselineVersion === '1.0.0', 'PackageValidationBaselineVersion metadata was not parsed.');
    assert(metadata.package.packageValidationBaselineName === 'Kivi.Client', 'PackageValidationBaselineName metadata was not parsed.');
    assert(metadata.package.packageOutputPath === 'artifacts/packages', 'Package output path was not parsed.');
    assert(metadata.assembly.title === 'Kivi Client', 'Assembly title metadata was not parsed.');
    assert(metadata.assembly.version === '1.2.3.0', 'Assembly version metadata was not parsed.');
    assert(metadata.assembly.comVisible === 'false', 'ComVisible metadata was not parsed.');
    assert(metadata.assembly.guid === '11111111-1111-1111-1111-111111111111', 'Assembly GUID metadata was not parsed.');
    assert(metadata.assembly.clsCompliant === 'true', 'CLSCompliant metadata was not parsed.');
    assert(metadata.inspections.enableNetAnalyzers === 'true', 'Inspection settings were not parsed.');
    assert(metadata.inspections.analysisLevel === 'latest', 'Analysis level was not parsed.');
    assert(metadata.buildSettings.startupObject === 'Kivi.Program', 'StartupObject was not parsed.');
    assert(metadata.buildSettings.applicationIcon === 'app.ico', 'ApplicationIcon was not parsed.');
    assert(metadata.buildSettings.userSecretsId === 'kivi-bank-api-client', 'UserSecretsId was not parsed.');
    assert(metadata.userSecrets.id === 'kivi-bank-api-client', 'User secrets metadata was not created.');
    assert(metadata.buildSettings.targetFrameworkIdentifier === '.NETCoreApp', 'TargetFrameworkIdentifier was not parsed.');
    assert(metadata.buildSettings.targetFrameworkVersion === 'v10.0', 'TargetFrameworkVersion was not parsed.');
    assert(metadata.buildSettings.targetFrameworkProfile === 'Profile7', 'TargetFrameworkProfile was not parsed.');
    assert(metadata.buildSettings.targetPlatformIdentifier === 'ios', 'TargetPlatformIdentifier was not parsed.');
    assert(metadata.buildSettings.targetPlatformVersion === '18.0', 'TargetPlatformVersion was not parsed.');
    assert(metadata.buildSettings.targetPlatformMinVersion === '17.0', 'TargetPlatformMinVersion was not parsed.');
    assert(metadata.buildSettings.supportedOSPlatformVersion === '17.0', 'SupportedOSPlatformVersion was not parsed.');
    assert(metadata.buildSettings.appendRuntimeIdentifierToOutputPath === 'false', 'AppendRuntimeIdentifierToOutputPath was not parsed.');
    assert(metadata.buildSettings.copyLocalLockFileAssemblies === 'true', 'CopyLocalLockFileAssemblies was not parsed.');
    assert(metadata.buildSettings.restorePackagesWithLockFile === 'true', 'RestorePackagesWithLockFile was not parsed.');
    assert(metadata.buildSettings.restoreLockedMode === 'true', 'RestoreLockedMode was not parsed.');
    assert(metadata.buildSettings.nuGetLockFilePath === 'packages.lock.json', 'NuGetLockFilePath was not parsed.');
    assert(metadata.buildSettings.restoreUseStaticGraphEvaluation === 'true', 'RestoreUseStaticGraphEvaluation was not parsed.');
    assert(metadata.buildSettings.runtimeIdentifier === 'osx-arm64', 'RuntimeIdentifier was not parsed.');
    assert(metadata.buildSettings.runtimeIdentifiers === 'osx-arm64;linux-x64', 'RuntimeIdentifiers was not parsed.');
    assert(metadata.buildSettings.runtimeFrameworkVersion === '10.0.0', 'RuntimeFrameworkVersion was not parsed.');
    assert(metadata.buildSettings.rollForward === 'LatestMinor', 'RollForward was not parsed.');
    assert(metadata.buildSettings.selfContained === 'true', 'SelfContained was not parsed.');
    assert(metadata.buildSettings.useAppHost === 'true', 'UseAppHost was not parsed.');
    assert(metadata.buildSettings.targetLatestRuntimePatch === 'true', 'TargetLatestRuntimePatch was not parsed.');
    assert(metadata.buildSettings.invariantGlobalization === 'false', 'InvariantGlobalization was not parsed.');
    assert(metadata.buildSettings.publishDir === 'artifacts/publish', 'PublishDir was not parsed.');
    assert(metadata.buildSettings.publishUrl === 'artifacts/webdeploy', 'PublishUrl was not parsed.');
    assert(metadata.buildSettings.publishSingleFile === 'true', 'PublishSingleFile was not parsed.');
    assert(metadata.buildSettings.publishTrimmed === 'true', 'PublishTrimmed was not parsed.');
    assert(metadata.buildSettings.publishReadyToRun === 'true', 'PublishReadyToRun was not parsed.');
    assert(metadata.buildSettings.publishAot === 'false', 'PublishAot was not parsed.');
    assert(metadata.buildSettings.includeNativeLibrariesForSelfExtract === 'true', 'IncludeNativeLibrariesForSelfExtract was not parsed.');
    assert(metadata.buildSettings.enableCompressionInSingleFile === 'true', 'EnableCompressionInSingleFile was not parsed.');
    assert(metadata.buildSettings.deterministic === 'true', 'Deterministic was not parsed.');
    assert(metadata.buildSettings.continuousIntegrationBuild === 'true', 'ContinuousIntegrationBuild was not parsed.');
    assert(metadata.buildSettings.debugSymbols === 'true', 'DebugSymbols was not parsed.');
    assert(metadata.buildSettings.debugType === 'portable', 'DebugType was not parsed.');
    assert(metadata.buildSettings.produceReferenceAssembly === 'true', 'ProduceReferenceAssembly was not parsed.');
    assert(metadata.buildSettings.emitCompilerGeneratedFiles === 'true', 'EmitCompilerGeneratedFiles was not parsed.');
    assert(metadata.buildSettings.compilerGeneratedFilesOutputPath === 'generated', 'CompilerGeneratedFilesOutputPath was not parsed.');
    assert(metadata.buildSettings.checkForOverflowUnderflow === 'true', 'CheckForOverflowUnderflow was not parsed.');
    assert(metadata.buildSettings.treatWarningsAsErrors === 'true', 'TreatWarningsAsErrors was not parsed.');
    assert(metadata.buildSettings.warningsAsErrors === 'CS1591', 'WarningsAsErrors was not parsed.');
    assert(metadata.buildSettings.noWarn === 'CS0168', 'NoWarn was not parsed.');
    assert(metadata.buildSettings.warningLevel === '5', 'WarningLevel was not parsed.');
    assert(metadata.projectReferences[0].referenceOutputAssembly === 'false', 'ProjectReference metadata was not parsed.');
    assert(metadata.projectItems.content[0].copyToOutputDirectory === 'PreserveNewest', 'Content item metadata was not parsed.');
    assert(metadata.projectItems.content[0].copyToPublishDirectory === 'Always', 'Content publish metadata was not parsed.');
    assert(metadata.projectItems.content[1].groupCondition === "'$(Configuration)'=='ResourceDebug'", 'Content item group condition was not parsed.');
    assert(metadata.projectItems.content[1].itemCondition === undefined, 'Group-conditioned content item should not have item condition.');
    assert(metadata.projectItems.none[0].identityAttribute === 'Update', 'None item identity attribute was not parsed.');
    assert(metadata.projectItems.embeddedResources[0].logicalName === 'Kivi.Resources', 'EmbeddedResource metadata was not parsed.');
    assert(metadata.projectItems.additionalFiles[0].name === 'stylecop.json', 'AdditionalFiles item was not parsed.');
    assert(metadata.imports.some((item) => item.name === 'Directory.Build.props'), 'Explicit imports were not parsed.');
    assert(metadata.targets.length === 1, 'MSBuild targets were not parsed.');
    assert(metadata.targets[0].name === 'GenerateClient', 'MSBuild target name was not parsed.');
    assert(metadata.targets[0].beforeTargets === 'BeforeBuild', 'MSBuild target BeforeTargets was not parsed.');
    assert(metadata.targets[0].dependsOnTargets === 'Restore', 'MSBuild target DependsOnTargets was not parsed.');
    assert(metadata.targets[0].tasks.some((task) => task.name === 'Message'), 'MSBuild target Message task was not parsed.');
    assert(metadata.targets[0].tasks.some((task) => task.name === 'Exec'), 'MSBuild target Exec task was not parsed.');

    const enrichedImports = await enrichImportsWithImplicitDirectoryBuildFiles(
      { fsPath: path.join('/tmp', 'src', 'App', 'App.csproj') },
      [
        {
          name: 'Sdk.props',
          source: 'Microsoft.NET.Sdk',
          implicit: true,
          kind: 'sdk'
        },
        {
          name: 'Sdk.targets',
          source: 'Microsoft.NET.Sdk',
          implicit: true,
          kind: 'sdk'
        }
      ]
    );
    assert(enrichedImports.some((item) => item.name === 'Directory.Build.props' && item.implicit === true && item.kind === 'directory-build-props'), 'Implicit Directory.Build.props import was not discovered.');
    assert(enrichedImports.some((item) => item.name === 'Directory.Build.targets' && item.implicit === true && item.kind === 'directory-build-targets'), 'Implicit Directory.Build.targets import was not discovered.');
    assert(enrichedImports.find((item) => item.name === 'Directory.Build.props')?.propertyCount === 1, 'Directory.Build.props properties were not summarized.');
    assert(enrichedImports.find((item) => item.name === 'Directory.Build.targets')?.targetCount === 1, 'Directory.Build.targets targets were not summarized.');
    assert(enrichedImports.find((item) => item.name === 'Directory.Build.targets')?.taskCount === 1, 'Directory.Build.targets tasks were not summarized.');
    assert(enrichedImports[enrichedImports.length - 1].name === 'Sdk.targets', 'Implicit Directory.Build imports should appear before Sdk.targets.');

    const msbuildSummary = readMsBuildFileSummaryFromText([
      '<Project>',
      '<PropertyGroup>',
      '<AnalysisLevel>latest</AnalysisLevel>',
      '</PropertyGroup>',
      '<Target Name="Prepare" BeforeTargets="Build">',
      '<Message Text="prepare" />',
      '</Target>',
      '</Project>'
    ].join(''));
    assert(msbuildSummary.properties[0].name === 'AnalysisLevel', 'MSBuild summary properties were not parsed.');
    assert(msbuildSummary.targets[0].name === 'Prepare', 'MSBuild summary targets were not parsed.');
    assert(msbuildSummary.targets[0].tasks[0].name === 'Message', 'MSBuild summary target tasks were not parsed.');

    const centralPackageVersions = readCentralPackageVersionsFromText([
      '<Project>',
      '<ItemGroup>',
      '<PackageVersion Include="Central.Package" Version="9.1.0" />',
      '<PackageVersion Include="Conditional.Central" Version="2.0.0" Condition="\'$(TargetFramework)\'==\'net10.0\'" />',
      '</ItemGroup>',
      '</Project>'
    ].join(''), path.join('/tmp', 'src', 'Directory.Packages.props'));
    const enrichedPackageReferences = enrichPackageReferencesWithCentralVersions(
      [
        {
          name: 'Central.Package',
          include: 'Central.Package'
        },
        {
          name: 'Explicit.Package',
          include: 'Explicit.Package',
          version: '1.0.0'
        }
      ],
      centralPackageVersions
    );
    assert(centralPackageVersions.length === 2, 'Central PackageVersion items were not parsed.');
    assert(centralPackageVersions[0].version === '9.1.0', 'Central PackageVersion version was not parsed.');
    assert(enrichedPackageReferences[0].version === '9.1.0', 'PackageReference did not inherit central package version.');
    assert(enrichedPackageReferences[0].centralVersion === '9.1.0', 'PackageReference centralVersion was not set.');
    assert(enrichedPackageReferences[0].versionSource === 'Directory.Packages.props', 'PackageReference version source was not central package management.');
    assert(enrichedPackageReferences[0].versionSourcePath.endsWith('Directory.Packages.props'), 'PackageReference central version source path was not set.');
    assert(enrichedPackageReferences[1].version === '1.0.0', 'Explicit PackageReference version was overwritten.');
    assert(enrichedPackageReferences[1].versionSource === 'PackageReference', 'Explicit PackageReference version source was not set.');

    const nugetConfig = readNuGetConfigFromText([
      '<configuration>',
      '<packageSources>',
      '<add key="nuget.org" value="https://api.nuget.org/v3/index.json" protocolVersion="3" />',
      '<add key="internal" value="https://nuget.example/v3/index.json" />',
      '</packageSources>',
      '<disabledPackageSources>',
      '<add key="internal" value="true" />',
      '</disabledPackageSources>',
      '<packageSourceMapping>',
      '<packageSource key="nuget.org">',
      '<package pattern="Newtonsoft.*" />',
      '<package pattern="System.*" />',
      '</packageSource>',
      '<packageSource key="internal">',
      '<package pattern="Kivi.*" />',
      '</packageSource>',
      '</packageSourceMapping>',
      '</configuration>'
    ].join(''), path.join('/tmp', 'src', 'NuGet.config'));
    assert(nugetConfig.fileName === 'NuGet.config', 'NuGet.config file name was not parsed.');
    assert(nugetConfig.packageSources.length === 2, 'NuGet package sources were not parsed.');
    assert(nugetConfig.packageSources[0].key === 'nuget.org', 'NuGet package source key was not parsed.');
    assert(nugetConfig.packageSources[0].protocolVersion === '3', 'NuGet package source protocol was not parsed.');
    assert(nugetConfig.packageSources[1].disabled === true, 'Disabled NuGet package source was not parsed.');
    assert(nugetConfig.packageSourceMappings.length === 2, 'NuGet package source mappings were not parsed.');
    assert(nugetConfig.packageSourceMappings[0].source === 'nuget.org', 'NuGet package source mapping key was not parsed.');
    assert(nugetConfig.packageSourceMappings[0].patterns.includes('Newtonsoft.*'), 'NuGet package source mapping pattern was not parsed.');

    const mappedPackages = enrichPackagesWithPackageSourceMappings([
      {
        name: 'Newtonsoft.Json',
        version: '13.0.3'
      },
      {
        name: 'Kivi.Client',
        version: '1.0.0'
      }
    ], nugetConfig);
    assert(mappedPackages[0].packageSourceMappings[0].source === 'nuget.org', 'Package source mapping was not applied to package references.');
    assert(mappedPackages[0].packageSourceMappingPatterns.includes('Newtonsoft.*'), 'Package source mapping patterns were not retained.');
    assert(mappedPackages[1].packageSourceMappings[0].source === 'internal', 'Internal package source mapping was not matched.');

    const mappedResolvedDependencies = enrichResolvedDependenciesWithPackageSourceMappings({
      'net10.0': {
        packages: [
          {
            name: 'System.Text.Json',
            version: '10.0.0'
          }
        ]
      }
    }, nugetConfig);
    assert(mappedResolvedDependencies['net10.0'].packages[0].packageSourceMappings[0].source === 'nuget.org', 'Package source mapping was not applied to resolved dependencies.');

    const packageLock = readPackageLockFileFromText(JSON.stringify({
      version: 1,
      dependencies: {
        'net10.0': {
          'Newtonsoft.Json': {
            type: 'Direct',
            requested: '[13.0.3, )',
            resolved: '13.0.3',
            contentHash: 'abc',
            dependencies: {
              'System.Runtime': '10.0.0'
            }
          },
          'System.Runtime': {
            type: 'Transitive',
            resolved: '10.0.0',
            contentHash: 'def'
          }
        }
      }
    }), path.join('/tmp', 'src', 'App', 'packages.lock.json'));
    assert(packageLock.exists === true, 'Package lock file existence was not marked.');
    assert(packageLock.version === '1', 'Package lock file version was not parsed.');
    assert(packageLock.targetFrameworks[0] === 'net10.0', 'Package lock target framework was not parsed.');
    assert(packageLock.packages.length === 2, 'Package lock packages were not parsed.');
    assert(packageLock.directCount === 1, 'Package lock direct count was not parsed.');
    assert(packageLock.transitiveCount === 1, 'Package lock transitive count was not parsed.');
    assert(packageLock.packages[0].dependencies[0].versionRange === '10.0.0', 'Package lock dependency version range was not parsed.');

    const userSecretsPath = resolveUserSecretsPath('kivi-bank-api-client');
    const userSecrets = readUserSecretsFromText(JSON.stringify({
      ConnectionStrings: {
        Default: 'Server=localhost'
      },
      ApiKey: 'secret'
    }), userSecretsPath, 'kivi-bank-api-client');
    assert(userSecrets.path.endsWith(path.join('kivi-bank-api-client', 'secrets.json')), 'User secrets path was not resolved.');
    assert(userSecrets.exists === true, 'User secrets existence was not marked.');
    assert(userSecrets.keyCount === 2, 'User secrets key count was not parsed.');
    assert(userSecrets.keys.includes('ConnectionStrings:Default'), 'Nested user secrets key was not flattened.');
    assert(userSecrets.keys.includes('ApiKey'), 'Top-level user secrets key was not parsed.');

    const globalJson = readGlobalJsonFromText(JSON.stringify({
      sdk: {
        version: '10.0.100',
        rollForward: 'latestFeature',
        allowPrerelease: true,
        paths: ['.dotnet']
      },
      'msbuild-sdks': {
        'Microsoft.Build.NoTargets': '3.7.0'
      }
    }), path.join('/tmp', 'src', 'global.json'));
    assert(globalJson.fileName === 'global.json', 'global.json file name was not parsed.');
    assert(globalJson.sdk.version === '10.0.100', 'global.json SDK version was not parsed.');
    assert(globalJson.sdk.rollForward === 'latestFeature', 'global.json SDK rollForward was not parsed.');
    assert(globalJson.sdk.allowPrerelease === 'true', 'global.json SDK allowPrerelease was not parsed.');
    assert(globalJson.sdk.paths[0] === '.dotnet', 'global.json SDK paths were not parsed.');
    assert(globalJson.msbuildSdks['Microsoft.Build.NoTargets'] === '3.7.0', 'global.json msbuild-sdks were not parsed.');

    const publishProfile = readPublishProfileFromText([
      '<Project>',
      '<PropertyGroup>',
      '<WebPublishMethod>FileSystem</WebPublishMethod>',
      '<PublishProvider>FileSystem</PublishProvider>',
      '<LastUsedBuildConfiguration>Release</LastUsedBuildConfiguration>',
      '<LastUsedPlatform>Any CPU</LastUsedPlatform>',
      '<TargetFramework>net10.0</TargetFramework>',
      '<RuntimeIdentifier>linux-x64</RuntimeIdentifier>',
      '<SelfContained>true</SelfContained>',
      '<PublishUrl>bin/Release/net10.0/publish</PublishUrl>',
      '<DeleteExistingFiles>true</DeleteExistingFiles>',
      '<LaunchSiteAfterPublish>false</LaunchSiteAfterPublish>',
      '</PropertyGroup>',
      '</Project>'
    ].join(''), path.join('/tmp', 'src', 'App', 'Properties', 'PublishProfiles', 'FolderProfile.pubxml'));
    assert(publishProfile.name === 'FolderProfile', 'Publish profile name was not parsed.');
    assert(publishProfile.publishMethod === 'FileSystem', 'Publish profile method was not parsed.');
    assert(publishProfile.publishProvider === 'FileSystem', 'Publish profile provider was not parsed.');
    assert(publishProfile.lastUsedBuildConfiguration === 'Release', 'Publish profile configuration was not parsed.');
    assert(publishProfile.lastUsedPlatform === 'Any CPU', 'Publish profile platform was not parsed.');
    assert(publishProfile.targetFramework === 'net10.0', 'Publish profile target framework was not parsed.');
    assert(publishProfile.runtimeIdentifier === 'linux-x64', 'Publish profile runtime identifier was not parsed.');
    assert(publishProfile.selfContained === 'true', 'Publish profile self-contained flag was not parsed.');
    assert(publishProfile.publishUrl === 'bin/Release/net10.0/publish', 'Publish profile URL was not parsed.');
    assert(publishProfile.deleteExistingFiles === 'true', 'Publish profile delete existing files flag was not parsed.');
    assert(publishProfile.launchSiteAfterPublish === 'false', 'Publish profile launch flag was not parsed.');
  } finally {
    Module._load = originalLoad;
  }
}

function validateProjectPropertiesView() {
  const originalLoad = Module._load;

  Module._load = function loadWithVscodeMock(request, parent, isMain) {
    if (request === 'vscode') {
      return {
        Uri: {
          file: (value) => ({ fsPath: value })
        },
        workspace: {
          asRelativePath: (value) => String(value),
          fs: {}
        }
      };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const { __test } = require(runtimeModulePath('projectPropertiesView.js'));
    const projectConfigurations = [
      {
        configuration: 'Staging',
        platform: 'x64',
        condition: "'$(Configuration)|$(Platform)'=='Staging|x64'",
        properties: {
          DefineConstants: 'STAGING',
          RuntimeIdentifier: 'osx-x64'
        }
      }
    ];
    const configurations = __test.getDisplayConfigurations(projectConfigurations);
    const html = __test.getProjectPropertiesHtml(
      {
        name: 'Kivi.BankApiClient',
        path: path.join('/tmp', 'Kivi.BankApiClient', 'Kivi.BankApiClient.csproj'),
        fileName: 'Kivi.BankApiClient.csproj',
        relativePath: 'Kivi.BankApiClient/Kivi.BankApiClient.csproj'
      },
      {
        targetFrameworks: ['net10.0'],
        configurations: projectConfigurations,
        packageReferences: [
          {
            name: 'Newtonsoft.Json',
            include: 'Newtonsoft.Json',
            version: '13.0.3',
            versionOverride: '13.0.4',
            privateAssets: 'all',
            includeAssets: 'runtime; build',
            outputItemType: 'Analyzer',
            referenceOutputAssembly: 'false',
            generatePathProperty: 'true',
            aliases: 'global',
            noWarn: 'NU1605',
            packageSourceMappings: [
              {
                source: 'nuget.org',
                patterns: ['Newtonsoft.*']
              }
            ],
            packageSourceMappingSources: ['nuget.org'],
            packageSourceMappingPatterns: ['Newtonsoft.*'],
            packageAssetGroups: [
              {
                key: 'buildTransitive',
                label: 'Build Transitive Assets',
                assets: ['buildTransitive/Newtonsoft.Json.targets']
              }
            ],
            condition: "'$(TargetFramework)'=='net10.0'",
            itemCondition: "'$(TargetFramework)'=='net10.0'"
          },
          {
            name: 'DebugOnly.Package',
            include: 'DebugOnly.Package',
            version: '1.0.0',
            condition: "'$(Configuration)'=='ResourceDebug'",
            groupCondition: "'$(Configuration)'=='ResourceDebug'"
          },
          {
            name: 'Central.Package',
            include: 'Central.Package',
            version: '9.1.0',
            centralVersion: '9.1.0',
            versionSource: 'Directory.Packages.props',
            versionSourcePath: path.join('/tmp', 'Kivi.BankApiClient', 'Directory.Packages.props')
          }
        ],
        centralPackageVersions: [
          {
            name: 'Central.Package',
            include: 'Central.Package',
            version: '9.1.0',
            path: path.join('/tmp', 'Kivi.BankApiClient', 'Directory.Packages.props'),
            itemCondition: "'$(TargetFramework)'=='net10.0'"
          }
        ],
        nugetConfig: {
          path: path.join('/tmp', 'Kivi.BankApiClient', 'NuGet.config'),
          fileName: 'NuGet.config',
          packageSources: [
            {
              key: 'nuget.org',
              value: 'https://api.nuget.org/v3/index.json',
              protocolVersion: '3',
              disabled: false
            },
            {
              key: 'internal',
              value: 'https://nuget.example/v3/index.json',
              disabled: true
            }
          ],
          packageSourceMappings: [
            {
              source: 'nuget.org',
              patterns: ['Newtonsoft.*', 'System.*']
            },
            {
              source: 'internal',
              patterns: ['Kivi.*']
            }
          ]
        },
        globalJson: {
          path: path.join('/tmp', 'global.json'),
          fileName: 'global.json',
          sdk: {
            version: '10.0.100',
            rollForward: 'latestFeature',
            allowPrerelease: 'true',
            paths: ['.dotnet']
          },
          msbuildSdks: {
            'Microsoft.Build.NoTargets': '3.7.0'
          }
        },
        userSecrets: {
          id: 'kivi-bank-api-client',
          path: path.join('/tmp', '.microsoft', 'usersecrets', 'kivi-bank-api-client', 'secrets.json'),
          fileName: 'secrets.json',
          exists: true,
          keys: ['ApiKey', 'ConnectionStrings:Default'],
          keyCount: 2
        },
        packageLock: {
          path: path.join('/tmp', 'Kivi.BankApiClient', 'packages.lock.json'),
          fileName: 'packages.lock.json',
          exists: true,
          version: '1',
          targetFrameworks: ['net10.0'],
          directCount: 1,
          transitiveCount: 1,
          packages: [
            {
              targetFramework: 'net10.0',
              name: 'Newtonsoft.Json',
              type: 'Direct',
              requested: '[13.0.3, )',
              resolved: '13.0.3',
              contentHash: 'abc',
              dependencies: [
                {
                  name: 'System.Runtime',
                  versionRange: '10.0.0'
                }
              ]
            },
            {
              targetFramework: 'net10.0',
              name: 'System.Runtime',
              type: 'Transitive',
              resolved: '10.0.0',
              contentHash: 'def',
              dependencies: []
            }
          ]
        },
        package: {
          repositoryBranch: 'main',
          repositoryCommit: 'abc123',
          publishRepositoryUrl: 'true',
          licenseUrl: 'https://licenses.example/kivi',
          iconUrl: 'https://cdn.example/icon.png',
          includeBuildOutput: 'true',
          includeContentInPack: 'false',
          contentTargetFolders: 'content;contentFiles',
          developmentDependency: 'false',
          serviceable: 'true',
          embedUntrackedSources: 'true',
          minClientVersion: '6.0.0',
          packageType: 'Dependency',
          packageValidationBaselineVersion: '1.0.0',
          packageValidationBaselineName: 'Kivi.Client'
        },
        projectReferences: [
          {
            name: 'Kivi.Core',
            include: '../Core/Core.csproj',
            referenceOutputAssembly: 'false',
            privateAssets: 'all',
            itemCondition: "'$(TargetFramework)'=='net10.0'",
            groupCondition: "'$(Configuration)'=='Debug'"
          }
        ],
        analyzerReferences: [
          {
            name: 'analyzers/Generator.dll',
            include: 'analyzers/Generator.dll',
            hintPath: 'analyzers/Generator.dll',
            privateAssets: 'all',
            includeAssets: 'runtime; build',
            excludeAssets: 'native',
            aliases: 'global',
            condition: "'$(Configuration)'=='Debug'",
            groupCondition: "'$(Configuration)'=='Debug'"
          }
        ],
        assemblyReferences: [
          {
            name: 'Legacy.Client',
            include: 'Legacy.Client',
            hintPath: 'lib/Legacy.Client.dll',
            itemCondition: "'$(TargetFramework)'=='net10.0'",
            groupCondition: "'$(Configuration)'=='Release'"
          }
        ],
        frameworkReferences: [
          {
            name: 'Microsoft.AspNetCore.App',
            include: 'Microsoft.AspNetCore.App',
            privateAssets: 'all',
            includeAssets: 'runtime; build',
            excludeAssets: 'native',
            itemCondition: "'$(TargetFramework)'=='net10.0'"
          }
        ],
        sourceGenerators: [
          {
            name: 'Kivi.SourceGenerator',
            include: 'Kivi.SourceGenerator',
            version: '1.0.0',
            source: 'package',
            versionOverride: '1.0.1',
            privateAssets: 'all',
            includeAssets: 'runtime; build',
            excludeAssets: 'compile',
            outputItemType: 'Analyzer',
            referenceOutputAssembly: 'false',
            generatePathProperty: 'true',
            aliases: 'global',
            noWarn: 'NU1605',
            itemCondition: "'$(TargetFramework)'=='net10.0'",
            groupCondition: "'$(Configuration)'=='Release'"
          },
          {
            name: 'analyzers/Generator.dll',
            include: 'analyzers/Generator.dll',
            source: 'analyzer',
            path: path.join('/tmp', 'Kivi.BankApiClient', 'analyzers', 'Generator.dll')
          }
        ],
        projectItems: {
          compile: [
            {
              name: 'Generated/Client.g.cs',
              include: 'Generated/Client.g.cs',
              identity: 'Generated/Client.g.cs',
              identityAttribute: 'Include',
              path: path.join('/tmp', 'Kivi.BankApiClient', 'Generated', 'Client.g.cs')
            }
          ],
          content: [
            {
              name: 'appsettings.json',
              include: 'appsettings.json',
              identity: 'appsettings.json',
              identityAttribute: 'Include',
              copyToOutputDirectory: 'PreserveNewest',
              copyToPublishDirectory: 'Always',
              groupCondition: "'$(Configuration)'=='ResourceDebug'",
              path: path.join('/tmp', 'Kivi.BankApiClient', 'appsettings.json')
            }
          ],
          none: [
            {
              name: 'README.md',
              update: 'README.md',
              identity: 'README.md',
              identityAttribute: 'Update',
              copyToOutputDirectory: 'Never',
              path: path.join('/tmp', 'Kivi.BankApiClient', 'README.md')
            }
          ],
          embeddedResources: [
            {
              name: 'Resources.resx',
              include: 'Resources.resx',
              identity: 'Resources.resx',
              identityAttribute: 'Include',
              logicalName: 'Kivi.Resources',
              path: path.join('/tmp', 'Kivi.BankApiClient', 'Resources.resx')
            }
          ],
          additionalFiles: [
            {
              name: 'stylecop.json',
              include: 'stylecop.json',
              identity: 'stylecop.json',
              identityAttribute: 'Include',
              path: path.join('/tmp', 'Kivi.BankApiClient', 'stylecop.json')
            }
          ]
        },
        imports: [
          {
            name: 'Directory.Build.props',
            source: 'Directory.Build.props',
            path: path.join('/tmp', 'Directory.Build.props'),
            implicit: false,
            kind: 'explicit',
            propertyCount: 1,
            targetCount: 0,
            taskCount: 0,
            properties: [
              {
                name: 'ManagePackageVersionsCentrally',
                value: 'true'
              }
            ],
            targets: []
          },
          {
            name: 'Directory.Build.targets',
            source: '../Directory.Build.targets',
            path: path.join('/tmp', 'Directory.Build.targets'),
            implicit: true,
            kind: 'directory-build-targets',
            propertyCount: 0,
            targetCount: 1,
            taskCount: 1,
            properties: [],
            targets: [
              {
                name: 'AfterCommonBuild',
                afterTargets: 'Build',
                tasks: [
                  {
                    name: 'Message'
                  }
                ]
              }
            ]
          },
          {
            name: 'Sdk.props',
            source: 'Microsoft.NET.Sdk',
            implicit: true,
            kind: 'sdk'
          }
        ],
        properties: [
          {
            name: 'TargetFramework',
            value: 'net10.0'
          },
          {
            name: 'DefineConstants',
            value: 'DEBUG;TRACE',
            groupCondition: "'$(Configuration)|$(Platform)'=='Debug|AnyCPU'"
          }
        ],
        buildSettings: {
          treatWarningsAsErrors: 'true',
          warningsAsErrors: 'CS1591',
          noWarn: 'CS0168',
          warningLevel: '5',
          userSecretsId: 'kivi-bank-api-client',
          targetFrameworkIdentifier: '.NETCoreApp',
          targetFrameworkVersion: 'v10.0',
          targetFrameworkProfile: 'Profile7',
          targetPlatformIdentifier: 'ios',
          targetPlatformVersion: '18.0',
          targetPlatformMinVersion: '17.0',
          supportedOSPlatformVersion: '17.0',
          restorePackagesWithLockFile: 'true',
          restoreLockedMode: 'true',
          nuGetLockFilePath: 'packages.lock.json',
          restoreUseStaticGraphEvaluation: 'true',
          runtimeIdentifier: 'osx-arm64',
          runtimeIdentifiers: 'osx-arm64;linux-x64',
          runtimeFrameworkVersion: '10.0.0',
          rollForward: 'LatestMinor',
          selfContained: 'true',
          useAppHost: 'true',
          targetLatestRuntimePatch: 'true',
          invariantGlobalization: 'false',
          publishDir: 'artifacts/publish',
          publishUrl: 'artifacts/webdeploy',
          publishSingleFile: 'true',
          publishTrimmed: 'true',
          publishReadyToRun: 'true',
          publishAot: 'false',
          includeNativeLibrariesForSelfExtract: 'true',
          enableCompressionInSingleFile: 'true',
          debugSymbols: 'true',
          debugType: 'portable'
        },
        publishProfiles: [
          {
            name: 'FolderProfile',
            fileName: 'FolderProfile.pubxml',
            path: path.join('/tmp', 'Kivi.BankApiClient', 'Properties', 'PublishProfiles', 'FolderProfile.pubxml'),
            publishMethod: 'FileSystem',
            publishProvider: 'FileSystem',
            publishUrl: 'artifacts/publish/folder',
            targetFramework: 'net10.0',
            runtimeIdentifier: 'linux-x64',
            lastUsedBuildConfiguration: 'Release'
          }
        ],
        launchSettings: {
          path: path.join('/tmp', 'Properties', 'launchSettings.json'),
          exists: true,
          profiles: [
            {
              name: 'Kivi.Local',
              commandName: 'Project',
              executablePath: '',
              commandLineArgs: '--local',
              workingDirectory: '',
              launchBrowser: 'false',
              launchUrl: '',
              applicationUrl: 'http://localhost:5050',
              environmentVariables: {
                ASPNETCORE_ENVIRONMENT: 'Local'
              }
            }
          ]
        },
        buildEvents: {
          preBuildEvent: 'echo pre',
          postBuildEvent: 'echo post',
          runPostBuildEvent: 'OnBuildSuccess'
        },
        targets: [
          {
            name: 'GenerateClient',
            beforeTargets: 'BeforeBuild',
            dependsOnTargets: 'Restore',
            condition: "'$(Configuration)'=='Debug'",
            tasks: [
              {
                name: 'Message'
              },
              {
                name: 'Exec'
              }
            ],
            body: '<Message Text="Generating client" Importance="High" />\n<Exec Command="dotnet tool run generate-client" />'
          }
        ],
        signing: {
          signAssembly: 'true',
          keyFile: 'key.snk',
          delaySign: 'false',
          publicSign: 'false'
        }
      },
      'nonce'
    );

    assert(configurations.some((item) => item.label === 'Staging | x64'), 'Custom configuration was not exposed to the properties view.');
    assert(configurations.some((item) => item.label === 'Debug | AnyCPU'), 'Debug fallback configuration was not exposed.');
    assert(configurations.some((item) => item.label === 'Release | AnyCPU'), 'Release fallback configuration was not exposed.');
    assert(html.includes('Staging | x64'), 'Custom configuration tab was not rendered.');
    assert(html.includes('data-action="addConfiguration"'), 'Add Configuration action was not rendered.');
    assert(html.includes('data-action="removeConfiguration"'), 'Remove Configuration action was not rendered.');
    assert(html.includes('Runtime identifier:'), 'RuntimeIdentifier editor was not rendered.');
    assert(html.includes('data-config-prop="RuntimeIdentifier"'), 'RuntimeIdentifier editor was not writable.');
    assert(html.includes('data-config-prop="SelfContained"'), 'SelfContained editor was not writable.');
    assert(html.includes('data-action="browseConfigurationProperty"'), 'Browse Configuration Property action was not rendered.');
    assert(html.includes('data-prop="TreatWarningsAsErrors"'), 'TreatWarningsAsErrors editor was not rendered.');
    assert(html.includes('data-prop="WarningsAsErrors"'), 'WarningsAsErrors editor was not rendered.');
    assert(html.includes('data-prop="NoWarn"'), 'NoWarn editor was not rendered.');
    assert(html.includes('data-prop="WarningLevel"'), 'WarningLevel editor was not rendered.');
    assert(html.includes('data-prop="DebugSymbols"'), 'DebugSymbols editor was not rendered.');
    assert(html.includes('data-prop="DebugType"'), 'DebugType editor was not rendered.');
    assert(html.includes('<option value="portable" selected>portable</option>'), 'DebugType value was not rendered.');
    assert(html.includes('data-pane="publish"'), 'Publish tab was not rendered.');
    assert(html.includes('FolderProfile'), 'Publish profile was not rendered.');
    assert(html.includes('FileSystem'), 'Publish profile method was not rendered.');
    assert(html.includes('artifacts/publish/folder'), 'Publish profile output path was not rendered.');
    assert(html.includes('data-action="publishWithProfile"'), 'Publish With Profile action was not rendered.');
    assert(html.includes('data-action="openPublishProfile"'), 'Open Publish Profile action was not rendered.');
    assert(html.includes('data-action="copyPublishProfilePath"'), 'Copy Publish Profile Path action was not rendered.');
    assert(html.includes('data-action="copyPublishProfileXml"'), 'Copy Publish Profile XML action was not rendered.');
    assert(html.includes('data-prop="RuntimeIdentifier"'), 'RuntimeIdentifier publish editor was not rendered.');
    assert(html.includes('data-prop="RuntimeIdentifiers"'), 'RuntimeIdentifiers publish editor was not rendered.');
    assert(html.includes('data-prop="RuntimeFrameworkVersion"'), 'RuntimeFrameworkVersion publish editor was not rendered.');
    assert(html.includes('data-prop="RollForward"'), 'RollForward publish editor was not rendered.');
    assert(html.includes('data-prop="SelfContained"'), 'SelfContained publish editor was not rendered.');
    assert(html.includes('data-prop="UseAppHost"'), 'UseAppHost publish editor was not rendered.');
    assert(html.includes('data-prop="TargetLatestRuntimePatch"'), 'TargetLatestRuntimePatch publish editor was not rendered.');
    assert(html.includes('data-prop="InvariantGlobalization"'), 'InvariantGlobalization publish editor was not rendered.');
    assert(html.includes('data-prop="PublishDir"'), 'PublishDir editor was not rendered.');
    assert(html.includes('data-prop="PublishUrl"'), 'PublishUrl editor was not rendered.');
    assert(html.includes('data-prop="PublishSingleFile"'), 'PublishSingleFile editor was not rendered.');
    assert(html.includes('data-prop="PublishTrimmed"'), 'PublishTrimmed editor was not rendered.');
    assert(html.includes('data-prop="PublishReadyToRun"'), 'PublishReadyToRun editor was not rendered.');
    assert(html.includes('data-prop="PublishAot"'), 'PublishAot editor was not rendered.');
    assert(html.includes('data-prop="IncludeNativeLibrariesForSelfExtract"'), 'IncludeNativeLibrariesForSelfExtract editor was not rendered.');
    assert(html.includes('data-prop="EnableCompressionInSingleFile"'), 'EnableCompressionInSingleFile editor was not rendered.');
    assert(html.includes('data-action="packageDetails"'), 'Package Details action was not rendered.');
    assert(html.includes('data-action="openPackageFolder"'), 'Open Package Folder action was not rendered.');
    assert(html.includes('data-action="copyPackageFolder"'), 'Copy Package Folder action was not rendered.');
    assert(html.includes('data-action="updatePackage"'), 'Update Package action was not rendered.');
    assert(html.includes('data-action="copyPackageMetadataXml"'), 'Copy Package Metadata XML action was not rendered.');
    assert(html.includes('Central Package Versions'), 'Central Package Versions section was not rendered.');
    assert(html.includes('data-action="openCentralPackageFile"'), 'Open Central Package File action was not rendered.');
    assert(html.includes('data-action="copyCentralPackagePath"'), 'Copy Central Package Path action was not rendered.');
    assert(html.includes('data-action="copyCentralPackageVersionXml"'), 'Copy Central PackageVersion XML action was not rendered.');
    assert(html.includes('&quot;path&quot;:&quot;/tmp/Kivi.BankApiClient/Directory.Packages.props&quot;'), 'Central package action payload did not include source path.');
    assert(html.includes('NuGet Config'), 'NuGet Config section was not rendered.');
    assert(html.includes('/tmp/Kivi.BankApiClient/NuGet.config'), 'NuGet.config path was not rendered.');
    assert(html.includes('https://api.nuget.org/v3/index.json'), 'NuGet package source URL was not rendered.');
    assert(html.includes('Disabled'), 'Disabled NuGet package source status was not rendered.');
    assert(html.includes('data-action="openNuGetConfig"'), 'Open NuGet.config action was not rendered.');
    assert(html.includes('data-action="copyNuGetConfigPath"'), 'Copy NuGet.config Path action was not rendered.');
    assert(html.includes('data-action="copyNuGetConfigXml"'), 'Copy NuGet.config XML action was not rendered.');
    assert(html.includes('data-action="copyNuGetPackageSource"'), 'Copy NuGet Package Source action was not rendered.');
    assert(html.includes('Mapped Source'), 'NuGet package source mapping table was not rendered.');
    assert(html.includes('Newtonsoft.*'), 'NuGet package source mapping pattern was not rendered.');
    assert(html.includes('data-action="copyNuGetPackageSourceMappingXml"'), 'Copy NuGet package source mapping XML action was not rendered.');
    assert(html.includes('Target Platform'), 'Target Platform section was not rendered.');
    assert(html.includes('data-prop="TargetFrameworkIdentifier"'), 'TargetFrameworkIdentifier editor was not rendered.');
    assert(html.includes('data-prop="TargetFrameworkVersion"'), 'TargetFrameworkVersion editor was not rendered.');
    assert(html.includes('data-prop="TargetFrameworkProfile"'), 'TargetFrameworkProfile editor was not rendered.');
    assert(html.includes('data-prop="TargetPlatformIdentifier"'), 'TargetPlatformIdentifier editor was not rendered.');
    assert(html.includes('data-prop="TargetPlatformVersion"'), 'TargetPlatformVersion editor was not rendered.');
    assert(html.includes('data-prop="TargetPlatformMinVersion"'), 'TargetPlatformMinVersion editor was not rendered.');
    assert(html.includes('data-prop="SupportedOSPlatformVersion"'), 'SupportedOSPlatformVersion editor was not rendered.');
    assert(html.includes('value="ios"'), 'TargetPlatformIdentifier value was not rendered.');
    assert(html.includes('value="18.0"'), 'TargetPlatformVersion value was not rendered.');
    assert(html.includes('User Secrets'), 'User Secrets section was not rendered.');
    assert(html.includes('data-prop="UserSecretsId"'), 'UserSecretsId editor was not rendered.');
    assert(html.includes('kivi-bank-api-client'), 'UserSecretsId value was not rendered.');
    assert(html.includes('ConnectionStrings:Default'), 'User secrets key names were not rendered.');
    assert(html.includes('data-action="openUserSecrets"'), 'Open User Secrets action was not rendered.');
    assert(html.includes('data-action="copyUserSecretsPath"'), 'Copy User Secrets Path action was not rendered.');
    assert(html.includes('data-action="copyUserSecretsJson"'), 'Copy User Secrets JSON action was not rendered.');
    assert(html.includes('Restore Lock'), 'Restore Lock section was not rendered.');
    assert(html.includes('data-prop="RestorePackagesWithLockFile"'), 'RestorePackagesWithLockFile editor was not rendered.');
    assert(html.includes('data-prop="RestoreLockedMode"'), 'RestoreLockedMode editor was not rendered.');
    assert(html.includes('data-prop="RestoreUseStaticGraphEvaluation"'), 'RestoreUseStaticGraphEvaluation editor was not rendered.');
    assert(html.includes('data-prop="NuGetLockFilePath"'), 'NuGetLockFilePath editor was not rendered.');
    assert(html.includes('/tmp/Kivi.BankApiClient/packages.lock.json'), 'packages.lock.json path was not rendered.');
    assert(html.includes('data-action="openPackageLockFile"'), 'Open Package Lock File action was not rendered.');
    assert(html.includes('data-action="copyPackageLockPath"'), 'Copy Package Lock Path action was not rendered.');
    assert(html.includes('data-action="copyPackageLockJson"'), 'Copy Package Lock JSON action was not rendered.');
    assert(html.includes('Content Hash'), 'Package lock table was not rendered.');
    assert(html.includes('[13.0.3, )'), 'Package lock requested range was not rendered.');
    assert(html.includes('SDK Selection'), 'SDK Selection section was not rendered.');
    assert(html.includes('/tmp/global.json'), 'global.json path was not rendered.');
    assert(html.includes('10.0.100'), 'global.json SDK version was not rendered.');
    assert(html.includes('latestFeature'), 'global.json SDK rollForward was not rendered.');
    assert(html.includes('Microsoft.Build.NoTargets 3.7.0'), 'global.json msbuild-sdks were not rendered.');
    assert(html.includes('data-action="openGlobalJson"'), 'Open global.json action was not rendered.');
    assert(html.includes('data-action="copyGlobalJsonPath"'), 'Copy global.json Path action was not rendered.');
    assert(html.includes('data-action="copyGlobalJsonJson"'), 'Copy global.json JSON action was not rendered.');
    assert(html.includes('data-prop="RepositoryBranch"'), 'RepositoryBranch editor was not rendered.');
    assert(html.includes('data-prop="RepositoryCommit"'), 'RepositoryCommit editor was not rendered.');
    assert(html.includes('data-prop="PublishRepositoryUrl"'), 'PublishRepositoryUrl editor was not rendered.');
    assert(html.includes('data-prop="PackageLicenseUrl"'), 'PackageLicenseUrl editor was not rendered.');
    assert(html.includes('data-prop="PackageIconUrl"'), 'PackageIconUrl editor was not rendered.');
    assert(html.includes('data-prop="IncludeBuildOutput"'), 'IncludeBuildOutput editor was not rendered.');
    assert(html.includes('data-prop="IncludeContentInPack"'), 'IncludeContentInPack editor was not rendered.');
    assert(html.includes('data-prop="ContentTargetFolders"'), 'ContentTargetFolders editor was not rendered.');
    assert(html.includes('data-prop="DevelopmentDependency"'), 'DevelopmentDependency editor was not rendered.');
    assert(html.includes('data-prop="Serviceable"'), 'Serviceable editor was not rendered.');
    assert(html.includes('data-prop="EmbedUntrackedSources"'), 'EmbedUntrackedSources editor was not rendered.');
    assert(html.includes('data-prop="MinClientVersion"'), 'MinClientVersion editor was not rendered.');
    assert(html.includes('data-prop="PackageType"'), 'PackageType editor was not rendered.');
    assert(html.includes('data-prop="PackageValidationBaselineVersion"'), 'PackageValidationBaselineVersion editor was not rendered.');
    assert(html.includes('data-prop="PackageValidationBaselineName"'), 'PackageValidationBaselineName editor was not rendered.');
    assert(html.includes('value="content;contentFiles"'), 'ContentTargetFolders value was not rendered.');
    assert(html.includes('value="https://cdn.example/icon.png"'), 'PackageIconUrl value was not rendered.');
    assert(html.includes('data-package-prop="Version"'), 'PackageReference Version editor was not rendered.');
    assert(html.includes('Version Source'), 'PackageReference Version Source column was not rendered.');
    assert(html.includes('Directory.Packages.props'), 'Central package version source was not rendered.');
    assert(html.includes('Source Mapping'), 'PackageReference Source Mapping column was not rendered.');
    assert(html.includes('nuget.org: Newtonsoft.*'), 'Package source mapping value was not rendered.');
    assert(html.includes('&quot;versionSource&quot;:&quot;Directory.Packages.props&quot;'), 'PackageReference action payload did not include central version source.');
    assert(html.includes('&quot;centralVersion&quot;:&quot;9.1.0&quot;'), 'PackageReference action payload did not include central version.');
    assert(html.includes('&quot;packageSourceMappings&quot;'), 'PackageReference action payload did not include package source mappings.');
    assert(html.includes('&quot;packageAssetGroups&quot;'), 'PackageReference action payload did not include package asset groups.');
    assert(html.includes('data-package-prop="VersionOverride"'), 'PackageReference VersionOverride editor was not rendered.');
    assert(html.includes('data-package-prop="PrivateAssets"'), 'PackageReference PrivateAssets editor was not rendered.');
    assert(html.includes('data-package-prop="OutputItemType"'), 'PackageReference OutputItemType editor was not rendered.');
    assert(html.includes('data-package-prop="ReferenceOutputAssembly"'), 'PackageReference ReferenceOutputAssembly editor was not rendered.');
    assert(html.includes('data-package-prop="GeneratePathProperty"'), 'PackageReference GeneratePathProperty editor was not rendered.');
    assert(html.includes('data-package-prop="Aliases"'), 'PackageReference Aliases editor was not rendered.');
    assert(html.includes('data-package-prop="NoWarn"'), 'PackageReference NoWarn editor was not rendered.');
    assert(html.includes('data-package-prop="ExcludeAssets"'), 'PackageReference ExcludeAssets editor was not rendered.');
    assert(html.includes('data-package-prop="Condition"'), 'PackageReference Condition editor was not rendered.');
    assert(html.includes('&quot;generatePathProperty&quot;'), 'PackageReference action payload did not include GeneratePathProperty metadata.');
    assert(html.includes('&quot;outputItemType&quot;'), 'PackageReference action payload did not include OutputItemType metadata.');
    assert(html.includes('&quot;referenceOutputAssembly&quot;'), 'PackageReference action payload did not include ReferenceOutputAssembly metadata.');
    assert(html.includes('&quot;noWarn&quot;'), 'PackageReference action payload did not include NoWarn metadata.');
    assert(html.includes('&quot;groupCondition&quot;'), 'PackageReference action payload did not include group condition metadata.');
    assert(html.includes('data-package-group-condition'), 'PackageReference editor did not render group condition target metadata.');
    assert(html.includes('&quot;condition&quot;'), 'PackageReference action payload did not include Condition metadata.');
    assert(html.includes('ResourceDebug'), 'Group condition was not rendered.');
    assert(html.includes('data-reference-element="ProjectReference"'), 'ProjectReference metadata editor was not rendered.');
    assert(html.includes('data-reference-prop="ReferenceOutputAssembly"'), 'ProjectReference ReferenceOutputAssembly editor was not rendered.');
    assert(html.includes('data-action="openProjectReferenceFolder"'), 'Open Project Reference Folder action was not rendered.');
    assert(html.includes('data-action="copyProjectReferencePath"'), 'Copy Project Reference Path action was not rendered.');
    assert(html.includes('&quot;elementName&quot;:&quot;ProjectReference&quot;'), 'ProjectReference action payload did not include element name metadata.');
    assert(html.includes('&quot;itemCondition&quot;:&quot;&#39;$(TargetFramework)&#39;==&#39;net10.0&#39;&quot;'), 'Reference action payload did not include item condition metadata.');
    assert(html.includes('&quot;groupCondition&quot;:&quot;&#39;$(Configuration)&#39;==&#39;Debug&#39;&quot;'), 'Reference action payload did not include group condition metadata.');
    assert(html.includes('data-reference-group-condition="&#39;$(Configuration)&#39;==&#39;Debug&#39;"'), 'Reference metadata editor did not render group condition target metadata.');
    assert(html.includes('data-reference-element="Reference"'), 'Assembly reference metadata editor was not rendered.');
    assert(html.includes('data-reference-prop="HintPath"'), 'Assembly reference HintPath editor was not rendered.');
    assert(html.includes('&quot;elementName&quot;:&quot;Reference&quot;'), 'Assembly reference action payload did not include element name metadata.');
    assert(html.includes('data-reference-element="FrameworkReference"'), 'FrameworkReference metadata editor was not rendered.');
    assert(html.includes('data-reference-element="FrameworkReference" data-reference-include="Microsoft.AspNetCore.App" data-reference-group-condition="" data-reference-prop="PrivateAssets" value="all"'), 'FrameworkReference PrivateAssets editor was not rendered.');
    assert(html.includes('data-reference-element="FrameworkReference" data-reference-include="Microsoft.AspNetCore.App" data-reference-group-condition="" data-reference-prop="IncludeAssets" value="runtime; build"'), 'FrameworkReference IncludeAssets editor was not rendered.');
    assert(html.includes('data-reference-element="FrameworkReference" data-reference-include="Microsoft.AspNetCore.App" data-reference-group-condition="" data-reference-prop="ExcludeAssets" value="native"'), 'FrameworkReference ExcludeAssets editor was not rendered.');
    assert(html.includes('&quot;elementName&quot;:&quot;FrameworkReference&quot;'), 'FrameworkReference action payload did not include element name metadata.');
    assert(html.includes('data-reference-element="Analyzer"'), 'Analyzer metadata editor was not rendered.');
    assert(html.includes('data-reference-element="Analyzer" data-reference-include="analyzers/Generator.dll" data-reference-group-condition="&#39;$(Configuration)&#39;==&#39;Debug&#39;" data-reference-prop="HintPath" value="analyzers/Generator.dll"'), 'Analyzer HintPath editor was not rendered.');
    assert(html.includes('data-reference-element="Analyzer" data-reference-include="analyzers/Generator.dll" data-reference-group-condition="&#39;$(Configuration)&#39;==&#39;Debug&#39;" data-reference-prop="PrivateAssets" value="all"'), 'Analyzer PrivateAssets editor was not rendered.');
    assert(html.includes('data-reference-element="Analyzer" data-reference-include="analyzers/Generator.dll" data-reference-group-condition="&#39;$(Configuration)&#39;==&#39;Debug&#39;" data-reference-prop="Aliases" value="global"'), 'Analyzer Aliases editor was not rendered.');
    assert(html.includes('&quot;elementName&quot;:&quot;Analyzer&quot;'), 'Analyzer action payload did not include element name metadata.');
    assert(html.includes('data-action="addAssemblyReference"'), 'Add Assembly Reference action was not rendered.');
    assert(html.includes('data-action="openAssemblyReference"'), 'Open Assembly Reference action was not rendered.');
    assert(html.includes('data-action="copyAssemblyReferencePath"'), 'Copy Assembly Reference Path action was not rendered.');
    assert(html.includes('data-action="removeAssemblyReference"'), 'Remove Assembly Reference action was not rendered.');
    assert(html.includes('data-action="openAnalyzerReference"'), 'Open Analyzer Reference action was not rendered.');
    assert(html.includes('data-action="copyAnalyzerReferencePath"'), 'Copy Analyzer Reference Path action was not rendered.');
    assert(html.includes('data-action="openSourceGenerator"'), 'Open Source Generator action was not rendered.');
    assert(html.includes('data-action="copySourceGeneratorPath"'), 'Copy Source Generator Path action was not rendered.');
    assert(html.includes('data-action="copySourceGeneratorXml"'), 'Copy Source Generator XML action was not rendered.');
    assert(html.includes('&quot;versionOverride&quot;:&quot;1.0.1&quot;'), 'Source generator action payload did not include VersionOverride metadata.');
    assert(html.includes('&quot;outputItemType&quot;:&quot;Analyzer&quot;'), 'Source generator action payload did not include OutputItemType metadata.');
    assert(html.includes('&quot;referenceOutputAssembly&quot;:&quot;false&quot;'), 'Source generator action payload did not include ReferenceOutputAssembly metadata.');
    assert(html.includes('&quot;generatePathProperty&quot;:&quot;true&quot;'), 'Source generator action payload did not include GeneratePathProperty metadata.');
    assert(html.includes('&quot;groupCondition&quot;:&quot;&#39;$(Configuration)&#39;==&#39;Release&#39;&quot;'), 'Source generator action payload did not include group condition metadata.');
    assert(html.includes('data-action="openProjectFolder"'), 'Open Project Folder action was not rendered.');
    assert(html.includes('data-action="copyProjectPath"'), 'Copy Project Path action was not rendered.');
    assert(html.includes('data-action="copyAssemblyMetadataXml"'), 'Copy Assembly Metadata XML action was not rendered.');
    assert(html.includes('data-pane="resources"'), 'Resources tab was not rendered.');
    assert(html.includes('appsettings.json'), 'Content project item was not rendered.');
    assert(html.includes('Resources.resx'), 'Embedded resource item was not rendered.');
    assert(html.includes('data-action="addProjectItem"'), 'Add Project Item action was not rendered.');
    assert(html.includes('data-value="Content"'), 'Add Content action was not rendered.');
    assert(html.includes('data-value="EmbeddedResource"'), 'Add Embedded Resource action was not rendered.');
    assert(html.includes('data-action="openProjectItem"'), 'Open Project Item action was not rendered.');
    assert(html.includes('data-action="openProjectItemFolder"'), 'Open Project Item Folder action was not rendered.');
    assert(html.includes('data-action="copyProjectItemPath"'), 'Copy Project Item Path action was not rendered.');
    assert(html.includes('data-action="copyProjectItemXml"'), 'Copy Project Item XML action was not rendered.');
    assert(html.includes('data-action="removeProjectItem"'), 'Remove Project Item action was not rendered.');
    assert(html.includes('data-project-item-prop="CopyToOutputDirectory"'), 'Project item CopyToOutputDirectory editor was not rendered.');
    assert(html.includes('data-project-item-prop="CopyToPublishDirectory"'), 'Project item CopyToPublishDirectory editor was not rendered.');
    assert(html.includes('data-project-item-prop="LogicalName"'), 'Project item LogicalName editor was not rendered.');
    assert(html.includes('data-project-item-prop="Condition"'), 'Project item Condition editor was not rendered.');
    assert(html.includes('data-project-item-group-condition'), 'Project item editor did not render group condition target metadata.');
    assert(html.includes('data-project-item-identity-attribute="Update"'), 'Project item identity attribute was not rendered.');
    assert(html.includes('id="Company-assembly"'), 'Assembly Company editor was not rendered.');
    assert(html.includes('id="Product-assembly"'), 'Assembly Product editor was not rendered.');
    assert(html.includes('id="Description-assembly"'), 'Assembly Description editor was not rendered.');
    assert((html.match(/data-prop="Company"/g) || []).length >= 2, 'Shared Company editors were not rendered.');
    assert(html.includes('function syncPropertyControls'), 'Shared project property synchronization was not rendered.');
    assert(html.includes('data-action="removeFrameworkReference"'), 'Remove Framework Reference action was not rendered.');
    assert(html.includes('data-action="openImport"'), 'Open Import action was not rendered.');
    assert(html.includes('data-action="openImportFolder"'), 'Open Import Folder action was not rendered.');
    assert(html.includes('data-action="copyImportPath"'), 'Copy Import Path action was not rendered.');
    assert(html.includes('data-action="copyImportSummary"'), 'Copy Import Summary action was not rendered.');
    assert(html.includes('data-action="copyImportXml"'), 'Copy Import XML action was not rendered.');
    assert(html.includes('ManagePackageVersionsCentrally'), 'Imported Directory.Build property summary was not rendered in payload.');
    assert(html.includes('AfterCommonBuild'), 'Imported Directory.Build target summary was not rendered in payload.');
    assert(html.includes('>1</td>'), 'Import summary counts were not rendered.');
    assert(html.includes('&quot;name&quot;:&quot;Directory.Build.props&quot;'), 'Explicit import action payload did not include the import name.');
    assert(html.includes('&quot;path&quot;:&quot;/tmp/Directory.Build.props&quot;'), 'Explicit import action payload did not include the import path.');
    assert(html.includes('&quot;kind&quot;:&quot;directory-build-targets&quot;'), 'Implicit Directory.Build import action payload did not include directory build kind metadata.');
    assert(html.includes('&quot;path&quot;:&quot;/tmp/Directory.Build.targets&quot;'), 'Implicit Directory.Build import action payload did not include source path.');
    assert(html.includes('&quot;implicit&quot;:true'), 'Implicit import action payload did not include implicit metadata.');
    assert(html.includes('&quot;kind&quot;:&quot;sdk&quot;'), 'Implicit import action payload did not include import kind metadata.');
    assert(html.includes('data-action="openProjectFile"'), 'Open Project File action was not rendered.');
    assert(html.includes('data-action="copyAllDiagnosticPropertiesXml"'), 'Copy All Diagnostic Properties XML action was not rendered.');
    assert(html.includes('data-action="copyDiagnosticPropertyName"'), 'Copy Diagnostic Property Name action was not rendered.');
    assert(html.includes('data-action="copyDiagnosticPropertyValue"'), 'Copy Diagnostic Property Value action was not rendered.');
    assert(html.includes('data-action="copyDiagnosticPropertyXml"'), 'Copy Diagnostic Property XML action was not rendered.');
    assert(html.includes('data-action="duplicateLaunchProfile"'), 'Duplicate Launch Profile action was not rendered.');
    assert(html.includes('data-action="copyLaunchCommand"'), 'Copy Launch Command action was not rendered.');
    assert(html.includes('data-action="openLaunchTerminal"'), 'Open Launch Terminal action was not rendered.');
    assert(html.includes('data-action="browseLaunchExecutable"'), 'Browse Launch Executable action was not rendered.');
    assert(html.includes('data-action="browseLaunchWorkingDirectory"'), 'Browse Launch Working Directory action was not rendered.');
    assert(html.includes('data-action="browseProjectProperty"'), 'Browse Project Property action was not rendered.');
    assert(html.includes('data-action="copyBuildSettingsXml"'), 'Copy Build Settings XML action was not rendered.');
    assert(html.includes('data-action="copyPublishSettingsXml"'), 'Copy Publish Settings XML action was not rendered.');
    assert(html.includes('data-action="runBuildEvent"'), 'Run Build Event action was not rendered.');
    assert(html.includes('data-action="copyBuildEvent"'), 'Copy Build Event action was not rendered.');
    assert(html.includes('data-action="copyBuildEventsXml"'), 'Copy Build Events XML action was not rendered.');
    assert(html.includes('MSBuild Targets'), 'MSBuild Targets section was not rendered.');
    assert(html.includes('GenerateClient'), 'MSBuild target name was not rendered.');
    assert(html.includes('BeforeBuild'), 'MSBuild target BeforeTargets was not rendered.');
    assert(html.includes('Message, Exec'), 'MSBuild target tasks were not rendered.');
    assert(html.includes('data-action="copyTargetXml"'), 'Copy Target XML action was not rendered.');
    assert(html.includes('data-action="openSigningKeyFile"'), 'Open Signing Key File action was not rendered.');
    assert(html.includes('data-action="copySigningKeyPath"'), 'Copy Signing Key Path action was not rendered.');
    assert(html.includes('data-action="copySigningXml"'), 'Copy Signing XML action was not rendered.');
    assert(html.includes('data-value="ApplicationIcon"'), 'Application icon browse action was not rendered.');
    assert(html.includes('data-value="AssemblyOriginatorKeyFile"'), 'Signing key browse action was not rendered.');
    assert(html.includes('data-value="PackageReadmeFile"'), 'Package readme browse action was not rendered.');
    assert(html.includes('data-value="PackageOutputPath"'), 'Package output path browse action was not rendered.');
    assert(html.includes('data-value="PublishDir"'), 'Publish directory browse action was not rendered.');
    assert(html.includes('data-value="PublishUrl"'), 'Publish URL browse action was not rendered.');
    assert(html.includes('data-value="DocumentationFile"'), 'Documentation file browse action was not rendered.');
  } finally {
    Module._load = originalLoad;
  }
}

function validateProjectActions() {
  const originalLoad = Module._load;

  Module._load = function loadWithVscodeMock(request, parent, isMain) {
    if (request === 'vscode') {
      return {
        Uri: {
          file: (value) => ({ fsPath: value }),
          parse: (value) => ({ toString: () => value })
        },
        workspace: {
          asRelativePath: (value) => String(value),
          fs: {}
        },
        window: {},
        env: {},
        commands: {}
      };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const { __test } = require(runtimeModulePath('projectActions.js'));
    const metadata = {
      packageReferences: [
        {
          name: 'Conditional.Package',
          include: 'Conditional.Package',
          version: '1.0.0',
          itemCondition: "'$(TargetFramework)'=='net8.0'",
          groupCondition: "'$(Configuration)'=='Debug'"
        },
        {
          name: 'Conditional.Package',
          include: 'Conditional.Package',
          version: '2.0.0',
          privateAssets: 'all',
          outputItemType: 'Analyzer',
          referenceOutputAssembly: 'false',
          itemCondition: "'$(TargetFramework)'=='net10.0'",
          groupCondition: "'$(Configuration)'=='Release'"
        }
      ],
      resolvedDependencies: {}
    };
    const packageInfo = __test.getProjectPackageInfo(metadata, JSON.stringify({
      name: 'Conditional.Package',
      include: 'Conditional.Package',
      itemCondition: "'$(TargetFramework)'=='net10.0'",
      groupCondition: "'$(Configuration)'=='Release'"
    }));
    const updateMetadata = __test.createPackageReferenceMetadata(packageInfo, '2.1.0');
    const xml = __test.createPackageReferenceXml(packageInfo);

    assert(packageInfo.version === '2.0.0', 'Project package action lookup did not honor item/group condition payload.');
    assert(packageInfo.groupCondition === "'$(Configuration)'=='Release'", 'Project package action lookup lost group condition.');
    assert(updateMetadata.Version === '2.1.0', 'Project package update metadata did not use the requested version.');
    assert(updateMetadata.Condition === "'$(TargetFramework)'=='net10.0'", 'Project package update metadata did not preserve item condition.');
    assert(updateMetadata.OutputItemType === 'Analyzer', 'Project package update metadata did not preserve OutputItemType.');
    assert(updateMetadata.ReferenceOutputAssembly === 'false', 'Project package update metadata did not preserve ReferenceOutputAssembly.');
    assert(xml.includes('Condition="\'$(TargetFramework)\'==\'net10.0\'"'), 'Project package XML did not preserve item condition.');
    assert(xml.includes('OutputItemType="Analyzer"'), 'Project package XML did not preserve OutputItemType.');
    assert(xml.includes('ReferenceOutputAssembly="false"'), 'Project package XML did not preserve ReferenceOutputAssembly.');
    assert(!xml.includes('Release'), 'Project package XML incorrectly copied group condition into item XML.');
    assert(
      __test.createPackageReferenceXml({
        name: 'Central.Package',
        include: 'Central.Package',
        version: '9.1.0',
        centralVersion: '9.1.0',
        versionSource: 'Directory.Packages.props'
      }) === '<PackageReference Include="Central.Package" />',
      'Project properties central PackageReference XML should not duplicate Version metadata.'
    );
    assert(
      __test.createCentralPackageVersionXml({
        name: 'Central.Package',
        include: 'Central.Package',
        version: '9.1.0',
        itemCondition: "'$(TargetFramework)'=='net10.0'"
      }) === '<PackageVersion Include="Central.Package" Version="9.1.0" Condition="\'$(TargetFramework)\'==\'net10.0\'" />',
      'Central PackageVersion XML did not preserve version metadata.'
    );
    assert(
      __test.createNuGetPackageSourceMappingXml({
        source: 'nuget.org',
        patterns: ['Newtonsoft.*', 'System.*']
      }) === '<packageSource key="nuget.org">\n  <package pattern="Newtonsoft.*" />\n  <package pattern="System.*" />\n</packageSource>',
      'NuGet package source mapping XML did not preserve mapping metadata.'
    );

    const frameworkXml = __test.createProjectPropertiesReferenceXml('copyFrameworkReference', {
      include: 'Microsoft.AspNetCore.App',
      privateAssets: 'all',
      includeAssets: 'runtime; build',
      excludeAssets: 'native',
      itemCondition: "'$(TargetFramework)'=='net10.0'",
      groupCondition: "'$(Configuration)'=='Release'"
    });
    assert(
      frameworkXml === '<FrameworkReference Include="Microsoft.AspNetCore.App" PrivateAssets="all" IncludeAssets="runtime; build" ExcludeAssets="native" Condition="\'$(TargetFramework)\'==\'net10.0\'" />',
      'Project properties FrameworkReference XML did not preserve metadata.'
    );
    assert(!frameworkXml.includes('Release'), 'Project properties FrameworkReference XML copied group condition into item XML.');

    const analyzerXml = __test.createProjectPropertiesReferenceXml('copyAnalyzerReference', {
      include: 'analyzers/Generator.dll',
      hintPath: 'analyzers/Generator.dll',
      privateAssets: 'all',
      includeAssets: 'runtime; build',
      excludeAssets: 'native',
      aliases: 'global',
      itemCondition: "'$(TargetFramework)'=='net10.0'",
      groupCondition: "'$(Configuration)'=='Release'"
    });
    assert(
      analyzerXml === '<Analyzer Include="analyzers/Generator.dll" HintPath="analyzers/Generator.dll" PrivateAssets="all" IncludeAssets="runtime; build" ExcludeAssets="native" Aliases="global" Condition="\'$(TargetFramework)\'==\'net10.0\'" />',
      'Project properties Analyzer XML did not preserve metadata.'
    );
    assert(!analyzerXml.includes('Release'), 'Project properties Analyzer XML copied group condition into item XML.');

    const packageSourceGeneratorXml = __test.createSourceGeneratorXml({
      name: 'Kivi.SourceGenerator',
      version: '1.0.0',
      versionOverride: '1.0.1',
      privateAssets: 'all',
      includeAssets: 'runtime; build',
      excludeAssets: 'compile',
      outputItemType: 'Analyzer',
      referenceOutputAssembly: 'false',
      generatePathProperty: 'true',
      aliases: 'global',
      noWarn: 'NU1605',
      itemCondition: "'$(TargetFramework)'=='net10.0'",
      groupCondition: "'$(Configuration)'=='Release'",
      source: 'package'
    });
    assert(
      packageSourceGeneratorXml === '<PackageReference Include="Kivi.SourceGenerator" Version="1.0.0" VersionOverride="1.0.1" PrivateAssets="all" IncludeAssets="runtime; build" ExcludeAssets="compile" OutputItemType="Analyzer" ReferenceOutputAssembly="false" GeneratePathProperty="true" Aliases="global" NoWarn="NU1605" Condition="\'$(TargetFramework)\'==\'net10.0\'" />',
      'Project properties package source generator XML did not preserve metadata.'
    );
    assert(!packageSourceGeneratorXml.includes('Release'), 'Project properties package source generator XML copied group condition into item XML.');
    assert(
      __test.createSourceGeneratorXml({
        name: 'Central.SourceGenerator',
        version: '3.0.0',
        centralVersion: '3.0.0',
        versionSource: 'Directory.Packages.props',
        source: 'package'
      }) === '<PackageReference Include="Central.SourceGenerator" PrivateAssets="all" OutputItemType="Analyzer" />',
      'Project properties central source generator XML should not duplicate Version metadata.'
    );

    const analyzerSourceGeneratorXml = __test.createSourceGeneratorXml({
      include: 'analyzers/Generator.dll',
      hintPath: 'analyzers/Generator.dll',
      privateAssets: 'all',
      includeAssets: 'runtime; build',
      aliases: 'global',
      itemCondition: "'$(TargetFramework)'=='net10.0'",
      groupCondition: "'$(Configuration)'=='Release'",
      source: 'analyzer'
    });
    assert(
      analyzerSourceGeneratorXml === '<Analyzer Include="analyzers/Generator.dll" HintPath="analyzers/Generator.dll" PrivateAssets="all" IncludeAssets="runtime; build" Aliases="global" Condition="\'$(TargetFramework)\'==\'net10.0\'" />',
      'Project properties analyzer source generator XML did not preserve metadata.'
    );
    assert(!analyzerSourceGeneratorXml.includes('Release'), 'Project properties analyzer source generator XML copied group condition into item XML.');

    const explicitImportXml = __test.createImportXml({
      name: 'Directory.Build.props',
      source: 'Directory.Build.props',
      condition: "Exists('Directory.Build.props')",
      label: 'Shared props',
      implicit: false
    });
    assert(
      explicitImportXml === '<Import Project="Directory.Build.props" Condition="Exists(\'Directory.Build.props\')" Label="Shared props" />',
      'Project properties explicit import XML did not preserve metadata.'
    );

    const implicitImportXml = __test.createImportXml({
      name: 'Sdk.props',
      source: 'Microsoft.NET.Sdk',
      implicit: true,
      kind: 'sdk'
    });
    assert(
      implicitImportXml === '<!-- Sdk.props is imported implicitly by Microsoft.NET.Sdk -->',
      'Project properties implicit import XML did not render an implicit import comment.'
    );
    assert(
      __test.createImportXml({
        name: 'Directory.Build.targets',
        source: '../Directory.Build.targets',
        implicit: true,
        kind: 'directory-build-targets'
      }) === '<Import Project="../Directory.Build.targets" />',
      'Project properties implicit Directory.Build import XML did not render a reusable Import.'
    );

    const diagnosticPropertyXml = __test.createDiagnosticPropertyXml({
      name: 'DefineConstants',
      value: 'TRACE;DEBUG',
      condition: "'$(TargetFramework)'=='net10.0'",
      groupCondition: "'$(Configuration)'=='Debug'"
    });
    assert(
      diagnosticPropertyXml === '<PropertyGroup Condition="\'$(Configuration)\'==\'Debug\'">\n  <DefineConstants Condition="\'$(TargetFramework)\'==\'net10.0\'">TRACE;DEBUG</DefineConstants>\n</PropertyGroup>',
      'Diagnostic property XML did not preserve item and group conditions.'
    );

    const signingXml = __test.createSigningXml({
      signAssembly: 'true',
      keyFile: 'keys/project.snk',
      delaySign: 'false',
      publicSign: 'true'
    });
    assert(
      signingXml === '<PropertyGroup>\n  <SignAssembly>true</SignAssembly>\n  <AssemblyOriginatorKeyFile>keys/project.snk</AssemblyOriginatorKeyFile>\n  <DelaySign>false</DelaySign>\n  <PublicSign>true</PublicSign>\n</PropertyGroup>',
      'Signing XML did not preserve signing metadata.'
    );

    const assemblyXml = __test.createAssemblyMetadataXml({
      assemblyName: 'Kivi.BankApiClient',
      rootNamespace: 'Kivi.BankApiClient',
      assembly: {
        title: 'Kivi Client',
        version: '1.2.3.0',
        fileVersion: '1.2.3.4',
        informationalVersion: '1.2.3+abc123',
        neutralLanguage: 'en-US',
        generateAssemblyInfo: 'true',
        comVisible: 'false',
        guid: '11111111-1111-1111-1111-111111111111',
        clsCompliant: 'true',
        copyright: 'Copyright 2026',
        trademark: 'Kivi'
      }
    });
    assert(
      assemblyXml === '<PropertyGroup>\n  <AssemblyName>Kivi.BankApiClient</AssemblyName>\n  <RootNamespace>Kivi.BankApiClient</RootNamespace>\n  <AssemblyTitle>Kivi Client</AssemblyTitle>\n  <AssemblyVersion>1.2.3.0</AssemblyVersion>\n  <FileVersion>1.2.3.4</FileVersion>\n  <InformationalVersion>1.2.3+abc123</InformationalVersion>\n  <NeutralLanguage>en-US</NeutralLanguage>\n  <GenerateAssemblyInfo>true</GenerateAssemblyInfo>\n  <ComVisible>false</ComVisible>\n  <Guid>11111111-1111-1111-1111-111111111111</Guid>\n  <CLSCompliant>true</CLSCompliant>\n  <Copyright>Copyright 2026</Copyright>\n  <Trademark>Kivi</Trademark>\n</PropertyGroup>',
      'Assembly metadata XML did not preserve assembly metadata.'
    );

    const packageMetadataXml = __test.createPackageMetadataXml({
      packageId: 'Kivi.BankApiClient',
      version: '1.2.3',
      packageVersion: '1.2.3-beta.1',
      authors: 'Kivi',
      company: 'Kivi',
      product: 'Kivi Client',
      description: 'Bank API client package',
      releaseNotes: 'Initial release',
      repositoryUrl: 'https://github.com/kivi/client',
      repositoryType: 'git',
      repositoryBranch: 'main',
      repositoryCommit: 'abc123',
      publishRepositoryUrl: 'true',
      projectUrl: 'https://kivi.example/client',
      tags: 'bank;client',
      licenseExpression: 'MIT',
      licenseFile: 'LICENSE',
      licenseUrl: 'https://licenses.example/legacy',
      readmeFile: 'README.md',
      icon: 'icon.png',
      iconUrl: 'https://cdn.example/icon.png',
      isPackable: 'true',
      generatePackageOnBuild: 'true',
      requireLicenseAcceptance: 'false',
      includeBuildOutput: 'true',
      includeContentInPack: 'true',
      contentTargetFolders: 'content;contentFiles',
      developmentDependency: 'false',
      serviceable: 'true',
      includeSymbols: 'true',
      includeSource: 'true',
      symbolPackageFormat: 'snupkg',
      embedUntrackedSources: 'true',
      minClientVersion: '6.0',
      packageType: 'Dependency',
      packageValidationBaselineVersion: '1.0.0',
      packageValidationBaselineName: 'Kivi.BankApiClient',
      packageOutputPath: 'artifacts/packages'
    });
    assert(packageMetadataXml.includes('<PackageId>Kivi.BankApiClient</PackageId>'), 'Package metadata XML did not preserve PackageId.');
    assert(packageMetadataXml.includes('<PackageReleaseNotes>Initial release</PackageReleaseNotes>'), 'Package metadata XML did not preserve release notes.');
    assert(packageMetadataXml.includes('<RepositoryBranch>main</RepositoryBranch>'), 'Package metadata XML did not preserve repository branch.');
    assert(packageMetadataXml.includes('<PublishRepositoryUrl>true</PublishRepositoryUrl>'), 'Package metadata XML did not preserve PublishRepositoryUrl.');
    assert(packageMetadataXml.includes('<PackageValidationBaselineName>Kivi.BankApiClient</PackageValidationBaselineName>'), 'Package metadata XML did not preserve validation baseline.');
    assert(packageMetadataXml.includes('<PackageOutputPath>artifacts/packages</PackageOutputPath>'), 'Package metadata XML did not preserve output path.');

    const buildSettingsXml = __test.createBuildSettingsXml({
      outputPath: 'bin/Debug/',
      baseOutputPath: 'artifacts/bin/',
      intermediateOutputPath: 'obj/custom/',
      appendTargetFrameworkToOutputPath: 'false',
      appendRuntimeIdentifierToOutputPath: 'false',
      copyLocalLockFileAssemblies: 'true',
      optimize: 'true',
      defineConstants: 'TRACE;DEBUG',
      allowUnsafeBlocks: 'true',
      checkForOverflowUnderflow: 'true',
      platformTarget: 'AnyCPU',
      deterministic: 'true',
      continuousIntegrationBuild: 'true',
      debugSymbols: 'true',
      debugType: 'portable',
      treatWarningsAsErrors: 'true',
      warningsAsErrors: 'CS1591',
      noWarn: 'CS0168',
      warningLevel: '5',
      generateDocumentationFile: 'true',
      documentationFile: 'docs/api.xml',
      produceReferenceAssembly: 'true',
      emitCompilerGeneratedFiles: 'true',
      compilerGeneratedFilesOutputPath: 'generated'
    });
    assert(buildSettingsXml.includes('<OutputPath>bin/Debug/</OutputPath>'), 'Build settings XML did not preserve OutputPath.');
    assert(buildSettingsXml.includes('<DefineConstants>TRACE;DEBUG</DefineConstants>'), 'Build settings XML did not preserve DefineConstants.');
    assert(buildSettingsXml.includes('<DebugType>portable</DebugType>'), 'Build settings XML did not preserve DebugType.');
    assert(buildSettingsXml.includes('<CompilerGeneratedFilesOutputPath>generated</CompilerGeneratedFilesOutputPath>'), 'Build settings XML did not preserve generated files output path.');

    const publishSettingsXml = __test.createPublishSettingsXml({
      runtimeIdentifier: 'osx-arm64',
      runtimeIdentifiers: 'osx-arm64;linux-x64',
      selfContained: 'true',
      useAppHost: 'true',
      targetLatestRuntimePatch: 'true',
      invariantGlobalization: 'false',
      publishDir: 'artifacts/publish',
      publishUrl: 'artifacts/webdeploy',
      publishSingleFile: 'true',
      publishTrimmed: 'true',
      publishReadyToRun: 'true',
      publishAot: 'false',
      includeNativeLibrariesForSelfExtract: 'true',
      enableCompressionInSingleFile: 'true'
    });
    assert(publishSettingsXml.includes('<RuntimeIdentifier>osx-arm64</RuntimeIdentifier>'), 'Publish settings XML did not preserve RuntimeIdentifier.');
    assert(publishSettingsXml.includes('<PublishSingleFile>true</PublishSingleFile>'), 'Publish settings XML did not preserve PublishSingleFile.');
    assert(publishSettingsXml.includes('<PublishAot>false</PublishAot>'), 'Publish settings XML did not preserve PublishAot.');
    assert(publishSettingsXml.includes('<EnableCompressionInSingleFile>true</EnableCompressionInSingleFile>'), 'Publish settings XML did not preserve compression setting.');

    const buildEventsXml = __test.createBuildEventsXml({
      preBuildEvent: 'dotnet tool restore',
      postBuildEvent: 'dotnet format --verify-no-changes',
      runPostBuildEvent: 'OnBuildSuccess'
    });
    assert(
      buildEventsXml === '<PropertyGroup>\n  <PreBuildEvent>dotnet tool restore</PreBuildEvent>\n  <PostBuildEvent>dotnet format --verify-no-changes</PostBuildEvent>\n  <RunPostBuildEvent>OnBuildSuccess</RunPostBuildEvent>\n</PropertyGroup>',
      'Build events XML did not preserve build event metadata.'
    );
  } finally {
    Module._load = originalLoad;
  }
}

function validateProjectPropertyEditor() {
  const originalLoad = Module._load;

  Module._load = function loadWithVscodeMock(request, parent, isMain) {
    if (request === 'vscode') {
      return {
        Uri: {
          file: (value) => ({ fsPath: value })
        },
        workspace: {
          fs: {}
        }
      };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const {
      removeProjectConfigurationInText,
      updateProjectItemReferencesInText,
      updateProjectPropertiesInText
    } = require(runtimeModulePath('projectFileEditor.js'));
    const currentText = [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '  <PropertyGroup>',
      '    <TargetFramework>net8.0</TargetFramework>',
      '    <Nullable>enable</Nullable>',
      '  </PropertyGroup>',
      '  <PropertyGroup Condition="\'$(Configuration)|$(Platform)\'==\'Debug|AnyCPU\'">',
      '    <DefineConstants>DEBUG;TRACE</DefineConstants>',
      '    <Optimize>false</Optimize>',
      '  </PropertyGroup>',
      '</Project>'
    ].join('\n');
    const nextText = updateProjectPropertiesInText(currentText, {
      properties: {
        TargetFramework: 'net10.0',
        Nullable: '',
        AssemblyName: 'Kivi.BankApiClient'
      },
      configurations: [
        {
          configuration: 'Debug',
          platform: 'AnyCPU',
          properties: {
            Optimize: 'true',
            DebugSymbols: 'true'
          }
        },
        {
          configuration: 'Release',
          platform: 'AnyCPU',
          properties: {
            Optimize: 'true',
            DefineConstants: 'TRACE'
          }
        }
      ]
    });

    assert(nextText.includes('<TargetFramework>net10.0</TargetFramework>'), 'TargetFramework was not updated.');
    assert(!nextText.includes('<Nullable>'), 'Empty property was not removed.');
    assert(nextText.includes('<AssemblyName>Kivi.BankApiClient</AssemblyName>'), 'New property was not inserted.');
    assert(nextText.includes('<Optimize>true</Optimize>'), 'Configuration property was not updated.');
    assert(nextText.includes('<DebugSymbols>true</DebugSymbols>'), 'Configuration property was not inserted.');
    assert(nextText.includes("Condition=\"'$(Configuration)|$(Platform)'=='Release|AnyCPU'\""), 'Missing configuration property group was not inserted.');
    assert(nextText.includes('<DefineConstants>TRACE</DefineConstants>'), 'New configuration group property was not inserted.');

    const removedConfigurationText = removeProjectConfigurationInText(nextText, 'Debug', 'AnyCPU');

    assert(!removedConfigurationText.includes("'$(Configuration)|$(Platform)'=='Debug|AnyCPU'"), 'Configuration property group was not removed.');
    assert(removedConfigurationText.includes("'$(Configuration)|$(Platform)'=='Release|AnyCPU'"), 'Removing Debug also removed Release configuration.');

    const nextReferenceText = updateProjectItemReferencesInText(currentText, [
      {
        action: 'add',
        elementName: 'PackageReference',
        include: 'Newtonsoft.Json',
        metadata: {
          Version: '13.0.4',
          VersionOverride: '13.0.5',
          PrivateAssets: 'all',
          GeneratePathProperty: 'true',
          Aliases: 'global',
          NoWarn: 'NU1605',
          Condition: "'$(TargetFramework)'=='net10.0'"
        }
      },
      {
        action: 'add',
        elementName: 'FrameworkReference',
        include: 'Microsoft.AspNetCore.App'
      },
      {
        action: 'add',
        elementName: 'ProjectReference',
        include: '../Core/Core.csproj',
        metadata: {
          ReferenceOutputAssembly: 'false',
          PrivateAssets: 'all'
        }
      },
      {
        action: 'add',
        elementName: 'Reference',
        include: 'Legacy.Client',
        metadata: {
          HintPath: 'lib/Legacy.Client.dll'
        }
      },
      {
        action: 'add',
        elementName: 'None',
        include: 'README.md',
        identityAttribute: 'Update',
        metadata: {
          CopyToOutputDirectory: 'Never'
        }
      },
      {
        action: 'remove',
        elementName: 'Reference',
        include: 'Legacy.Client'
      }
    ]);

    assert(nextReferenceText.includes('<PackageReference Include="Newtonsoft.Json" Version="13.0.4" VersionOverride="13.0.5" PrivateAssets="all" GeneratePathProperty="true" Aliases="global" NoWarn="NU1605" Condition="\'$(TargetFramework)\'==\'net10.0\'" />'), 'PackageReference metadata was not upserted.');
    assert(nextReferenceText.includes('<ProjectReference Include="../Core/Core.csproj" ReferenceOutputAssembly="false" PrivateAssets="all" />'), 'ProjectReference metadata was not upserted.');
    assert(nextReferenceText.includes('<FrameworkReference Include="Microsoft.AspNetCore.App" />'), 'FrameworkReference was not inserted.');
    assert(nextReferenceText.includes('<None Update="README.md" CopyToOutputDirectory="Never" />'), 'Project item identity attribute was not preserved.');
    assert(!nextReferenceText.includes('Legacy.Client'), 'Reference remove operation did not remove the item.');

    const conditionalItemText = [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '  <ItemGroup Condition="\'$(Configuration)\'==\'ResourceDebug\'">',
      '    <Content Include="debugsettings.json" CopyToOutputDirectory="Always" />',
      '  </ItemGroup>',
      '</Project>'
    ].join('\n');
    const nextConditionalItemText = updateProjectItemReferencesInText(conditionalItemText, [
      {
        action: 'add',
        elementName: 'Content',
        include: 'debugsettings.json',
        metadata: {
          CopyToOutputDirectory: 'PreserveNewest'
        }
      }
    ]);

    assert(nextConditionalItemText.includes('<ItemGroup Condition="\'$(Configuration)\'==\'ResourceDebug\'">'), 'Conditional ItemGroup was not preserved.');
    assert(nextConditionalItemText.includes('<Content Include="debugsettings.json" CopyToOutputDirectory="PreserveNewest" />'), 'Conditional project item metadata was not updated in place.');
    assert(!nextConditionalItemText.includes('<Content Include="debugsettings.json" CopyToOutputDirectory="PreserveNewest" Condition='), 'Group condition was copied onto the item.');

    const duplicateConditionalItemText = [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '  <ItemGroup Condition="\'$(Configuration)\'==\'Debug\'">',
      '    <Content Include="appsettings.json" CopyToOutputDirectory="Always" />',
      '  </ItemGroup>',
      '  <ItemGroup Condition="\'$(Configuration)\'==\'Release\'">',
      '    <Content Include="appsettings.json" CopyToOutputDirectory="Never" />',
      '  </ItemGroup>',
      '</Project>'
    ].join('\n');
    const nextDuplicateConditionalItemText = updateProjectItemReferencesInText(duplicateConditionalItemText, [
      {
        action: 'add',
        elementName: 'Content',
        include: 'appsettings.json',
        groupCondition: "'$(Configuration)'=='Release'",
        metadata: {
          CopyToOutputDirectory: 'PreserveNewest'
        }
      }
    ]);

    assert(nextDuplicateConditionalItemText.includes('<Content Include="appsettings.json" CopyToOutputDirectory="Always" />'), 'Non-target conditional item was changed.');
    assert(nextDuplicateConditionalItemText.includes('<Content Include="appsettings.json" CopyToOutputDirectory="PreserveNewest" />'), 'Target conditional item was not updated.');
    assert(!nextDuplicateConditionalItemText.includes('<Content Include="appsettings.json" CopyToOutputDirectory="Never" />'), 'Old target conditional item metadata was left behind.');

    const conditionalGroupInsertText = [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '  <ItemGroup Condition="\'$(Configuration)\'==\'Release\'">',
      '    <Content Include="existing.json" />',
      '  </ItemGroup>',
      '</Project>'
    ].join('\n');
    const nextConditionalGroupInsertText = updateProjectItemReferencesInText(conditionalGroupInsertText, [
      {
        action: 'add',
        elementName: 'None',
        include: 'release-notes.md',
        groupCondition: "'$(Configuration)'=='Release'",
        metadata: {
          CopyToOutputDirectory: 'Never'
        }
      }
    ]);

    assert(nextConditionalGroupInsertText.includes('<ItemGroup Condition="\'$(Configuration)\'==\'Release\'">'), 'Existing conditional ItemGroup was not reused.');
    assert(nextConditionalGroupInsertText.includes('<None Include="release-notes.md" CopyToOutputDirectory="Never" />'), 'Item was not inserted into the conditional group.');
    assert(nextConditionalGroupInsertText.includes([
      '  <ItemGroup Condition="\'$(Configuration)\'==\'Release\'">',
      '    <Content Include="existing.json" />',
      '    <None Include="release-notes.md" CopyToOutputDirectory="Never" />',
      '  </ItemGroup>'
    ].join('\n')), 'Conditional group insert formatting is not stable.');
    assert(!nextConditionalGroupInsertText.includes('<ItemGroup>\n    <None Include="release-notes.md" CopyToOutputDirectory="Never" />'), 'Conditional insert fell back to an unconditional ItemGroup.');

    const newConditionalGroupText = updateProjectItemReferencesInText('<Project Sdk="Microsoft.NET.Sdk">\n</Project>', [
      {
        action: 'add',
        elementName: 'Content',
        include: 'staging.json',
        groupCondition: "'$(Configuration)'=='Staging'",
        metadata: {
          CopyToOutputDirectory: 'PreserveNewest'
        }
      }
    ]);

    assert(newConditionalGroupText.includes('<ItemGroup Condition="\'$(Configuration)\'==\'Staging\'">'), 'Missing conditional ItemGroup was not created.');
    assert(newConditionalGroupText.includes('<Content Include="staging.json" CopyToOutputDirectory="PreserveNewest" />'), 'Item was not inserted into the new conditional group.');
    assert(newConditionalGroupText.includes([
      '  <ItemGroup Condition="\'$(Configuration)\'==\'Staging\'">',
      '    <Content Include="staging.json" CopyToOutputDirectory="PreserveNewest" />',
      '  </ItemGroup>'
    ].join('\n')), 'New conditional group formatting is not stable.');
  } finally {
    Module._load = originalLoad;
  }
}

function validateSolutionFileEditor() {
  const { __test } = require(runtimeModulePath('solutionFileEditor.js'));
  const solutionPath = path.join('/repo', 'Kivi.sln');
  const projectPath = path.join('/repo', 'src', 'App', 'App.csproj');
  const clientGuid = '{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}';
  const coreGuid = '{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}';
  const projectGuid = '{CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC}';
  const slnText = [
    'Microsoft Visual Studio Solution File, Format Version 12.00',
    `Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "Clients", "Clients", "${clientGuid}"`,
    'EndProject',
    'Global',
    '\tGlobalSection(SolutionConfigurationPlatforms) = preSolution',
    '\t\tDebug|Any CPU = Debug|Any CPU',
    '\tEndGlobalSection',
    '\tGlobalSection(ProjectConfigurationPlatforms) = postSolution',
    '\tEndGlobalSection',
    '\tGlobalSection(NestedProjects) = preSolution',
    '\tEndGlobalSection',
    'EndGlobal',
    ''
  ].join('\n');
  const slnProjectResult = __test.addProjectToSolutionText(slnText, solutionPath, projectPath, {
    solutionFolder: 'Clients/Core',
    createGuid: createGuidSequence([coreGuid, projectGuid])
  });

  assert(slnProjectResult.changed, 'Adding a project to .sln should report a change.');
  assert(
    slnProjectResult.text.includes(`Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App", "src\\App\\App.csproj", "${projectGuid}"`),
    '.sln project block was not inserted.'
  );
  assert(
    slnProjectResult.text.includes(`${projectGuid}.Debug|Any CPU.ActiveCfg = Debug|Any CPU`),
    '.sln project configuration was not inserted.'
  );
  assert(
    slnProjectResult.text.includes(`${projectGuid} = ${coreGuid}`),
    '.sln project was not nested under the selected solution folder.'
  );
  assert(
    slnProjectResult.text.includes(`${coreGuid} = ${clientGuid}`),
    '.sln solution folder nesting was not inserted.'
  );

  const duplicateSlnProject = __test.addProjectToSolutionText(slnProjectResult.text, solutionPath, projectPath, {
    solutionFolder: 'Clients/Core',
    createGuid: createGuidSequence(['{DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD}'])
  });

  assert(!duplicateSlnProject.changed, 'Duplicate .sln project add should not rewrite the solution.');

  const slnFolderResult = __test.addSolutionFolderToSolutionText(slnText, solutionPath, 'Shared/Infrastructure', {
    createGuid: createGuidSequence([
      '{11111111-1111-1111-1111-111111111111}',
      '{22222222-2222-2222-2222-222222222222}'
    ])
  });

  assert(slnFolderResult.text.includes('= "Shared", "Shared"'), '.sln solution folder was not inserted.');
  assert(slnFolderResult.text.includes('= "Infrastructure", "Infrastructure"'), '.sln nested solution folder was not inserted.');
  assert(
    slnFolderResult.text.includes('{22222222-2222-2222-2222-222222222222} = {11111111-1111-1111-1111-111111111111}'),
    '.sln nested solution folder mapping was not inserted.'
  );

  const slnxPath = path.join('/repo', 'Kivi.slnx');
  const slnxText = [
    '<Solution>',
    '  <Folder Name="Clients">',
    '  </Folder>',
    '</Solution>',
    ''
  ].join('\n');
  const slnxProjectResult = __test.addProjectToSolutionText(slnxText, slnxPath, projectPath, {
    solutionFolder: 'Clients/Core'
  });

  assert(slnxProjectResult.changed, 'Adding a project to .slnx should report a change.');
  assert(slnxProjectResult.text.includes('<Project Path="src/App/App.csproj" />'), '.slnx project path was not inserted.');
  assert(slnxProjectResult.text.includes('<Folder Name="Core">'), '.slnx solution folder was not inserted for the project.');

  const slnxFolderResult = __test.addSolutionFolderToSolutionText('<Solution>\n</Solution>\n', slnxPath, 'Shared/Infrastructure');

  assert(slnxFolderResult.text.includes('<Folder Name="Shared">'), '.slnx solution folder was not inserted.');
  assert(slnxFolderResult.text.includes('<Folder Name="Infrastructure">'), '.slnx nested solution folder was not inserted.');

  const duplicateSlnxFolder = __test.addSolutionFolderToSolutionText(slnxFolderResult.text, slnxPath, 'Shared/Infrastructure');

  assert(!duplicateSlnxFolder.changed, 'Duplicate .slnx folder add should not rewrite the solution.');
}

function createGuidSequence(values) {
  const queue = [...values];

  return () => queue.shift();
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
