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
exports.removeProjectConfiguration = removeProjectConfiguration;
exports.removeProjectConfigurationInText = removeProjectConfigurationInText;
exports.updateProjectProperties = updateProjectProperties;
exports.updateProjectPropertiesInText = updateProjectPropertiesInText;
exports.updateProjectItemReferences = updateProjectItemReferences;
exports.updateProjectItemReferencesInText = updateProjectItemReferencesInText;
// @ts-nocheck
const vscode = __importStar(require("vscode"));
function updateProjectPropertiesInText(text, updates) {
    const entries = normalizeUpdates(updates);
    const configurationUpdates = normalizeConfigurationUpdates(updates);
    let nextText = text;
    if (entries.length > 0) {
        nextText = updateUnconditionalProperties(nextText, entries);
    }
    for (const update of configurationUpdates) {
        nextText = updateConfigurationProperties(nextText, update);
    }
    return nextText;
}
function updateUnconditionalProperties(text, entries) {
    const targetGroup = findEditablePropertyGroup(text);
    if (!targetGroup) {
        return insertPropertyGroup(text, entries);
    }
    let body = targetGroup.body;
    const indent = detectPropertyIndent(body);
    for (const [name, value] of entries) {
        body = upsertProperty(body, name, value, indent);
    }
    return `${text.slice(0, targetGroup.bodyStart)}${body}${text.slice(targetGroup.bodyEnd)}`;
}
async function updateProjectProperties(projectPath, updates) {
    const uri = vscode.Uri.file(projectPath);
    const buffer = await vscode.workspace.fs.readFile(uri);
    const currentText = Buffer.from(buffer).toString('utf8');
    const nextText = updateProjectPropertiesInText(currentText, updates);
    if (nextText !== currentText) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(nextText, 'utf8'));
    }
    return nextText;
}
async function updateProjectItemReferences(projectPath, operations) {
    const uri = vscode.Uri.file(projectPath);
    const buffer = await vscode.workspace.fs.readFile(uri);
    const currentText = Buffer.from(buffer).toString('utf8');
    const nextText = updateProjectItemReferencesInText(currentText, operations);
    if (nextText !== currentText) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(nextText, 'utf8'));
    }
    return nextText;
}
async function removeProjectConfiguration(projectPath, configuration, platform = 'AnyCPU') {
    const uri = vscode.Uri.file(projectPath);
    const buffer = await vscode.workspace.fs.readFile(uri);
    const currentText = Buffer.from(buffer).toString('utf8');
    const nextText = removeProjectConfigurationInText(currentText, configuration, platform);
    if (nextText !== currentText) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(nextText, 'utf8'));
    }
    return nextText;
}
function removeProjectConfigurationInText(text, configuration, platform = 'AnyCPU') {
    const safeConfiguration = sanitizeConditionPart(configuration);
    const safePlatform = sanitizeConditionPart(platform || 'AnyCPU');
    if (!safeConfiguration || !safePlatform) {
        return text;
    }
    const targetGroup = findConfigurationPropertyGroup(text, safeConfiguration, safePlatform);
    if (!targetGroup) {
        return text;
    }
    return `${text.slice(0, targetGroup.start)}${text.slice(targetGroup.end)}`;
}
function updateProjectItemReferencesInText(text, operations = []) {
    return operations.reduce((nextText, operation) => {
        const normalized = normalizeItemReferenceOperation(operation);
        if (!normalized) {
            return nextText;
        }
        if (normalized.action === 'remove') {
            return removeItemReference(nextText, normalized);
        }
        return upsertItemReference(nextText, normalized);
    }, text);
}
function normalizeUpdates(updates = {}) {
    const source = updates && updates.properties && typeof updates.properties === 'object'
        ? updates.properties
        : updates;
    return Object.entries(source || {})
        .filter(([name]) => /^[A-Za-z_][\w.-]*$/.test(name))
        .filter(([name]) => name !== 'configurations' && name !== 'properties')
        .map(([name, value]) => [name, value === undefined || value === null ? '' : String(value).trim()]);
}
function normalizeItemReferenceOperation(operation = {}) {
    const elementName = String(operation.elementName || '').trim();
    const include = String(operation.include || operation.name || '').trim();
    const action = operation.action === 'remove' ? 'remove' : 'add';
    const identityAttribute = normalizeItemIdentityAttribute(operation.identityAttribute);
    const groupCondition = operation.groupCondition === undefined || operation.groupCondition === null
        ? undefined
        : String(operation.groupCondition).trim();
    if (!/^[A-Za-z_][\w.-]*$/.test(elementName) || !include) {
        return undefined;
    }
    const metadata = Object.entries(operation.metadata || {})
        .filter(([name, value]) => /^[A-Za-z_][\w.-]*$/.test(name) && value !== undefined && value !== null && String(value).trim() !== '')
        .map(([name, value]) => [name, String(value).trim()]);
    return {
        action,
        elementName,
        include,
        identityAttribute,
        groupCondition,
        metadata
    };
}
function upsertItemReference(text, operation) {
    const existing = findItemReference(text, operation.elementName, operation.include, operation.groupCondition);
    const markup = createItemReferenceMarkup(operation, existing?.indent || '    ');
    if (existing) {
        return `${text.slice(0, existing.start)}${markup}${text.slice(existing.end)}`;
    }
    return insertItemReference(text, operation);
}
function removeItemReference(text, operation) {
    const existing = findItemReference(text, operation.elementName, operation.include, operation.groupCondition);
    if (!existing) {
        return text;
    }
    const nextText = `${text.slice(0, existing.start)}${text.slice(existing.end)}`;
    return removeEmptyItemGroups(nextText);
}
function findItemReference(text, elementName, include, groupCondition) {
    const itemGroupPattern = /<ItemGroup\b([^>]*)>([\s\S]*?)<\/ItemGroup>/gi;
    let groupMatch = itemGroupPattern.exec(text);
    while (groupMatch) {
        const groupAttrs = readXmlAttributes(groupMatch[1] || '');
        const currentGroupCondition = String(groupAttrs.Condition || '').trim();
        if (groupCondition !== undefined && currentGroupCondition !== groupCondition) {
            groupMatch = itemGroupPattern.exec(text);
            continue;
        }
        const groupBody = groupMatch[2] || '';
        const groupBodyStart = groupMatch.index + groupMatch[0].indexOf(groupBody);
        const itemPattern = new RegExp(`(^[ \\t]*)<${escapeRegExp(elementName)}\\b([^>]*)\\/>\\s*\\r?\\n?|(^[ \\t]*)<${escapeRegExp(elementName)}\\b([^>]*)>[\\s\\S]*?<\\/${escapeRegExp(elementName)}>\\s*\\r?\\n?`, 'gmi');
        let itemMatch = itemPattern.exec(groupBody);
        while (itemMatch) {
            const attrs = readXmlAttributes(itemMatch[2] || itemMatch[4] || '');
            const candidate = attrs.Include || attrs.Update || attrs.Remove;
            if (candidate && normalizeReferenceIdentity(candidate) === normalizeReferenceIdentity(include)) {
                return {
                    start: groupBodyStart + itemMatch.index,
                    end: groupBodyStart + itemMatch.index + itemMatch[0].length,
                    indent: itemMatch[1] || itemMatch[3] || '    '
                };
            }
            itemMatch = itemPattern.exec(groupBody);
        }
        groupMatch = itemGroupPattern.exec(text);
    }
    return undefined;
}
function insertItemReference(text, operation) {
    const itemGroup = findEditableItemGroup(text, operation.groupCondition);
    const markup = createItemReferenceMarkup(operation, detectItemIndent(itemGroup?.body || ''));
    if (itemGroup) {
        const trailingIndent = /([ \t]*)$/.exec(itemGroup.body)?.[1] || '';
        const insertAt = itemGroup.bodyEnd - trailingIndent.length;
        const separator = text.slice(0, insertAt).endsWith('\n') || itemGroup.body.trim() === '' ? '' : '\n';
        return `${text.slice(0, insertAt)}${separator}${markup}${text.slice(insertAt)}`;
    }
    return insertItemGroup(text, operation);
}
function insertItemGroup(text, operation) {
    const projectClose = /<\/Project>\s*$/i.exec(text);
    if (!projectClose) {
        throw new Error('Project file does not contain a closing </Project> element.');
    }
    const groupCondition = operation.groupCondition === undefined ? '' : String(operation.groupCondition).trim();
    const conditionAttribute = groupCondition ? ` Condition="${escapeXmlAttribute(groupCondition)}"` : '';
    const group = [
        '',
        `  <ItemGroup${conditionAttribute}>`,
        createItemReferenceMarkup(operation, '    ').trimEnd(),
        '  </ItemGroup>',
        ''
    ].join('\n');
    return `${text.slice(0, projectClose.index)}${group}${text.slice(projectClose.index)}`;
}
function findEditableItemGroup(text, groupCondition) {
    const pattern = /<ItemGroup\b([^>]*)>([\s\S]*?)<\/ItemGroup>/gi;
    const hasExplicitGroupCondition = groupCondition !== undefined;
    const expectedGroupCondition = hasExplicitGroupCondition ? String(groupCondition).trim() : '';
    let match = pattern.exec(text);
    while (match) {
        const attrs = readXmlAttributes(match[1] || '');
        const currentGroupCondition = String(attrs.Condition || '').trim();
        if ((hasExplicitGroupCondition && currentGroupCondition === expectedGroupCondition) ||
            (!hasExplicitGroupCondition && currentGroupCondition === '')) {
            const bodyStart = match.index + match[0].indexOf(match[2]);
            return {
                body: match[2],
                bodyEnd: bodyStart + match[2].length
            };
        }
        match = pattern.exec(text);
    }
    return undefined;
}
function createItemReferenceMarkup(operation, indent) {
    const attributes = [
        [operation.identityAttribute || 'Include', operation.include],
        ...operation.metadata
    ]
        .filter(([, value]) => value !== undefined && value !== '')
        .map(([name, value]) => `${name}="${escapeXmlAttribute(value)}"`)
        .join(' ');
    return `${indent}<${operation.elementName}${attributes ? ` ${attributes}` : ''} />\n`;
}
function normalizeItemIdentityAttribute(value) {
    return ['Include', 'Update', 'Remove'].includes(value) ? value : 'Include';
}
function removeEmptyItemGroups(text) {
    return text.replace(/\n?[ \t]*<ItemGroup\b[^>]*>\s*<\/ItemGroup>\s*/gi, '\n');
}
function detectItemIndent(body) {
    const match = /\n([ \t]+)<[A-Za-z_][\w.-]*\b/.exec(body || '');
    return match ? match[1] : '    ';
}
function normalizeReferenceIdentity(value) {
    return String(value || '').replace(/\\/g, '/').toLowerCase();
}
function readXmlAttributes(value) {
    const attrs = {};
    const pattern = /([A-Za-z_][\w.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let match = pattern.exec(value || '');
    while (match) {
        attrs[match[1]] = unescapeXmlAttribute(match[3] ?? match[4] ?? '');
        match = pattern.exec(value || '');
    }
    return attrs;
}
function normalizeConfigurationUpdates(updates = {}) {
    const values = Array.isArray(updates.configurations) ? updates.configurations : [];
    return values
        .map((entry) => ({
        configuration: sanitizeConditionPart(entry.configuration),
        platform: sanitizeConditionPart(entry.platform || 'AnyCPU'),
        entries: normalizeUpdates(entry.properties || {})
    }))
        .filter((entry) => entry.configuration && entry.platform && entry.entries.length > 0);
}
function findEditablePropertyGroup(text) {
    const pattern = /<PropertyGroup\b([^>]*)>([\s\S]*?)<\/PropertyGroup>/gi;
    let match = pattern.exec(text);
    while (match) {
        const attrs = match[1] || '';
        const bodyStart = match.index + match[0].indexOf(match[2]);
        const bodyEnd = bodyStart + match[2].length;
        const group = {
            attrs,
            body: match[2],
            bodyStart,
            bodyEnd
        };
        if (!/\bCondition\s*=/.test(attrs)) {
            return group;
        }
        match = pattern.exec(text);
    }
    return undefined;
}
function insertPropertyGroup(text, entries) {
    const projectOpen = /<Project\b[^>]*>/i.exec(text);
    if (!projectOpen) {
        throw new Error('Project file does not contain a <Project> root element.');
    }
    const group = [
        '',
        '  <PropertyGroup>',
        ...entries
            .filter(([, value]) => value !== '')
            .map(([name, value]) => `    <${name}>${escapeXml(value)}</${name}>`),
        '  </PropertyGroup>'
    ].join('\n');
    const insertAt = projectOpen.index + projectOpen[0].length;
    return `${text.slice(0, insertAt)}${group}${text.slice(insertAt)}`;
}
function updateConfigurationProperties(text, update) {
    const targetGroup = findConfigurationPropertyGroup(text, update.configuration, update.platform);
    if (!targetGroup) {
        return insertConfigurationPropertyGroup(text, update);
    }
    let body = targetGroup.body;
    const indent = detectPropertyIndent(body);
    for (const [name, value] of update.entries) {
        body = upsertProperty(body, name, value, indent);
    }
    return `${text.slice(0, targetGroup.bodyStart)}${body}${text.slice(targetGroup.bodyEnd)}`;
}
function findConfigurationPropertyGroup(text, configuration, platform) {
    const pattern = /<PropertyGroup\b([^>]*)>([\s\S]*?)<\/PropertyGroup>/gi;
    let match = pattern.exec(text);
    while (match) {
        const attrs = match[1] || '';
        const parsed = parseConfigurationCondition(attrs);
        if (parsed && parsed.configuration === configuration && parsed.platform === platform) {
            const bodyStart = match.index + match[0].indexOf(match[2]);
            const bodyEnd = bodyStart + match[2].length;
            return {
                start: match.index,
                end: match.index + match[0].length,
                attrs,
                body: match[2],
                bodyStart,
                bodyEnd
            };
        }
        match = pattern.exec(text);
    }
    return undefined;
}
function insertConfigurationPropertyGroup(text, update) {
    const writableEntries = update.entries.filter(([, value]) => value !== '');
    if (writableEntries.length === 0) {
        return text;
    }
    const projectClose = /<\/Project>\s*$/i.exec(text);
    if (!projectClose) {
        throw new Error('Project file does not contain a closing </Project> element.');
    }
    const group = [
        '',
        `  <PropertyGroup Condition="'$(Configuration)|$(Platform)'=='${escapeXml(update.configuration)}|${escapeXml(update.platform)}'">`,
        ...writableEntries.map(([name, value]) => `    <${name}>${escapeXml(value)}</${name}>`),
        '  </PropertyGroup>',
        ''
    ].join('\n');
    const insertAt = projectClose.index;
    return `${text.slice(0, insertAt)}${group}${text.slice(insertAt)}`;
}
function parseConfigurationCondition(value) {
    const match = /Configuration\)\|\$\(Platform\).*?['"]([^|'"]+)\|([^'"]+)['"]/i.exec(value || '');
    if (!match) {
        return undefined;
    }
    return {
        configuration: match[1],
        platform: match[2]
    };
}
function sanitizeConditionPart(value) {
    const text = String(value || '').trim();
    if (!text || /['"<>&|]/.test(text)) {
        return '';
    }
    return text;
}
function upsertProperty(body, name, value, indent) {
    const propertyPattern = new RegExp(`(^[ \\t]*)<${escapeRegExp(name)}\\b[^>]*>[\\s\\S]*?<\\/${escapeRegExp(name)}>\\s*\\r?\\n?`, 'm');
    if (propertyPattern.test(body)) {
        if (value === '') {
            return body.replace(propertyPattern, '');
        }
        return body.replace(propertyPattern, `${indent}<${name}>${escapeXml(value)}</${name}>\n`);
    }
    if (value === '') {
        return body;
    }
    const normalized = body.endsWith('\n') || body.trim() === '' ? body : `${body}\n`;
    return `${normalized}${indent}<${name}>${escapeXml(value)}</${name}>\n`;
}
function detectPropertyIndent(body) {
    const match = /\n([ \t]+)<[A-Za-z_][\w.-]*\b/.exec(body);
    return match ? match[1] : '    ';
}
function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
function escapeXmlAttribute(value) {
    return escapeXml(value).replace(/"/g, '&quot;');
}
function unescapeXmlAttribute(value) {
    return String(value)
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}
function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
//# sourceMappingURL=projectFileEditor.js.map