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
exports.addProjectToSolutionFile = addProjectToSolutionFile;
exports.addProjectToSolutionText = addProjectToSolutionText;
exports.addSolutionFolderToSolutionFile = addSolutionFolderToSolutionFile;
exports.addSolutionFolderToSolutionText = addSolutionFolderToSolutionText;
exports.saveSolutionAs = saveSolutionAs;
const crypto = __importStar(require("crypto"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const PROJECT_TYPE_GUIDS = {
    '.csproj': '{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}',
    '.fsproj': '{F2A71F9B-5D33-465A-A702-920D77279786}',
    '.vbproj': '{F184B08F-C81C-45F6-A57F-5ABD9991F28F}',
    '.proj': '{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}'
};
const SOLUTION_FOLDER_TYPE_GUID = '{2150E333-8FDC-42A3-9474-1A3956D46DE8}';
const DEFAULT_SOLUTION_CONFIGURATIONS = ['Debug|Any CPU', 'Release|Any CPU'];
async function addProjectToSolutionFile(solutionPath, projectPath, options = {}) {
    const text = await readTextFile(solutionPath);
    const result = addProjectToSolutionText(text, solutionPath, projectPath, options);
    if (result.changed) {
        await writeTextFile(solutionPath, result.text);
    }
    return result;
}
async function addSolutionFolderToSolutionFile(solutionPath, folderPath, options = {}) {
    const text = await readTextFile(solutionPath);
    const result = addSolutionFolderToSolutionText(text, solutionPath, folderPath, options);
    if (result.changed) {
        await writeTextFile(solutionPath, result.text);
    }
    return result;
}
async function saveSolutionAs(sourcePath, targetPath) {
    const text = await readTextFile(sourcePath);
    await writeTextFile(targetPath, text);
}
function addProjectToSolutionText(text, solutionPath, projectPath, options = {}) {
    const extension = path.extname(solutionPath).toLowerCase();
    if (extension === '.slnx') {
        return addProjectToSlnxText(text, solutionPath, projectPath, options);
    }
    return addProjectToSlnText(text, solutionPath, projectPath, options);
}
function addSolutionFolderToSolutionText(text, solutionPath, folderPath, options = {}) {
    const extension = path.extname(solutionPath).toLowerCase();
    const parts = getFolderParts(folderPath);
    if (parts.length === 0) {
        return {
            text,
            changed: false
        };
    }
    if (extension === '.slnx') {
        return addSolutionFolderToSlnxText(text, parts);
    }
    const result = ensureSlnFolderPath(text, parts, options.createGuid);
    return {
        text: result.text,
        changed: result.changed,
        folderGuid: result.folderGuid
    };
}
function addProjectToSlnText(text, solutionPath, projectPath, options = {}) {
    const relativePath = toSlnRelativePath(solutionPath, projectPath);
    const existingPaths = readSlnProjectPaths(text);
    if (existingPaths.has(normalizeRelativePath(relativePath))) {
        return {
            text,
            changed: false,
            relativePath
        };
    }
    const folderResult = ensureSlnFolderPath(text, getFolderParts(options.solutionFolder), options.createGuid);
    const projectGuid = createGuid(options.createGuid);
    const projectName = options.name || path.basename(projectPath, path.extname(projectPath));
    const projectTypeGuid = PROJECT_TYPE_GUIDS[path.extname(projectPath).toLowerCase()] || PROJECT_TYPE_GUIDS['.csproj'];
    const eol = detectEol(folderResult.text);
    const projectBlock = [
        `Project("${projectTypeGuid}") = "${escapeSlnValue(projectName)}", "${escapeSlnValue(relativePath)}", "${projectGuid}"`,
        'EndProject'
    ].join(eol);
    let nextText = insertSlnProjectBlock(folderResult.text, projectBlock);
    nextText = ensureSlnNestedMapping(nextText, projectGuid, folderResult.folderGuid);
    nextText = ensureSlnProjectConfigurations(nextText, projectGuid);
    return {
        text: nextText,
        changed: true,
        projectGuid,
        relativePath
    };
}
function addSolutionFolderToSlnxText(text, parts) {
    const existingFolders = readSlnxFolderPaths(text);
    const folderPath = parts.join('/');
    if (existingFolders.has(folderPath.toLowerCase())) {
        return {
            text,
            changed: false
        };
    }
    return {
        text: insertSlnxBlock(text, createSlnxFolderBlock(parts)),
        changed: true
    };
}
function addProjectToSlnxText(text, solutionPath, projectPath, options = {}) {
    const relativePath = toSlnxRelativePath(solutionPath, projectPath);
    const existingPaths = readSlnxProjectPaths(text);
    if (existingPaths.has(normalizeRelativePath(relativePath))) {
        return {
            text,
            changed: false,
            relativePath
        };
    }
    const folderParts = getFolderParts(options.solutionFolder);
    const projectLine = `<Project Path="${escapeXml(relativePath)}" />`;
    const block = folderParts.length > 0
        ? createSlnxFolderBlock(folderParts, projectLine)
        : `  ${projectLine}`;
    return {
        text: insertSlnxBlock(text, block),
        changed: true,
        relativePath
    };
}
function ensureSlnFolderPath(text, parts, createGuidFn) {
    let nextText = text;
    let changed = false;
    let parentGuid;
    const folders = readSlnFolders(nextText);
    let currentPath = '';
    for (const part of parts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        const key = currentPath.toLowerCase();
        let folderGuid = folders.pathToGuid.get(key);
        if (!folderGuid) {
            folderGuid = createGuid(createGuidFn);
            const eol = detectEol(nextText);
            const folderBlock = [
                `Project("${SOLUTION_FOLDER_TYPE_GUID}") = "${escapeSlnValue(part)}", "${escapeSlnValue(part)}", "${folderGuid}"`,
                'EndProject'
            ].join(eol);
            nextText = insertSlnProjectBlock(nextText, folderBlock);
            folders.pathToGuid.set(key, folderGuid);
            folders.foldersByGuid.set(folderGuid.toLowerCase(), part);
            changed = true;
        }
        if (parentGuid) {
            const nestedResult = ensureSlnNestedMapping(nextText, folderGuid, parentGuid);
            changed = changed || nestedResult !== nextText;
            nextText = nestedResult;
        }
        parentGuid = folderGuid;
    }
    return {
        text: nextText,
        changed,
        folderGuid: parentGuid
    };
}
function readSlnProjectPaths(text) {
    const result = new Set();
    const projectPattern = /^Project\("[^"]+"\)\s*=\s*"[^"]+",\s*"([^"]+)",\s*"[^"]+"/gmi;
    let match = projectPattern.exec(text);
    while (match) {
        const extension = path.extname(match[1]).toLowerCase();
        if (PROJECT_TYPE_GUIDS[extension]) {
            result.add(normalizeRelativePath(match[1]));
        }
        match = projectPattern.exec(text);
    }
    return result;
}
function readSlnFolders(text) {
    const foldersByGuid = new Map();
    const parentByGuid = new Map();
    const pathToGuid = new Map();
    const projectPattern = /^Project\("([^"]+)"\)\s*=\s*"([^"]+)",\s*"[^"]+",\s*"([^"]+)"/gmi;
    let match = projectPattern.exec(text);
    while (match) {
        if (normalizeGuid(match[1]) === normalizeGuid(SOLUTION_FOLDER_TYPE_GUID)) {
            foldersByGuid.set(normalizeGuid(match[3]), match[2]);
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
    for (const guid of foldersByGuid.keys()) {
        const parts = getSlnFolderPath(guid, foldersByGuid, parentByGuid);
        if (parts.length > 0) {
            pathToGuid.set(parts.join('/').toLowerCase(), guid.toUpperCase());
        }
    }
    return {
        foldersByGuid,
        parentByGuid,
        pathToGuid
    };
}
function readSlnxProjectPaths(text) {
    const result = new Set();
    const projectPattern = /<(?:Project|project)\b[^>]*(?:Path|path)=["']([^"']+)["']/g;
    let match = projectPattern.exec(text);
    while (match) {
        result.add(normalizeRelativePath(match[1]));
        match = projectPattern.exec(text);
    }
    return result;
}
function readSlnxFolderPaths(text) {
    const result = new Set();
    const stack = [];
    for (const line of text.split(/\r?\n/)) {
        const folderOpen = line.match(/<Folder\b[^>]*(?:Name|name)=["']([^"']+)["'][^>]*>/);
        if (folderOpen) {
            const parts = getFolderParts(folderOpen[1]);
            stack.push(parts);
            result.add(stack.flat().join('/').toLowerCase());
            if (/\/>\s*$/.test(line)) {
                stack.pop();
            }
        }
        if (/<\/Folder>/i.test(line) && stack.length > 0) {
            stack.pop();
        }
    }
    return result;
}
function getSlnFolderPath(guid, foldersByGuid, parentByGuid) {
    const result = [];
    const seen = new Set();
    let current = normalizeGuid(guid);
    while (current && foldersByGuid.has(current) && !seen.has(current)) {
        seen.add(current);
        result.unshift(foldersByGuid.get(current));
        current = parentByGuid.get(current);
    }
    return result;
}
function insertSlnProjectBlock(text, block) {
    const eol = detectEol(text);
    const normalizedBlock = block.endsWith(eol) ? block : `${block}${eol}`;
    const globalMatch = /^Global\b/mi.exec(text);
    if (globalMatch) {
        return `${text.slice(0, globalMatch.index)}${normalizedBlock}${text.slice(globalMatch.index)}`;
    }
    return `${text.trimEnd()}${eol}${normalizedBlock}`;
}
function ensureSlnNestedMapping(text, childGuid, parentGuid) {
    if (!childGuid || !parentGuid) {
        return text;
    }
    const normalizedChild = normalizeGuid(childGuid);
    const normalizedParent = normalizeGuid(parentGuid);
    const existingPattern = new RegExp(`${escapeRegExp(normalizedChild)}\\s*=\\s*${escapeRegExp(normalizedParent)}`, 'i');
    if (existingPattern.test(text)) {
        return text;
    }
    const eol = detectEol(text);
    const line = `\t\t${childGuid.toUpperCase()} = ${parentGuid.toUpperCase()}`;
    const sectionPattern = /(GlobalSection\(NestedProjects\)\s*=\s*preSolution[\s\S]*?)(\s*EndGlobalSection)/i;
    if (sectionPattern.test(text)) {
        return text.replace(sectionPattern, `$1${eol}${line}$2`);
    }
    const section = `\tGlobalSection(NestedProjects) = preSolution${eol}${line}${eol}\tEndGlobalSection${eol}`;
    return insertSlnGlobalSection(text, section);
}
function ensureSlnProjectConfigurations(text, projectGuid) {
    const eol = detectEol(text);
    const configurations = readSlnConfigurations(text);
    const existingPattern = new RegExp(`${escapeRegExp(projectGuid)}\\.[^.]+\\.ActiveCfg`, 'i');
    if (existingPattern.test(text)) {
        return text;
    }
    const lines = configurations.flatMap((configuration) => [
        `\t\t${projectGuid}.${configuration}.ActiveCfg = ${configuration}`,
        `\t\t${projectGuid}.${configuration}.Build.0 = ${configuration}`
    ]);
    const sectionPattern = /(GlobalSection\(ProjectConfigurationPlatforms\)\s*=\s*postSolution[\s\S]*?)(\s*EndGlobalSection)/i;
    if (sectionPattern.test(text)) {
        return text.replace(sectionPattern, `$1${eol}${lines.join(eol)}$2`);
    }
    const section = `\tGlobalSection(ProjectConfigurationPlatforms) = postSolution${eol}${lines.join(eol)}${eol}\tEndGlobalSection${eol}`;
    return insertSlnGlobalSection(text, section);
}
function readSlnConfigurations(text) {
    const section = /GlobalSection\(SolutionConfigurationPlatforms\)\s*=\s*preSolution([\s\S]*?)EndGlobalSection/i.exec(text);
    if (!section) {
        return DEFAULT_SOLUTION_CONFIGURATIONS;
    }
    const configurations = [];
    for (const line of section[1].split(/\r?\n/)) {
        const match = line.match(/^\s*([^=]+?)\s*=/);
        if (match) {
            configurations.push(match[1].trim());
        }
    }
    return configurations.length > 0 ? configurations : DEFAULT_SOLUTION_CONFIGURATIONS;
}
function insertSlnGlobalSection(text, section) {
    const endGlobalMatch = /^EndGlobal\b/mi.exec(text);
    const eol = detectEol(text);
    if (endGlobalMatch) {
        return `${text.slice(0, endGlobalMatch.index)}${section}${text.slice(endGlobalMatch.index)}`;
    }
    return `${text.trimEnd()}${eol}Global${eol}${section}EndGlobal${eol}`;
}
function createSlnxFolderBlock(parts, innerLine) {
    const eol = '\n';
    const lines = [];
    parts.forEach((part, index) => {
        lines.push(`${'  '.repeat(index + 1)}<Folder Name="${escapeXml(part)}">`);
    });
    if (innerLine) {
        lines.push(`${'  '.repeat(parts.length + 1)}${innerLine}`);
    }
    for (let index = parts.length - 1; index >= 0; index -= 1) {
        lines.push(`${'  '.repeat(index + 1)}</Folder>`);
    }
    return lines.join(eol);
}
function insertSlnxBlock(text, block) {
    const eol = detectEol(text);
    const source = text.trim() ? text : `<Solution>${eol}</Solution>${eol}`;
    const normalizedBlock = block.replace(/\n/g, eol);
    const closingPattern = /<\/Solution>\s*$/i;
    if (closingPattern.test(source)) {
        return source.replace(closingPattern, `${normalizedBlock}${eol}</Solution>${eol}`);
    }
    return `${source.trimEnd()}${eol}${normalizedBlock}${eol}`;
}
function getFolderParts(value) {
    return String(value || '')
        .replace(/\\/g, '/')
        .split('/')
        .map((part) => part.trim())
        .filter(Boolean);
}
function toSlnRelativePath(solutionPath, targetPath) {
    return path.relative(path.dirname(solutionPath), targetPath).replace(/\//g, '\\');
}
function toSlnxRelativePath(solutionPath, targetPath) {
    return path.relative(path.dirname(solutionPath), targetPath).replace(/\\/g, '/');
}
function normalizeRelativePath(value) {
    return String(value || '').replace(/\\/g, '/').toLowerCase();
}
function normalizeGuid(value) {
    return String(value || '').toLowerCase();
}
function createGuid(createGuidFn) {
    const value = createGuidFn ? createGuidFn() : crypto.randomUUID();
    const normalized = String(value).replace(/[{}]/g, '').toUpperCase();
    return `{${normalized}}`;
}
function detectEol(text) {
    return /\r\n/.test(text) ? '\r\n' : '\n';
}
function escapeSlnValue(value) {
    return String(value).replace(/"/g, '\\"');
}
function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
async function readTextFile(filePath) {
    const buffer = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
    return Buffer.from(buffer).toString('utf8');
}
async function writeTextFile(filePath, text) {
    await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(text, 'utf8'));
}
const __test = {
    addProjectToSolutionText,
    addSolutionFolderToSolutionText,
    readSlnFolders,
    readSlnxFolderPaths,
    readSlnxProjectPaths
};
exports.__test = __test;
//# sourceMappingURL=solutionFileEditor.js.map