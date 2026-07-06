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
exports.NuGetProtocolHost = void 0;
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
class NuGetProtocolHost {
    extensionPath;
    constructor(extensionPath) {
        this.extensionPath = extensionPath;
    }
    async listSources() {
        return this.send({
            Command: 'list-sources'
        });
    }
    async search(sourceUrl, query, prerelease, skip = 0, take = 100) {
        return this.send({
            Command: 'search',
            SourceUrl: sourceUrl,
            Filter: query,
            Prerelease: prerelease,
            Skip: skip,
            Take: take
        });
    }
    async getPackage(sourceUrl, packageId, prerelease) {
        return this.send({
            Command: 'get-package',
            SourceUrl: sourceUrl,
            PackageId: packageId,
            Prerelease: prerelease
        });
    }
    async getPackageDetails(sourceUrl, packageId, version) {
        return this.send({
            Command: 'get-package-details',
            SourceUrl: sourceUrl,
            PackageId: packageId,
            Version: version,
            Prerelease: true
        });
    }
    async send(request) {
        const protocolHostPath = path.join(this.extensionPath, 'dist', 'protocol-host', 'CanNugetGallery.ProtocolHost.dll');
        const requestBody = JSON.stringify({
            ...request,
            WorkspaceFolders: vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) || []
        });
        return new Promise((resolve, reject) => {
            const child = (0, child_process_1.spawn)('dotnet', [protocolHostPath], {
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
                    const response = JSON.parse(stdout);
                    if (response.IsFailure) {
                        reject(new Error(response.Error?.Message || 'NuGet protocol host failed.'));
                        return;
                    }
                    resolve(response.Data);
                }
                catch (error) {
                    reject(new Error(`Failed to parse NuGet protocol host response: ${error instanceof Error ? error.message : String(error)}`));
                }
            });
            child.stdin.write(requestBody);
            child.stdin.end();
        });
    }
    buildEnvironment() {
        const env = { ...process.env };
        const httpConfig = vscode.workspace.getConfiguration('http');
        const configuredProxy = httpConfig.get('proxy');
        const proxyStrictSsl = httpConfig.get('proxyStrictSSL');
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
exports.NuGetProtocolHost = NuGetProtocolHost;
