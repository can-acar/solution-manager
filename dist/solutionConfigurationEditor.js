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
exports.readSolutionConfigurationModel = readSolutionConfigurationModel;
exports.applySolutionConfigurationChange = applySolutionConfigurationChange;
// @ts-nocheck
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const SOLUTION_FOLDER_TYPE_GUID = '2150E333-8FDC-42A3-9474-1A3956D46DE8';
const DEFAULT_SOLUTION_CONFIGURATIONS = ['Debug|Any CPU', 'Release|Any CPU'];
function detectEol(text) {
    return /\r\n/.test(text) ? '\r\n' : '\n';
}
function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
async function readTextFile(filePath) {
    const buffer = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
    return Buffer.from(buffer).toString('utf8');
}
async function writeTextFile(filePath, text) {
    await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(text, 'utf8'));
}
function isSlnx(solutionPath) {
    return path.extname(solutionPath).toLowerCase() === '.slnx';
}
async function readSolutionConfigurationModel(solutionPath) {
    const text = await readTextFile(solutionPath);
    return isSlnx(solutionPath)
        ? parseSlnxConfiguration(text, solutionPath)
        : parseSlnConfiguration(text, solutionPath);
}
async function applySolutionConfigurationChange(solutionPath, change) {
    const text = await readTextFile(solutionPath);
    const next = isSlnx(solutionPath)
        ? updateSlnxConfiguration(text, change)
        : updateSlnConfiguration(text, change);
    if (next !== text) {
        await writeTextFile(solutionPath, next);
    }
}
function normalizeGuid(value) {
    return String(value || '').replace(/[{}]/g, '').toUpperCase();
}
function parseSlnConfiguration(text, solutionPath) {
    const solutionDirectory = path.dirname(solutionPath);
    const solutionConfigurations = readSlnSolutionConfigurations(text);
    const projects = readSlnProjects(text, solutionDirectory);
    const entries = readSlnProjectConfigurationEntries(text);
    const projectModels = projects.map((project) => ({
        ...project,
        configurations: solutionConfigurations.map((solutionConfiguration) => {
            const entry = entries.get(project.guid)?.get(solutionConfiguration);
            return {
                solutionConfiguration,
                configPlatform: entry?.configPlatform || solutionConfiguration,
                build: entry ? entry.build : false,
                deploy: entry ? entry.deploy : false,
                mapped: Boolean(entry)
            };
        })
    }));
    return {
        format: 'sln',
        solutionConfigurations,
        configPlatformOptions: solutionConfigurations,
        projects: projectModels
    };
}
function readSlnSolutionConfigurations(text) {
    const section = /GlobalSection\(SolutionConfigurationPlatforms\)\s*=\s*preSolution([\s\S]*?)EndGlobalSection/i.exec(text);
    if (!section) {
        return [...DEFAULT_SOLUTION_CONFIGURATIONS];
    }
    const configurations = [];
    for (const line of section[1].split(/\r?\n/)) {
        const match = line.match(/^\s*([^=]+?)\s*=/);
        if (match) {
            configurations.push(match[1].trim());
        }
    }
    return configurations.length > 0 ? configurations : [...DEFAULT_SOLUTION_CONFIGURATIONS];
}
function readSlnProjects(text, solutionDirectory) {
    const pattern = /Project\("\{([0-9A-Fa-f-]+)\}"\)\s*=\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"\{([0-9A-Fa-f-]+)\}"/g;
    const projects = [];
    let match;
    while ((match = pattern.exec(text)) !== null) {
        const typeGuid = normalizeGuid(match[1]);
        if (typeGuid === SOLUTION_FOLDER_TYPE_GUID) {
            continue;
        }
        const relativePath = match[3].replace(/\\/g, path.sep);
        projects.push({
            guid: normalizeGuid(match[4]),
            name: match[2],
            relativePath: match[3],
            absolutePath: path.resolve(solutionDirectory, relativePath)
        });
    }
    return projects;
}
function readSlnProjectConfigurationEntries(text) {
    const section = /GlobalSection\(ProjectConfigurationPlatforms\)\s*=\s*postSolution([\s\S]*?)EndGlobalSection/i.exec(text);
    const entries = new Map();
    if (!section) {
        return entries;
    }
    const linePattern = /^\s*\{?([0-9A-Fa-f-]{36})\}?\.(.+?)\.(ActiveCfg|Build\.0|Deploy\.0)\s*=\s*(.+?)\s*$/;
    for (const line of section[1].split(/\r?\n/)) {
        const match = line.match(linePattern);
        if (!match) {
            continue;
        }
        const guid = normalizeGuid(match[1]);
        const solutionConfiguration = match[2].trim();
        const kind = match[3];
        const value = match[4].trim();
        if (!entries.has(guid)) {
            entries.set(guid, new Map());
        }
        const guidEntries = entries.get(guid);
        if (!guidEntries.has(solutionConfiguration)) {
            guidEntries.set(solutionConfiguration, { configPlatform: solutionConfiguration, build: false, deploy: false });
        }
        const entry = guidEntries.get(solutionConfiguration);
        if (kind === 'ActiveCfg') {
            entry.configPlatform = value;
        }
        else if (kind === 'Build.0') {
            entry.build = true;
        }
        else if (kind === 'Deploy.0') {
            entry.deploy = true;
        }
    }
    return entries;
}
function updateSlnConfiguration(text, change) {
    const eol = detectEol(text);
    const guid = normalizeGuid(change.projectGuid);
    const solutionConfiguration = change.solutionConfiguration;
    const lines = text.split(/\r\n|\n/);
    const matchesTarget = (line, kind) => {
        const match = line.match(/^\s*\{?([0-9A-Fa-f-]{36})\}?\.(.+?)\.(ActiveCfg|Build\.0|Deploy\.0)\s*=/);
        return match
            && normalizeGuid(match[1]) === guid
            && match[2].trim() === solutionConfiguration
            && (!kind || match[3] === kind);
    };
    const activeCfgIndex = lines.findIndex((line) => matchesTarget(line, 'ActiveCfg'));
    if (activeCfgIndex === -1) {
        return text;
    }
    const indent = (lines[activeCfgIndex].match(/^\s*/) || [''])[0];
    const currentConfigPlatform = (lines[activeCfgIndex].match(/=\s*(.+?)\s*$/) || [null, solutionConfiguration])[1];
    if (change.field === 'configPlatform') {
        const nextValue = change.value;
        for (let index = 0; index < lines.length; index += 1) {
            if (matchesTarget(lines[index])) {
                lines[index] = lines[index].replace(/=\s*.+$/, `= ${nextValue}`);
            }
        }
        return lines.join(eol);
    }
    const kind = change.field === 'deploy' ? 'Deploy.0' : 'Build.0';
    const existingIndex = lines.findIndex((line) => matchesTarget(line, kind));
    if (change.value) {
        if (existingIndex === -1) {
            const insertLine = `${indent}{${guid}}.${solutionConfiguration}.${kind} = ${currentConfigPlatform}`;
            const insertAt = findSlnEntryInsertIndex(lines, activeCfgIndex, kind);
            lines.splice(insertAt, 0, insertLine);
        }
    }
    else if (existingIndex !== -1) {
        lines.splice(existingIndex, 1);
    }
    return lines.join(eol);
}
function findSlnEntryInsertIndex(lines, activeCfgIndex, kind) {
    if (kind === 'Deploy.0') {
        const buildIndex = lines.findIndex((line, index) => {
            if (index <= activeCfgIndex) {
                return false;
            }
            return /\.Build\.0\s*=/.test(line);
        });
        if (buildIndex !== -1) {
            return buildIndex + 1;
        }
    }
    return activeCfgIndex + 1;
}
function parseSlnxConfiguration(text, solutionPath) {
    const solutionDirectory = path.dirname(solutionPath);
    const buildTypes = readSlnxNamedElements(text, 'BuildType');
    const platforms = readSlnxNamedElements(text, 'Platform');
    const effectiveBuildTypes = buildTypes.length ? buildTypes : ['Debug', 'Release'];
    const effectivePlatforms = platforms.length ? platforms : ['Any CPU'];
    const solutionConfigurations = [];
    for (const buildType of effectiveBuildTypes) {
        for (const platform of effectivePlatforms) {
            solutionConfigurations.push(`${buildType}|${platform}`);
        }
    }
    const projects = readSlnxProjects(text, solutionDirectory);
    const projectModels = projects.map((project) => ({
        guid: '',
        name: project.name,
        relativePath: project.relativePath,
        absolutePath: project.absolutePath,
        configurations: solutionConfigurations.map((solutionConfiguration) => {
            const rules = project.rules;
            return {
                solutionConfiguration,
                configPlatform: rules.configuration.get(solutionConfiguration) || solutionConfiguration,
                build: rules.build.has(solutionConfiguration) ? rules.build.get(solutionConfiguration) : true,
                deploy: rules.deploy.has(solutionConfiguration) ? rules.deploy.get(solutionConfiguration) : false,
                mapped: true
            };
        })
    }));
    return {
        format: 'slnx',
        solutionConfigurations,
        configPlatformOptions: solutionConfigurations,
        projects: projectModels
    };
}
function readSlnxNamedElements(text, elementName) {
    const pattern = new RegExp(`<${elementName}\\b[^>]*\\bName\\s*=\\s*"([^"]*)"`, 'gi');
    const values = [];
    let match;
    while ((match = pattern.exec(text)) !== null) {
        values.push(match[1]);
    }
    return values;
}
function readSlnxProjects(text, solutionDirectory) {
    const pattern = /<Project\b[^>]*\bPath\s*=\s*"([^"]*)"[^>]*?(\/>|>([\s\S]*?)<\/Project>)/gi;
    const projects = [];
    let match;
    while ((match = pattern.exec(text)) !== null) {
        const rawPath = match[1];
        const inner = match[3] || '';
        const relativePath = rawPath.replace(/\\/g, path.sep);
        projects.push({
            name: path.basename(rawPath, path.extname(rawPath)),
            relativePath: rawPath,
            absolutePath: path.resolve(solutionDirectory, relativePath),
            rules: readSlnxProjectRules(inner)
        });
    }
    return projects;
}
function readSlnxProjectRules(inner) {
    const configuration = new Map();
    const build = new Map();
    const deploy = new Map();
    const readAttr = (element, attribute) => {
        const match = element.match(new RegExp(`\\b${attribute}\\s*=\\s*"([^"]*)"`, 'i'));
        return match ? match[1] : undefined;
    };
    for (const element of inner.match(/<(Configuration|Build|Deploy)\b[^>]*\/?>/gi) || []) {
        const solution = readAttr(element, 'Solution');
        const project = readAttr(element, 'Project');
        if (!solution) {
            continue;
        }
        if (/^<Configuration/i.test(element) && project) {
            configuration.set(solution, project);
        }
        else if (/^<Build/i.test(element)) {
            build.set(solution, String(project).toLowerCase() !== 'false');
        }
        else if (/^<Deploy/i.test(element)) {
            deploy.set(solution, String(project).toLowerCase() === 'true');
        }
    }
    return { configuration, build, deploy };
}
function updateSlnxConfiguration(text, change) {
    const targetPath = change.projectPath;
    const solutionConfiguration = change.solutionConfiguration;
    const pattern = /<Project\b[^>]*\bPath\s*=\s*"([^"]*)"[^>]*?(\/>|>[\s\S]*?<\/Project>)/gi;
    let result = text;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        if (match[1].replace(/\\/g, '/') !== String(targetPath).replace(/\\/g, '/')) {
            continue;
        }
        const original = match[0];
        const expanded = original.endsWith('/>')
            ? `${original.slice(0, -2)}></Project>`
            : original;
        const updated = applySlnxProjectRule(expanded, solutionConfiguration, change);
        result = result.slice(0, match.index) + updated + result.slice(match.index + original.length);
        break;
    }
    return result;
}
function applySlnxProjectRule(projectElement, solutionConfiguration, change) {
    const elementName = change.field === 'configPlatform'
        ? 'Configuration'
        : change.field === 'deploy'
            ? 'Deploy'
            : 'Build';
    const projectValue = change.field === 'configPlatform'
        ? change.value
        : String(Boolean(change.value));
    const openMatch = projectElement.match(/^(<Project\b[^>]*>)([\s\S]*)(<\/Project>)$/i);
    if (!openMatch) {
        return projectElement;
    }
    const openTag = openMatch[1];
    let inner = openMatch[2];
    const closeTag = openMatch[3];
    const indentMatch = inner.match(/\n(\s*)\S/);
    const indent = indentMatch ? indentMatch[1] : '    ';
    const rulePattern = new RegExp(`\\s*<${elementName}\\b[^>]*\\bSolution\\s*=\\s*"${escapeRegExp(solutionConfiguration)}"[^>]*\\/?>`, 'i');
    const newRule = `<${elementName} Solution="${escapeXml(solutionConfiguration)}" Project="${escapeXml(projectValue)}" />`;
    inner = inner.replace(rulePattern, '');
    const trailingWhitespace = inner.match(/\s*$/)[0];
    inner = `${inner.replace(/\s*$/, '')}\n${indent}${newRule}${trailingWhitespace}`;
    return `${openTag}${inner}${closeTag}`;
}
function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
//# sourceMappingURL=solutionConfigurationEditor.js.map