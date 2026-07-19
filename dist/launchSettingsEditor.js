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
exports.addLaunchProfileToData = addLaunchProfileToData;
exports.addProjectLaunchProfile = addProjectLaunchProfile;
exports.duplicateLaunchProfileInData = duplicateLaunchProfileInData;
exports.duplicateProjectLaunchProfile = duplicateProjectLaunchProfile;
exports.ensureLaunchSettingsFile = ensureLaunchSettingsFile;
exports.getLaunchSettingsPath = getLaunchSettingsPath;
exports.normalizeLaunchSettings = normalizeLaunchSettings;
exports.parseEnvironmentVariables = parseEnvironmentVariables;
exports.readProjectLaunchSettings = readProjectLaunchSettings;
exports.readProjectLaunchSettingsFromText = readProjectLaunchSettingsFromText;
exports.removeLaunchProfileFromData = removeLaunchProfileFromData;
exports.removeProjectLaunchProfile = removeProjectLaunchProfile;
exports.serializeEnvironmentVariables = serializeEnvironmentVariables;
exports.updateLaunchSettingsData = updateLaunchSettingsData;
exports.updateProjectLaunchSettings = updateProjectLaunchSettings;
// @ts-nocheck
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
function getLaunchSettingsPath(projectPath) {
    return path.join(path.dirname(projectPath), 'Properties', 'launchSettings.json');
}
async function readProjectLaunchSettings(projectPath) {
    const launchPath = getLaunchSettingsPath(projectPath);
    try {
        const buffer = await vscode.workspace.fs.readFile(vscode.Uri.file(launchPath));
        return readProjectLaunchSettingsFromText(Buffer.from(buffer).toString('utf8'), launchPath, true);
    }
    catch {
        return normalizeLaunchSettings({}, launchPath, false);
    }
}
function readProjectLaunchSettingsFromText(text, launchPath = '', exists = true) {
    return normalizeLaunchSettings(JSON.parse(text), launchPath, exists);
}
async function updateProjectLaunchSettings(projectPath, profileUpdates = []) {
    if (!Array.isArray(profileUpdates) || profileUpdates.length === 0) {
        return readProjectLaunchSettings(projectPath);
    }
    const launchPath = getLaunchSettingsPath(projectPath);
    const current = await readLaunchSettingsData(launchPath);
    const next = updateLaunchSettingsData(current, profileUpdates);
    await writeLaunchSettings(launchPath, next);
    return normalizeLaunchSettings(next, launchPath, true);
}
async function addProjectLaunchProfile(projectPath, profileName) {
    const launchPath = getLaunchSettingsPath(projectPath);
    const current = await readLaunchSettingsData(launchPath);
    const next = addLaunchProfileToData(current, profileName);
    await writeLaunchSettings(launchPath, next);
    return normalizeLaunchSettings(next, launchPath, true);
}
async function removeProjectLaunchProfile(projectPath, profileName) {
    const launchPath = getLaunchSettingsPath(projectPath);
    const current = await readLaunchSettingsData(launchPath);
    const next = removeLaunchProfileFromData(current, profileName);
    await writeLaunchSettings(launchPath, next);
    return normalizeLaunchSettings(next, launchPath, true);
}
async function duplicateProjectLaunchProfile(projectPath, profileName) {
    const launchPath = getLaunchSettingsPath(projectPath);
    const current = await readLaunchSettingsData(launchPath);
    const next = duplicateLaunchProfileInData(current, profileName);
    await writeLaunchSettings(launchPath, next);
    return normalizeLaunchSettings(next, launchPath, true);
}
async function ensureLaunchSettingsFile(projectPath, projectName) {
    const launchPath = getLaunchSettingsPath(projectPath);
    try {
        await vscode.workspace.fs.stat(vscode.Uri.file(launchPath));
        return launchPath;
    }
    catch {
        const profileName = projectName || path.basename(projectPath, path.extname(projectPath));
        await writeLaunchSettings(launchPath, {
            profiles: {
                [profileName]: {
                    commandName: 'Project'
                }
            }
        });
        return launchPath;
    }
}
function updateLaunchSettingsData(data = {}, profileUpdates = []) {
    const next = cloneJsonObject(data);
    next.profiles = next.profiles && typeof next.profiles === 'object' ? { ...next.profiles } : {};
    for (const update of profileUpdates) {
        const originalName = String(update.originalName || '').trim();
        const name = String(update.name || originalName).trim();
        if (update.remove) {
            if (originalName) {
                delete next.profiles[originalName];
            }
            continue;
        }
        if (!name) {
            continue;
        }
        const existing = cloneJsonObject(next.profiles[originalName] || next.profiles[name] || {});
        if (originalName && originalName !== name) {
            delete next.profiles[originalName];
        }
        setStringProperty(existing, 'commandName', update.commandName);
        setStringProperty(existing, 'executablePath', update.executablePath);
        setStringProperty(existing, 'commandLineArgs', update.commandLineArgs);
        setStringProperty(existing, 'workingDirectory', update.workingDirectory);
        setBooleanProperty(existing, 'launchBrowser', update.launchBrowser);
        setStringProperty(existing, 'launchUrl', update.launchUrl);
        setStringProperty(existing, 'applicationUrl', update.applicationUrl);
        setEnvironmentVariables(existing, update.environmentVariables);
        next.profiles[name] = existing;
    }
    return next;
}
function addLaunchProfileToData(data = {}, profileName = '') {
    const next = cloneJsonObject(data);
    next.profiles = next.profiles && typeof next.profiles === 'object' ? { ...next.profiles } : {};
    const name = getUniqueProfileName(next.profiles, profileName || 'New Profile');
    next.profiles[name] = {
        commandName: 'Project'
    };
    return next;
}
function removeLaunchProfileFromData(data = {}, profileName = '') {
    const next = cloneJsonObject(data);
    next.profiles = next.profiles && typeof next.profiles === 'object' ? { ...next.profiles } : {};
    const name = String(profileName || '').trim();
    if (name) {
        delete next.profiles[name];
    }
    return next;
}
function duplicateLaunchProfileInData(data = {}, profileName = '') {
    const next = cloneJsonObject(data);
    next.profiles = next.profiles && typeof next.profiles === 'object' ? { ...next.profiles } : {};
    const name = String(profileName || '').trim();
    if (!name || !next.profiles[name]) {
        return next;
    }
    const copyName = getUniqueProfileName(next.profiles, `${name} Copy`);
    next.profiles[copyName] = cloneJsonObject(next.profiles[name]);
    return next;
}
function normalizeLaunchSettings(data = {}, launchPath = '', exists = false) {
    const profiles = Object.entries(data.profiles || {})
        .map(([name, profile]) => ({
        name,
        commandName: stringValue(profile.commandName),
        executablePath: stringValue(profile.executablePath),
        commandLineArgs: stringValue(profile.commandLineArgs),
        workingDirectory: stringValue(profile.workingDirectory),
        launchBrowser: profile.launchBrowser === undefined ? '' : String(Boolean(profile.launchBrowser)),
        launchUrl: stringValue(profile.launchUrl),
        applicationUrl: stringValue(profile.applicationUrl),
        environmentVariables: profile.environmentVariables && typeof profile.environmentVariables === 'object'
            ? profile.environmentVariables
            : {}
    }))
        .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
    return {
        path: launchPath,
        exists,
        profiles,
        raw: data
    };
}
function serializeEnvironmentVariables(value = {}) {
    return Object.entries(value)
        .map(([name, variableValue]) => `${name}=${variableValue}`)
        .join('\n');
}
function parseEnvironmentVariables(value = '') {
    const result = {};
    for (const line of String(value).split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        const separator = trimmed.indexOf('=');
        if (separator <= 0) {
            continue;
        }
        const name = trimmed.slice(0, separator).trim();
        const variableValue = trimmed.slice(separator + 1).trim();
        if (name) {
            result[name] = variableValue;
        }
    }
    return result;
}
async function writeLaunchSettings(launchPath, data) {
    const uri = vscode.Uri.file(launchPath);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(launchPath)));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8'));
}
async function readLaunchSettingsData(launchPath) {
    let buffer;
    try {
        buffer = await vscode.workspace.fs.readFile(vscode.Uri.file(launchPath));
    }
    catch {
        return {};
    }
    const text = Buffer.from(buffer).toString('utf8').replace(/^﻿/, '');
    if (!text.trim()) {
        return {};
    }
    try {
        return JSON.parse(text);
    }
    catch {
        throw new Error(`launchSettings.json is not valid JSON and was left unchanged: ${launchPath}`);
    }
}
function getUniqueProfileName(profiles, requestedName) {
    const baseName = String(requestedName || 'New Profile').trim() || 'New Profile';
    if (!profiles[baseName]) {
        return baseName;
    }
    let index = 2;
    let candidate = `${baseName} ${index}`;
    while (profiles[candidate]) {
        index += 1;
        candidate = `${baseName} ${index}`;
    }
    return candidate;
}
function setStringProperty(target, name, value) {
    const normalized = String(value ?? '').trim();
    if (normalized) {
        target[name] = normalized;
    }
    else {
        delete target[name];
    }
}
function setBooleanProperty(target, name, value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized) {
        delete target[name];
        return;
    }
    target[name] = normalized === 'true';
}
function setEnvironmentVariables(target, value) {
    const parsed = parseEnvironmentVariables(value);
    if (Object.keys(parsed).length > 0) {
        target.environmentVariables = parsed;
    }
    else {
        delete target.environmentVariables;
    }
}
function cloneJsonObject(value) {
    return JSON.parse(JSON.stringify(value || {}));
}
function stringValue(value) {
    return value === undefined || value === null ? '' : String(value);
}
//# sourceMappingURL=launchSettingsEditor.js.map