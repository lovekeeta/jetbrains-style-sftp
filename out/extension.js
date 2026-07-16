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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const ssh2_sftp_client_1 = __importDefault(require("ssh2-sftp-client"));
class SftpService {
    secrets;
    log;
    client;
    profileId;
    constructor(secrets, log) {
        this.secrets = secrets;
        this.log = log;
    }
    async list(profile, remotePath) { await this.connect(profile); this.log.debug(`List ${profile.name}:${remotePath}`); return (await this.client.list(remotePath)); }
    async download(profile, remotePath) { await this.connect(profile); this.log.info(`Download ${profile.name}:${remotePath}`); return (await this.client.get(remotePath)); }
    async downloadIfExists(profile, remotePath) { await this.connect(profile); const type = await this.client.exists(remotePath); return type === '-' ? { data: (await this.client.get(remotePath)), exists: true } : { data: Buffer.alloc(0), exists: false }; }
    async upload(profile, localPath, remotePath) {
        await this.uploadData(profile, await readCurrentLocalData(vscode.Uri.file(localPath)), remotePath);
    }
    async uploadData(profile, data, remotePath) {
        await this.connect(profile);
        const remoteDirectory = path.posix.dirname(remotePath);
        const directoryType = await this.client.exists(remoteDirectory);
        if (directoryType === false) {
            await this.client.mkdir(remoteDirectory, true);
        }
        else if (directoryType !== 'd') {
            throw new Error(`Remote path exists but is not a directory: ${remoteDirectory}`);
        }
        if (profile.useTemporaryFile === false) {
            await this.client.put(data, remotePath);
            this.log.info(`Uploaded ${profile.name}:${remotePath}`);
            return;
        }
        const temporaryPath = `${remotePath}.remote-deploy-${Date.now()}.tmp`;
        try {
            await this.client.put(data, temporaryPath);
            await this.replaceRemoteAtomically(temporaryPath, remotePath);
            this.log.info(`Safely uploaded ${profile.name}:${remotePath}`);
        }
        catch (error) {
            await this.client.delete(temporaryPath).catch(() => undefined);
            throw error;
        }
    }
    async replaceRemoteAtomically(temporaryPath, targetPath) {
        try {
            await this.client.posixRename(temporaryPath, targetPath);
            return;
        }
        catch {
            const targetExists = await this.client.exists(targetPath);
            if (!targetExists) {
                await this.client.rename(temporaryPath, targetPath);
                return;
            }
            const backupPath = `${targetPath}.remote-deploy-${Date.now()}.bak`;
            await this.client.rename(targetPath, backupPath);
            try {
                await this.client.rename(temporaryPath, targetPath);
                await this.client.delete(backupPath);
            }
            catch (error) {
                await this.client.rename(backupPath, targetPath).catch(() => undefined);
                throw error;
            }
        }
    }
    async rename(profile, oldPath, newPath) { await this.connect(profile); await this.client.rename(oldPath, newPath); }
    async delete(profile, remotePath, directory) { await this.connect(profile); if (directory) {
        await this.client.rmdir(remotePath, true);
    }
    else {
        await this.client.delete(remotePath);
    } }
    async dispose() { if (this.client) {
        await this.client.end().catch(() => undefined);
        this.client = undefined;
        this.profileId = undefined;
    } }
    async connect(profile) {
        if (this.client && this.profileId === profile.id) {
            return;
        }
        await this.dispose();
        const config = { host: profile.host, port: profile.port, username: profile.username, readyTimeout: 15000 };
        if (profile.authMethod === 'privateKey') {
            if (!profile.privateKeyPath) {
                throw new Error('Select an SSH private key for this SFTP profile.');
            }
            config.privateKey = await fs.readFile(profile.privateKeyPath);
        }
        else {
            const storedPassword = await this.secrets.get(`remoteDeploy.password.${profile.id}`);
            const password = profile.password || storedPassword || await vscode.window.showInputBox({ prompt: `Password for ${profile.username}@${profile.host}`, password: true, ignoreFocusOut: true });
            if (password === undefined) {
                throw new Error('Password entry cancelled.');
            }
            if (!password) {
                throw new Error('Enter a password for this SFTP profile.');
            }
            config.password = password;
        }
        const client = new ssh2_sftp_client_1.default();
        await client.connect(config);
        this.client = client;
        this.profileId = profile.id;
    }
}
class RemoteFileSystemProvider {
    sftp;
    emitter = new vscode.EventEmitter();
    onDidChangeFile = this.emitter.event;
    constructor(sftp) {
        this.sftp = sftp;
    }
    watch() { return new vscode.Disposable(() => undefined); }
    async stat(uri) {
        const { profile, remotePath } = this.resolve(uri);
        const parent = path.posix.dirname(remotePath);
        const item = (await this.sftp.list(profile, parent)).find(entry => entry.name === path.posix.basename(remotePath));
        if (!item) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        return { type: item.type === 'd' ? vscode.FileType.Directory : item.type === 'l' ? vscode.FileType.SymbolicLink : vscode.FileType.File, ctime: item.modifyTime, mtime: item.modifyTime, size: item.size };
    }
    async readDirectory(uri) {
        const { profile, remotePath } = this.resolve(uri);
        return (await this.sftp.list(profile, remotePath)).map(entry => [entry.name, entry.type === 'd' ? vscode.FileType.Directory : entry.type === 'l' ? vscode.FileType.SymbolicLink : vscode.FileType.File]);
    }
    async readFile(uri) { const { profile, remotePath } = this.resolve(uri); return this.sftp.download(profile, remotePath); }
    async writeFile(uri, content, options) {
        this.requireTrusted();
        const { profile, remotePath } = this.resolve(uri);
        const exists = await this.exists(profile, remotePath);
        if (exists && !options.overwrite) {
            throw vscode.FileSystemError.FileExists(uri);
        }
        if (!exists && !options.create) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        await this.sftp.uploadData(profile, Buffer.from(content), remotePath);
        this.emitter.fire([{ type: exists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
    }
    async createDirectory(uri) { this.requireTrusted(); const { profile, remotePath } = this.resolve(uri); await this.sftp.uploadData(profile, Buffer.alloc(0), path.posix.join(remotePath, '.remote-deploy-keep')); await this.sftp.delete(profile, path.posix.join(remotePath, '.remote-deploy-keep'), false); this.emitter.fire([{ type: vscode.FileChangeType.Created, uri }]); }
    async delete(uri, options) { this.requireTrusted(); const { profile, remotePath } = this.resolve(uri); const stat = await this.stat(uri); await this.sftp.delete(profile, remotePath, stat.type === vscode.FileType.Directory && options.recursive); this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]); }
    async rename(oldUri, newUri, options) {
        this.requireTrusted();
        if (oldUri.authority !== newUri.authority) {
            throw vscode.FileSystemError.NoPermissions('Cannot rename across SFTP profiles.');
        }
        const oldFile = this.resolve(oldUri), newFile = this.resolve(newUri);
        if (!options.overwrite && await this.exists(newFile.profile, newFile.remotePath)) {
            throw vscode.FileSystemError.FileExists(newUri);
        }
        await this.sftp.rename(oldFile.profile, oldFile.remotePath, newFile.remotePath);
        this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri: oldUri }, { type: vscode.FileChangeType.Created, uri: newUri }]);
    }
    resolve(uri) {
        const profile = getSettings().profiles.find(item => item.id === uri.authority);
        if (!profile) {
            throw vscode.FileSystemError.Unavailable(`Unknown SFTP profile: ${uri.authority}`);
        }
        const remotePath = normalizeRemotePath(uri.path);
        if (remotePath !== profile.remoteRoot && !remotePath.startsWith(`${profile.remoteRoot}/`)) {
            throw vscode.FileSystemError.NoPermissions('Remote path is outside the configured root.');
        }
        return { profile, remotePath };
    }
    async exists(profile, remotePath) { try {
        await this.stat(vscode.Uri.from({ scheme: 'remote-deploy', authority: profile.id, path: remotePath }));
        return true;
    }
    catch {
        return false;
    } }
    requireTrusted() { if (!vscode.workspace.isTrusted) {
        throw vscode.FileSystemError.NoPermissions('Trust the workspace before modifying remote files.');
    } }
}
class RemoteNode extends vscode.TreeItem {
    kind;
    profile;
    remotePath;
    constructor(kind, profile, remotePath, size) {
        const label = kind === 'selector' ? `SFTP SERVER    ${profile.name}  ▾` : kind === 'server' ? profile.name : kind === 'setup' ? 'Add an SFTP Connection' : path.posix.basename(remotePath) || remotePath;
        super(label, kind === 'server' ? vscode.TreeItemCollapsibleState.Expanded : kind === 'directory' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        this.kind = kind;
        this.profile = profile;
        this.remotePath = remotePath;
        this.contextValue = kind;
        this.tooltip = kind === 'selector' ? `Switch SFTP server — currently ${profile.name} (${profile.username}@${profile.host}:${profile.port})` : kind === 'server' ? `${profile.username}@${profile.host}:${profile.port}${remotePath}` : remotePath;
        if (kind === 'selector') {
            this.iconPath = new vscode.ThemeIcon('server-environment');
            this.command = { command: 'remoteDeploy.selectServer', title: 'Switch SFTP Server' };
        }
        if (kind === 'server') {
            this.iconPath = new vscode.ThemeIcon('remote-explorer', new vscode.ThemeColor('charts.green'));
            this.description = `${profile.host}:${profile.port}${remotePath}`;
        }
        if (kind === 'directory') {
            this.iconPath = new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.green'));
        }
        if (kind === 'file') {
            this.resourceUri = vscode.Uri.from({ scheme: 'remote-deploy', authority: profile.id, path: remotePath });
            this.description = size === undefined ? undefined : formatSize(size);
            this.command = { command: 'remoteDeploy.previewRemote', title: 'Edit Remote File', arguments: [this] };
        }
        if (kind === 'setup') {
            this.iconPath = new vscode.ThemeIcon('add');
            this.description = 'Create a deployment profile';
            this.command = { command: 'remoteDeploy.configure', title: 'Add SFTP Connection' };
        }
    }
}
class RemoteExplorer {
    sftp;
    emitter = new vscode.EventEmitter();
    onDidChangeTreeData = this.emitter.event;
    constructor(sftp) {
        this.sftp = sftp;
    }
    refresh() { this.emitter.fire(undefined); }
    getTreeItem(node) { return node; }
    async getChildren(node) {
        const settings = getSettings();
        if (!settings.profiles.length) {
            return node ? [] : [new RemoteNode('setup')];
        }
        const profile = selectedProfile(settings);
        if (!node) {
            return [new RemoteNode('selector', profile), new RemoteNode('server', profile, profile.remoteRoot)];
        }
        if (node.kind !== 'server' && node.kind !== 'directory') {
            return [];
        }
        const remotePath = node.remotePath;
        const nodeProfile = node.profile ?? profile;
        try {
            const entries = await this.sftp.list(nodeProfile, remotePath);
            return entries.filter(entry => entry.name !== '.' && entry.name !== '..').sort((a, b) => Number(b.type === 'd') - Number(a.type === 'd') || a.name.localeCompare(b.name)).map(entry => new RemoteNode(entry.type === 'd' ? 'directory' : 'file', nodeProfile, path.posix.join(remotePath, entry.name), entry.size));
        }
        catch (error) {
            vscode.window.showErrorMessage(`JetBrains style SFTP: ${messageOf(error)}`);
            return [];
        }
    }
}
function activate(context) {
    const log = vscode.window.createOutputChannel('JetBrains style SFTP', { log: true });
    const sftp = new SftpService(context.secrets, log);
    const explorer = new RemoteExplorer(sftp);
    const remoteFileSystem = new RemoteFileSystemProvider(sftp);
    const primaryTree = vscode.window.createTreeView('remoteDeploy.explorer', { treeDataProvider: explorer, canSelectMany: true });
    const fallbackTree = vscode.window.createTreeView('remoteDeploy.explorerFallback', { treeDataProvider: explorer, canSelectMany: true });
    context.subscriptions.push(sftp, primaryTree, fallbackTree, log, vscode.workspace.registerFileSystemProvider('remote-deploy', remoteFileSystem, { isCaseSensitive: true }));
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (document) => {
        if (document.uri.scheme !== 'file' || !vscode.workspace.isTrusted) {
            return;
        }
        const settings = getSettings();
        const enabled = vscode.workspace.getConfiguration('remoteDeploy').get('uploadOnSave', false);
        for (const profile of settings.profiles) {
            if (!enabled && !profile.uploadOnSave) {
                continue;
            }
            try {
                remotePathFor(profile, document.uri.fsPath);
                if (isLocalExcluded(profile, document.uri.fsPath)) {
                    continue;
                }
                await sftp.upload(profile, document.uri.fsPath, remotePathFor(profile, document.uri.fsPath));
                log.info(`Uploaded on save ${profile.name}:${document.uri.fsPath}`);
            }
            catch (error) {
                if (!messageOf(error).includes('outside this project and has no mapping')) {
                    log.error(`Upload on save failed for ${document.uri.fsPath}: ${messageOf(error)}`);
                }
            }
        }
    }), vscode.commands.registerCommand('remoteDeploy.configure', () => openProfilesPanel(context, sftp, explorer)), vscode.commands.registerCommand('remoteDeploy.addMapping', () => openProfilesPanel(context, sftp, explorer)), vscode.commands.registerCommand('remoteDeploy.selectServer', async () => {
        const settings = getSettings();
        if (!settings.profiles.length) {
            openProfilesPanel(context, sftp, explorer);
            return;
        }
        const selected = await vscode.window.showQuickPick(settings.profiles.slice().sort((a, b) => a.name.localeCompare(b.name)).map(profile => ({ label: profile.name, description: `${profile.username}@${profile.host}:${profile.port}`, detail: profile.id === settings.defaultProfileId ? 'Currently selected' : undefined, profile })), { placeHolder: 'Choose a configured SFTP server', title: 'JetBrains style SFTP: Switch SFTP Server', matchOnDescription: true, matchOnDetail: true });
        if (!selected) {
            return;
        }
        await vscode.workspace.getConfiguration('remoteDeploy').update('defaultProfileId', selected.profile.id, vscode.ConfigurationTarget.Workspace);
        await sftp.dispose();
        explorer.refresh();
    }), vscode.commands.registerCommand('remoteDeploy.refresh', async () => { await sftp.dispose(); explorer.refresh(); }), vscode.commands.registerCommand('remoteDeploy.showLog', () => log.show(true)), vscode.commands.registerCommand('remoteDeploy.uploadDefault', async (uri) => vscode.commands.executeCommand('remoteDeploy.upload', uri, selectedProfile(getSettings()))), vscode.commands.registerCommand('remoteDeploy.previewDeployDefault', async (uri, selectedUris) => vscode.commands.executeCommand('remoteDeploy.previewDeploy', uri, selectedUris, selectedProfile(getSettings()))), vscode.commands.registerCommand('remoteDeploy.compareDefault', async (uri) => vscode.commands.executeCommand('remoteDeploy.compare', uri, selectedProfile(getSettings()))), vscode.commands.registerCommand('remoteDeploy.upload', async (uri, profileOverride) => withLocalFile(uri, async (local) => { const profile = profileOverride ?? await selectProfileForLocalAction('upload to'); if (!profile) {
        return;
    } const remote = remotePathFor(profile, local.fsPath); await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Uploading ${path.basename(local.fsPath)} to ${profile.name}` }, () => sftp.upload(profile, local.fsPath, remote)); explorer.refresh(); vscode.window.showInformationMessage(`Uploaded to ${profile.name}: ${remote}`); })), vscode.commands.registerCommand('remoteDeploy.previewDeploy', async (uri, selectedUris, profileOverride) => {
        const candidates = (selectedUris?.length ? selectedUris : uri ? [uri] : vscode.window.activeTextEditor?.document.uri ? [vscode.window.activeTextEditor.document.uri] : []).filter(item => item.scheme === 'file');
        if (!candidates.length) {
            vscode.window.showWarningMessage('Select one or more local files or folders first.');
            return;
        }
        const profile = profileOverride ?? await selectProfileForLocalAction('sync with deployed files on');
        if (!profile) {
            return;
        }
        try {
            const files = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Scanning local files for deployment comparison' }, async () => {
                const discovered = (await Promise.all(candidates.map(candidate => collectLocalFiles(candidate.fsPath, profile)))).flat();
                const unique = [...new Map(discovered.map(file => [path.resolve(file).toLowerCase(), vscode.Uri.file(file)])).values()];
                return unique;
            });
            if (!files.length) {
                vscode.window.showWarningMessage('The selected folders do not contain any files.');
                return;
            }
            const previews = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Comparing ${files.length} local file${files.length === 1 ? '' : 's'} with ${profile.name}` }, async (progress) => {
                const result = [];
                for (let index = 0; index < files.length; index++) {
                    const local = files[index];
                    progress.report({ message: path.basename(local.fsPath), increment: 100 / files.length });
                    const remotePath = remotePathFor(profile, local.fsPath);
                    const [localData, remoteFile] = await Promise.all([readCurrentLocalData(local), sftp.downloadIfExists(profile, remotePath)]);
                    result.push({ local, remotePath, localData, remoteData: remoteFile.data, remoteExists: remoteFile.exists, comparable: isTextBuffer(localData) && (!remoteFile.exists || isTextBuffer(remoteFile.data)) });
                }
                return result;
            });
            openDeployPreview(context, sftp, explorer, profile, previews);
        }
        catch (error) {
            vscode.window.showErrorMessage(`Deployment preview failed: ${messageOf(error)}`);
        }
    }), vscode.commands.registerCommand('remoteDeploy.compare', async (argument, profileOverride) => {
        const local = argument ?? vscode.window.activeTextEditor?.document.uri;
        if (!local || local.scheme !== 'file') {
            vscode.window.showWarningMessage('Select or open a local file to compare.');
            return;
        }
        const profile = profileOverride ?? await selectProfileForLocalAction('compare with');
        if (!profile) {
            return;
        }
        const remote = remotePathFor(profile, local.fsPath);
        try {
            const data = await sftp.download(profile, remote);
            const serverFile = await writeComparisonFile(context, profile.id, remote, data);
            await vscode.commands.executeCommand('vscode.diff', local, serverFile, `${path.basename(remote)} — Local ↔ ${profile.name}`);
        }
        catch (error) {
            vscode.window.showErrorMessage(`Comparison failed: ${messageOf(error)}`);
        }
    }), vscode.commands.registerCommand('remoteDeploy.compareClipboard', async (argument) => {
        const local = argument ?? vscode.window.activeTextEditor?.document.uri;
        if (!local || local.scheme !== 'file') {
            vscode.window.showWarningMessage('Select or open a local file to compare.');
            return;
        }
        const clipboard = await vscode.env.clipboard.readText();
        if (!clipboard) {
            vscode.window.showWarningMessage('The clipboard is empty. Copy text first, then compare it with the selected file.');
            return;
        }
        try {
            const clipboardFile = await writeClipboardComparisonFile(context, local.fsPath, clipboard);
            await vscode.commands.executeCommand('vscode.diff', clipboardFile, local, `${path.basename(local.fsPath)} — Clipboard ↔ Local`);
        }
        catch (error) {
            vscode.window.showErrorMessage(`Clipboard comparison failed: ${messageOf(error)}`);
        }
    }), vscode.commands.registerCommand('remoteDeploy.compareLocal', async (node) => {
        if (!node?.profile || node.kind !== 'file') {
            return;
        }
        const local = vscode.Uri.file(defaultLocalPath(node.profile, node.remotePath));
        try {
            const data = await sftp.download(node.profile, node.remotePath);
            const serverFile = await writeComparisonFile(context, node.profile.id, node.remotePath, data);
            await vscode.commands.executeCommand('vscode.diff', serverFile, local, `${path.basename(node.remotePath)} — ${node.profile.name} ↔ Local`);
        }
        catch (error) {
            vscode.window.showErrorMessage(`Comparison failed: ${messageOf(error)}`);
        }
    }), vscode.commands.registerCommand('remoteDeploy.previewRemote', async (node) => {
        if (!node?.profile || node.kind !== 'file') {
            return;
        }
        try {
            const remoteUri = vscode.Uri.from({ scheme: 'remote-deploy', authority: node.profile.id, path: node.remotePath });
            const document = await vscode.workspace.openTextDocument(remoteUri);
            await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
        }
        catch (error) {
            vscode.window.showErrorMessage(`Opening remote file failed: ${messageOf(error)}`);
        }
    }), vscode.commands.registerCommand('remoteDeploy.download', async (node) => {
        if (!node?.profile || (node.kind !== 'file' && node.kind !== 'directory')) {
            return;
        }
        const defaultTarget = defaultLocalPath(node.profile, node.remotePath);
        const target = node.kind === 'directory'
            ? (await vscode.window.showOpenDialog({ defaultUri: vscode.Uri.file(path.dirname(defaultTarget)), canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Download Here' }))?.[0]
            : await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(defaultTarget), saveLabel: 'Download' });
        if (!target) {
            return;
        }
        const destination = node.kind === 'directory' ? path.join(target.fsPath, path.posix.basename(node.remotePath)) : target.fsPath;
        try {
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Downloading ${path.posix.basename(node.remotePath)}` }, () => downloadRemoteItem(sftp, node.profile, node.remotePath, destination, node.kind === 'directory'));
            if (node.kind === 'file') {
                await vscode.window.showTextDocument(vscode.Uri.file(destination));
            }
            vscode.window.showInformationMessage(`Downloaded to ${destination}`);
        }
        catch (error) {
            vscode.window.showErrorMessage(`Download failed: ${messageOf(error)}`);
        }
    }), vscode.commands.registerCommand('remoteDeploy.renameRemote', async (node) => {
        if (!node?.profile || (node.kind !== 'file' && node.kind !== 'directory')) {
            return;
        }
        const currentName = path.posix.basename(node.remotePath);
        const name = await vscode.window.showInputBox({ title: 'Rename Remote Item', prompt: `Rename ${currentName}`, value: currentName, validateInput: value => !value.trim() ? 'Enter a name.' : value.includes('/') || value.includes('\\') ? 'Name cannot contain path separators.' : undefined });
        if (!name || name === currentName) {
            return;
        }
        const newPath = path.posix.join(path.posix.dirname(node.remotePath), name);
        try {
            await sftp.rename(node.profile, node.remotePath, newPath);
            explorer.refresh();
            vscode.window.showInformationMessage(`Renamed to ${name}`);
        }
        catch (error) {
            vscode.window.showErrorMessage(`Rename failed: ${messageOf(error)}`);
        }
    }), vscode.commands.registerCommand('remoteDeploy.deleteRemote', async (node) => {
        if (!node?.profile || (node.kind !== 'file' && node.kind !== 'directory')) {
            return;
        }
        const name = path.posix.basename(node.remotePath);
        const confirmation = await vscode.window.showWarningMessage(`Delete ${node.kind} "${name}" from ${node.profile.name}?${node.kind === 'directory' ? ' The folder and all contents will be permanently deleted.' : ''}`, { modal: true }, 'Delete');
        if (confirmation !== 'Delete') {
            return;
        }
        try {
            await sftp.delete(node.profile, node.remotePath, node.kind === 'directory');
            explorer.refresh();
            vscode.window.showInformationMessage(`Deleted ${name} from ${node.profile.name}.`);
        }
        catch (error) {
            vscode.window.showErrorMessage(`Delete failed: ${messageOf(error)}`);
        }
    }), vscode.commands.registerCommand('remoteDeploy.syncLocal', async (node, selectedNodes) => {
        const candidates = selectedNodes?.length ? selectedNodes : node ? [node] : [];
        const remoteFiles = candidates.filter(item => item.profile && item.kind === 'file');
        if (remoteFiles.length) {
            const profile = remoteFiles[0].profile;
            const files = remoteFiles.filter(item => item.profile?.id === profile.id);
            try {
                const previews = await Promise.all(files.map(async (item) => {
                    const localPath = defaultLocalPath(profile, item.remotePath);
                    const [remoteData, localFile] = await Promise.all([sftp.download(profile, item.remotePath), readLocalFileIfExists(localPath)]);
                    return { remotePath: item.remotePath, localPath, remoteData, localData: localFile.data, localExists: localFile.exists, comparable: isTextBuffer(remoteData) && (!localFile.exists || isTextBuffer(localFile.data)) };
                }));
                openSyncLocalPreview(context, profile, previews);
            }
            catch (error) {
                vscode.window.showErrorMessage(`Sync preview failed: ${messageOf(error)}`);
            }
            return;
        }
        if (!node?.profile || node.kind !== 'directory') {
            return;
        }
        const destination = defaultLocalPath(node.profile, node.remotePath);
        const confirmation = await vscode.window.showWarningMessage(`Sync ${node.remotePath} to local? Existing local directory content at ${destination} may be overwritten.`, { modal: true }, 'Sync to Local');
        if (confirmation !== 'Sync to Local') {
            return;
        }
        try {
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Syncing ${path.posix.basename(node.remotePath)} to local` }, () => downloadRemoteItem(sftp, node.profile, node.remotePath, destination, true));
            vscode.window.showInformationMessage(`Synced to local: ${destination}`);
        }
        catch (error) {
            vscode.window.showErrorMessage(`Sync failed: ${messageOf(error)}`);
        }
    }));
}
async function downloadRemoteItem(sftp, profile, remotePath, localPath, directory) {
    if (!directory) {
        const data = await sftp.download(profile, remotePath);
        await fs.mkdir(path.dirname(localPath), { recursive: true });
        await fs.writeFile(localPath, data);
        return;
    }
    await fs.mkdir(localPath, { recursive: true });
    const entries = await sftp.list(profile, remotePath);
    for (const entry of entries.filter(item => item.name !== '.' && item.name !== '..')) {
        await downloadRemoteItem(sftp, profile, path.posix.join(remotePath, entry.name), path.join(localPath, entry.name), entry.type === 'd');
    }
}
async function withLocalFile(uri, action) {
    const file = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!file || file.scheme !== 'file') {
        vscode.window.showWarningMessage('Select or open a local file first.');
        return;
    }
    try {
        await action(file);
    }
    catch (error) {
        vscode.window.showErrorMessage(`Upload failed: ${messageOf(error)}`);
    }
}
async function collectLocalFiles(localPath, profile) {
    const stat = await fs.stat(localPath);
    if (stat.isFile()) {
        return isLocalExcluded(profile, localPath) ? [] : [localPath];
    }
    if (!stat.isDirectory() || isLocalExcluded(profile, localPath)) {
        return [];
    }
    const entries = await fs.readdir(localPath, { withFileTypes: true });
    const nested = await Promise.all(entries.filter(entry => !entry.isSymbolicLink()).map(entry => collectLocalFiles(path.join(localPath, entry.name), profile)));
    return nested.flat();
}
function isLocalExcluded(profile, localPath) {
    const resolved = path.resolve(localPath);
    const mapping = profile.mappings.filter(item => resolved === item.localPath || resolved.startsWith(`${item.localPath}${path.sep}`)).sort((a, b) => b.localPath.length - a.localPath.length)[0];
    if (!mapping) {
        return false;
    }
    const relative = path.relative(mapping.localPath, resolved).split(path.sep).join('/');
    const patterns = profile.exclusions?.patterns ?? ['.git/**', '.vscode/**', 'node_modules/**'];
    const explicit = (profile.exclusions?.localPaths ?? []).some(item => { const excluded = path.resolve(mapping.localPath, item); return resolved === excluded || resolved.startsWith(`${excluded}${path.sep}`); });
    return explicit || patterns.some(pattern => simpleGlobMatch(pattern, relative) || simpleGlobMatch(pattern, path.posix.basename(relative)));
}
function simpleGlobMatch(pattern, value) {
    const expression = `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`;
    return new RegExp(expression, process.platform === 'win32' ? 'i' : '').test(value);
}
async function readCurrentLocalData(local) {
    const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === local.toString());
    return document ? Buffer.from(document.getText(), 'utf8') : fs.readFile(local.fsPath);
}
async function readLocalFileIfExists(localPath) {
    const local = vscode.Uri.file(localPath);
    const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === local.toString());
    if (document) {
        return { data: Buffer.from(document.getText(), 'utf8'), exists: true };
    }
    try {
        return { data: await fs.readFile(localPath), exists: true };
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            return { data: Buffer.alloc(0), exists: false };
        }
        throw error;
    }
}
function openSyncLocalPreview(context, profile, files) {
    const panel = vscode.window.createWebviewPanel('remoteDeploy.previewSyncLocal', `Sync ${files.length} file${files.length === 1 ? '' : 's'} to Local`, vscode.ViewColumn.Active, { enableScripts: true });
    panel.webview.html = syncLocalPreviewHtml(profile, files);
    panel.webview.onDidReceiveMessage(async (message) => {
        const selected = files[message.index ?? 0];
        if (!selected) {
            return;
        }
        if (message.type === 'compare') {
            if (!selected.comparable) {
                vscode.window.showWarningMessage(`Cannot compare binary file: ${path.basename(selected.remotePath)}`);
                return;
            }
            try {
                const serverFile = await writeComparisonFile(context, profile.id, selected.remotePath, selected.remoteData);
                const localFile = selected.localExists ? vscode.Uri.file(selected.localPath) : await writeEmptyComparisonFile(context, profile.id, selected.localPath);
                await vscode.commands.executeCommand('vscode.diff', localFile, serverFile, `${path.basename(selected.remotePath)} — Local ↔ Server`);
            }
            catch (error) {
                vscode.window.showErrorMessage(`Comparison failed: ${messageOf(error)}`);
            }
            return;
        }
        if (message.type === 'sync') {
            try {
                await fs.mkdir(path.dirname(selected.localPath), { recursive: true });
                await fs.writeFile(selected.localPath, selected.remoteData);
                panel.webview.postMessage({ type: 'synced', index: message.index ?? 0, text: `Synced successfully: ${selected.localPath}` });
                vscode.window.showInformationMessage(`Synced to local: ${selected.localPath}`);
            }
            catch (error) {
                panel.webview.postMessage({ type: 'error', index: message.index ?? 0, text: `Sync failed: ${messageOf(error)}` });
            }
            return;
        }
        if (message.type === 'syncAll') {
            let completed = 0;
            try {
                await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Syncing ${files.length} files to local`, cancellable: false }, async (progress) => {
                    for (let index = 0; index < files.length; index++) {
                        const file = files[index];
                        progress.report({ message: path.basename(file.remotePath), increment: 100 / files.length });
                        await fs.mkdir(path.dirname(file.localPath), { recursive: true });
                        await fs.writeFile(file.localPath, file.remoteData);
                        completed++;
                        panel.webview.postMessage({ type: 'synced', index, text: `Synced successfully: ${file.localPath}` });
                    }
                });
                panel.webview.postMessage({ type: 'allSynced', text: `All ${files.length} files synced successfully.` });
                vscode.window.showInformationMessage(`Synced ${files.length} files to local.`);
            }
            catch (error) {
                panel.webview.postMessage({ type: 'error', index: completed, text: `Sync stopped after ${completed} file(s): ${messageOf(error)}` });
            }
        }
    }, undefined, context.subscriptions);
}
function openDeployPreview(context, sftp, explorer, profile, files) {
    const panel = vscode.window.createWebviewPanel('remoteDeploy.previewDeploy', `Deploy ${files.length} file${files.length === 1 ? '' : 's'} to ${profile.name}`, vscode.ViewColumn.Active, { enableScripts: true });
    panel.webview.html = deployPreviewHtml(profile, files);
    panel.webview.onDidReceiveMessage(async (message) => {
        const selected = files[message.index ?? 0];
        if (!selected) {
            return;
        }
        if (message.type === 'compare') {
            try {
                selected.localData = await readCurrentLocalData(selected.local);
                const serverFile = await writeComparisonFile(context, profile.id, selected.remotePath, selected.remoteData);
                const localFile = await writeLocalComparisonFile(context, profile.id, selected.local.fsPath, selected.localData);
                await vscode.commands.executeCommand('vscode.diff', serverFile, localFile, `${path.basename(selected.remotePath)} — Server ↔ Local${vscode.workspace.textDocuments.find(document => document.uri.toString() === selected.local.toString())?.isDirty ? ' (Unsaved)' : ''}`);
            }
            catch (error) {
                vscode.window.showErrorMessage(`Comparison failed: ${messageOf(error)}`);
            }
            return;
        }
        if (message.type === 'deploy') {
            try {
                await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Deploying ${path.basename(selected.local.fsPath)} to ${profile.name}` }, () => sftp.upload(profile, selected.local.fsPath, selected.remotePath));
                selected.remoteData = Buffer.from(selected.localData);
                selected.remoteExists = true;
                explorer.refresh();
                panel.webview.postMessage({ type: 'deployed', index: message.index ?? 0, text: `Deployed successfully: ${selected.remotePath}` });
                vscode.window.showInformationMessage(`Deployed to ${profile.name}: ${selected.remotePath}`);
            }
            catch (error) {
                panel.webview.postMessage({ type: 'error', index: message.index ?? 0, text: `Deployment failed: ${messageOf(error)}` });
            }
            return;
        }
        if (message.type === 'overwriteLocal') {
            if (!selected.remoteExists) {
                panel.webview.postMessage({ type: 'error', index: message.index ?? 0, text: 'Cannot overwrite local because the server file does not exist.' });
                return;
            }
            try {
                await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Overwriting ${path.basename(selected.local.fsPath)} with ${profile.name}` }, async () => {
                    await fs.mkdir(path.dirname(selected.local.fsPath), { recursive: true });
                    await fs.writeFile(selected.local.fsPath, selected.remoteData);
                });
                selected.localData = Buffer.from(selected.remoteData);
                panel.webview.postMessage({ type: 'localOverwritten', index: message.index ?? 0, text: `Local file overwritten successfully: ${selected.local.fsPath}` });
                vscode.window.showInformationMessage(`Local file updated from ${profile.name}: ${selected.local.fsPath}`);
            }
            catch (error) {
                panel.webview.postMessage({ type: 'error', index: message.index ?? 0, text: `Overwrite local failed: ${messageOf(error)}` });
            }
            return;
        }
        if (message.type === 'deployAll') {
            let completed = 0;
            try {
                await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Deploying ${files.length} files to ${profile.name}`, cancellable: false }, async (progress) => {
                    for (let index = 0; index < files.length; index++) {
                        const file = files[index];
                        progress.report({ message: path.basename(file.local.fsPath), increment: 100 / files.length });
                        file.localData = await readCurrentLocalData(file.local);
                        await sftp.uploadData(profile, file.localData, file.remotePath);
                        file.remoteData = Buffer.from(file.localData);
                        file.remoteExists = true;
                        completed++;
                        panel.webview.postMessage({ type: 'deployed', index, text: `Deployed successfully: ${file.remotePath}` });
                    }
                });
                explorer.refresh();
                panel.webview.postMessage({ type: 'allDeployed', text: `All ${files.length} files deployed successfully.` });
                vscode.window.showInformationMessage(`Deployed ${files.length} files to ${profile.name}.`);
            }
            catch (error) {
                panel.webview.postMessage({ type: 'error', index: completed, text: `Deployment stopped after ${completed} file(s): ${messageOf(error)}` });
            }
        }
    }, undefined, context.subscriptions);
}
function syncLocalPreviewHtml(profile, files) {
    const file = files[0];
    if (!file) {
        return '';
    }
    const data = JSON.stringify({ profile: profile.name, host: profile.host, remotePath: file.remotePath, localPath: file.localPath, remoteText: file.comparable ? file.remoteData.toString('utf8') : '', localText: file.comparable ? file.localData.toString('utf8') : '', localExists: file.localExists }).replace(/</g, '\\u003c');
    return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:20px;margin:0}.summary{border:1px solid var(--vscode-panel-border);padding:16px;margin-bottom:16px;background:var(--vscode-sideBar-background)}h1{font-size:20px;margin:0 0 14px}.detail{display:grid;grid-template-columns:110px 1fr;gap:8px;margin:6px 0}.detail label{color:var(--vscode-descriptionForeground)}.path{font-family:var(--vscode-editor-font-family);word-break:break-all}.actions{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:16px}.action-buttons{display:flex;gap:8px}.status{color:var(--vscode-descriptionForeground);flex:1}.error{color:var(--vscode-errorForeground)}button{padding:8px 18px;border:0;border-radius:2px;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.compare-title{font-size:16px;margin:12px 0}.compare{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);border:1px solid var(--vscode-panel-border);min-height:540px}.pane{min-width:0;min-height:0;overflow:auto}.pane:first-child{border-right:1px solid var(--vscode-panel-border)}.pane h2{font-size:13px;margin:0;padding:9px 12px;background:var(--vscode-editorGroupHeader-tabsBackground);border-bottom:1px solid var(--vscode-panel-border)}pre{box-sizing:border-box;margin:0;padding:10px 0;overflow:auto;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);line-height:1.5;tab-size:4}.line{display:block;padding:0 10px;white-space:pre}.changed{background:var(--vscode-diffEditor-insertedTextBackground)}.local.changed{background:var(--vscode-diffEditor-removedTextBackground)}.number{display:inline-block;width:42px;text-align:right;margin-right:12px;color:var(--vscode-editorLineNumber-foreground);user-select:none}</style></head><body><div class="summary"><h1>Ready to Sync to Local</h1><div class="detail"><label>Current SFTP</label><strong id="server"></strong></div><div class="detail"><label>Server file</label><span class="path" id="remotePath"></span></div><div class="detail"><label id="localAction">Overwrite local</label><span class="path" id="localPath"></span></div><div class="actions"><span id="status" class="status">Review the server changes before syncing to local.</span><div class="action-buttons"><button id="compare" class="secondary">Open Side-by-Side Diff</button><button id="sync">Sync and Overwrite Local</button></div></div></div><div class="compare-title">Compare Changes</div><div class="compare"><section class="pane"><h2>Server version — will be synced</h2><pre id="remote"></pre></section><section class="pane"><h2 id="localTitle">Local version — will be overwritten</h2><pre id="local"></pre></section></div><script>const vscode=acquireVsCodeApi(),data=${data};const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');document.getElementById('server').textContent=data.profile+' ('+data.host+')';document.getElementById('remotePath').textContent=data.remotePath;document.getElementById('localPath').textContent=data.localPath;if(!data.localExists){document.getElementById('localAction').textContent='Create local';document.getElementById('localTitle').textContent='Local version — file does not exist (empty)';document.getElementById('status').textContent='The local file does not exist. Review the server file before syncing.';document.getElementById('sync').textContent='Sync and Create Local File'}const remote=data.remoteText.split(/\\r?\\n/),local=data.localText.split(/\\r?\\n/),count=Math.max(remote.length,local.length);function lines(values,other,localSide){let html='';for(let i=0;i<count;i++){const value=values[i]??'',changed=value!==(other[i]??'');html+='<span class="line '+(localSide?'local ':'')+(changed?'changed':'')+'"><span class="number">'+(i+1)+'</span>'+esc(value)+'</span>'}return html}document.getElementById('remote').innerHTML=lines(remote,local,false);document.getElementById('local').innerHTML=lines(local,remote,true);document.getElementById('compare').onclick=()=>vscode.postMessage({type:'compare'});document.getElementById('sync').onclick=()=>{const button=document.getElementById('sync');button.disabled=true;button.textContent='Syncing…';document.getElementById('status').textContent='Downloading the server file and overwriting the local version…';vscode.postMessage({type:'sync'})};window.addEventListener('message',event=>{const message=event.data,status=document.getElementById('status'),button=document.getElementById('sync');status.textContent=message.text;status.className=message.type==='error'?'status error':'status';if(message.type==='error'){button.disabled=false;button.textContent=data.localExists?'Sync and Overwrite Local':'Sync and Create Local File'}else if(message.type==='synced'){button.textContent='Synced'}});</script></body></html>`;
}
function deployPreviewHtml(profile, files) {
    const data = JSON.stringify({ profile: profile.name, host: profile.host, files: files.map(file => ({ name: path.basename(file.displayLocalPath ?? file.local.fsPath), localPath: file.displayLocalPath ?? file.local.fsPath, remotePath: file.remotePath, localText: file.comparable ? file.localData.toString('utf8') : '', remoteText: file.comparable ? file.remoteData.toString('utf8') : '', remoteExists: file.remoteExists, comparable: file.comparable, identical: file.remoteExists && file.localData.equals(file.remoteData) })) }).replace(/</g, '\\u003c');
    return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:20px;margin:0}.summary,.files{border:1px solid var(--vscode-panel-border);padding:16px;margin-bottom:16px;background:var(--vscode-sideBar-background)}h1{font-size:20px;margin:0 0 14px}.detail{display:grid;grid-template-columns:110px 1fr;gap:8px;margin:6px 0}.detail label{color:var(--vscode-descriptionForeground)}.path{font-family:var(--vscode-editor-font-family);word-break:break-all}.actions{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:16px}.action-buttons{display:flex;gap:8px}.status{color:var(--vscode-descriptionForeground);flex:1}.error{color:var(--vscode-errorForeground)}button{padding:8px 18px;border:0;border-radius:2px;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.file-list{width:100%;border-collapse:collapse}.file-list th,.file-list td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--vscode-panel-border)}.file-list tr[data-index]{cursor:pointer}.file-list tr[data-index]:hover{background:var(--vscode-list-hoverBackground)}.file-list tr.active{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}.badge{display:inline-block;padding:2px 7px;border-radius:10px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}.compare-title{font-size:16px;margin:12px 0}.compare{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);border:1px solid var(--vscode-panel-border);min-height:480px}.pane{min-width:0;min-height:0;overflow:auto}.pane:first-child{border-right:1px solid var(--vscode-panel-border)}.pane h2{font-size:13px;margin:0;padding:9px 12px;background:var(--vscode-editorGroupHeader-tabsBackground);border-bottom:1px solid var(--vscode-panel-border)}.binary-notice{display:none;grid-column:1/-1;align-items:center;justify-content:center;min-height:480px;font-size:16px;color:var(--vscode-descriptionForeground)}pre{box-sizing:border-box;margin:0;padding:10px 0;overflow:auto;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);line-height:1.5;tab-size:4}.line{display:block;padding:0 10px;white-space:pre}.changed{background:var(--vscode-diffEditor-insertedTextBackground)}.remote.changed{background:var(--vscode-diffEditor-removedTextBackground)}.number{display:inline-block;width:42px;text-align:right;margin-right:12px;color:var(--vscode-editorLineNumber-foreground);user-select:none}</style></head><body><div class="summary"><h1>Ready to Deploy <span class="badge" id="count"></span></h1><div class="detail"><label>Current SFTP</label><strong id="server"></strong></div><div class="detail"><label>Local file</label><span class="path" id="localPath"></span></div><div class="detail"><label id="remoteAction">Overwrite</label><span class="path" id="remotePath"></span></div><div class="actions"><span id="status" class="status">Select a file below to review and deploy.</span><div class="action-buttons"><button id="compare" class="secondary">Open VS Code Compare</button><button id="overwriteLocal" class="secondary">Overwrite Local with Server</button><button id="deploy">Deploy Selected File</button><button id="deployAll">Deploy All Files</button></div></div></div><div class="files"><table class="file-list"><thead><tr><th>Source Path</th><th>Target Path</th><th>Status</th></tr></thead><tbody id="fileRows"></tbody></table></div><div class="compare-title">Compare Changes</div><div class="compare"><section class="pane"><h2>Local version — will be deployed</h2><pre id="local"></pre></section><section class="pane"><h2 id="remoteTitle">Server version — will be overwritten</h2><pre id="remote"></pre></section><div id="binaryNotice" class="binary-notice">Cannot compare binary file</div></div><script>const vscode=acquireVsCodeApi(),data=${data};let selected=0;const deployed=new Set(),localOverwritten=new Set(),esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');document.getElementById('server').textContent=data.profile+' ('+data.host+')';document.getElementById('count').textContent=data.files.length+' file'+(data.files.length===1?'':'s');function alignLines(local,remote){const rows=local.length+1,cols=remote.length+1,matrix=Array.from({length:rows},()=>new Uint32Array(cols));for(let i=local.length-1;i>=0;i--)for(let j=remote.length-1;j>=0;j--)matrix[i][j]=local[i]===remote[j]?matrix[i+1][j+1]+1:Math.max(matrix[i+1][j],matrix[i][j+1]);const aligned=[];let i=0,j=0;while(i<local.length||j<remote.length){if(i<local.length&&j<remote.length&&local[i]===remote[j]){aligned.push({local:local[i],remote:remote[j],localNumber:++i,remoteNumber:++j,changed:false})}else if(j>=remote.length||(i<local.length&&matrix[i+1][j]>=matrix[i][j+1])){aligned.push({local:local[i],remote:null,localNumber:++i,remoteNumber:null,changed:true})}else{aligned.push({local:null,remote:remote[j],localNumber:null,remoteNumber:++j,changed:true})}}return aligned}function lines(aligned,remoteSide){return aligned.map(row=>{const value=remoteSide?row.remote:row.local,number=remoteSide?row.remoteNumber:row.localNumber;return '<span class="line '+(remoteSide?'remote ':'')+(row.changed?'changed':'')+(value===null?' empty':'')+'"><span class="number">'+(number??'')+'</span>'+esc(value??'')+'</span>'}).join('')}function rows(){document.getElementById('fileRows').innerHTML=data.files.map((file,index)=>'<tr data-index="'+index+'" class="'+(index===selected?'active':'')+'"><td class="path" title="'+esc(file.localPath)+'">'+esc(file.localPath)+'</td><td class="path" title="'+esc(file.remotePath)+'">'+esc(file.remotePath)+'</td><td>'+(deployed.has(index)?'✅ Deployed':localOverwritten.has(index)?'✅ Local Updated':file.identical?'✅ Identical':file.remoteExists?'🟡 Modified':'🆕 New')+'</td></tr>').join('');document.querySelectorAll('tr[data-index]').forEach(row=>row.onclick=()=>{selected=Number(row.dataset.index);render()})}function render(){const file=data.files[selected];document.getElementById('localPath').textContent=file.localPath;document.getElementById('remotePath').textContent=file.remotePath;document.getElementById('remoteAction').textContent=file.remoteExists?'Overwrite':'Create';document.getElementById('remoteTitle').textContent=file.remoteExists?'Server version — will be overwritten':'Server version — file does not exist (empty)';const panes=document.querySelectorAll('.pane'),notice=document.getElementById('binaryNotice'),compareButton=document.getElementById('compare');panes.forEach(pane=>pane.style.display=file.comparable?'block':'none');notice.style.display=file.comparable?'none':'flex';compareButton.disabled=!file.comparable;compareButton.title=file.comparable?'':'Cannot compare binary file';const local=file.localText.split(/\\r?\\n/),remote=file.remoteText.split(/\\r?\\n/),aligned=alignLines(local,remote);document.getElementById('local').innerHTML=lines(aligned,false);document.getElementById('remote').innerHTML=lines(aligned,true);const button=document.getElementById('deploy');button.disabled=deployed.has(selected)||file.identical;button.textContent=deployed.has(selected)?'Deployed':file.identical?'Up to Date':file.remoteExists?'Deploy Selected File':'Create Selected File';const overwriteButton=document.getElementById('overwriteLocal');overwriteButton.disabled=!file.remoteExists;overwriteButton.textContent='Overwrite Local with Server';document.getElementById('status').textContent=file.identical?'The local and server files are identical. No deployment is needed.':file.remoteExists?'Review the selected file, deploy local to server, or overwrite local with server.':'The selected server file does not exist and will be created.';rows()}document.getElementById('compare').onclick=()=>vscode.postMessage({type:'compare',index:selected});document.getElementById('overwriteLocal').onclick=()=>{const button=document.getElementById('overwriteLocal');button.disabled=true;button.textContent='Overwriting Local…';document.getElementById('status').textContent='Writing the server version to the selected local file…';vscode.postMessage({type:'overwriteLocal',index:selected})};document.getElementById('deploy').onclick=()=>{const button=document.getElementById('deploy');button.disabled=true;button.textContent='Deploying…';vscode.postMessage({type:'deploy',index:selected})};document.getElementById('deployAll').onclick=()=>{const button=document.getElementById('deployAll');button.disabled=true;button.textContent='Deploying All…';vscode.postMessage({type:'deployAll',index:selected})};window.addEventListener('message',event=>{const message=event.data,status=document.getElementById('status');status.textContent=message.text;status.className=message.type==='error'?'status error':'status';if(message.type==='deployed'){const file=data.files[message.index];if(file){file.remoteText=file.localText;file.remoteExists=true}deployed.add(message.index);localOverwritten.delete(message.index);render();status.textContent=message.text}if(message.type==='localOverwritten'){const file=data.files[message.index];if(file){file.localText=file.remoteText;file.identical=true}localOverwritten.add(message.index);deployed.delete(message.index);render();status.textContent=message.text;document.getElementById('overwriteLocal').textContent='Local Updated from Server'}if(message.type==='error'){document.getElementById('overwriteLocal').disabled=!data.files[selected].remoteExists;document.getElementById('overwriteLocal').textContent='Overwrite Local with Server';document.getElementById('deploy').disabled=false;document.getElementById('deploy').textContent=data.files[selected].remoteExists?'Deploy Selected File':'Create Selected File';document.getElementById('deployAll').disabled=false;document.getElementById('deployAll').textContent='Deploy All Files'}if(message.type==='allDeployed'){document.getElementById('deployAll').textContent='All Deployed'}});render()</script></body></html>`;
}
function openProfilesPanel(context, sftp, explorer) {
    const panel = vscode.window.createWebviewPanel('remoteDeploy.profiles', 'Connection Hierarchy', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
    panel.webview.html = profilePanelHtml(getSettings(), vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '');
    panel.webview.onDidReceiveMessage(async (message) => {
        if (message.type === 'browse') {
            const choice = await vscode.window.showOpenDialog({ canSelectFiles: message.profile?.privateKeyPath === '__key__', canSelectFolders: message.profile?.privateKeyPath !== '__key__', canSelectMany: false });
            if (choice?.[0]) {
                panel.webview.postMessage({ type: 'browse', value: choice[0].fsPath, key: message.profile?.privateKeyPath === '__key__' });
            }
            return;
        }
        if (message.type === 'test' && message.profile) {
            try {
                await sftp.dispose();
                await sftp.list(normalizeProfile(message.profile), normalizeRemotePath(message.profile.remoteRoot || '/'));
                panel.webview.postMessage({ type: 'status', text: 'Connection successful.', error: false });
            }
            catch (error) {
                panel.webview.postMessage({ type: 'status', text: `Connection failed: ${messageOf(error)}`, error: true });
            }
            return;
        }
        if (message.type === 'delete' && message.profile) {
            const settings = getSettings();
            const savedProfile = settings.profiles.find(item => item.id === message.profile.id);
            const profileName = savedProfile?.name ?? message.profile.name ?? 'this profile';
            const confirmation = await vscode.window.showWarningMessage(`Delete SFTP profile "${profileName}"? This removes its configuration and saved password from this workspace.`, { modal: true }, 'Delete Profile');
            if (confirmation !== 'Delete Profile') {
                return;
            }
            const profiles = settings.profiles.filter(item => item.id !== message.profile.id);
            const defaultProfileId = settings.defaultProfileId === message.profile.id ? profiles[0]?.id ?? '' : settings.defaultProfileId;
            await context.secrets.delete(`remoteDeploy.password.${message.profile.id}`);
            await vscode.workspace.getConfiguration('remoteDeploy').update('profiles', profiles, vscode.ConfigurationTarget.Workspace);
            await vscode.workspace.getConfiguration('remoteDeploy').update('defaultProfileId', defaultProfileId, vscode.ConfigurationTarget.Workspace);
            await sftp.dispose();
            explorer.refresh();
            panel.webview.postMessage({ type: 'deleted', profiles, defaultProfileId, text: `${profileName} deleted.` });
            vscode.window.showInformationMessage(`JetBrains style SFTP: ${profileName} deleted.`);
            return;
        }
        if (message.type === 'save' && message.profile) {
            if (!message.profile.name || !message.profile.host || !message.profile.username) {
                panel.webview.postMessage({ type: 'status', text: 'Profile name, host, and username are required.', error: true });
                return;
            }
            const profile = normalizeProfile(message.profile);
            const settings = getSettings();
            const profiles = settings.profiles.some(item => item.id === profile.id) ? settings.profiles.map(item => item.id === profile.id ? profile : item) : [...settings.profiles, profile];
            const defaultProfileId = message.defaultProfileId === profile.id || !settings.defaultProfileId ? profile.id : settings.defaultProfileId;
            if (message.profile.password) {
                await context.secrets.store(`remoteDeploy.password.${profile.id}`, message.profile.password);
            }
            if (profile.authMethod === 'privateKey') {
                await context.secrets.delete(`remoteDeploy.password.${profile.id}`);
            }
            await vscode.workspace.getConfiguration('remoteDeploy').update('profiles', profiles, vscode.ConfigurationTarget.Workspace);
            await vscode.workspace.getConfiguration('remoteDeploy').update('defaultProfileId', defaultProfileId, vscode.ConfigurationTarget.Workspace);
            await sftp.dispose();
            explorer.refresh();
            panel.webview.postMessage({ type: 'saved', profiles, defaultProfileId, selectedProfileId: profile.id, text: `${profile.name} saved for this workspace.` });
            vscode.window.showInformationMessage(`JetBrains style SFTP: ${profile.name} saved for this workspace.`);
        }
    }, undefined, context.subscriptions);
}
function profilePanelHtml(settings, workspacePath) {
    const data = JSON.stringify(settings).replace(/</g, '\\u003c');
    const currentFolder = JSON.stringify(workspacePath).replace(/</g, '\\u003c');
    return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:22px;max-width:1050px;margin:auto}h1{font-size:20px}.layout{display:grid;grid-template-columns:260px 1fr;gap:20px}.profiles{border-right:1px solid var(--vscode-panel-border);padding-right:15px}.connection-group{margin:4px 0 10px}.group-label{font-weight:600;padding:6px 8px;color:var(--vscode-foreground)}.group-label:before{content:'▾';display:inline-block;width:18px;color:var(--vscode-descriptionForeground)}.profile-row{display:grid;grid-template-columns:minmax(0,1fr) 28px 28px;align-items:center;margin:3px 0;gap:3px}.profile{min-width:0;text-align:left;margin:0;background:transparent;color:var(--vscode-foreground);border:0;padding:7px 8px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.profile:before{content:'◻';display:inline-block;width:18px;color:var(--vscode-descriptionForeground)}.profile.default:before{content:'★';color:var(--vscode-charts-yellow)}.profile.active{background:var(--vscode-list-activeSelectionBackground)}.profile-action{display:flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;background:transparent;color:var(--vscode-foreground);font-family:'Segoe MDL2 Assets','Segoe UI Symbol',sans-serif;font-size:15px}.profile-action:hover{background:var(--vscode-toolbar-hoverBackground)}.profile-action.remove{color:var(--vscode-errorForeground)}.group-add{margin:4px 0 2px 36px;padding:4px 8px;font-size:12px}button{padding:7px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:2px;cursor:pointer}.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.danger{background:var(--vscode-errorForeground);color:var(--vscode-button-foreground)}.danger:hover{opacity:.9}.row{display:grid;grid-template-columns:145px 1fr;align-items:center;gap:10px;margin:10px 0}.checkbox-row{display:grid;grid-template-columns:145px 1fr;align-items:center;gap:10px;margin:10px 0}.checkbox-control{display:flex;align-items:center;gap:8px}.checkbox-control input{width:auto;margin:0;padding:0}input,select{box-sizing:border-box;width:100%;padding:7px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border)}.inline{display:flex;gap:8px}.inline input{flex:1}.mapping{border:1px solid var(--vscode-panel-border);padding:10px;margin:10px 0}.mapping .row{grid-template-columns:125px 1fr}.actions{margin-top:20px;padding-top:15px;border-top:1px solid var(--vscode-panel-border);display:flex;justify-content:flex-end;gap:8px}.status{min-height:20px;color:var(--vscode-descriptionForeground)}.error{color:var(--vscode-errorForeground)}small{color:var(--vscode-descriptionForeground)}textarea{box-sizing:border-box;width:100%;min-height:72px;padding:7px;resize:vertical;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);font-family:var(--vscode-editor-font-family)}</style></head><body><h1>Connection Hierarchy</h1><div class="layout"><aside class="profiles"><div id="profileList"></div><button id="add" class="secondary">+ Add SFTP</button></aside><main><div id="editor"></div><div class="actions"><button id="remove" class="danger">Delete Profile</button><button id="save">Save Current Profile</button></div></main></div><script>const vscode=acquireVsCodeApi(),state=${data},currentFolder=${currentFolder};let selected=state.defaultProfileId||state.profiles[0]?.id||'';const byId=()=>state.profiles.find(p=>p.id===selected);const id=()=>crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2);function esc(v){return String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')}function render(){const list=document.getElementById('profileList');list.innerHTML=state.profiles.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(p=>'<div class="profile-row"><button class="profile '+(p.id===selected?'active ':'')+(p.id===state.defaultProfileId?'default':'')+'" data-id="'+p.id+'" title="'+esc(p.name)+(p.id===state.defaultProfileId?' — Workspace default':'')+'">'+esc(p.name)+'</button><button class="profile-action" data-copy="'+p.id+'" title="Copy '+esc(p.name)+'" aria-label="Copy '+esc(p.name)+'">⧉</button><button class="profile-action remove" data-remove="'+p.id+'" title="Remove '+esc(p.name)+'" aria-label="Remove '+esc(p.name)+'">×</button></div>').join('')||'<small>No SFTP profiles yet.</small>';list.querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>{selected=b.dataset.id;render()});list.querySelectorAll('[data-copy]').forEach(b=>b.onclick=()=>{const source=state.profiles.find(p=>p.id===b.dataset.copy);if(!source)return;const copy=JSON.parse(JSON.stringify(source));copy.id=id();copy.name=source.name+' Copy';copy.password='';state.profiles.push(copy);selected=copy.id;render()});list.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{const p=state.profiles.find(p=>p.id===b.dataset.remove);if(p)vscode.postMessage({type:'delete',profile:p})});const p=byId();const e=document.getElementById('editor');if(!p){e.innerHTML='<p>Add an SFTP profile. Each profile owns its own path mappings.</p>';return}e.innerHTML='<div class="row"><label>Profile name</label><input data-k="name"></div><div class="row"><label>Host</label><input data-k="host" placeholder="192.168.236.52"></div><div class="row"><label>Port</label><input data-k="port" type="number"></div><div class="row"><label>Username</label><input data-k="username"></div><div class="row"><label>Root path</label><input data-k="remoteRoot"></div><div class="row"><label>Authentication</label><select data-k="authMethod"><option value="password">Password</option><option value="privateKey">SSH private key</option></select></div><div class="row password-row"><label>Password</label><input data-k="password" type="password" placeholder="Saved securely in VS Code"></div><div class="row key-row"><label>Private key</label><div class="inline"><input data-k="privateKeyPath"><button class="secondary" id="key">Browse…</button></div></div><div class="checkbox-row"><span></span><label class="checkbox-control"><input id="default" type="checkbox"><span>Workspace default</span></label></div><h3>Deployment Behavior</h3><div class="checkbox-row"><label>Upload on save</label><label class="checkbox-control"><input id="uploadOnSave" type="checkbox"><span>Upload mapped files whenever they are saved</span></label></div><div class="checkbox-row"><label>Safe upload</label><label class="checkbox-control"><input id="useTemporaryFile" type="checkbox"><span>Upload a temporary file, then replace the target</span></label></div><h3>Deployment Exclusions</h3><small>One path or glob per line. Paths are relative to each path mapping.</small><div class="row"><label>Glob patterns</label><textarea id="exclusionPatterns" placeholder=".git/**&#10;.vscode/**&#10;node_modules/**"></textarea></div><div class="row"><label>Explicit local paths</label><textarea id="excludedLocalPaths" placeholder="secrets&#10;private-config.json"></textarea></div><div class="row"><label>Test</label><button id="test">Test Connection</button></div><div id="status" class="status"></div><h3>Path Mappings</h3><small>These mappings belong only to this SFTP profile.</small><div id="maps"></div><button id="addMap" class="secondary">Add New Mapping</button>';for(const k of ['name','host','port','username','remoteRoot','authMethod','privateKeyPath','password'])e.querySelector('[data-k="'+k+'"]').value=p[k]??'';function authRows(){const key=p.authMethod==='privateKey';e.querySelector('.key-row').style.display=key?'grid':'none';e.querySelector('.password-row').style.display=key?'none':'grid'}e.querySelectorAll('[data-k]').forEach(input=>{const update=()=>{p[input.dataset.k]=input.type==='number'?Number(input.value):input.value;if(input.dataset.k==='authMethod')authRows()};input.oninput=update;input.onchange=update});authRows();const lines=value=>Array.isArray(value)?value.join('\\n'):'';p.exclusions=p.exclusions||{};e.querySelector('#uploadOnSave').checked=Boolean(p.uploadOnSave);e.querySelector('#uploadOnSave').onchange=event=>p.uploadOnSave=event.target.checked;e.querySelector('#useTemporaryFile').checked=p.useTemporaryFile!==false;e.querySelector('#useTemporaryFile').onchange=event=>p.useTemporaryFile=event.target.checked;e.querySelector('#exclusionPatterns').value=lines(p.exclusions.patterns);e.querySelector('#excludedLocalPaths').value=lines(p.exclusions.localPaths);const exclusionLines=value=>value.split(/\\r?\\n/).map(item=>item.trim()).filter(Boolean);e.querySelector('#exclusionPatterns').oninput=event=>p.exclusions.patterns=exclusionLines(event.target.value);e.querySelector('#excludedLocalPaths').oninput=event=>p.exclusions.localPaths=exclusionLines(event.target.value);e.querySelector('#default').checked=state.defaultProfileId===p.id;e.querySelector('#default').onchange=event=>{if(event.target.checked){state.defaultProfileId=p.id;render()}};e.querySelector('#key').onclick=()=>vscode.postMessage({type:'browse',profile:{privateKeyPath:'__key__'}});e.querySelector('#test').onclick=()=>vscode.postMessage({type:'test',profile:p});function mapRow(m){if(!m.localPath)m.localPath=currentFolder;const d=document.createElement('div');d.className='mapping';d.innerHTML='<div class="row"><label>Local path</label><div class="inline"><input data-k="localPath"><button class="secondary">Browse…</button></div></div><div class="row"><label>Deployment path</label><input data-k="deploymentPath"></div><div class="row"><label>Web path</label><input data-k="webPath"></div><button class="secondary">Remove</button>';for(const k of ['localPath','deploymentPath','webPath'])d.querySelector('[data-k="'+k+'"]').value=m[k]??'';d.querySelectorAll('[data-k]').forEach(i=>i.oninput=()=>m[i.dataset.k]=i.value);d.querySelector('.inline button').onclick=()=>{p.__browse=m;vscode.postMessage({type:'browse',profile:{privateKeyPath:''}})};d.querySelector('.mapping>button').onclick=()=>{p.mappings=p.mappings.filter(x=>x!==m);render()};e.querySelector('#maps').appendChild(d)}p.mappings=p.mappings||[];p.mappings.forEach(mapRow);e.querySelector('#addMap').onclick=()=>{p.mappings.push({localPath:currentFolder,deploymentPath:'',webPath:'/'});render()}}function addProfile(){const p={id:id(),name:'New SFTP',host:'',port:22,username:'',remoteRoot:'/',authMethod:'password',privateKeyPath:'',password:'',mappings:[]};state.profiles.push(p);selected=p.id;render()}document.getElementById('add').onclick=()=>addProfile();document.getElementById('remove').onclick=()=>{const p=byId();if(p)vscode.postMessage({type:'delete',profile:p})};document.getElementById('save').onclick=()=>{const p=byId();if(p)vscode.postMessage({type:'save',profile:p,defaultProfileId:state.defaultProfileId})};window.addEventListener('message',e=>{const m=e.data,p=byId();if(m.type==='browse'&&p){if(m.key)p.privateKeyPath=m.value;else if(p.__browse){p.__browse.localPath=m.value;delete p.__browse}render()}if(m.type==='status'){const s=document.getElementById('status');if(s){s.textContent=m.text;s.className='status '+(m.error?'error':'')}}if(m.type==='saved'){state.profiles=m.profiles;state.defaultProfileId=m.defaultProfileId;selected=m.selectedProfileId||selected;if(!state.profiles.some(p=>p.id===selected))selected=state.defaultProfileId||state.profiles[0]?.id||'';render();const s=document.getElementById('status');if(s){s.textContent=m.text;s.className='status'}}if(m.type==='deleted'){state.profiles=m.profiles;state.defaultProfileId=m.defaultProfileId;selected=state.defaultProfileId||state.profiles[0]?.id||'';render()}});render()</script></body></html>`;
}
function getSettings() {
    const config = vscode.workspace.getConfiguration('remoteDeploy');
    const profiles = config.get('profiles', []);
    if (profiles.length) {
        return { profiles: profiles.map(normalizeProfile), defaultProfileId: config.get('defaultProfileId', profiles[0].id) };
    }
    const host = config.get('host', '');
    if (!host) {
        return { profiles: [], defaultProfileId: '' };
    }
    const legacy = { id: 'legacy', name: host, host, port: config.get('port', 22), username: config.get('username', ''), remoteRoot: config.get('remoteRoot', '/'), authMethod: config.get('privateKeyPath', '') ? 'privateKey' : 'password', privateKeyPath: config.get('privateKeyPath', ''), mappings: config.get('mappings', []) };
    return { profiles: [normalizeProfile(legacy)], defaultProfileId: 'legacy' };
}
function normalizeProfile(profile) { const { group: _group, ...flatProfile } = profile; return { ...flatProfile, authMethod: profile.authMethod === 'privateKey' ? 'privateKey' : 'password', id: profile.id || crypto.randomUUID(), name: profile.name || profile.host, port: Number(profile.port) || 22, remoteRoot: normalizeRemotePath(profile.remoteRoot || '/'), mappings: (profile.mappings || []).filter(mapping => mapping.localPath && mapping.deploymentPath).map(mapping => ({ localPath: path.resolve(mapping.localPath), deploymentPath: normalizeRemotePath(mapping.deploymentPath), webPath: mapping.webPath })) }; }
function selectedProfile(settings) { const profile = settings.profiles.find(item => item.id === settings.defaultProfileId) ?? settings.profiles[0]; if (!profile) {
    throw new Error('Create an SFTP profile first.');
} return profile; }
async function selectProfileForLocalAction(action) { const settings = getSettings(); if (!settings.profiles.length) {
    vscode.window.showWarningMessage('Create an SFTP profile first.');
    return undefined;
} const defaultId = settings.defaultProfileId; const selected = await vscode.window.showQuickPick(settings.profiles.slice().sort((a, b) => a.name.localeCompare(b.name)).map(profile => ({ label: profile.name, description: `${profile.username}@${profile.host}:${profile.port}`, detail: profile.id === defaultId ? 'Workspace default' : undefined, profile })), { title: 'JetBrains style SFTP: Select Server', placeHolder: `Select the server to ${action}`, ignoreFocusOut: true }); return selected?.profile; }
function mappingRemotePath(profile, mapping) { const root = normalizeRemotePath(profile.remoteRoot || '/'); const deployment = normalizeRemotePath(mapping.deploymentPath || '/'); return deployment === root || deployment.startsWith(`${root}/`) ? deployment : path.posix.join(root, deployment.replace(/^\/+/, '')); }
function remotePathFor(profile, localPath) { const resolvedLocalPath = path.resolve(localPath); const mapping = profile.mappings.filter(m => isPathWithin(resolvedLocalPath, m.localPath)).sort((a, b) => b.localPath.length - a.localPath.length)[0]; if (mapping) {
    return path.posix.join(mappingRemotePath(profile, mapping), path.relative(mapping.localPath, resolvedLocalPath).split(path.sep).join('/'));
} const root = workspaceRootFor(resolvedLocalPath); if (!root) {
    throw new Error(`File is outside every open workspace folder and has no path mapping in ${profile.name}. Add a mapping for ${resolvedLocalPath} in Connection Hierarchy.`);
} return path.posix.join(profile.remoteRoot, path.relative(root, resolvedLocalPath).split(path.sep).join('/')); }
function isPathWithin(candidate, parent) { const relative = path.relative(path.resolve(parent), path.resolve(candidate)); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
function workspaceRootFor(localPath) { return vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath).filter(folder => isPathWithin(localPath, folder)).sort((a, b) => b.length - a.length)[0]; }
function defaultLocalPath(profile, remotePath) { const mapping = profile.mappings.map(item => ({ item, remoteBase: mappingRemotePath(profile, item) })).filter(({ remoteBase }) => remotePath === remoteBase || remotePath.startsWith(`${remoteBase}/`)).sort((a, b) => b.remoteBase.length - a.remoteBase.length)[0]; return mapping ? path.join(mapping.item.localPath, path.posix.relative(mapping.remoteBase, remotePath)) : path.join(workspaceRoot(), path.posix.relative(profile.remoteRoot, remotePath)); }
function workspaceRoot() { const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; if (!root) {
    throw new Error('Open a workspace folder first.');
} return root; }
async function writeRemotePreviewFile(context, profileId, remotePath, data) { const hash = crypto.createHash('sha1').update(`${profileId}:${remotePath}`).digest('hex').slice(0, 12); const file = path.join(context.globalStorageUri.fsPath, 'previews', hash, path.basename(remotePath)); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); return vscode.Uri.file(file); }
async function writeComparisonFile(context, profileId, remotePath, data) { const hash = crypto.createHash('sha1').update(`${profileId}:${remotePath}`).digest('hex').slice(0, 12); const ext = path.extname(remotePath); const file = path.join(context.globalStorageUri.fsPath, 'comparisons', `${path.basename(remotePath, ext)}.${hash}.server${ext}`); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); return vscode.Uri.file(file); }
async function writeLocalComparisonFile(context, profileId, localPath, data) { const hash = crypto.createHash('sha1').update(`${profileId}:${localPath}`).digest('hex').slice(0, 12); const ext = path.extname(localPath); const file = path.join(context.globalStorageUri.fsPath, 'comparisons', `${path.basename(localPath, ext)}.${hash}.local${ext}`); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); return vscode.Uri.file(file); }
async function writeClipboardComparisonFile(context, localPath, content) { const hash = crypto.createHash('sha1').update(localPath).digest('hex').slice(0, 12); const ext = path.extname(localPath) || '.txt'; const file = path.join(context.globalStorageUri.fsPath, 'comparisons', `${path.basename(localPath, path.extname(localPath))}.${hash}.clipboard${ext}`); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content, 'utf8'); return vscode.Uri.file(file); }
async function writeEmptyComparisonFile(context, profileId, localPath) { const hash = crypto.createHash('sha1').update(`${profileId}:${localPath}`).digest('hex').slice(0, 12); const ext = path.extname(localPath); const file = path.join(context.globalStorageUri.fsPath, 'comparisons', `${path.basename(localPath, ext)}.${hash}.local-empty${ext}`); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, ''); return vscode.Uri.file(file); }
function isTextBuffer(data) { if (!data.length) {
    return true;
} const sample = data.subarray(0, Math.min(data.length, 8192)); if (sample.includes(0)) {
    return false;
} let control = 0; for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) {
        control++;
    }
} return control / sample.length < 0.02; }
function normalizeRemotePath(value) { const normalized = path.posix.normalize(value.replace(/\\/g, '/')); return normalized.startsWith('/') ? normalized : `/${normalized}`; }
function formatSize(size) { return size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1048576).toFixed(1)} MB`; }
function messageOf(error) { return error instanceof Error ? error.message : String(error); }
async function deactivate() { }
//# sourceMappingURL=extension.js.map