# VS Code Antigravity MCP (`vscode-antigravity-mcp`)

Zero-dependency **Model Context Protocol (MCP) Server** + **VS Code UI Extension** bridging AI coding agents (Google Antigravity, Claude Desktop, Cursor, Copilot, etc.) directly into **Local** and **Remote-SSH / WSL / Dev Container** VS Code windows.

---

## Key Highlights / Điểm nổi bật

- **1:1 Antigravity Tool Schemas:** Exact parameter names (`Path`, `StartLine`, `EndLine`, `ByteOffset`, `Target`, `Replacement`, `CommandLine`, `WaitMsBeforeAsync`, ...) and output formatting matching Antigravity's native toolset.
- **Seamless Remote-SSH / WSL / Containers Support (Zero Remote Install):** Uses `"extensionKind": ["ui"]` + `vscode.workspace.fs` + VS Code Terminal Shell Integration (`^1.93.0`), allowing agents on your local machine to read, edit, search, and run commands inside remote SSH/WSL/Container windows **without installing anything on the remote server**.
- **Live Editor Context & Undo-Safe Saves:** Reads live cursor position (`line`, `column`), highlighted selection (`selectedText`), open tabs, and compiler/LSP diagnostics (`Problems`). Edits on open tabs apply via `vscode.WorkspaceEdit` + `doc.save()` — saving immediately to disk while preserving `Ctrl+Z` Undo history in VS Code.
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

## Useful Commands

```bash
# Package VSIX only
npm run build

# Run automated MCP protocol tests
npm test

# Uninstall extension from all VS Code profiles & remove MCP config entry
npm run uninstall-bridge
```

## License

[MIT](./LICENSE)
