# VS Code Antigravity MCP (`vscode-antigravity-mcp`)

Zero-dependency **Model Context Protocol (MCP) Server** + **VS Code UI Extension** bridging AI coding agents (Google Antigravity, Claude Desktop, Cursor, Copilot, etc.) directly into **Local** and **Remote-SSH / WSL / Dev Container** VS Code windows.

---

## Key Highlights / Điểm nổi bật

- **1:1 Antigravity Tool Schemas:** Exact parameter names (`Path`, `StartLine`, `EndLine`, `ByteOffset`, `Target`, `Replacement`, `CommandLine`, `WaitMsBeforeAsync`, ...) and output formatting matching Antigravity's native toolset.
- **Seamless Remote-SSH / WSL / Containers Support (Zero Remote Install):** Uses `"extensionKind": ["ui"]` + `vscode.workspace.fs` + VS Code Terminal Shell Integration (`^1.93.0`), allowing agents on your local machine to read, edit, search, and run commands inside remote SSH/WSL/Container windows **without installing anything on the remote server**.
- **Live Editor & Preview Context + Undo-Safe Saves:** Reads live cursor position (`line`, `column`), highlighted selection (`selectedText`), open tabs (including Preview / Custom Editor / Webview / Diff / Notebook tabs), and compiler/LSP diagnostics (`Problems`). Includes an optional **Antigravity Markdown Preview** (`*.md` custom editor) that captures live highlighted text directly inside rendered Markdown. Edits on open tabs apply via `vscode.WorkspaceEdit` + `doc.save()` — saving immediately to disk while preserving `Ctrl+Z` Undo history in VS Code.
- **Multi-Window Smart Routing & Offline Fallback:** Automatically routes local vs. remote paths across multiple open VS Code windows, and falls back to standalone Node.js file/shell execution when VS Code is closed.
- **Zero External Dependencies:** Pure Node.js (`>=18`), no `npm install` required. Works on Windows, macOS, and Linux.

---

## Quick Start / Cài đặt nhanh (1 lệnh)

```bash
git clone https://github.com/anhpi1/vscode-antigravity-mcp.git
cd vscode-antigravity-mcp
npm run setup
```

What `npm run setup` does automatically:
1. Packages `dist/vscode-antigravity-mcp-1.0.0.vsix` (pure Node.js ZIP builder, no external CLI tools required).
2. Installs the extension into VS Code's Default profile **and all custom VS Code profiles**.
3. Registers the `"vscode"` MCP server in `~/.gemini/config/mcp_config.json` for Antigravity.

After running setup, open **Antigravity -> Additional Options (`...`) -> MCP Servers -> Refresh** (or start a new chat).

### Windows Troubleshooting / Lưu ý trên Windows

- **PowerShell blocks `npm.ps1` (`ExecutionPolicy`):** Run the setup script directly with Node.js instead of `npm`:
  ```powershell
  node ./scripts/install.js
  ```
- **VS Code extension not showing in `code --list-extensions`:** If `install.js` fails to install the `.vsix` due to `cmd.exe` quote escaping, install the packaged VSIX directly:
  ```powershell
  code --install-extension ./dist/vscode-antigravity-mcp-1.0.0.vsix --force
  code --list-extensions --show-versions
  ```
  *(For custom VS Code profiles, add `--profile "<ProfileName>"`.)*

---

## Manual MCP Configuration (Other MCP Clients)

Add to your `mcp_config.json` / `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vscode": {
      "command": "node",
      "args": ["/absolute/path/to/vscode-antigravity-mcp/src/mcp-server.js"]
    }
  }
}
```

---

## Available MCP Tools (12 Tools)

| Category | Tool Name | Parameters | Description |
| :--- | :--- | :--- | :--- |
| **File Operations** | `read_file` | `Path`, `StartLine`, `EndLine`, `ByteOffset` | Read up to 800 lines or 46,080 bytes with `1: ...` line numbering (Local & Remote-SSH). |
| | `write_file` | `Path`, `Content`, `Overwrite`, `Append` | Create, overwrite, or append files; auto-saves and preserves `Ctrl+Z` Undo on open tabs. |
| | `edit_file` | `Path`, `Target`, `Replacement` | Exact text replacement via `WorkspaceEdit` + auto-save + CRLF/LF normalization. |
| **Search & Directories** | `list_dir` | `DirectoryPath` | List subdirectories and file byte sizes (Local & Remote-SSH). |
| | `find_by_name` | `SearchDirectory`, `Pattern`, `Extensions`, `Excludes`, `Type`, `MaxDepth`, `FullPath` | Fast glob/extension file finder. |
| | `grep_search` | `SearchPath`, `Query`, `IsRegex`, `CaseInsensitive`, `MatchPerLine`, `Includes` | Text and regex content search with line numbers. |
| **Shell & Tasks** | `run_command` | `CommandLine`, `WaitMsBeforeAsync`, `IsDaemon`, `toolSummary`, `Cwd`, `TargetWindow` | Run commands locally or on Remote-SSH/WSL via VS Code Shell Integration; supports async background tasks. |
| | `manage_task` | `Action` (`list`, `status`, `send_input`, `kill`), `TaskId`, `Input` | Inspect, send stdin to, or terminate background command tasks. |
| **VS Code Editor & UI** | `vscode_get_editor_state` | `AllWindows` | Get active `filePath`, `cursor` (`line`, `column`), `selectedText`, `openTabs`, and remote authority. |
| | `vscode_open_file` | `Path`, `StartLine`, `StartColumn`, `EndLine`, `EndColumn`, `Preview` | Open file in VS Code, scroll into view, and set cursor/selection range. |
| | `vscode_get_diagnostics` | `Path`, `Severity` | Read Errors/Warnings from VS Code's Problems panel (Clangd, C/C++, Pylance, ESLint, etc.). |
| | `vscode_execute_command` | `Command`, `Args` | Trigger any VS Code Command ID (e.g. `editor.action.formatDocument`, `cmake.build`). |

---

## Markdown Preview with Live Selection

VS Code isolates built-in Webview previews (`vscode.markdown.preview.editor`), so external extensions can detect the active preview file path (`activeTab` / `filePath`) via `tabGroups`, but cannot read highlighted text inside built-in Webviews.

To read **both** the active file path and live highlighted text while viewing rendered `.md` files:
1. Open any `.md` file in VS Code.
2. Click the **`Open Antigravity Markdown Preview`** icon in the top-right editor title bar (or right-click the file -> **Open With...** -> **Antigravity Markdown Preview**).
3. Highlight any text in the rendered Markdown view — it is exposed through `vscode_get_editor_state` (and the optional PreInvocation hook below).

---

## Optional: Live Context PreInvocation Hook (Antigravity)

This hook is **optional** and is **not** installed by `npm run setup`. When enabled, Antigravity automatically injects your active VS Code file path, cursor position, and highlighted text (from both text editors and **Antigravity Markdown Preview**) into every user turn without manually calling `vscode_get_editor_state`.

### Install / Uninstall Hook

```bash
# Install optional PreInvocation hook into ~/.gemini/config/hooks.json
npm run setup-hook
# (Windows PowerShell without npm.ps1):
node ./scripts/install-hook.js

# Remove the hook
npm run uninstall-hook
# or:
node ./scripts/install-hook.js --uninstall
```

### Manual Hook Configuration (`~/.gemini/config/hooks.json`)

```json
{
  "vscode-live-cursor-and-selection": {
    "enabled": true,
    "PreInvocation": [
      {
        "type": "command",
        "command": "node /absolute/path/to/vscode-antigravity-mcp/hooks/vscode-context-hook.js",
        "timeout": 10
      }
    ]
  }
}
```

---

## Useful Commands

```bash
# Package VSIX only
npm run build

# Run automated MCP protocol tests
npm test

# Install / uninstall optional Antigravity PreInvocation hook
npm run setup-hook
npm run uninstall-hook

# Uninstall extension from all VS Code profiles & remove MCP config entry
npm run uninstall-bridge
```

## License

[MIT](./LICENSE)
