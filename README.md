# cli-agent-vscode

A standalone VS Code sidebar for [cli-agent](https://github.com/sHuewe/cli-agent) using the **AG-UI 1.0 HTTP/SSE API**.

## v0.1 features

- Authenticated streaming chat, MCP tool-call notices and approval interrupt/resume
- Independent backend sessions with New Chat
- Send selected editor text, relative filename and line range into the composer
- Bearer credentials stored in VS Code SecretStorage, not exposed to Webviews
- Loopback-only HTTP API connection, CSP-locked Webview, plain-text rendering
- CI-built local VSIX; no Marketplace registration required

## Run

Install cli-agent with its `web` extra, then start its standalone API **within your VS Code workspace/environment**:

```sh
cli-agent-api --workspace . --port 8765 --with-os-read
```

In VS Code, open the **cli-agent** activity bar and click **Connect**. Paste the Bearer-Token printed in the CLI terminal. For explicit workspace write access, start the API with `--with-os-write` instead of `--with-os-read`; backend tool safety policies remain authoritative.

`cliAgent.apiUrl` defaults to `http://127.0.0.1:8765`. Only loopback HTTP endpoints are supported. Use the same environment for VS Code and the API process (e.g. both inside WSL).

## Development

```sh
npm install
npm run check
npm test
npm run compile
npm run package
code --install-extension cli-agent-vscode-0.1.0.vsix
```

Press F5 (after compile) for the Extension Development Host. On pull requests, GitHub Actions builds the VSIX as a downloadable workflow artifact.

## Scope and limitations

This release uses a **manually started** `cli-agent-api`. It does not yet launch the Python backend, reconnect to prior sessions after restarting VS Code, render Markdown, or offer write-capable editor frontend tools. Each New Chat creates a fresh backend session and closes the previous one. The extension attempts to clean up its current backend session on disposal.

The extension does not replace cli-agent's permission, workspace, or MCP controls. Approval decisions use standard AG-UI resume messages, and a failed resume HTTP request leaves the approval available for retry.
