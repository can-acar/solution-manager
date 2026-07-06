import { spawn } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

type ProtocolCommand = 'list-sources' | 'search' | 'get-package' | 'get-package-details';

type ProtocolRequest = {
  Command: ProtocolCommand;
  SourceName?: string;
  SourceUrl?: string;
  PackageId?: string;
  Version?: string;
  Filter?: string;
  Prerelease?: boolean;
  Skip?: number;
  Take?: number;
  WorkspaceFolders?: string[];
};

type ProtocolResponse<T> = {
  IsFailure?: boolean;
  Data?: T;
  Error?: {
    Message?: string;
  };
};

class NuGetProtocolHost {
  constructor(private readonly extensionPath: string) {}

  async listSources(): Promise<any[]> {
    return this.send<any[]>({
      Command: 'list-sources'
    });
  }

  async search(sourceUrl: string, query: string, prerelease: boolean, skip = 0, take = 50): Promise<any[]> {
    return this.send<any[]>({
      Command: 'search',
      SourceUrl: sourceUrl,
      Filter: query,
      Prerelease: prerelease,
      Skip: skip,
      Take: take
    });
  }

  async getPackage(sourceUrl: string, packageId: string, prerelease: boolean): Promise<any> {
    return this.send<any>({
      Command: 'get-package',
      SourceUrl: sourceUrl,
      PackageId: packageId,
      Prerelease: prerelease
    });
  }

  async getPackageDetails(sourceUrl: string, packageId: string, version: string): Promise<any> {
    return this.send<any>({
      Command: 'get-package-details',
      SourceUrl: sourceUrl,
      PackageId: packageId,
      Version: version,
      Prerelease: true
    });
  }

  private async send<T>(request: ProtocolRequest): Promise<T> {
    const protocolHostPath = path.join(
      this.extensionPath,
      'dist',
      'protocol-host',
      'CanNugetGallery.ProtocolHost.dll'
    );

    const requestBody = JSON.stringify({
      ...request,
      WorkspaceFolders: vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) || []
    });

    return new Promise<T>((resolve, reject) => {
      const child = spawn('dotnet', [protocolHostPath], {
        env: this.buildEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('NuGet protocol host timed out.'));
      }, 45000);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timeout);

        if (code !== 0) {
          reject(new Error(stderr || `NuGet protocol host exited with code ${code}.`));
          return;
        }

        try {
          const response = JSON.parse(stdout) as ProtocolResponse<T>;

          if (response.IsFailure) {
            reject(new Error(response.Error?.Message || 'NuGet protocol host failed.'));
            return;
          }

          resolve(response.Data as T);
        } catch (error) {
          reject(new Error(`Failed to parse NuGet protocol host response: ${error instanceof Error ? error.message : String(error)}`));
        }
      });

      child.stdin.write(requestBody);
      child.stdin.end();
    });
  }

  private buildEnvironment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const httpConfig = vscode.workspace.getConfiguration('http');
    const configuredProxy = httpConfig.get<string>('proxy');
    const proxyStrictSsl = httpConfig.get<boolean>('proxyStrictSSL');

    if (configuredProxy) {
      env.HTTP_PROXY = configuredProxy;
      env.HTTPS_PROXY = configuredProxy;
      env.http_proxy = configuredProxy;
      env.https_proxy = configuredProxy;
    }

    if (proxyStrictSsl === false) {
      env.NUGET_CERT_REVOCATION_MODE = 'offline';
    }

    return env;
  }
}

export {
  NuGetProtocolHost
};
