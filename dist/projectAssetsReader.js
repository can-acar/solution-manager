"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PACKAGE_ASSET_GROUPS = void 0;
exports.readProjectAssetsFromText = readProjectAssetsFromText;
function readProjectAssetsFromText(text) {
    const assets = JSON.parse(text);
    const projectFrameworks = assets.project?.frameworks || {};
    const targets = assets.targets || {};
    const libraries = assets.libraries || {};
    const result = {};
    for (const [targetName, targetLibraries] of Object.entries(targets)) {
        const framework = normalizeTargetFramework(targetName);
        const projectFramework = findProjectFramework(projectFrameworks, framework, targetName);
        const topLevelPackageNames = new Set((projectFramework?.topLevelPackages || []).map((item) => item.id?.toLowerCase()).filter(Boolean));
        const frameworkReferences = Object.keys(projectFramework?.frameworkReferences || {}).map((name) => ({ name }));
        const packages = [];
        const projects = [];
        for (const [libraryKey, targetLibrary] of Object.entries(targetLibraries || {})) {
            const parsed = parseLibraryKey(libraryKey);
            const library = libraries[libraryKey] || {};
            const item = {
                name: parsed.name,
                version: parsed.version,
                key: libraryKey,
                type: targetLibrary.type || library.type,
                requested: targetLibrary.requested,
                resolved: targetLibrary.resolved,
                dependencies: Object.entries(targetLibrary.dependencies || {}).map(([name, version]) => ({
                    name,
                    version
                })),
                ...readLibraryAssetGroups(targetLibrary),
                path: library.path,
                sha512: library.sha512,
                direct: topLevelPackageNames.has(parsed.name.toLowerCase())
            };
            if (item.type === 'project') {
                projects.push(item);
            }
            else if (item.type === 'package') {
                packages.push(item);
            }
        }
        result[framework] = {
            targetName,
            packages: sortPackages(packages),
            projects: sortPackages(projects),
            frameworkReferences
        };
    }
    return result;
}
function isRealAsset(value) {
    return value && value !== '_._';
}
const PACKAGE_ASSET_GROUPS = [
    ['compile', 'Compile Assets'],
    ['runtime', 'Runtime Assets'],
    ['native', 'Native Assets'],
    ['resource', 'Resource Assets'],
    ['build', 'Build Assets'],
    ['buildMultiTargeting', 'Build Multi-Targeting Assets'],
    ['buildTransitive', 'Build Transitive Assets'],
    ['contentFiles', 'Content Files'],
    ['analyzers', 'Analyzers'],
    ['frameworkAssemblies', 'Framework Assemblies'],
    ['runtimeTargets', 'Runtime Targets']
];
exports.PACKAGE_ASSET_GROUPS = PACKAGE_ASSET_GROUPS;
function readLibraryAssetGroups(targetLibrary = {}) {
    const result = {};
    const packageAssetGroups = [];
    for (const [key, label] of PACKAGE_ASSET_GROUPS) {
        const assets = readAssetGroup(targetLibrary[key]);
        result[key] = assets;
        if (assets.length > 0) {
            packageAssetGroups.push({
                key,
                label,
                assets
            });
        }
    }
    result.packageAssetGroups = packageAssetGroups;
    return result;
}
function readAssetGroup(value) {
    if (!value) {
        return [];
    }
    if (Array.isArray(value)) {
        return value.filter(isRealAsset).map(String);
    }
    if (typeof value === 'object') {
        return Object.keys(value).filter(isRealAsset);
    }
    return [];
}
function parseLibraryKey(value) {
    const [name, ...versionParts] = String(value).split('/');
    return {
        name,
        version: versionParts.join('/')
    };
}
function normalizeTargetFramework(value) {
    const firstPart = String(value).split('/')[0];
    const netCore = /^\.NETCoreApp,Version=v(\d+)\.(\d+)/i.exec(firstPart);
    if (netCore) {
        return `net${netCore[1]}.${netCore[2]}`;
    }
    const netStandard = /^\.NETStandard,Version=v(\d+)\.(\d+)/i.exec(firstPart);
    if (netStandard) {
        return `netstandard${netStandard[1]}.${netStandard[2]}`;
    }
    const netFramework = /^\.NETFramework,Version=v(\d+)\.(\d+)/i.exec(firstPart);
    if (netFramework) {
        return `net${netFramework[1]}${netFramework[2]}`;
    }
    return firstPart;
}
function findProjectFramework(frameworks, normalizedFramework, targetName) {
    if (frameworks[normalizedFramework]) {
        return frameworks[normalizedFramework];
    }
    const targetFirstPart = String(targetName).split('/')[0].toLowerCase();
    const match = Object.entries(frameworks).find(([framework]) => {
        const normalized = normalizeTargetFramework(framework).toLowerCase();
        return normalized === normalizedFramework.toLowerCase() || framework.toLowerCase() === targetFirstPart;
    });
    return match ? match[1] : undefined;
}
function sortPackages(packages) {
    return [...packages].sort((left, right) => {
        if (left.direct !== right.direct) {
            return left.direct ? -1 : 1;
        }
        return left.name.localeCompare(right.name, undefined, {
            sensitivity: 'base'
        });
    });
}
