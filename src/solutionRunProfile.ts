import * as path from 'path';
import * as vscode from 'vscode';
import { readProjectLaunchSettings } from '#src/launchSettingsEditor';
import { quoteForShell, TerminalRunner } from '#src/terminalRunner';

const SOLUTION_RUN_PROFILES_KEY = 'solutionManager.solutionRunProfiles.v1';
const RUN_PROFILE_VERSION = 1;
const CSHARP_DEV_KIT_EXTENSION_ID = 'ms-dotnettools.csdevkit';

type SolutionProject = {
  name?: string;
  path: string;
  uri?: string;
};

type SolutionItem = {
  name?: string;
  path: string;
};

type SolutionRunTarget = {
  projectName: string;
  projectPath: string;
  launchProfile?: string;
};

type SolutionRunProfile = {
  version: typeof RUN_PROFILE_VERSION;
  solutionPath: string;
  name: string;
  targets: SolutionRunTarget[];
};

type StoredRunProfiles = Record<string, unknown>;

type ProfileValidation = {
  profile?: SolutionRunProfile;
  reason?: string;
};

class SolutionRunProfileManager {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly terminalRunner: TerminalRunner
  ) {}

  async selectProfile(
    solution: SolutionItem,
    projects: SolutionProject[],
    unloadedProjectUris: Set<string>
  ): Promise<SolutionRunProfile | undefined> {
    const availableProjects = projects.filter((project) => (
      project.path && !unloadedProjectUris.has(project.uri || '')
    ));

    if (availableProjects.length === 0) {
      vscode.window.showInformationMessage('Solution Manager: no loaded projects are available for a Run Profile.');
      return undefined;
    }

    const currentProfile = this.getStoredProfile(solution.path);
    const currentTargets = new Set(
      (currentProfile?.targets || []).map((target) => normalizePath(target.projectPath))
    );
    const pickedProjects = await vscode.window.showQuickPick(
      availableProjects.map((project) => ({
        label: project.name || path.basename(project.path, path.extname(project.path)),
        description: vscode.workspace.asRelativePath(project.path, false),
        detail: project.path,
        picked: currentTargets.has(normalizePath(project.path)),
        project
      })),
      {
        title: 'Solution Manager: Select Run Profile Projects',
        placeHolder: 'Select one or more startup projects',
        canPickMany: true
      }
    );

    if (!pickedProjects || pickedProjects.length === 0) {
      return undefined;
    }

    const targets: SolutionRunTarget[] = [];

    for (const item of pickedProjects) {
      const project = item.project;
      const launchSettings = await readProjectLaunchSettings(project.path);
      const runnableProfiles = (launchSettings.profiles || []).filter(isRunnableLaunchProfile);
      const existingTarget = currentProfile?.targets.find((target) => (
        normalizePath(target.projectPath) === normalizePath(project.path)
      ));
      let launchProfile: string | undefined;

      if (runnableProfiles.length > 0) {
        const profilePick = await vscode.window.showQuickPick(
          [
            ...runnableProfiles.map((profile) => ({
              label: profile.name,
              description: 'launchSettings.json',
              profileName: profile.name,
              picked: profile.name === existingTarget?.launchProfile
            })),
            {
              label: 'Default project settings',
              description: 'Run without a launchSettings.json profile',
              profileName: undefined,
              picked: !existingTarget?.launchProfile
            }
          ],
          {
            title: `Solution Manager: ${item.label} Run Profile`,
            placeHolder: 'Select a launch profile'
          }
        );

        if (!profilePick) {
          return undefined;
        }

        launchProfile = profilePick.profileName;
      }

      targets.push({
        projectName: item.label,
        projectPath: project.path,
        launchProfile
      });
    }

    const profile: SolutionRunProfile = {
      version: RUN_PROFILE_VERSION,
      solutionPath: solution.path,
      name: deriveRunProfileName(targets),
      targets
    };

    await this.storeProfile(profile);
    vscode.window.setStatusBarMessage(`Solution Manager: Run Profile "${profile.name}" selected.`, 3000);
    return profile;
  }

  async run(
    solution: SolutionItem,
    projects: SolutionProject[],
    unloadedProjectUris: Set<string>
  ): Promise<void> {
    const profile = await this.resolveProfile(solution, projects, unloadedProjectUris);

    if (!profile) {
      return;
    }

    for (const target of profile.targets) {
      this.terminalRunner.runCommand(createSolutionRunCommand(target), {
        useTask: true,
        dedicatedTask: true,
        taskName: `Run: ${target.projectName}`
      });
    }

    vscode.window.setStatusBarMessage(`Solution Manager: started Run Profile "${profile.name}".`, 3000);
  }

  async debug(
    solution: SolutionItem,
    projects: SolutionProject[],
    unloadedProjectUris: Set<string>
  ): Promise<void> {
    const profile = await this.resolveProfile(solution, projects, unloadedProjectUris);

    if (!profile || !(await ensureDotnetDebuggerAvailable())) {
      return;
    }

    for (const target of profile.targets) {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(target.projectPath));
      const started = await vscode.debug.startDebugging(
        workspaceFolder,
        createDotnetDebugConfiguration(target)
      );

      if (!started) {
        throw new Error(`The debugger could not start ${target.projectName}.`);
      }
    }

    vscode.window.setStatusBarMessage(`Solution Manager: started Debug Profile "${profile.name}".`, 3000);
  }

  private async resolveProfile(
    solution: SolutionItem,
    projects: SolutionProject[],
    unloadedProjectUris: Set<string>
  ): Promise<SolutionRunProfile | undefined> {
    const storedProfile = this.getStoredProfile(solution.path);

    if (!storedProfile) {
      return this.selectProfile(solution, projects, unloadedProjectUris);
    }

    const validation = await validateRunProfile(
      storedProfile,
      solution,
      projects,
      unloadedProjectUris
    );

    if (validation.profile) {
      return validation.profile;
    }

    await vscode.window.showWarningMessage(
      `Solution Manager: the active Run Profile is no longer valid. ${validation.reason || ''}`.trim()
    );
    return this.selectProfile(solution, projects, unloadedProjectUris);
  }

  private getStoredProfile(solutionPath: string): SolutionRunProfile | undefined {
    const profiles = this.getStoredProfiles();

    return normalizeStoredRunProfile(profiles[normalizePath(solutionPath)], solutionPath);
  }

  private async storeProfile(profile: SolutionRunProfile): Promise<void> {
    const profiles = this.getStoredProfiles();

    await this.context.workspaceState.update(SOLUTION_RUN_PROFILES_KEY, {
      ...profiles,
      [normalizePath(profile.solutionPath)]: profile
    });
  }

  private getStoredProfiles(): StoredRunProfiles {
    const value = this.context.workspaceState.get<unknown>(
      SOLUTION_RUN_PROFILES_KEY,
      {}
    );

    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as StoredRunProfiles
      : {};
  }
}

async function validateRunProfile(
  profile: SolutionRunProfile,
  solution: SolutionItem,
  projects: SolutionProject[],
  unloadedProjectUris: Set<string>
): Promise<ProfileValidation> {
  const normalizedProfile = normalizeStoredRunProfile(profile, solution.path);

  if (!normalizedProfile) {
    return { reason: 'Its stored data is malformed or belongs to another solution.' };
  }

  const projectsByPath = new Map(
    projects.map((project) => [normalizePath(project.path), project])
  );
  const validatedTargets: SolutionRunTarget[] = [];

  for (const target of normalizedProfile.targets) {
    const project = projectsByPath.get(normalizePath(target.projectPath));

    if (!project) {
      return { reason: `${target.projectName} is no longer part of the solution.` };
    }

    if (unloadedProjectUris.has(project.uri || '')) {
      return { reason: `${target.projectName} is unloaded.` };
    }

    if (target.launchProfile) {
      const launchSettings = await readProjectLaunchSettings(project.path);
      const launchProfile = (launchSettings.profiles || []).find((candidate) => (
        candidate.name === target.launchProfile && isRunnableLaunchProfile(candidate)
      ));

      if (!launchProfile) {
        return {
          reason: `${target.launchProfile} no longer exists as a runnable Project profile for ${target.projectName}.`
        };
      }
    }

    validatedTargets.push({
      ...target,
      projectName: project.name || target.projectName,
      projectPath: project.path
    });
  }

  return {
    profile: {
      ...normalizedProfile,
      targets: validatedTargets
    }
  };
}

function normalizeStoredRunProfile(
  value: unknown,
  solutionPath: string
): SolutionRunProfile | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const candidate = value as Partial<SolutionRunProfile>;

  if (
    candidate.version !== RUN_PROFILE_VERSION
    || typeof candidate.solutionPath !== 'string'
    || !path.isAbsolute(candidate.solutionPath)
    || normalizePath(candidate.solutionPath) !== normalizePath(solutionPath)
    || !Array.isArray(candidate.targets)
    || candidate.targets.length === 0
  ) {
    return undefined;
  }

  const seenProjectPaths = new Set<string>();
  const targets: SolutionRunTarget[] = [];

  for (const target of candidate.targets) {
    if (
      !target
      || typeof target !== 'object'
      || typeof target.projectPath !== 'string'
      || !target.projectPath.trim()
      || !path.isAbsolute(target.projectPath)
    ) {
      return undefined;
    }

    const normalizedProjectPath = normalizePath(target.projectPath);

    if (seenProjectPaths.has(normalizedProjectPath)) {
      continue;
    }

    seenProjectPaths.add(normalizedProjectPath);
    targets.push({
      projectName: typeof target.projectName === 'string' && target.projectName.trim()
        ? target.projectName.trim()
        : path.basename(target.projectPath, path.extname(target.projectPath)),
      projectPath: target.projectPath,
      launchProfile: typeof target.launchProfile === 'string' && target.launchProfile.trim()
        ? target.launchProfile.trim()
        : undefined
    });
  }

  if (targets.length === 0) {
    return undefined;
  }

  return {
    version: RUN_PROFILE_VERSION,
    solutionPath: candidate.solutionPath,
    name: typeof candidate.name === 'string' && candidate.name.trim()
      ? candidate.name.trim()
      : deriveRunProfileName(targets),
    targets
  };
}

function createSolutionRunCommand(target: SolutionRunTarget): string {
  const launchProfile = target.launchProfile
    ? ` --launch-profile ${quoteForShell(target.launchProfile)}`
    : '';

  return `dotnet run --project ${quoteForShell(target.projectPath)}${launchProfile}`;
}

function createDotnetDebugConfiguration(
  target: SolutionRunTarget
): vscode.DebugConfiguration {
  const configuration: vscode.DebugConfiguration = {
    type: 'dotnet',
    request: 'launch',
    name: `Solution Manager: ${target.projectName}`,
    projectPath: target.projectPath
  };

  if (target.launchProfile) {
    configuration.launchSettingsProfile = target.launchProfile;
  }

  return configuration;
}

function deriveRunProfileName(targets: SolutionRunTarget[]): string {
  if (targets.length === 1) {
    const target = targets[0];
    return `${target.projectName} — ${target.launchProfile || 'Default'}`;
  }

  return `${targets.length} startup projects`;
}

function isRunnableLaunchProfile(profile: { commandName?: string }): boolean {
  return String(profile.commandName || '').toLowerCase() === 'project';
}

async function ensureDotnetDebuggerAvailable(): Promise<boolean> {
  if (vscode.extensions.getExtension(CSHARP_DEV_KIT_EXTENSION_ID)) {
    return true;
  }

  const selection = await vscode.window.showErrorMessage(
    'Solution Manager: Debug Profiles require the Microsoft C# Dev Kit extension.',
    'Install C# Dev Kit'
  );

  if (selection === 'Install C# Dev Kit') {
    await vscode.commands.executeCommand(
      'workbench.extensions.installExtension',
      CSHARP_DEV_KIT_EXTENSION_ID
    );
  }

  return false;
}

function normalizePath(value: string): string {
  const normalized = path.resolve(value).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

const __test = {
  createDotnetDebugConfiguration,
  createSolutionRunCommand,
  deriveRunProfileName,
  isRunnableLaunchProfile,
  normalizeStoredRunProfile
};

export {
  __test,
  SolutionRunProfileManager
};
