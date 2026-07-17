import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import SftpClient from 'ssh2-sftp-client';

type RemoteEntry = { name: string; type: '-' | 'd' | 'l'; size: number; modifyTime: number };
type PathMapping = { localPath: string; deploymentPath: string; webPath?: string };
type DeploymentProfile = { id: string; name: string; host: string; port: number; username: string; remoteRoot: string; authMethod: 'password' | 'privateKey'; privateKeyPath: string; password?: string; mappings: PathMapping[]; exclusions?: { patterns?: string[]; localPaths?: string[]; remotePaths?: string[] }; uploadOnSave?: boolean; useTemporaryFile?: boolean };
type Settings = { profiles: DeploymentProfile[]; defaultProfileId: string };
type DeployPreviewFile = { local: vscode.Uri; displayLocalPath?: string; remotePath: string; localData: Buffer; remoteData: Buffer; remoteExists: boolean; comparable: boolean };
type SyncLocalPreviewFile = { remotePath: string; localPath: string; remoteData: Buffer; localData: Buffer; localExists: boolean; comparable: boolean };

class SftpService implements vscode.Disposable {
  private client?: SftpClient;
  private profileId?: string;

  constructor(private readonly secrets: vscode.SecretStorage, private readonly log: vscode.LogOutputChannel) {}


  async list(profile: DeploymentProfile, remotePath: string): Promise<RemoteEntry[]> { await this.connect(profile); this.log.debug(`List ${profile.name}:${remotePath}`); return (await this.client!.list(remotePath)) as RemoteEntry[]; }
  async download(profile: DeploymentProfile, remotePath: string): Promise<Buffer> { await this.connect(profile); this.log.info(`Download ${profile.name}:${remotePath}`); return (await this.client!.get(remotePath)) as Buffer; }
  async downloadIfExists(profile: DeploymentProfile, remotePath: string): Promise<{ data: Buffer; exists: boolean }> { await this.connect(profile); const type = await this.client!.exists(remotePath); return type === '-' ? { data: (await this.client!.get(remotePath)) as Buffer, exists: true } : { data: Buffer.alloc(0), exists: false }; }
  async upload(profile: DeploymentProfile, localPath: string, remotePath: string): Promise<void> {
    await this.uploadData(profile, await readCurrentLocalData(vscode.Uri.file(localPath)), remotePath);
  }
  async uploadData(profile: DeploymentProfile, data: Buffer, remotePath: string): Promise<void> {
    await this.connect(profile);
    const remoteDirectory = path.posix.dirname(remotePath);
    const directoryType = await this.client!.exists(remoteDirectory);
    if (directoryType === false) { await this.client!.mkdir(remoteDirectory, true); }
    else if (directoryType !== 'd') { throw new Error(`Remote path exists but is not a directory: ${remoteDirectory}`); }
    if (profile.useTemporaryFile === false) { await this.client!.put(data, remotePath); this.log.info(`Uploaded ${profile.name}:${remotePath}`); return; }
    const temporaryPath = `${remotePath}.remote-deploy-${Date.now()}.tmp`;
    try {
      await this.client!.put(data, temporaryPath);
      await this.replaceRemoteAtomically(temporaryPath, remotePath);
      this.log.info(`Safely uploaded ${profile.name}:${remotePath}`);
    } catch (error) {
      await this.client!.delete(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
  private async replaceRemoteAtomically(temporaryPath: string, targetPath: string): Promise<void> {
    try { await this.client!.posixRename(temporaryPath, targetPath); return; }
    catch {
      const targetExists = await this.client!.exists(targetPath);
      if (!targetExists) { await this.client!.rename(temporaryPath, targetPath); return; }
      const backupPath = `${targetPath}.remote-deploy-${Date.now()}.bak`;
      await this.client!.rename(targetPath, backupPath);
      try { await this.client!.rename(temporaryPath, targetPath); await this.client!.delete(backupPath); }
      catch (error) { await this.client!.rename(backupPath, targetPath).catch(() => undefined); throw error; }
    }
  }
  async rename(profile: DeploymentProfile, oldPath: string, newPath: string): Promise<void> { await this.connect(profile); await this.client!.rename(oldPath, newPath); }
  async delete(profile: DeploymentProfile, remotePath: string, directory: boolean): Promise<void> { await this.connect(profile); if (directory) { await this.client!.rmdir(remotePath, true); } else { await this.client!.delete(remotePath); } }
  async dispose(): Promise<void> { if (this.client) { await this.client.end().catch(() => undefined); this.client = undefined; this.profileId = undefined; } }

  private async connect(profile: DeploymentProfile): Promise<void> {
    if (this.client && this.profileId === profile.id) { return; }
    await this.dispose();
    const config: Record<string, unknown> = { host: profile.host, port: profile.port, username: profile.username, readyTimeout: 15000 };
    if (profile.authMethod === 'privateKey') {
      if (!profile.privateKeyPath) { throw new Error('Select an SSH private key for this SFTP profile.'); }
      config.privateKey = await fs.readFile(profile.privateKeyPath);
    } else {
      const storedPassword = await this.secrets.get(`remoteDeploy.password.${profile.id}`);
      const password = profile.password || storedPassword || await vscode.window.showInputBox({ prompt: `Password for ${profile.username}@${profile.host}`, password: true, ignoreFocusOut: true });
      if (password === undefined) { throw new Error('Password entry cancelled.'); }
      if (!password) { throw new Error('Enter a password for this SFTP profile.'); }
      config.password = password;
    }
    const client = new SftpClient();
    await client.connect(config);
    this.client = client;
    this.profileId = profile.id;
  }
}

class RemoteFileSystemProvider implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  constructor(private readonly sftp: SftpService) {}
  watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }
  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { profile, remotePath } = this.resolve(uri);
    const parent = path.posix.dirname(remotePath);
    const item = (await this.sftp.list(profile, parent)).find(entry => entry.name === path.posix.basename(remotePath));
    if (!item) { throw vscode.FileSystemError.FileNotFound(uri); }
    return { type: item.type === 'd' ? vscode.FileType.Directory : item.type === 'l' ? vscode.FileType.SymbolicLink : vscode.FileType.File, ctime: item.modifyTime, mtime: item.modifyTime, size: item.size };
  }
  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const { profile, remotePath } = this.resolve(uri);
    return (await this.sftp.list(profile, remotePath)).map(entry => [entry.name, entry.type === 'd' ? vscode.FileType.Directory : entry.type === 'l' ? vscode.FileType.SymbolicLink : vscode.FileType.File]);
  }
  async readFile(uri: vscode.Uri): Promise<Uint8Array> { const { profile, remotePath } = this.resolve(uri); return this.sftp.download(profile, remotePath); }
  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    this.requireTrusted();
    const { profile, remotePath } = this.resolve(uri);
    const exists = await this.exists(profile, remotePath);
    if (exists && !options.overwrite) { throw vscode.FileSystemError.FileExists(uri); }
    if (!exists && !options.create) { throw vscode.FileSystemError.FileNotFound(uri); }
    await this.sftp.uploadData(profile, Buffer.from(content), remotePath);
    this.emitter.fire([{ type: exists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
  }
  async createDirectory(uri: vscode.Uri): Promise<void> { this.requireTrusted(); const { profile, remotePath } = this.resolve(uri); await this.sftp.uploadData(profile, Buffer.alloc(0), path.posix.join(remotePath, '.remote-deploy-keep')); await this.sftp.delete(profile, path.posix.join(remotePath, '.remote-deploy-keep'), false); this.emitter.fire([{ type: vscode.FileChangeType.Created, uri }]); }
  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> { this.requireTrusted(); const { profile, remotePath } = this.resolve(uri); const stat = await this.stat(uri); await this.sftp.delete(profile, remotePath, stat.type === vscode.FileType.Directory && options.recursive); this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]); }
  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    this.requireTrusted();
    if (oldUri.authority !== newUri.authority) { throw vscode.FileSystemError.NoPermissions('Cannot rename across SFTP profiles.'); }
    const oldFile = this.resolve(oldUri), newFile = this.resolve(newUri);
    if (!options.overwrite && await this.exists(newFile.profile, newFile.remotePath)) { throw vscode.FileSystemError.FileExists(newUri); }
    await this.sftp.rename(oldFile.profile, oldFile.remotePath, newFile.remotePath);
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri: oldUri }, { type: vscode.FileChangeType.Created, uri: newUri }]);
  }
  private resolve(uri: vscode.Uri): { profile: DeploymentProfile; remotePath: string } {
    const profile = getSettings().profiles.find(item => item.id === uri.authority);
    if (!profile) { throw vscode.FileSystemError.Unavailable(`Unknown SFTP profile: ${uri.authority}`); }
    const remotePath = normalizeRemotePath(uri.path);
    if (remotePath !== profile.remoteRoot && !remotePath.startsWith(`${profile.remoteRoot}/`)) { throw vscode.FileSystemError.NoPermissions('Remote path is outside the configured root.'); }
    return { profile, remotePath };
  }
  private async exists(profile: DeploymentProfile, remotePath: string): Promise<boolean> { try { await this.stat(vscode.Uri.from({ scheme: 'remote-deploy', authority: profile.id, path: remotePath })); return true; } catch { return false; } }
  private requireTrusted(): void { if (!vscode.workspace.isTrusted) { throw vscode.FileSystemError.NoPermissions('Trust the workspace before modifying remote files.'); } }
}

class RemoteNode extends vscode.TreeItem {
  constructor(readonly kind: 'selector' | 'server' | 'directory' | 'file' | 'setup', readonly profile?: DeploymentProfile, readonly remotePath?: string, size?: number) {
    const label = kind === 'selector' ? `SFTP SERVER    ${profile!.name}  ▾` : kind === 'server' ? profile!.name : kind === 'setup' ? 'Add an SFTP Connection' : path.posix.basename(remotePath!) || remotePath!;
    super(label, kind === 'server' ? vscode.TreeItemCollapsibleState.Expanded : kind === 'directory' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.contextValue = kind;
    this.tooltip = kind === 'selector' ? `Switch SFTP server — currently ${profile!.name} (${profile!.username}@${profile!.host}:${profile!.port})` : kind === 'server' ? `${profile!.username}@${profile!.host}:${profile!.port}${remotePath}` : remotePath;
    if (kind === 'selector') { this.iconPath = new vscode.ThemeIcon('server-environment'); this.command = { command: 'remoteDeploy.selectServer', title: 'Switch SFTP Server' }; }
    if (kind === 'server') { this.iconPath = new vscode.ThemeIcon('remote-explorer', new vscode.ThemeColor('charts.green')); this.description = `${profile!.host}:${profile!.port}${remotePath}`; }
    if (kind === 'directory') { this.iconPath = new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.green')); }
    if (kind === 'file') {
      this.resourceUri = vscode.Uri.from({ scheme: 'remote-deploy', authority: profile!.id, path: remotePath! });
      this.description = size === undefined ? undefined : formatSize(size);
      this.command = { command: 'remoteDeploy.previewRemote', title: 'Edit Remote File', arguments: [this] };
    }
    if (kind === 'setup') { this.iconPath = new vscode.ThemeIcon('add'); this.description = 'Create a deployment profile'; this.command = { command: 'remoteDeploy.configure', title: 'Add SFTP Connection' }; }
  }
}

class RemoteExplorer implements vscode.TreeDataProvider<RemoteNode> {
  private readonly emitter = new vscode.EventEmitter<RemoteNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private readonly sftp: SftpService) {}
  refresh(): void { this.emitter.fire(undefined); }
  getTreeItem(node: RemoteNode): vscode.TreeItem { return node; }
  async getChildren(node?: RemoteNode): Promise<RemoteNode[]> {
    const settings = getSettings();
    if (!settings.profiles.length) { return node ? [] : [new RemoteNode('setup')]; }
    const profile = selectedProfile(settings);
    if (!node) { return [new RemoteNode('selector', profile), new RemoteNode('server', profile, profile.remoteRoot)]; }
    if (node.kind !== 'server' && node.kind !== 'directory') { return []; }
    const remotePath = node.remotePath!;
    const nodeProfile = node.profile ?? profile;
    try {
      const entries = await this.sftp.list(nodeProfile, remotePath);
      return entries.filter(entry => entry.name !== '.' && entry.name !== '..').sort((a, b) => Number(b.type === 'd') - Number(a.type === 'd') || a.name.localeCompare(b.name)).map(entry => new RemoteNode(entry.type === 'd' ? 'directory' : 'file', nodeProfile, path.posix.join(remotePath, entry.name), entry.size));
    } catch (error) { vscode.window.showErrorMessage(`JetBrains style SFTP: ${messageOf(error)}`); return []; }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('JetBrains style SFTP', { log: true });
  const sftp = new SftpService(context.secrets, log);
  const explorer = new RemoteExplorer(sftp);
  const remoteFileSystem = new RemoteFileSystemProvider(sftp);
  const primaryTree = vscode.window.createTreeView('remoteDeploy.explorer', { treeDataProvider: explorer, canSelectMany: true });
  const fallbackTree = vscode.window.createTreeView('remoteDeploy.explorerFallback', { treeDataProvider: explorer, canSelectMany: true });
  let lastSelectedTree: vscode.TreeView<RemoteNode> | undefined;
  const selectedRemoteNodes = (): readonly RemoteNode[] => {
    if (lastSelectedTree?.selection.length) { return lastSelectedTree.selection; }
    if (primaryTree.visible && primaryTree.selection.length) { return primaryTree.selection; }
    if (fallbackTree.visible && fallbackTree.selection.length) { return fallbackTree.selection; }
    return primaryTree.selection.length ? primaryTree.selection : fallbackTree.selection;
  };
  const selectedRemoteNode = (): RemoteNode | undefined => selectedRemoteNodes()[0];
  context.subscriptions.push(sftp, primaryTree, fallbackTree, primaryTree.onDidChangeSelection(() => { lastSelectedTree = primaryTree; }), fallbackTree.onDidChangeSelection(() => { lastSelectedTree = fallbackTree; }), log, vscode.workspace.registerFileSystemProvider('remote-deploy', remoteFileSystem, { isCaseSensitive: true }));
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async document => {
      if (document.uri.scheme !== 'file' || !vscode.workspace.isTrusted) { return; }
      const settings = getSettings();
      const enabled = vscode.workspace.getConfiguration('remoteDeploy').get<boolean>('uploadOnSave', false);
      for (const profile of settings.profiles) {
        if (!enabled && !profile.uploadOnSave) { continue; }
        try {
          remotePathFor(profile, document.uri.fsPath);
          if (isLocalExcluded(profile, document.uri.fsPath)) { continue; }
          await sftp.upload(profile, document.uri.fsPath, remotePathFor(profile, document.uri.fsPath));
          log.info(`Uploaded on save ${profile.name}:${document.uri.fsPath}`);
        } catch (error) {
          if (!messageOf(error).includes('outside this project and has no mapping')) { log.error(`Upload on save failed for ${document.uri.fsPath}: ${messageOf(error)}`); }
        }
      }
    }),
    vscode.commands.registerCommand('remoteDeploy.configure', () => openProfilesPanel(context, sftp, explorer)),
    vscode.commands.registerCommand('remoteDeploy.addMapping', () => openProfilesPanel(context, sftp, explorer)),
    vscode.commands.registerCommand('remoteDeploy.selectServer', async () => {
      const settings = getSettings();
      if (!settings.profiles.length) { openProfilesPanel(context, sftp, explorer); return; }
      const selected = await selectServerInEditor(context, settings, 'Select Workspace Server', 'Choose the server shown in Remote Files and used by default actions.');
      if (!selected) { return; }
      await vscode.workspace.getConfiguration('remoteDeploy').update('defaultProfileId', selected.id, vscode.ConfigurationTarget.Workspace);
      await sftp.dispose(); explorer.refresh();
    }),
    vscode.commands.registerCommand('remoteDeploy.refresh', async () => { await sftp.dispose(); explorer.refresh(); }),
    vscode.commands.registerCommand('remoteDeploy.showLog', () => log.show(true)),
    vscode.commands.registerCommand('remoteDeploy.uploadDefault', async (uri?: vscode.Uri) => vscode.commands.executeCommand('remoteDeploy.upload', uri, selectedProfile(getSettings()))),
    vscode.commands.registerCommand('remoteDeploy.previewDeployDefault', async (uri?: vscode.Uri, selectedUris?: vscode.Uri[]) => vscode.commands.executeCommand('remoteDeploy.previewDeploy', uri, selectedUris, selectedProfile(getSettings()))),
    vscode.commands.registerCommand('remoteDeploy.compareDefault', async (uri?: vscode.Uri) => vscode.commands.executeCommand('remoteDeploy.compare', uri, selectedProfile(getSettings()))),
    vscode.commands.registerCommand('remoteDeploy.upload', async (uri?: vscode.Uri, profileOverride?: DeploymentProfile) => withLocalFile(uri, async local => { const profile = profileOverride ?? await selectProfileForLocalAction(context, 'upload to'); if (!profile) { return; } const remote = remotePathFor(profile, local.fsPath); await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Uploading ${path.basename(local.fsPath)} to ${profile.name}` }, () => sftp.upload(profile, local.fsPath, remote)); explorer.refresh(); vscode.window.showInformationMessage(`Uploaded to ${profile.name}: ${remote}`); })),
    vscode.commands.registerCommand('remoteDeploy.previewDeploy', async (uri?: vscode.Uri, selectedUris?: vscode.Uri[], profileOverride?: DeploymentProfile) => {
      const candidates = (selectedUris?.length ? selectedUris : uri ? [uri] : vscode.window.activeTextEditor?.document.uri ? [vscode.window.activeTextEditor.document.uri] : []).filter(item => item.scheme === 'file');
      if (!candidates.length) { vscode.window.showWarningMessage('Select one or more local files or folders first.'); return; }
      const profile = profileOverride ?? await selectProfileForLocalAction(context, 'sync with deployed files on');
      if (!profile) { return; }
      try {
        const files = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Scanning local files for deployment comparison' }, async () => {
          const discovered = (await Promise.all(candidates.map(candidate => collectLocalFiles(candidate.fsPath, profile)))).flat();
          const unique = [...new Map(discovered.map(file => [path.resolve(file).toLowerCase(), vscode.Uri.file(file)])).values()];
          return unique;
        });
        if (!files.length) { vscode.window.showWarningMessage('The selected folders do not contain any files.'); return; }
        const previews = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Comparing ${files.length} local file${files.length === 1 ? '' : 's'} with ${profile.name}` }, async progress => {
          const result: DeployPreviewFile[] = [];
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
      } catch (error) { vscode.window.showErrorMessage(`Deployment preview failed: ${messageOf(error)}`); }
    }),
    vscode.commands.registerCommand('remoteDeploy.compare', async (argument?: vscode.Uri, profileOverride?: DeploymentProfile) => {
      const local = argument ?? vscode.window.activeTextEditor?.document.uri;
      if (!local || local.scheme !== 'file') { vscode.window.showWarningMessage('Select or open a local file to compare.'); return; }
      const profile = profileOverride ?? await selectProfileForLocalAction(context, 'compare with');
      if (!profile) { return; }
      const remote = remotePathFor(profile, local.fsPath);
      try { const data = await sftp.download(profile, remote); const serverFile = await writeComparisonFile(context, profile.id, remote, data); await vscode.commands.executeCommand('vscode.diff', local, serverFile, `${path.basename(remote)} — Local ↔ ${profile.name}`); } catch (error) { vscode.window.showErrorMessage(`Comparison failed: ${messageOf(error)}`); }
    }),
    vscode.commands.registerCommand('remoteDeploy.compareClipboard', async (argument?: vscode.Uri) => {
      const local = argument ?? vscode.window.activeTextEditor?.document.uri;
      if (!local || local.scheme !== 'file') { vscode.window.showWarningMessage('Select or open a local file to compare.'); return; }
      const clipboard = await vscode.env.clipboard.readText();
      if (!clipboard) { vscode.window.showWarningMessage('The clipboard is empty. Copy text first, then compare it with the selected file.'); return; }
      try {
        const clipboardFile = await writeClipboardComparisonFile(context, local.fsPath, clipboard);
        await vscode.commands.executeCommand('vscode.diff', clipboardFile, local, `${path.basename(local.fsPath)} — Clipboard ↔ Local`);
      } catch (error) { vscode.window.showErrorMessage(`Clipboard comparison failed: ${messageOf(error)}`); }
    }),
    vscode.commands.registerCommand('remoteDeploy.compareLocal', async (node?: RemoteNode) => {
      node ??= selectedRemoteNode();
      if (!node?.profile || node.kind !== 'file') { return; }
      const local = vscode.Uri.file(defaultLocalPath(node.profile, node.remotePath!));
      try {
        const data = await sftp.download(node.profile, node.remotePath!);
        const serverFile = await writeComparisonFile(context, node.profile.id, node.remotePath!, data);
        await vscode.commands.executeCommand('vscode.diff', serverFile, local, `${path.basename(node.remotePath!)} — ${node.profile.name} ↔ Local`);
      } catch (error) { vscode.window.showErrorMessage(`Comparison failed: ${messageOf(error)}`); }
    }),
    vscode.commands.registerCommand('remoteDeploy.previewRemote', async (node?: RemoteNode) => {
      node ??= selectedRemoteNode();
      if (!node?.profile || node.kind !== 'file') { return; }
      try {
        const remoteUri = vscode.Uri.from({ scheme: 'remote-deploy', authority: node.profile.id, path: node.remotePath! });
        const document = await vscode.workspace.openTextDocument(remoteUri);
        await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
      } catch (error) { vscode.window.showErrorMessage(`Opening remote file failed: ${messageOf(error)}`); }
    }),
    vscode.commands.registerCommand('remoteDeploy.download', async (node?: RemoteNode) => {
      node ??= selectedRemoteNode();
      if (!node?.profile || (node.kind !== 'file' && node.kind !== 'directory')) { return; }
      const defaultTarget = defaultLocalPath(node.profile, node.remotePath!);
      const target = node.kind === 'directory'
        ? (await vscode.window.showOpenDialog({ defaultUri: vscode.Uri.file(path.dirname(defaultTarget)), canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Download Here' }))?.[0]
        : await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(defaultTarget), saveLabel: 'Download' });
      if (!target) { return; }
      const destination = node.kind === 'directory' ? path.join(target.fsPath, path.posix.basename(node.remotePath!)) : target.fsPath;
      try { await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Downloading ${path.posix.basename(node.remotePath!)}` }, () => downloadRemoteItem(sftp, node.profile!, node.remotePath!, destination, node.kind === 'directory')); if (node.kind === 'file') { await vscode.window.showTextDocument(vscode.Uri.file(destination)); } vscode.window.showInformationMessage(`Downloaded to ${destination}`); } catch (error) { vscode.window.showErrorMessage(`Download failed: ${messageOf(error)}`); }
    }),
    vscode.commands.registerCommand('remoteDeploy.renameRemote', async (node?: RemoteNode) => {
      node ??= selectedRemoteNode();
      if (!node?.profile || (node.kind !== 'file' && node.kind !== 'directory')) { return; }
      const currentName = path.posix.basename(node.remotePath!);
      const name = await vscode.window.showInputBox({ title: 'Rename Remote Item', prompt: `Rename ${currentName}`, value: currentName, validateInput: value => !value.trim() ? 'Enter a name.' : value.includes('/') || value.includes('\\') ? 'Name cannot contain path separators.' : undefined });
      if (!name || name === currentName) { return; }
      const newPath = path.posix.join(path.posix.dirname(node.remotePath!), name);
      try { await sftp.rename(node.profile, node.remotePath!, newPath); explorer.refresh(); vscode.window.showInformationMessage(`Renamed to ${name}`); } catch (error) { vscode.window.showErrorMessage(`Rename failed: ${messageOf(error)}`); }
    }),
    vscode.commands.registerCommand('remoteDeploy.deleteRemote', async (node?: RemoteNode) => {
      node ??= selectedRemoteNode();
      if (!node?.profile || (node.kind !== 'file' && node.kind !== 'directory')) { return; }
      const name = path.posix.basename(node.remotePath!);
      const confirmation = await vscode.window.showWarningMessage(`Delete ${node.kind} "${name}" from ${node.profile.name}?${node.kind === 'directory' ? ' The folder and all contents will be permanently deleted.' : ''}`, { modal: true }, 'Delete');
      if (confirmation !== 'Delete') { return; }
      try { await sftp.delete(node.profile, node.remotePath!, node.kind === 'directory'); explorer.refresh(); vscode.window.showInformationMessage(`Deleted ${name} from ${node.profile.name}.`); } catch (error) { vscode.window.showErrorMessage(`Delete failed: ${messageOf(error)}`); }
    }),
    vscode.commands.registerCommand('remoteDeploy.syncLocal', async (node?: RemoteNode, selectedNodes?: RemoteNode[]) => {
      const fallbackSelection = !node && !selectedNodes?.length ? selectedRemoteNodes() : [];
      const candidates = selectedNodes?.length ? selectedNodes : node ? [node] : fallbackSelection;
      node ??= candidates[0];
      const remoteFiles = candidates.filter(item => item.profile && item.kind === 'file');
      if (remoteFiles.length) {
        const profile = remoteFiles[0].profile!;
        const files = remoteFiles.filter(item => item.profile?.id === profile.id);
        try {
          const previews = await Promise.all(files.map(async item => {
            const localPath = defaultLocalPath(profile, item.remotePath!);
            const [remoteData, localFile] = await Promise.all([sftp.download(profile, item.remotePath!), readLocalFileIfExists(localPath)]);
            return { remotePath: item.remotePath!, localPath, remoteData, localData: localFile.data, localExists: localFile.exists, comparable: isTextBuffer(remoteData) && (!localFile.exists || isTextBuffer(localFile.data)) } satisfies SyncLocalPreviewFile;
          }));
          openSyncLocalPreview(context, profile, previews);
        } catch (error) { vscode.window.showErrorMessage(`Sync preview failed: ${messageOf(error)}`); }
        return;
      }
      if (!node?.profile || node.kind !== 'directory') { return; }
      const destination = defaultLocalPath(node.profile, node.remotePath!);
      const confirmation = await vscode.window.showWarningMessage(`Sync ${node.remotePath} to local? Existing local directory content at ${destination} may be overwritten.`, { modal: true }, 'Sync to Local');
      if (confirmation !== 'Sync to Local') { return; }
      try { await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Syncing ${path.posix.basename(node.remotePath!)} to local` }, () => downloadRemoteItem(sftp, node.profile!, node.remotePath!, destination, true)); vscode.window.showInformationMessage(`Synced to local: ${destination}`); } catch (error) { vscode.window.showErrorMessage(`Sync failed: ${messageOf(error)}`); }
    })
  );
}

async function downloadRemoteItem(sftp: SftpService, profile: DeploymentProfile, remotePath: string, localPath: string, directory: boolean): Promise<void> {
  if (!directory) { const data = await sftp.download(profile, remotePath); await fs.mkdir(path.dirname(localPath), { recursive: true }); await fs.writeFile(localPath, data); return; }
  await fs.mkdir(localPath, { recursive: true });
  const entries = await sftp.list(profile, remotePath);
  for (const entry of entries.filter(item => item.name !== '.' && item.name !== '..')) {
    await downloadRemoteItem(sftp, profile, path.posix.join(remotePath, entry.name), path.join(localPath, entry.name), entry.type === 'd');
  }
}

async function withLocalFile(uri: vscode.Uri | undefined, action: (file: vscode.Uri) => Promise<void>): Promise<void> {
  const file = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!file || file.scheme !== 'file') { vscode.window.showWarningMessage('Select or open a local file first.'); return; }
  try { await action(file); } catch (error) { vscode.window.showErrorMessage(`Upload failed: ${messageOf(error)}`); }
}

async function collectLocalFiles(localPath: string, profile: DeploymentProfile): Promise<string[]> {
  const stat = await fs.stat(localPath);
  if (stat.isFile()) { return isLocalExcluded(profile, localPath) ? [] : [localPath]; }
  if (!stat.isDirectory() || isLocalExcluded(profile, localPath)) { return []; }
  const entries = await fs.readdir(localPath, { withFileTypes: true });
  const nested = await Promise.all(entries.filter(entry => !entry.isSymbolicLink()).map(entry => collectLocalFiles(path.join(localPath, entry.name), profile)));
  return nested.flat();
}

function isLocalExcluded(profile: DeploymentProfile, localPath: string): boolean {
  const resolved = path.resolve(localPath);
  const mapping = profile.mappings.filter(item => resolved === item.localPath || resolved.startsWith(`${item.localPath}${path.sep}`)).sort((a, b) => b.localPath.length - a.localPath.length)[0];
  if (!mapping) { return false; }
  const relative = path.relative(mapping.localPath, resolved).split(path.sep).join('/');
  const patterns = profile.exclusions?.patterns ?? ['.git/**', '.vscode/**', 'node_modules/**'];
  const explicit = (profile.exclusions?.localPaths ?? []).some(item => { const excluded = path.resolve(mapping.localPath, item); return resolved === excluded || resolved.startsWith(`${excluded}${path.sep}`); });
  return explicit || patterns.some(pattern => simpleGlobMatch(pattern, relative) || simpleGlobMatch(pattern, path.posix.basename(relative)));
}

function simpleGlobMatch(pattern: string, value: string): boolean {
  const expression = `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`;
  return new RegExp(expression, process.platform === 'win32' ? 'i' : '').test(value);
}

async function readCurrentLocalData(local: vscode.Uri): Promise<Buffer> {
  const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === local.toString());
  return document ? Buffer.from(document.getText(), 'utf8') : fs.readFile(local.fsPath);
}

async function readLocalFileIfExists(localPath: string): Promise<{ data: Buffer; exists: boolean }> {
  const local = vscode.Uri.file(localPath);
  const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === local.toString());
  if (document) { return { data: Buffer.from(document.getText(), 'utf8'), exists: true }; }
  try { return { data: await fs.readFile(localPath), exists: true }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return { data: Buffer.alloc(0), exists: false }; } throw error; }
}

function openSyncLocalPreview(context: vscode.ExtensionContext, profile: DeploymentProfile, files: SyncLocalPreviewFile[]): void {
  const panel = vscode.window.createWebviewPanel('remoteDeploy.previewSyncLocal', `Sync ${files.length} file${files.length === 1 ? '' : 's'} to Local`, vscode.ViewColumn.Active, { enableScripts: true });
  const panelDisposables: vscode.Disposable[] = [];
  let operationBusy = false;
  panel.webview.html = syncLocalPreviewHtml(panel.webview.cspSource, profile, files);
  panelDisposables.push(panel.webview.onDidReceiveMessage(async (message: { type: string; index?: number }) => {
    const selected = files[message.index ?? 0];
    if (!selected) { return; }
    if (message.type === 'compare') {
      if (!selected.comparable) { vscode.window.showWarningMessage(`Cannot compare binary file: ${path.basename(selected.remotePath)}`); return; }
      try {
        const serverFile = await writeComparisonFile(context, profile.id, selected.remotePath, selected.remoteData);
        const localFile = selected.localExists ? vscode.Uri.file(selected.localPath) : await writeEmptyComparisonFile(context, profile.id, selected.localPath);
        await vscode.commands.executeCommand('vscode.diff', localFile, serverFile, `${path.basename(selected.remotePath)} — Local ↔ Server`);
      } catch (error) { vscode.window.showErrorMessage(`Comparison failed: ${messageOf(error)}`); }
      return;
    }
    if (message.type !== 'sync' && message.type !== 'syncAll') { return; }
    if (operationBusy) { return; }
    operationBusy = true;
    panel.webview.postMessage({ type: 'operationBusy', busy: true });
    try {
      if (message.type === 'sync') {
        await fs.mkdir(path.dirname(selected.localPath), { recursive: true });
        await fs.writeFile(selected.localPath, selected.remoteData);
        selected.localData = Buffer.from(selected.remoteData);
        selected.localExists = true;
        selected.comparable = isTextBuffer(selected.remoteData);
        panel.webview.postMessage({ type: 'synced', index: message.index ?? 0, text: `Synced successfully: ${selected.localPath}`, file: previewSyncState(selected) });
        vscode.window.showInformationMessage(`Synced to local: ${selected.localPath}`);
        return;
      }
      let completed = 0;
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Syncing ${files.length} files to local`, cancellable: false }, async progress => {
          for (let index = 0; index < files.length; index++) {
            const file = files[index];
            progress.report({ message: path.basename(file.remotePath), increment: 100 / files.length });
            await fs.mkdir(path.dirname(file.localPath), { recursive: true });
            await fs.writeFile(file.localPath, file.remoteData);
            file.localData = Buffer.from(file.remoteData);
            file.localExists = true;
            file.comparable = isTextBuffer(file.remoteData);
            completed++;
            panel.webview.postMessage({ type: 'synced', index, text: `Synced successfully: ${file.localPath}`, file: previewSyncState(file) });
          }
        });
        panel.webview.postMessage({ type: 'allSynced', text: `All ${files.length} files synced successfully.` });
        vscode.window.showInformationMessage(`Synced ${files.length} files to local.`);
      } catch (error) { panel.webview.postMessage({ type: 'error', index: completed, text: `Sync stopped after ${completed} file(s): ${messageOf(error)}` }); }
    } catch (error) {
      panel.webview.postMessage({ type: 'error', index: message.index ?? 0, text: `Sync failed: ${messageOf(error)}` });
    } finally {
      operationBusy = false;
      panel.webview.postMessage({ type: 'operationBusy', busy: false });
    }
  }));
  panel.onDidDispose(() => panelDisposables.splice(0).forEach(disposable => disposable.dispose()));
}

function openDeployPreview(context: vscode.ExtensionContext, sftp: SftpService, explorer: RemoteExplorer, profile: DeploymentProfile, files: DeployPreviewFile[]): void {
  const panel = vscode.window.createWebviewPanel('remoteDeploy.previewDeploy', `Deploy ${files.length} file${files.length === 1 ? '' : 's'} to ${profile.name}`, vscode.ViewColumn.Active, { enableScripts: true });
  const panelDisposables: vscode.Disposable[] = [];
  let operationBusy = false;
  panel.webview.html = deployPreviewHtml(panel.webview.cspSource, profile, files);
  panelDisposables.push(panel.webview.onDidReceiveMessage(async (message: { type: string; index?: number }) => {
    const selected = files[message.index ?? 0];
    if (!selected) { return; }
    if (message.type === 'compare') {
      try {
        selected.localData = await readCurrentLocalData(selected.local);
        selected.comparable = isTextBuffer(selected.localData) && (!selected.remoteExists || isTextBuffer(selected.remoteData));
        panel.webview.postMessage({ type: 'fileUpdated', index: message.index ?? 0, file: previewDeployState(selected) });
        const serverFile = await writeComparisonFile(context, profile.id, selected.remotePath, selected.remoteData);
        const localFile = await writeLocalComparisonFile(context, profile.id, selected.local.fsPath, selected.localData);
        await vscode.commands.executeCommand('vscode.diff', serverFile, localFile, `${path.basename(selected.remotePath)} — Server ↔ Local${vscode.workspace.textDocuments.find(document => document.uri.toString() === selected.local.toString())?.isDirty ? ' (Unsaved)' : ''}`);
      } catch (error) { vscode.window.showErrorMessage(`Comparison failed: ${messageOf(error)}`); }
      return;
    }
    if (message.type !== 'deploy' && message.type !== 'overwriteLocal' && message.type !== 'deployAll') { return; }
    if (operationBusy) { return; }
    operationBusy = true;
    panel.webview.postMessage({ type: 'operationBusy', busy: true });
    try {
      if (message.type === 'deploy') {
        selected.localData = await readCurrentLocalData(selected.local);
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Deploying ${path.basename(selected.local.fsPath)} to ${profile.name}` }, () => sftp.uploadData(profile, selected.localData, selected.remotePath));
        selected.remoteData = Buffer.from(selected.localData);
        selected.remoteExists = true;
        selected.comparable = isTextBuffer(selected.localData);
        explorer.refresh();
        panel.webview.postMessage({ type: 'deployed', index: message.index ?? 0, text: `Deployed successfully: ${selected.remotePath}`, file: previewDeployState(selected) });
        vscode.window.showInformationMessage(`Deployed to ${profile.name}: ${selected.remotePath}`);
        return;
      }
      if (message.type === 'overwriteLocal') {
        if (!selected.remoteExists) { panel.webview.postMessage({ type: 'error', index: message.index ?? 0, text: 'Cannot overwrite local because the server file does not exist.' }); return; }
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Overwriting ${path.basename(selected.local.fsPath)} with ${profile.name}` }, async () => {
          await fs.mkdir(path.dirname(selected.local.fsPath), { recursive: true });
          await fs.writeFile(selected.local.fsPath, selected.remoteData);
        });
        selected.localData = Buffer.from(selected.remoteData);
        selected.comparable = isTextBuffer(selected.remoteData);
        panel.webview.postMessage({ type: 'localOverwritten', index: message.index ?? 0, text: `Local file overwritten successfully: ${selected.local.fsPath}`, file: previewDeployState(selected) });
        vscode.window.showInformationMessage(`Local file updated from ${profile.name}: ${selected.local.fsPath}`);
        return;
      }
      let completed = 0;
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Deploying ${files.length} files to ${profile.name}`, cancellable: false }, async progress => {
          for (let index = 0; index < files.length; index++) {
            const file = files[index];
            progress.report({ message: path.basename(file.local.fsPath), increment: 100 / files.length });
            file.localData = await readCurrentLocalData(file.local);
            await sftp.uploadData(profile, file.localData, file.remotePath);
            file.remoteData = Buffer.from(file.localData);
            file.remoteExists = true;
            file.comparable = isTextBuffer(file.localData);
            completed++;
            panel.webview.postMessage({ type: 'deployed', index, text: `Deployed successfully: ${file.remotePath}`, file: previewDeployState(file) });
          }
        });
        explorer.refresh();
        panel.webview.postMessage({ type: 'allDeployed', text: `All ${files.length} files deployed successfully.` });
        vscode.window.showInformationMessage(`Deployed ${files.length} files to ${profile.name}.`);
      } catch (error) { panel.webview.postMessage({ type: 'error', index: completed, text: `Deployment stopped after ${completed} file(s): ${messageOf(error)}` }); }
    } catch (error) {
      const label = message.type === 'overwriteLocal' ? 'Overwrite local' : 'Deployment';
      panel.webview.postMessage({ type: 'error', index: message.index ?? 0, text: `${label} failed: ${messageOf(error)}` });
    } finally {
      operationBusy = false;
      panel.webview.postMessage({ type: 'operationBusy', busy: false });
    }
  }));
  panel.onDidDispose(() => panelDisposables.splice(0).forEach(disposable => disposable.dispose()));
}

function previewSyncState(file: SyncLocalPreviewFile): { remoteText: string; localText: string; localExists: boolean; comparable: boolean; identical: boolean } {
  return { remoteText: file.comparable ? file.remoteData.toString('utf8') : '', localText: file.comparable ? file.localData.toString('utf8') : '', localExists: file.localExists, comparable: file.comparable, identical: file.localExists && file.remoteData.equals(file.localData) };
}

function previewDeployState(file: DeployPreviewFile): { remoteText: string; localText: string; remoteExists: boolean; comparable: boolean; identical: boolean } {
  return { remoteText: file.comparable ? file.remoteData.toString('utf8') : '', localText: file.comparable ? file.localData.toString('utf8') : '', remoteExists: file.remoteExists, comparable: file.comparable, identical: file.remoteExists && file.localData.equals(file.remoteData) };
}

function syncLocalPreviewHtml(cspSource: string, profile: DeploymentProfile, files: SyncLocalPreviewFile[]): string {
  const nonce = webviewNonce();
  const data = safeJson({ profile: profile.name, host: profile.host, files: files.map(file => ({ name: path.basename(file.remotePath), remotePath: file.remotePath, localPath: file.localPath, ...previewSyncState(file) })) });
  return previewHtml(cspSource, nonce, 'Sync Remote Files to Local', 'Review remote and local versions before writing to your workspace.', data, 'sync');
}

function deployPreviewHtml(cspSource: string, profile: DeploymentProfile, files: DeployPreviewFile[]): string {
  const nonce = webviewNonce();
  const data = safeJson({ profile: profile.name, host: profile.host, files: files.map(file => ({ name: path.basename(file.displayLocalPath ?? file.local.fsPath), localPath: file.displayLocalPath ?? file.local.fsPath, remotePath: file.remotePath, ...previewDeployState(file) })) });
  return previewHtml(cspSource, nonce, 'Deployment Preview', 'Review local and server versions before deploying.', data, 'deploy');
}

function previewHtml(cspSource: string, nonce: string, title: string, description: string, data: string, mode: 'sync' | 'deploy'): string {
  const deployMode = mode === 'deploy';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">${sharedWebviewCss()}.preview-shell{width:min(1280px,100%);margin:0 auto;padding:24px}.hero{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;margin-bottom:16px}.hero h1{margin:0 0 8px;font-size:24px}.hero p{margin:0;color:var(--vscode-descriptionForeground)}.summary-card{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;padding:16px;margin-bottom:16px;border:1px solid var(--vscode-panel-border);border-radius:6px;background:var(--vscode-sideBar-background)}.summary-label{font-size:12px;color:var(--vscode-descriptionForeground);margin-bottom:4px}.summary-value{font-weight:600;overflow-wrap:anywhere}.workspace{display:grid;grid-template-columns:minmax(260px,.8fr) minmax(0,2fr);min-height:600px;border:1px solid var(--vscode-panel-border);border-radius:6px;overflow:hidden}.file-panel{border-right:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);min-width:0}.panel-heading{padding:12px 16px;border-bottom:1px solid var(--vscode-panel-border);font-weight:600}.file-list{display:grid}.file-row{min-height:64px;padding:10px 14px;border:0;border-bottom:1px solid var(--vscode-panel-border);background:transparent;color:var(--vscode-foreground);text-align:left;cursor:pointer;transition:background-color 180ms ease}.file-row:hover{background:var(--vscode-list-hoverBackground)}.file-row.active{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}.file-name{font-weight:600;overflow-wrap:anywhere}.file-detail{font-family:var(--vscode-editor-font-family);font-size:12px;opacity:.78;overflow-wrap:anywhere;margin-top:4px}.compare-panel{min-width:0;display:flex;flex-direction:column}.detail-header{padding:12px 16px;border-bottom:1px solid var(--vscode-panel-border);display:flex;justify-content:space-between;align-items:center;gap:16px}.detail-paths{display:grid;gap:4px;min-width:0}.detail-path{font-family:var(--vscode-editor-font-family);font-size:12px;overflow-wrap:anywhere}.compare{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);min-height:0;flex:1}.pane{min-width:0;overflow:auto}.pane:first-child{border-right:1px solid var(--vscode-panel-border)}.pane h2{position:sticky;top:0;z-index:1;font-size:13px;margin:0;padding:10px 12px;background:var(--vscode-editorGroupHeader-tabsBackground);border-bottom:1px solid var(--vscode-panel-border)}pre{box-sizing:border-box;margin:0;padding:8px 0;overflow:auto;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);line-height:1.5;tab-size:4}.line{display:block;padding:0 10px;white-space:pre;min-height:1.5em}.changed.added{background:var(--vscode-diffEditor-insertedTextBackground)}.changed.removed{background:var(--vscode-diffEditor-removedTextBackground)}.number{display:inline-block;width:42px;text-align:right;margin-right:12px;color:var(--vscode-editorLineNumber-foreground);user-select:none}.binary{padding:48px 24px;text-align:center;color:var(--vscode-descriptionForeground)}.action-bar{position:sticky;bottom:0;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 16px;margin-top:16px;border:1px solid var(--vscode-panel-border);border-radius:6px;background:var(--vscode-editor-background)}.action-buttons{display:flex;gap:8px;flex-wrap:wrap}.status{min-height:20px;color:var(--vscode-descriptionForeground)}.status.error{color:var(--vscode-errorForeground)}@media(max-width:900px){.workspace{grid-template-columns:1fr}.file-panel{border-right:0;border-bottom:1px solid var(--vscode-panel-border);max-height:280px;overflow:auto}.compare{grid-template-columns:1fr}.pane:first-child{border-right:0;border-bottom:1px solid var(--vscode-panel-border)}.summary-card{grid-template-columns:1fr}.action-bar{align-items:stretch;flex-direction:column}.action-buttons button{flex:1}}@media(prefers-reduced-motion:reduce){.file-row{transition:none}}</style></head><body><main class="preview-shell"><header class="hero"><div><h1>${title}</h1><p>${description}</p></div><span id="count" class="badge"></span></header><section class="summary-card" aria-label="Connection summary"><div><div class="summary-label">Connection</div><div id="profile" class="summary-value"></div></div><div><div class="summary-label">Host</div><div id="host" class="summary-value mono"></div></div><div><div class="summary-label">Selected file</div><div id="selectedName" class="summary-value"></div></div></section><section class="workspace"><aside class="file-panel"><div class="panel-heading">Files</div><div id="fileList" class="file-list" role="listbox"></div></aside><section class="compare-panel"><header class="detail-header"><div id="paths" class="detail-paths"></div><span id="stateBadge" class="badge"></span></header><div id="compare" class="compare"></div></section></section><footer class="action-bar"><div id="status" class="status" role="status" aria-live="polite">Select a file to review its paths and contents.</div><div class="action-buttons"><button id="compareButton" class="secondary">Compare</button>${deployMode ? '<button id="overwriteButton" class="secondary">Overwrite Local</button><button id="primaryButton">Deploy Selected</button><button id="allButton">Deploy All</button>' : '<button id="primaryButton">Sync Selected</button><button id="allButton">Sync All</button>'}</div></footer></main><script nonce="${nonce}">const vscode=acquireVsCodeApi(),data=${data},mode='${mode}';let active=0,operationBusy=false;const list=document.getElementById('fileList'),compare=document.getElementById('compare'),status=document.getElementById('status'),compareButton=document.getElementById('compareButton'),primaryButton=document.getElementById('primaryButton'),allButton=document.getElementById('allButton'),overwriteButton=document.getElementById('overwriteButton');document.getElementById('profile').textContent=data.profile;document.getElementById('host').textContent=data.host;document.getElementById('count').textContent=data.files.length+' file'+(data.files.length===1?'':'s');function node(tag,className,text){const item=document.createElement(tag);if(className)item.className=className;if(text!==undefined)item.textContent=text;return item}function fileState(file){return file.identical?'Identical':(mode==='deploy'?(file.remoteExists?'Modified':'New'):(file.localExists?'Modified':'New local file'))}function renderList(){list.replaceChildren();data.files.forEach((file,index)=>{const button=node('button','file-row'+(index===active?' active':''));button.type='button';button.tabIndex=index===active?0:-1;button.setAttribute('role','option');button.setAttribute('aria-selected',String(index===active));button.append(node('div','file-name',file.name),node('div','file-detail',fileState(file)));button.addEventListener('click',()=>{active=index;render();list.children[active]?.focus()});list.append(button)})}function lines(text){return text.split(/\\r?\\n/)}function pane(titleText,text,otherText,side){const section=node('section','pane');section.append(node('h2','',titleText));const pre=document.createElement('pre'),own=lines(text),other=lines(otherText);let otherCursor=0;for(let index=0;index<own.length;index++){const matchIndex=other.indexOf(own[index],otherCursor),changed=matchIndex<0;if(!changed)otherCursor=matchIndex+1;const row=node('span','line'+(changed?' changed '+(side==='local'?'removed':'added'):''));row.append(node('span','number',String(index+1)),document.createTextNode(own[index]));pre.append(row)}section.append(pre);return section}function render(){renderList();const file=data.files[active];if(!file)return;document.getElementById('selectedName').textContent=file.name;const paths=document.getElementById('paths');paths.replaceChildren(node('div','detail-path',(mode==='deploy'?'Local: ':'Remote: ')+(mode==='deploy'?file.localPath:file.remotePath)),node('div','detail-path',(mode==='deploy'?'Remote: ':'Local: ')+(mode==='deploy'?file.remotePath:file.localPath)));document.getElementById('stateBadge').textContent=fileState(file);compare.replaceChildren();if(file.comparable){const firstText=mode==='deploy'?file.remoteText:file.localText,secondText=mode==='deploy'?file.localText:file.remoteText;compare.append(pane(mode==='deploy'?'Server':'Local',firstText,secondText,mode==='deploy'?'server':'local'),pane(mode==='deploy'?'Local':'Server',secondText,firstText,mode==='deploy'?'local':'server'))}else compare.append(node('div','binary','Binary content cannot be rendered as text. The file action remains available.'));compareButton.disabled=!file.comparable||operationBusy;if(overwriteButton)overwriteButton.disabled=!file.remoteExists||operationBusy;primaryButton.disabled=operationBusy;allButton.disabled=operationBusy}function send(type){if(operationBusy)return;vscode.postMessage({type,index:active})}compareButton.addEventListener('click',()=>send('compare'));primaryButton.addEventListener('click',()=>send(mode==='deploy'?'deploy':'sync'));allButton.addEventListener('click',()=>send(mode==='deploy'?'deployAll':'syncAll'));if(overwriteButton)overwriteButton.addEventListener('click',()=>send('overwriteLocal'));document.addEventListener('keydown',event=>{if(!data.files.length)return;const target=event.target;if((event.key==='ArrowDown'||event.key==='ArrowUp')&&((target instanceof HTMLElement&&target.closest('.file-list'))||document.activeElement?.classList.contains('file-row'))){event.preventDefault();active=(active+(event.key==='ArrowDown'?1:-1)+data.files.length)%data.files.length;render();list.children[active].focus()}});window.addEventListener('message',event=>{const message=event.data;if(message.type==='operationBusy'){operationBusy=message.busy;render();return}if(message.type==='fileUpdated'||message.type==='deployed'||message.type==='synced'||message.type==='localOverwritten'){status.textContent=message.text||status.textContent;status.className='status';const file=data.files[message.index];if(file&&message.file)Object.assign(file,message.file);render()}else if(message.type==='allDeployed'||message.type==='allSynced'){status.textContent=message.text;status.className='status';render()}else if(message.type==='error'){status.textContent=message.text;status.className='status error'}});render()</script></body></html>`;
}

function openProfilesPanel(context: vscode.ExtensionContext, sftp: SftpService, explorer: RemoteExplorer): void {
  const panel = vscode.window.createWebviewPanel('remoteDeploy.profiles', 'Connection Hierarchy', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
  const panelDisposables: vscode.Disposable[] = [];
  panel.webview.html = profilePanelHtml(panel.webview.cspSource, getSettings(), vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '');
  panelDisposables.push(panel.webview.onDidReceiveMessage(async (message: { type: string; profiles?: DeploymentProfile[]; defaultProfileId?: string; profile?: DeploymentProfile }) => {
    if (message.type === 'browse') { const choice = await vscode.window.showOpenDialog({ canSelectFiles: message.profile?.privateKeyPath === '__key__', canSelectFolders: message.profile?.privateKeyPath !== '__key__', canSelectMany: false }); if (choice?.[0]) { panel.webview.postMessage({ type: 'browse', value: choice[0].fsPath, key: message.profile?.privateKeyPath === '__key__' }); } return; }
    if (message.type === 'test' && message.profile) { try { await sftp.dispose(); await sftp.list({ ...normalizeProfile(message.profile), password: message.profile.password }, normalizeRemotePath(message.profile.remoteRoot || '/')); panel.webview.postMessage({ type: 'status', text: 'Connection successful.', error: false }); } catch (error) { panel.webview.postMessage({ type: 'status', text: `Connection failed: ${messageOf(error)}`, error: true }); } return; }
    if (message.type === 'delete' && message.profile) {
      const settings = getSettings();
      const savedProfile = settings.profiles.find(item => item.id === message.profile!.id);
      const profileName = savedProfile?.name ?? message.profile.name ?? 'this profile';
      const confirmation = await vscode.window.showWarningMessage(`Delete SFTP profile "${profileName}"? This removes its configuration and saved password from this workspace.`, { modal: true }, 'Delete Profile');
      if (confirmation !== 'Delete Profile') { return; }
      const profiles = settings.profiles.filter(item => item.id !== message.profile!.id);
      const defaultProfileId = settings.defaultProfileId === message.profile.id ? profiles[0]?.id ?? '' : settings.defaultProfileId;
      await context.secrets.delete(`remoteDeploy.password.${message.profile.id}`);
      await vscode.workspace.getConfiguration('remoteDeploy').update('profiles', profiles, vscode.ConfigurationTarget.Workspace);
      await vscode.workspace.getConfiguration('remoteDeploy').update('defaultProfileId', defaultProfileId, vscode.ConfigurationTarget.Workspace);
      await sftp.dispose(); explorer.refresh();
      panel.webview.postMessage({ type: 'deleted', profiles: sanitizeSettingsForWebview({ profiles, defaultProfileId }).profiles, defaultProfileId, text: `${profileName} deleted.` });
      vscode.window.showInformationMessage(`JetBrains style SFTP: ${profileName} deleted.`);
      return;
    }
    if (message.type === 'save' && message.profile) {
      if (!message.profile.name || !message.profile.host || !message.profile.username) { panel.webview.postMessage({ type: 'status', text: 'Profile name, host, and username are required.', error: true }); return; }
      const profile = normalizeProfile(message.profile);
      const settings = getSettings();
      const profiles = settings.profiles.some(item => item.id === profile.id) ? settings.profiles.map(item => item.id === profile.id ? profile : item) : [...settings.profiles, profile];
      const defaultProfileId = message.defaultProfileId === profile.id || !settings.defaultProfileId ? profile.id : settings.defaultProfileId;
      if (message.profile.password) { await context.secrets.store(`remoteDeploy.password.${profile.id}`, message.profile.password); }
      if (profile.authMethod === 'privateKey') { await context.secrets.delete(`remoteDeploy.password.${profile.id}`); }
      await vscode.workspace.getConfiguration('remoteDeploy').update('profiles', profiles, vscode.ConfigurationTarget.Workspace);
      await vscode.workspace.getConfiguration('remoteDeploy').update('defaultProfileId', defaultProfileId, vscode.ConfigurationTarget.Workspace);
      await sftp.dispose(); explorer.refresh();
      panel.webview.postMessage({ type: 'saved', profiles: sanitizeSettingsForWebview({ profiles, defaultProfileId }).profiles, defaultProfileId, selectedProfileId: profile.id, text: `${profile.name} saved for this workspace.` });
      vscode.window.showInformationMessage(`JetBrains style SFTP: ${profile.name} saved for this workspace.`);
    }
  }));
  panel.onDidDispose(() => panelDisposables.splice(0).forEach(disposable => disposable.dispose()));
}

function profilePanelHtml(cspSource: string, settings: Settings, workspacePath: string): string {
  const nonce = webviewNonce();
  const data = safeJson(sanitizeSettingsForWebview(settings));
  const currentFolder = safeJson(workspacePath);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:22px;max-width:1050px;margin:auto}h1{font-size:20px}.layout{display:grid;grid-template-columns:260px 1fr;gap:20px}.profiles{border-right:1px solid var(--vscode-panel-border);padding-right:15px}.connection-group{margin:4px 0 10px}.group-label{font-weight:600;padding:6px 8px;color:var(--vscode-foreground)}.group-label:before{content:'▾';display:inline-block;width:18px;color:var(--vscode-descriptionForeground)}.profile-row{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:'profile actions';align-items:center;margin:3px 0;gap:8px}.profile{grid-area:profile;min-width:0;text-align:left;margin:0;background:transparent;color:var(--vscode-foreground);border:0;padding:7px 8px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.profile:before{content:'◻';display:inline-block;width:18px;color:var(--vscode-descriptionForeground)}.profile.default:before{content:'★';color:var(--vscode-charts-yellow)}.profile.active{background:var(--vscode-list-activeSelectionBackground)}.profile-actions{grid-area:actions;display:flex;align-items:center;justify-content:flex-end;gap:4px;min-width:max-content}.profile-action{display:inline-flex;align-items:center;justify-content:center;min-width:48px;height:32px;padding:0 8px;background:transparent;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:12px;line-height:1;white-space:nowrap}.profile-action:hover{background:var(--vscode-toolbar-hoverBackground)}.profile-action.remove{min-width:60px;color:var(--vscode-errorForeground)}@media(max-width:760px){.layout{grid-template-columns:1fr}.profiles{border-right:0;border-bottom:1px solid var(--vscode-panel-border);padding-right:0;padding-bottom:15px}.profile-row{grid-template-columns:minmax(0,1fr) auto}}@media(max-width:420px){.profile-row{grid-template-columns:1fr;grid-template-areas:'profile' 'actions'}.profile-actions{justify-content:flex-start;padding:0 8px 6px}}.group-add{margin:4px 0 2px 36px;padding:4px 8px;font-size:12px}button{padding:7px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:2px;cursor:pointer}.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.danger{background:var(--vscode-errorForeground);color:var(--vscode-button-foreground)}.danger:hover{opacity:.9}.row{display:grid;grid-template-columns:145px 1fr;align-items:center;gap:10px;margin:10px 0}.checkbox-row{display:grid;grid-template-columns:145px 1fr;align-items:center;gap:10px;margin:10px 0}.checkbox-control{display:flex;align-items:center;gap:8px}.checkbox-control input{width:auto;margin:0;padding:0}input,select{box-sizing:border-box;width:100%;padding:7px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border)}.inline{display:flex;gap:8px}.inline input{flex:1}.mapping{border:1px solid var(--vscode-panel-border);padding:10px;margin:10px 0}.mapping .row{grid-template-columns:125px 1fr}.actions{margin-top:20px;padding-top:15px;border-top:1px solid var(--vscode-panel-border);display:flex;justify-content:flex-end;gap:8px}.status{min-height:20px;color:var(--vscode-descriptionForeground)}.error{color:var(--vscode-errorForeground)}small{color:var(--vscode-descriptionForeground)}textarea{box-sizing:border-box;width:100%;min-height:72px;padding:7px;resize:vertical;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);font-family:var(--vscode-editor-font-family)}${sharedWebviewCss()}@media(max-width:760px){body{padding:16px}.layout{grid-template-columns:1fr}.profiles{border-right:0;border-bottom:1px solid var(--vscode-panel-border);padding:0 0 16px}.row,.checkbox-row,.mapping .row{grid-template-columns:1fr}.actions{position:sticky;bottom:0;background:var(--vscode-editor-background);padding:12px 0}.profile-row{grid-template-columns:minmax(0,1fr) 44px 44px}.profile-action{width:44px;height:44px}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important}}</style></head><body><h1>Connection Hierarchy</h1><div class="layout"><aside class="profiles"><div id="profileList"></div><button id="add" class="secondary">+ Add SFTP</button></aside><main><div id="editor"></div><div class="actions"><button id="remove" class="danger">Delete Profile</button><button id="save">Save Current Profile</button></div></main></div><script nonce="${nonce}">const vscode=acquireVsCodeApi(),state=${data},currentFolder=${currentFolder};let selected=state.defaultProfileId||state.profiles[0]?.id||'';const byId=()=>state.profiles.find(p=>p.id===selected);const id=()=>crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2);function esc(v){return String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')}function render(){const list=document.getElementById('profileList');list.replaceChildren();state.profiles.slice().sort((a,b)=>a.name.localeCompare(b.name)).forEach(p=>{const row=document.createElement('div');row.className='profile-row';const selectButton=document.createElement('button');selectButton.className='profile '+(p.id===selected?'active ':'')+(p.id===state.defaultProfileId?'default':'');selectButton.dataset.id=p.id;selectButton.title=p.name+(p.id===state.defaultProfileId?' — Workspace default':'');selectButton.textContent=p.name;const copyButton=document.createElement('button');copyButton.className='profile-action';copyButton.dataset.copy=p.id;copyButton.title='Copy '+p.name;copyButton.setAttribute('aria-label','Copy '+p.name);copyButton.textContent='Copy';const removeButton=document.createElement('button');removeButton.className='profile-action remove';removeButton.dataset.remove=p.id;removeButton.title='Remove '+p.name;removeButton.setAttribute('aria-label','Remove '+p.name);removeButton.textContent='Remove';const actions=document.createElement('div');actions.className='profile-actions';actions.append(copyButton,removeButton);row.append(selectButton,actions);list.append(row)});if(!state.profiles.length){const empty=document.createElement('small');empty.textContent='No SFTP profiles yet.';list.append(empty)}list.querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>{selected=b.dataset.id;render()});list.querySelectorAll('[data-copy]').forEach(b=>b.onclick=()=>{const source=state.profiles.find(p=>p.id===b.dataset.copy);if(!source)return;const copy=JSON.parse(JSON.stringify(source));copy.id=id();copy.name=source.name+' Copy';copy.password='';state.profiles.push(copy);selected=copy.id;render()});list.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{const p=state.profiles.find(p=>p.id===b.dataset.remove);if(p)vscode.postMessage({type:'delete',profile:p})});const p=byId();const e=document.getElementById('editor');if(!p){e.innerHTML='<p>Add an SFTP profile. Each profile owns its own path mappings.</p>';return}e.innerHTML='<div class="row"><label for="name">Profile name</label><input id="name" data-k="name"></div><div class="row"><label for="host">Host</label><input id="host" data-k="host" placeholder="192.168.236.52"></div><div class="row"><label for="port">Port</label><input id="port" data-k="port" type="number"></div><div class="row"><label for="username">Username</label><input id="username" data-k="username"></div><div class="row"><label for="remoteRoot">Root path</label><input id="remoteRoot" data-k="remoteRoot"></div><div class="row"><label for="authMethod">Authentication</label><select id="authMethod" data-k="authMethod"><option value="password">Password</option><option value="privateKey">SSH private key</option></select></div><div class="row password-row"><label for="password">Password</label><input id="password" data-k="password" type="password" placeholder="Saved securely in VS Code"></div><div class="row key-row"><label for="privateKeyPath">Private key</label><div class="inline"><input id="privateKeyPath" data-k="privateKeyPath"><button class="secondary" id="key">Browse…</button></div></div><div class="checkbox-row"><span></span><label class="checkbox-control" for="default"><input id="default" type="checkbox"><span>Workspace default</span></label></div><h3>Deployment Behavior</h3><div class="checkbox-row"><label for="uploadOnSave">Upload on save</label><label class="checkbox-control"><input id="uploadOnSave" type="checkbox"><span>Upload mapped files whenever they are saved</span></label></div><div class="checkbox-row"><label for="useTemporaryFile">Safe upload</label><label class="checkbox-control"><input id="useTemporaryFile" type="checkbox"><span>Upload a temporary file, then replace the target</span></label></div><h3>Deployment Exclusions</h3><small>One path or glob per line. Paths are relative to each path mapping.</small><div class="row"><label for="exclusionPatterns">Glob patterns</label><textarea id="exclusionPatterns" aria-label="Exclusion glob patterns" placeholder=".git/**&#10;.vscode/**&#10;node_modules/**"></textarea></div><div class="row"><label for="excludedLocalPaths">Explicit local paths</label><textarea id="excludedLocalPaths" aria-label="Excluded local paths" placeholder="secrets&#10;private-config.json"></textarea></div><div class="row"><label>Test</label><button id="test">Test Connection</button></div><div id="status" class="status"></div><h3>Path Mappings</h3><small>These mappings belong only to this SFTP profile.</small><div id="maps"></div><button id="addMap" class="secondary">Add New Mapping</button>';for(const k of ['name','host','port','username','remoteRoot','authMethod','privateKeyPath','password'])e.querySelector('[data-k="'+k+'"]').value=p[k]??'';function authRows(){const key=p.authMethod==='privateKey';e.querySelector('.key-row').style.display=key?'grid':'none';e.querySelector('.password-row').style.display=key?'none':'grid'}e.querySelectorAll('[data-k]').forEach(input=>{const update=()=>{p[input.dataset.k]=input.type==='number'?Number(input.value):input.value;if(input.dataset.k==='authMethod')authRows()};input.oninput=update;input.onchange=update});authRows();const lines=value=>Array.isArray(value)?value.join('\\n'):'';p.exclusions=p.exclusions||{};e.querySelector('#uploadOnSave').checked=Boolean(p.uploadOnSave);e.querySelector('#uploadOnSave').onchange=event=>p.uploadOnSave=event.target.checked;e.querySelector('#useTemporaryFile').checked=p.useTemporaryFile!==false;e.querySelector('#useTemporaryFile').onchange=event=>p.useTemporaryFile=event.target.checked;e.querySelector('#exclusionPatterns').value=lines(p.exclusions.patterns);e.querySelector('#excludedLocalPaths').value=lines(p.exclusions.localPaths);const exclusionLines=value=>value.split(/\\r?\\n/).map(item=>item.trim()).filter(Boolean);e.querySelector('#exclusionPatterns').oninput=event=>p.exclusions.patterns=exclusionLines(event.target.value);e.querySelector('#excludedLocalPaths').oninput=event=>p.exclusions.localPaths=exclusionLines(event.target.value);e.querySelector('#default').checked=state.defaultProfileId===p.id;e.querySelector('#default').onchange=event=>{if(event.target.checked){state.defaultProfileId=p.id;render()}};e.querySelector('#key').onclick=()=>vscode.postMessage({type:'browse',profile:{privateKeyPath:'__key__'}});e.querySelector('#test').onclick=()=>vscode.postMessage({type:'test',profile:p});function mapRow(m){if(!m.localPath)m.localPath=currentFolder;const d=document.createElement('div');d.className='mapping';d.innerHTML='<div class="row"><label>Local path</label><div class="inline"><input data-k="localPath" aria-label="Mapping local path"><button class="secondary" aria-label="Browse for mapping local path">Browse…</button></div></div><div class="row"><label>Deployment path</label><input data-k="deploymentPath" aria-label="Mapping deployment path"></div><div class="row"><label>Web path</label><input data-k="webPath" aria-label="Mapping web path"></div><button class="secondary" aria-label="Remove path mapping">Remove</button>';for(const k of ['localPath','deploymentPath','webPath'])d.querySelector('[data-k="'+k+'"]').value=m[k]??'';d.querySelectorAll('[data-k]').forEach(i=>i.oninput=()=>m[i.dataset.k]=i.value);d.querySelector('.inline button').onclick=()=>{p.__browse=m;vscode.postMessage({type:'browse',profile:{privateKeyPath:''}})};d.querySelector('.mapping>button').onclick=()=>{p.mappings=p.mappings.filter(x=>x!==m);render()};e.querySelector('#maps').appendChild(d)}p.mappings=p.mappings||[];p.mappings.forEach(mapRow);e.querySelector('#addMap').onclick=()=>{p.mappings.push({localPath:currentFolder,deploymentPath:'',webPath:'/'});render()}}function addProfile(){const p={id:id(),name:'New SFTP',host:'',port:22,username:'',remoteRoot:'/',authMethod:'password',privateKeyPath:'',password:'',mappings:[]};state.profiles.push(p);selected=p.id;render()}document.getElementById('add').onclick=()=>addProfile();document.getElementById('remove').onclick=()=>{const p=byId();if(p)vscode.postMessage({type:'delete',profile:p})};document.getElementById('save').onclick=()=>{const p=byId();if(p)vscode.postMessage({type:'save',profile:p,defaultProfileId:state.defaultProfileId})};window.addEventListener('message',e=>{const m=e.data,p=byId();if(m.type==='browse'&&p){if(m.key)p.privateKeyPath=m.value;else if(p.__browse){p.__browse.localPath=m.value;delete p.__browse}render()}if(m.type==='status'){const s=document.getElementById('status');if(s){s.textContent=m.text;s.className='status '+(m.error?'error':'')}}if(m.type==='saved'){state.profiles=m.profiles;state.defaultProfileId=m.defaultProfileId;selected=m.selectedProfileId||selected;if(!state.profiles.some(p=>p.id===selected))selected=state.defaultProfileId||state.profiles[0]?.id||'';render();const s=document.getElementById('status');if(s){s.textContent=m.text;s.className='status'}}if(m.type==='deleted'){state.profiles=m.profiles;state.defaultProfileId=m.defaultProfileId;selected=state.defaultProfileId||state.profiles[0]?.id||'';render()}});render()</script></body></html>`;
}

function webviewNonce(): string { return crypto.randomBytes(16).toString('hex'); }
function safeJson(value: unknown): string { return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026'); }
function sanitizeSettingsForWebview(settings: Settings): Settings { return { defaultProfileId: settings.defaultProfileId, profiles: settings.profiles.map(profile => { const { password: _password, ...safeProfile } = profile; return safeProfile; }) }; }
function sharedWebviewCss(): string { return `*{box-sizing:border-box}html{background:var(--vscode-editor-background)}body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);margin:0}button,input,select,textarea{font:inherit}button{min-height:44px;padding:0 16px;border:1px solid transparent;border-radius:4px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer;transition:background-color 180ms ease,border-color 180ms ease,transform 180ms ease}button:hover{background:var(--vscode-button-hoverBackground)}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button.danger{background:var(--vscode-testing-iconFailed);color:var(--vscode-button-foreground)}input,select,textarea{width:100%;min-height:44px;padding:8px 10px;border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground)}.badge{display:inline-flex;align-items:center;min-height:24px;padding:2px 8px;border-radius:12px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:12px;font-weight:600}.muted{color:var(--vscode-descriptionForeground)}.mono{font-family:var(--vscode-editor-font-family);overflow-wrap:anywhere}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;scroll-behavior:auto!important}}`; }

function getSettings(): Settings {
  const config = vscode.workspace.getConfiguration('remoteDeploy');
  const profiles = config.get<DeploymentProfile[]>('profiles', []);
  if (profiles.length) { return { profiles: profiles.map(normalizeProfile), defaultProfileId: config.get<string>('defaultProfileId', profiles[0].id) }; }
  const host = config.get<string>('host', '');
  if (!host) { return { profiles: [], defaultProfileId: '' }; }
  const legacy: DeploymentProfile = { id: 'legacy', name: host, host, port: config.get<number>('port', 22), username: config.get<string>('username', ''), remoteRoot: config.get<string>('remoteRoot', '/'), authMethod: config.get<string>('privateKeyPath', '') ? 'privateKey' : 'password', privateKeyPath: config.get<string>('privateKeyPath', ''), mappings: config.get<PathMapping[]>('mappings', []) };
  return { profiles: [normalizeProfile(legacy)], defaultProfileId: 'legacy' };
}
function normalizeProfile(profile: DeploymentProfile): DeploymentProfile { const { group: _group, password: _password, ...flatProfile } = profile as DeploymentProfile & { group?: string }; return { ...flatProfile, authMethod: profile.authMethod === 'privateKey' ? 'privateKey' : 'password', id: profile.id || crypto.randomUUID(), name: profile.name || profile.host, port: Number(profile.port) || 22, remoteRoot: normalizeRemotePath(profile.remoteRoot || '/'), mappings: (profile.mappings || []).filter(mapping => mapping.localPath && mapping.deploymentPath).map(mapping => ({ localPath: path.resolve(mapping.localPath), deploymentPath: normalizeRemotePath(mapping.deploymentPath), webPath: mapping.webPath })) }; }
function selectedProfile(settings: Settings): DeploymentProfile { const profile = settings.profiles.find(item => item.id === settings.defaultProfileId) ?? settings.profiles[0]; if (!profile) { throw new Error('Create an SFTP profile first.'); } return profile; }
function selectServerInEditor(_context: vscode.ExtensionContext, settings: Settings, title: string, description: string): Promise<DeploymentProfile | undefined> {
  const projection = settings.profiles.slice().sort((a, b) => a.name.localeCompare(b.name)).map(profile => ({ id: profile.id, name: profile.name, username: profile.username, host: profile.host, port: profile.port, remoteRoot: profile.remoteRoot, authMethod: profile.authMethod, mappingCount: profile.mappings.length, isDefault: profile.id === settings.defaultProfileId }));
  return new Promise(resolve => {
    const panel = vscode.window.createWebviewPanel('remoteDeploy.serverSelector', title, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: false });
    const panelDisposables: vscode.Disposable[] = [];
    let settled = false;
    const finish = (profile?: DeploymentProfile) => { if (settled) { return; } settled = true; resolve(profile); panel.dispose(); };
    panelDisposables.push(panel.onDidDispose(() => { panelDisposables.splice(0).forEach(disposable => disposable.dispose()); if (!settled) { settled = true; resolve(undefined); } }));
    panelDisposables.push(panel.webview.onDidReceiveMessage((message: { type: string; id?: string }) => {
      if (message.type === 'cancel') { finish(); return; }
      if (message.type === 'configure') { finish(); void vscode.commands.executeCommand('remoteDeploy.configure'); return; }
      if (message.type === 'select' && message.id) { finish(settings.profiles.find(profile => profile.id === message.id)); }
    }));
    panel.webview.html = serverSelectorHtml(panel.webview.cspSource, title, description, projection);
  });
}

async function selectProfileForLocalAction(context: vscode.ExtensionContext, action: string): Promise<DeploymentProfile | undefined> { const settings = getSettings(); if (!settings.profiles.length) { vscode.window.showWarningMessage('Create an SFTP profile first.'); return undefined; } return selectServerInEditor(context, settings, 'Select Server', `Select the server to ${action}.`); }
function serverSelectorHtml(cspSource: string, title: string, description: string, profiles: Array<{ id: string; name: string; username: string; host: string; port: number; remoteRoot: string; authMethod: 'password' | 'privateKey'; mappingCount: number; isDefault: boolean }>): string {
  const nonce = webviewNonce();
  const data = safeJson({ title, description, profiles });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">${sharedWebviewCss()}html,body{min-height:100%;background:transparent}body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.45)}.selector-shell{width:min(680px,100%);max-height:min(760px,calc(100vh - 48px));overflow:auto;margin:0;padding:24px;border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));border-radius:10px;background:var(--vscode-editorWidget-background,var(--vscode-editor-background));box-shadow:0 18px 48px rgba(0,0,0,.35)}.selector-header{margin-bottom:18px}.selector-title{margin:0 0 6px;font-size:22px;line-height:1.25}.selector-description{margin:0;color:var(--vscode-descriptionForeground);max-width:600px}.search-wrap{position:relative;margin-bottom:12px}.search-wrap svg{position:absolute;left:14px;top:50%;transform:translateY(-50%);width:18px;height:18px;color:var(--vscode-input-placeholderForeground);pointer-events:none}.search{height:44px;padding-left:44px}.server-list{display:grid;gap:8px;max-height:390px;overflow:auto}.server-card{width:100%;min-height:68px;text-align:left;display:grid;grid-template-columns:minmax(140px,1.1fr) minmax(180px,1.5fr) auto;gap:12px;align-items:center;padding:12px 14px;border:1px solid var(--vscode-panel-border);border-radius:6px;background:var(--vscode-list-inactiveSelectionBackground,var(--vscode-editor-background));color:var(--vscode-foreground);cursor:pointer;transition:background-color 180ms ease,border-color 180ms ease,transform 180ms ease}.server-card:hover{background:var(--vscode-list-hoverBackground)}.server-card.focused,.server-card:focus-visible{border-color:var(--vscode-focusBorder);box-shadow:0 0 0 1px var(--vscode-focusBorder);outline:none}.server-card:active{transform:translateY(1px)}.server-name{display:flex;align-items:center;gap:8px;font-weight:600;font-size:15px}.server-endpoint,.server-root{font-family:var(--vscode-editor-font-family);overflow-wrap:anywhere}.server-meta{display:flex;justify-content:flex-end;align-items:center;gap:8px;flex-wrap:wrap}.empty{padding:32px 20px;text-align:center;border:1px dashed var(--vscode-panel-border);border-radius:6px;color:var(--vscode-descriptionForeground)}.selector-footer{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-top:18px;padding-top:14px;border-top:1px solid var(--vscode-panel-border)}.shortcut{color:var(--vscode-descriptionForeground);font-size:12px}.footer-actions{display:flex;gap:8px;flex-wrap:wrap}@media(max-width:720px){body{padding:12px}.selector-shell{max-height:calc(100vh - 24px);padding:20px}.server-card{grid-template-columns:1fr;gap:8px}.server-meta{justify-content:flex-start}.selector-footer{align-items:flex-start;flex-direction:column}.footer-actions{width:100%}.footer-actions button{flex:1}}@media(prefers-reduced-motion:reduce){.server-card{transition:none}}</style></head><body><main class="selector-shell" role="dialog" aria-modal="true" aria-labelledby="selectorTitle" aria-describedby="selectorDescription"><header class="selector-header"><h1 id="selectorTitle" class="selector-title"></h1><p id="selectorDescription" class="selector-description"></p></header><div class="search-wrap"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"></circle><path d="m16 16 5 5" fill="none" stroke="currentColor" stroke-width="2"></path></svg><label class="sr-only" for="search">Search connections</label><input id="search" class="search" type="search" placeholder="Search by name, host, user, root, or authentication" autocomplete="off"></div><div id="list" class="server-list" role="group" aria-label="Available SFTP connections"></div><div id="empty" class="empty" role="status" hidden><strong>No connections match your search.</strong><div>Try a different term or configure another connection.</div></div><footer class="selector-footer"><div class="shortcut">Use Up/Down to move, Enter or Space to select, Escape to cancel.</div><div class="footer-actions"><button id="configure" class="secondary">Configure Connections</button><button id="cancel" class="secondary">Cancel</button></div></footer></main><script nonce="${nonce}">const vscode=acquireVsCodeApi(),data=${data};const title=document.getElementById('selectorTitle'),description=document.getElementById('selectorDescription'),search=document.getElementById('search'),list=document.getElementById('list'),empty=document.getElementById('empty');title.textContent=data.title;description.textContent=data.description;let visible=[],focusIndex=0;function make(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node}function render(){const query=search.value.trim().toLocaleLowerCase();visible=data.profiles.filter(profile=>[profile.name,profile.username,profile.host,String(profile.port),profile.remoteRoot,profile.authMethod].some(value=>String(value).toLocaleLowerCase().includes(query)));focusIndex=Math.min(focusIndex,Math.max(visible.length-1,0));list.replaceChildren();visible.forEach((profile,index)=>{const card=make('button','server-card'+(index===focusIndex?' focused':''));card.type='button';card.tabIndex=index===focusIndex?0:-1;card.id='server-'+profile.id;card.dataset.id=profile.id;const identity=make('div');const name=make('div','server-name');name.append(make('span','',profile.name));if(profile.isDefault)name.append(make('span','badge','Workspace default'));identity.append(name,make('div','muted server-root',profile.remoteRoot));const endpoint=make('div','server-endpoint',profile.username+'@'+profile.host+':'+profile.port);const meta=make('div','server-meta');meta.append(make('span','badge',profile.authMethod==='privateKey'?'SSH private key':'Password'),make('span','badge',profile.mappingCount+' mapping'+(profile.mappingCount===1?'':'s')));card.append(identity,endpoint,meta);card.addEventListener('mouseenter',()=>{focusIndex=index;updateFocus(false)});card.addEventListener('focus',()=>{focusIndex=index;updateFocus(false)});card.addEventListener('click',()=>select(profile.id));list.append(card)});empty.hidden=visible.length>0}function updateFocus(moveDom=true){[...list.children].forEach((item,index)=>{const focused=index===focusIndex;item.classList.toggle('focused',focused);item.tabIndex=focused?0:-1});if(moveDom&&visible.length)list.children[focusIndex].focus()}function select(id){vscode.postMessage({type:'select',id})}search.addEventListener('input',()=>{focusIndex=0;render()});document.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();vscode.postMessage({type:'cancel'});return}if(event.key==='Tab'){const focusable=[...document.querySelectorAll('button,input')].filter(item=>!item.disabled);if(focusable.length&&event.shiftKey&&document.activeElement===focusable[0]){event.preventDefault();focusable[focusable.length-1].focus()}else if(focusable.length&&!event.shiftKey&&document.activeElement===focusable[focusable.length-1]){event.preventDefault();focusable[0].focus()}return}if(!visible.length)return;const target=event.target;if((event.key==='ArrowDown'||event.key==='ArrowUp')&&(target===search||(target instanceof HTMLElement&&target.closest('.server-list')))){event.preventDefault();focusIndex=(focusIndex+(event.key==='ArrowDown'?1:-1)+visible.length)%visible.length;updateFocus();return}if((event.key==='Enter'||event.key===' ')&&document.activeElement===search){event.preventDefault();select(visible[focusIndex].id)}});document.getElementById('cancel').addEventListener('click',()=>vscode.postMessage({type:'cancel'}));document.getElementById('configure').addEventListener('click',()=>vscode.postMessage({type:'configure'}));render();search.focus()</script></body></html>`;
}

function mappingRemotePath(profile: DeploymentProfile, mapping: PathMapping): string { const root = normalizeRemotePath(profile.remoteRoot || '/'); const deployment = normalizeRemotePath(mapping.deploymentPath || '/'); return deployment === root || deployment.startsWith(`${root}/`) ? deployment : path.posix.join(root, deployment.replace(/^\/+/, '')); }
function remotePathFor(profile: DeploymentProfile, localPath: string): string { const resolvedLocalPath = path.resolve(localPath); const mapping = profile.mappings.filter(m => isPathWithin(resolvedLocalPath, m.localPath)).sort((a, b) => b.localPath.length - a.localPath.length)[0]; if (mapping) { return path.posix.join(mappingRemotePath(profile, mapping), path.relative(mapping.localPath, resolvedLocalPath).split(path.sep).join('/')); } const root = workspaceRootFor(resolvedLocalPath); if (!root) { throw new Error(`File is outside every open workspace folder and has no path mapping in ${profile.name}. Add a mapping for ${resolvedLocalPath} in Connection Hierarchy.`); } return path.posix.join(profile.remoteRoot, path.relative(root, resolvedLocalPath).split(path.sep).join('/')); }
function isPathWithin(candidate: string, parent: string): boolean { const relative = path.relative(path.resolve(parent), path.resolve(candidate)); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
function workspaceRootFor(localPath: string): string | undefined { return vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath).filter(folder => isPathWithin(localPath, folder)).sort((a, b) => b.length - a.length)[0]; }
function defaultLocalPath(profile: DeploymentProfile, remotePath: string): string { const mapping = profile.mappings.map(item => ({ item, remoteBase: mappingRemotePath(profile, item) })).filter(({ remoteBase }) => remotePath === remoteBase || remotePath.startsWith(`${remoteBase}/`)).sort((a, b) => b.remoteBase.length - a.remoteBase.length)[0]; return mapping ? path.join(mapping.item.localPath, path.posix.relative(mapping.remoteBase, remotePath)) : path.join(workspaceRoot(), path.posix.relative(profile.remoteRoot, remotePath)); }
function workspaceRoot(): string { const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; if (!root) { throw new Error('Open a workspace folder first.'); } return root; }
async function writeRemotePreviewFile(context: vscode.ExtensionContext, profileId: string, remotePath: string, data: Buffer): Promise<vscode.Uri> { const hash = crypto.createHash('sha1').update(`${profileId}:${remotePath}`).digest('hex').slice(0, 12); const file = path.join(context.globalStorageUri.fsPath, 'previews', hash, path.basename(remotePath)); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); return vscode.Uri.file(file); }
async function writeComparisonFile(context: vscode.ExtensionContext, profileId: string, remotePath: string, data: Buffer): Promise<vscode.Uri> { const hash = crypto.createHash('sha1').update(`${profileId}:${remotePath}`).digest('hex').slice(0, 12); const ext = path.extname(remotePath); const file = path.join(context.globalStorageUri.fsPath, 'comparisons', `${path.basename(remotePath, ext)}.${hash}.server${ext}`); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); return vscode.Uri.file(file); }
async function writeLocalComparisonFile(context: vscode.ExtensionContext, profileId: string, localPath: string, data: Buffer): Promise<vscode.Uri> { const hash = crypto.createHash('sha1').update(`${profileId}:${localPath}`).digest('hex').slice(0, 12); const ext = path.extname(localPath); const file = path.join(context.globalStorageUri.fsPath, 'comparisons', `${path.basename(localPath, ext)}.${hash}.local${ext}`); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); return vscode.Uri.file(file); }
async function writeClipboardComparisonFile(context: vscode.ExtensionContext, localPath: string, content: string): Promise<vscode.Uri> { const hash = crypto.createHash('sha1').update(localPath).digest('hex').slice(0, 12); const ext = path.extname(localPath) || '.txt'; const file = path.join(context.globalStorageUri.fsPath, 'comparisons', `${path.basename(localPath, path.extname(localPath))}.${hash}.clipboard${ext}`); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content, 'utf8'); return vscode.Uri.file(file); }
async function writeEmptyComparisonFile(context: vscode.ExtensionContext, profileId: string, localPath: string): Promise<vscode.Uri> { const hash = crypto.createHash('sha1').update(`${profileId}:${localPath}`).digest('hex').slice(0, 12); const ext = path.extname(localPath); const file = path.join(context.globalStorageUri.fsPath, 'comparisons', `${path.basename(localPath, ext)}.${hash}.local-empty${ext}`); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, ''); return vscode.Uri.file(file); }
function isTextBuffer(data: Buffer): boolean { if (!data.length) { return true; } const sample = data.subarray(0, Math.min(data.length, 8192)); if (sample.includes(0)) { return false; } let control = 0; for (const byte of sample) { if (byte < 9 || (byte > 13 && byte < 32)) { control++; } } return control / sample.length < 0.02; }
function normalizeRemotePath(value: string): string { const normalized = path.posix.normalize(value.replace(/\\/g, '/')); return normalized.startsWith('/') ? normalized : `/${normalized}`; }
function formatSize(size: number): string { return size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1048576).toFixed(1)} MB`; }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export async function deactivate(): Promise<void> {}
