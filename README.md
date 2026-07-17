# JetBrains style SFTP

**JetBrains style SFTP** is a Visual Studio Code extension for browsing SFTP servers, comparing remote and local files, and deploying changes without leaving the editor. It is designed for projects that need one or more SFTP targets with clear, workspace-specific path mappings.

> The extension currently targets VS Code 1.85 or later and communicates over SFTP (SSH).

## Highlights

- Manage multiple named SFTP profiles per workspace and choose a workspace default.
- Authenticate with a password or an SSH private key.
- Store passwords in VS Code Secret Storage rather than workspace settings.
- Browse the configured remote root from the Activity Bar.
- Open and edit remote files directly in VS Code through a virtual file system.
- Upload a local file to the default server or choose a target server at execution time.
- Review a folder deployment in a side-by-side preview before deploying one or all files.
- Compare local files with remote files, local files with clipboard text, and remote files with their mapped local counterparts.
- Download, rename, delete, and sync files or folders from the remote browser.
- Upload mapped files automatically when they are saved.
- Use temporary-file uploads followed by a rename for safer remote replacements.
- Exclude build output, dependencies, secrets, or other paths from folder deployment previews and upload-on-save.

## Requirements

- [Visual Studio Code](https://code.visualstudio.com/) **1.85.0 or later**
- Access to an SFTP server over SSH
- A server account authenticated by password or SSH private key

For extension development, use a current Node.js LTS release (Node.js 20 or newer is recommended) and npm.

## Installation

### Install a packaged extension

Download a `.vsix` package from the project releases, then either:

1. In VS Code, open **Extensions**.
2. Select **Views and More Actions** (`...`) > **Install from VSIX...**.
3. Choose the downloaded package and reload VS Code if prompted.

Or install it from a terminal:

```powershell
code --install-extension jetbrains-style-sftp-0.0.7.vsix
```

### Build from source

```powershell
git clone <repository-url>
cd sftp-extension
npm install
npm run compile
```

Open the folder in VS Code and press `F5` to launch an Extension Development Host. See [Development](#development) for watch and packaging commands.

## Quick Start

1. Open the project folder you want to deploy in VS Code.
2. Open the **JetBrains style SFTP** view from the Activity Bar.
3. Click **Configuration** in the view title bar, or run **JetBrains style SFTP: Configuration** from the Command Palette.
4. Select **Add SFTP**, then enter the connection details:
   - Profile name, host, port, username, and remote root.
   - **Password** or **SSH private key** authentication.
   - One or more local-to-remote path mappings.
5. Click **Test Connection**, then **Save Current Profile**.
6. Set the profile as **Workspace default** if it should be the usual deployment target.
7. Right-click a local file or folder in Explorer and choose an action from the **JetBrains style SFTP** submenu.

The Remote Files tree shows the default profile. Use **Select Server** in its title bar to open a modal-style server selector with a dimmed overlay and centered dialog card. The selector supports search, full-row selection, and Up/Down plus Enter or Space keyboard navigation. Closing it or choosing Cancel leaves the current default unchanged. VS Code renders the dialog inside a Webview panel, while the overlay provides the modal presentation.

## Configuring Connections

The **Connection Hierarchy** panel stores profiles in workspace settings. Each profile owns its mappings, exclusions, upload behavior, and connection details.

### Authentication


| Method          | Configuration                                     | Notes                                                                             |
| --------------- | ------------------------------------------------- | --------------------------------------------------------------------------------- |
| Password        | Select**Password** and enter the password         | The password is saved in VS Code Secret Storage, not in`.vscode/settings.json`.   |
| SSH private key | Select**SSH private key** and choose the key file | The key file remains on your machine; its path is saved in the workspace profile. |

When a profile uses password authentication and no saved password is available, the extension prompts for it during connection.

### Path mappings

A mapping has a **Local path** and **Deployment path**. The extension uses the most specific local mapping that contains the file.

For example, with this profile:

```text
Remote root:      /var/www/my-app
Local path:       C:\work\my-app\frontend
Deployment path:  /current
```

the local file:

```text
C:\work\my-app\frontend\src\main.ts
```

deploys to:

```text
/var/www/my-app/current/src/main.ts
```

If a deployment path is already inside the remote root, it is used as-is. If a local file has no matching mapping but is inside an open workspace folder, its workspace-relative path is placed below the profile's remote root. Files outside all workspace folders need an explicit mapping.

The configuration panel also exposes a **Web path** field. It is stored with the mapping for project metadata compatibility, but the current extension does not use it to construct SFTP paths.

### Workspace settings example

The configuration panel is the recommended way to manage settings. The equivalent non-sensitive structure in `.vscode/settings.json` looks like this:

```json
{
  "remoteDeploy.defaultProfileId": "staging",
  "remoteDeploy.profiles": [
    {
      "id": "staging",
      "name": "Staging",
      "host": "sftp.example.com",
      "port": 22,
      "username": "deploy",
      "remoteRoot": "/var/www/my-app",
      "authMethod": "privateKey",
      "privateKeyPath": "C:\\Users\\you\\.ssh\\id_ed25519",
      "uploadOnSave": false,
      "useTemporaryFile": true,
      "mappings": [
        {
          "localPath": "C:\\work\\my-app",
          "deploymentPath": "/current"
        }
      ],
      "exclusions": {
        "patterns": [
          ".git/**",
          ".vscode/**",
          "node_modules/**",
          "dist/**"
        ],
        "localPaths": [
          ".env",
          "secrets"
        ]
      }
    }
  ]
}
```

Do not add passwords to `settings.json` or commit credentials to source control. Save passwords through the configuration panel instead.

## Using the Extension

### Local-file actions

Right-click a local file or folder in VS Code Explorer, or right-click an open local editor, to find **JetBrains style SFTP** actions.


| Action                                          | What it does                                                                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Upload to Default SFTP**                      | Uploads the selected local file to the workspace-default profile.                                                       |
| **Upload to Selected SFTP...**                  | Opens the searchable editor-area server selector, then uploads to that profile without changing the workspace default. |
| **Sync with Deployed on Default/Selected SFTP** | The Selected variant opens the searchable editor-area server selector without changing the default; the preview lists multiple files and supports Sync Selected, Sync All, and Compare. |
| **Compare with Default/Selected SFTP**          | Opens VS Code's diff editor; the Selected variant uses the editor-area selector once and does not change the default.   |
| **Compare with Clipboard**                      | Opens a diff editor between copied text and the selected local file.                                                    |

The preview marks files as new, modified, or identical. For text files, it displays an inline comparison and can open VS Code's full diff editor. Binary files can still be deployed, but are not displayed as text diffs.

Before deploying from the preview, you can:

- compare a selected text file in VS Code;
- overwrite the local file with its existing server version; or
- deploy the selected file or all scanned files.

The remote-to-local sync preview also lists every selected file and provides **Sync Selected**, **Sync All**, and **Compare** actions.

For open text documents, comparisons and preview deployments use the current editor content, including unsaved edits.

### Remote Files view

Open the **JetBrains style SFTP** Activity Bar view to browse the currently selected profile from its configured remote root. Directories appear before files.

Right-click a remote item to:

- **Download from Here...** — download a file, or recursively download a directory;
- **Sync With Local...** — preview a remote file against its mapped local destination before overwriting or creating it; sync a selected directory recursively after confirmation;
- **Preview Remote File** — open the remote file in VS Code;
- **Compare with Local** — open a server-versus-local diff for a mapped file;
- **Rename...** or **Delete...** — manage files and directories on the server.

Deleting a remote directory is recursive and requires a modal confirmation. Remote operations are restricted to the configured remote root.

### Editing remote files

Opening a remote file uses the `remote-deploy:` virtual file system. In a trusted workspace, saving edits back to that document uploads the changes to the corresponding SFTP file. The extension refreshes the remote file system after writes.

## Upload on Save and Exclusions

Enable **Upload on save** for an individual profile in the configuration panel. You can also set the workspace setting below to enable upload-on-save for every configured profile:

```json
{
  "remoteDeploy.uploadOnSave": true
}
```

Only local files with a valid mapping or workspace-relative destination are eligible. Upload-on-save is disabled in untrusted workspaces.

For each profile, exclusions are evaluated relative to the matching path mapping:

- **Glob patterns** support `*`, `**`, and `?`.
- **Explicit local paths** are relative to the mapping root and exclude the file or directory tree.
- If no patterns are configured, the defaults are `.git/**`, `.vscode/**`, and `node_modules/**`.

Exclusions apply to folder deployment previews and upload-on-save. A direct manual upload of one explicitly selected file is not filtered by exclusions.

## Safe Uploads

**Safe upload** is enabled by default for profiles. The extension uploads content to a temporary remote file and then renames it into place. It first attempts an atomic POSIX rename and falls back to a backup-and-replace sequence when needed. This reduces the chance of clients reading a partially uploaded target file.

Disable Safe upload only when the target server does not support this replacement workflow.

## Commands

All commands are available through the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).


| Command                                                    | Purpose                                                                |
| ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| `JetBrains style SFTP: Configuration`                          | Open the profile and mapping editor.                                   |
| `JetBrains style SFTP: Select Server`                          | Change the workspace-default profile.                                  |

### Keyboard shortcuts

The extension adds scoped shortcuts for common right-click actions. Remote-tree actions work when the Remote Files tree is focused; local-file actions work when a local file editor is focused.

| Action | Windows/Linux | macOS |
| --- | --- | --- |
| Download remote item | Ctrl+Alt+Shift+D | Cmd+Alt+Shift+D |
| Sync remote item with local | Ctrl+Alt+Shift+S | Cmd+Alt+Shift+S |
| Rename remote item | Ctrl+Alt+Shift+R | Cmd+Alt+Shift+R |
| Delete remote item | Ctrl+Alt+Shift+Delete | Cmd+Alt+Shift+Backspace |
| Compare remote item with local | Ctrl+Alt+Shift+C | Cmd+Alt+Shift+C |
| Upload to default SFTP | Ctrl+Alt+Shift+U | Cmd+Alt+Shift+U |
| Sync with deployed default SFTP | Ctrl+Alt+Shift+Y | Cmd+Alt+Shift+Y |
| Compare with default SFTP | Ctrl+Alt+Shift+V | Cmd+Alt+Shift+V |
| Compare with clipboard | Ctrl+Alt+Shift+B | Cmd+Alt+Shift+B |
| `JetBrains style SFTP: Refresh Remote Files`                   | Reconnect and refresh the remote tree.                                 |
| `JetBrains style SFTP: Show File Transfer Log`                 | Open the extension's log output channel.                               |
| `JetBrains style SFTP: Upload to Default SFTP`                 | Upload a local file to the default profile.                            |
| `JetBrains style SFTP: Upload to Selected SFTP...`             | Upload a local file after choosing a profile.                          |
| `JetBrains style SFTP: Sync with Deployed on Default SFTP`     | Review and deploy selected local files/folders to the default profile. |
| `JetBrains style SFTP: Sync with Deployed on Selected SFTP...` | Review and deploy after choosing a profile.                            |
| `JetBrains style SFTP: Compare with Default SFTP`              | Compare a local file with its default-profile counterpart.             |
| `JetBrains style SFTP: Compare with Selected SFTP...`          | Compare a local file after choosing a profile.                         |
| `JetBrains style SFTP: Compare with Clipboard`                 | Compare copied text with a local file.                                 |

Remote-view actions such as download, rename, delete, preview, and sync are exposed in the item's context menu.

## Security Notes

- SFTP credentials are used only to connect to the configured server.
- Passwords saved through the extension use VS Code Secret Storage; they are not written to workspace configuration.
- Private keys are read from the configured local path when a connection is created. Keep private key files protected with normal OS permissions.
- Profiles, hostnames, usernames, remote roots, mappings, and private-key paths are workspace settings. Treat a shared `.vscode/settings.json` as configuration that may reveal infrastructure details.
- File-changing remote operations and remote virtual-file-system writes require a trusted workspace.

## Development

### Scripts

```powershell
# Install dependencies
npm install

# Compile TypeScript to out/
npm run compile

# Recompile when source files change
npm run watch

# Build the versioned distributable VSIX package
npm run package -- --out jetbrains-style-sftp-0.0.7.vsix
```

Press `F5` in VS Code after compiling to run the extension in an Extension Development Host. The compiled entry point is `out/extension.js`.

### Project layout

```text
src/extension.ts       Extension implementation and webview UI
media/remote-host.svg  Activity Bar icon
out/                   Compiled extension output
package.json           VS Code manifest, commands, settings, and npm scripts
```

## Troubleshooting


| Problem                                    | Things to check                                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Connection fails                           | Verify host, port, username, network/VPN access, authentication method, and SSH key permissions. Use**Test Connection** in Configuration.                          |
| A local file has no deployment destination | Add a mapping for the containing directory, or open the file from an active workspace folder.                                                                      |
| A folder preview is empty                  | Check the selected folder, then review the profile's exclusion patterns and explicit local paths. Symbolic links are skipped during folder scans.                  |
| Upload on save does not run                | Confirm the workspace is trusted, upload-on-save is enabled for the profile or workspace, and the saved file has a valid destination. Check the File Transfer Log. |
| A diff is unavailable                      | The built-in text comparison is intentionally disabled for binary content. Deploy or download the binary file directly instead.                                    |
| Remote tree looks stale                    | Run**JetBrains style SFTP: Refresh Remote Files** to reconnect and reload the directory.                                                                               |

## Current Scope

JetBrains style SFTP supports SFTP over SSH. It does not provide FTP, FTPS, or SCP transport modes.

## License

No license file is currently included in this repository. Add an appropriate license before redistributing or accepting external contributions.
