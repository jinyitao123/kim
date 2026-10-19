# Weave Workbench Desktop

The desktop client of [Weave Workbench](../README.md). Employees do daily work in local folders, hand materials to Weave agent teams, and handle the tasks assigned to them; developers configure teams and test business actions. Authoritative business state stays in Forge, and execution state stays in Weave — this app only presents them.

This directory is a product adaptation of [GooeyPi](https://github.com/am-will/gooey-pi) (MIT), a desktop workspace for [Pi](https://pi.dev/) and [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent). The harness, session, project, terminal, browser, and capability features described below come from that base and are kept.

## Three harnesses, one workspace

Use the switcher in the top-left corner to move between Pi Work, Prime Work and Loom Work. GooeyPi detects the installed harnesses and shows the ones that are ready. You can refresh detection or set a custom executable path in Settings.

Each harness keeps its own projects, sessions, model list, provider visibility, and running work. Switching harnesses changes the workspace without stopping work already running in another one.

You only need one harness to get started:

- [Pi](https://pi.dev/) is the base coding-agent harness in the Pi family.
- [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) adds Prime's provider integrations and native heartbeats.
- [Loom](https://github.com/jinyitao123/loom) is a single native executable (`loom agent --mode rpc`) that speaks the same protocol and session format as Pi. It runs the OpenAI-compatible models of the providers connected for Prime Work, and receives the app's capabilities (team work, questions, browser, schedules, session collaboration, team development) as MCP tools served by the app.

## What you can do

### Work with agents

- Stream conversations with Markdown, reasoning summaries, tool activity, retries, and context compaction.
- Choose a model, reasoning level, and Fast mode when the selected model supports it.
- Queue a follow-up or steer an agent while it is working.
- Paste or drop PNG, JPEG, GIF, and WebP images into a prompt when the model supports vision.
- Resume, rename, search, and archive persistent sessions.
- See running, finished, failed, and waiting-for-input work in one Activity view, then clear items you have handled.

### Keep projects organized

- Add local folders and reopen sessions grouped by project.
- Search projects, chats, and branches from the sidebar.
- Switch between linked Git worktrees from the composer.
- Create a branch worktree and open it as a new GooeyPi workspace.
- Mention another top-level session with `@session`, copy its UUID, or let agents create and message model-selected sessions for parallel work.

### Use the built-in coding workspace

- Review Git status and diffs, stage or unstage files, restore changes with confirmation, and commit without leaving the app.
- Browse project files and reveal them in your system file manager.
- Open multiple terminal tabs for a session. Highlight terminal output to attach it to the next prompt.
- Open the right-hand Summary, Changes, Browser, or Files panel whenever you need it.

### Browse with shared context

- Use an isolated in-app browser with an address bar, navigation history, downloads, and an external-browser handoff.
- Point at page elements and add notes. GooeyPi attaches those annotations to your next message.
- Enable browser control so an agent can open and operate its own tabs. You can watch its cursor and work in the same tabs when you want to take over.

### Automate repeat work

- Create one-time or recurring schedules for the active harness.
- Pick the project or existing session, model, reasoning level, timezone, and Fast mode.
- Run a schedule immediately, pause or resume it, and inspect the result and run history.
- Manage Prime heartbeats alongside GooeyPi schedules when Prime Agent exposes them.
- On macOS, opt in under **Settings → General** to keep scheduled work running from the menu bar after closing the window, and optionally launch GooeyPi in the background at login. The packaged app also accepts `--background` to start without opening its window.

### Add capabilities

The Capabilities page brings together packages, extensions, skills, prompts, and MCP servers. Prime Agent MCP configuration stays outside GooeyPi. For Pi Work, GooeyPi can manage local stdio MCP definitions through the Pi MCP Adapter. Network MCP and authentication stay under the selected harness's direct control; those entries are visible but read-only in GooeyPi, with bounded definition-only removal available for cleanup. MCP discovery has an independent 2,500-definition-per-settings-file limit and reports an explicit warning when that limit is exceeded, so unrelated capabilities cannot hide supported MCP rows.

GooeyPi also ships optional capabilities for:

- Let an agent ask you a small set of questions in a native dialog.
- Give agents controlled access to the in-app browser.
- Use TryCUA computer control when the separate CUA Driver is installed.

Ask User and computer control are off by default. You can enable, disable, or remove capabilities from the app.

### Talk instead of type

- Dictate prompts with OpenAI, Groq, Deepgram, or a local `whisper.cpp` installation.
- Open the realtime voice companion to search, discuss work, and start a task in the currently selected harness.
- Choose an animated desktop pet that reacts while an agent works and carries the realtime voice controls. GooeyPi includes the Orb and GooeyPi pets and can discover compatible Codex pets.

### Make it comfortable

- Choose a light, dark, or system theme and adjust the interface text size.
- Reduce motion, resize the workspace panels, or let them become overlays in a narrow window.
- Use keyboard navigation and the command palette for common actions.

## Get started

1. Install Pi, Prime Agent, or both.
2. Sign in or configure a model provider through each harness's own CLI.
3. Run it from source (see below) or build a local package.
4. Add a project folder and start a session.

GooeyPi checks common install locations automatically. If a harness is missing, open **Settings → Harness** to refresh detection or choose its executable.

Harness provider credentials stay with the harness. Optional voice keys are encrypted with the operating system's secure storage, and local `whisper.cpp` dictation needs no API key.

## Run from source

You will need Node.js 24.15.0 or newer and npm 12.0.2 or newer. The repository pins Node.js 24.15.0 in `.nvmrc`; with [nvm](https://github.com/nvm-sh/nvm), you can select it with:

```bash
nvm install && nvm use
npm run toolchain:bootstrap
```

The bootstrap command verifies the exact size and SHA-512 of the checked-in npm archive, then installs it offline with install-time lifecycle scripts disabled into the invoked npm's configured global prefix, verifies the installed CLI and both tool versions against `package.json` and `.nvmrc`, and makes its shim available to subsequent GitHub Actions steps before dependencies are installed.

```bash
npm install
npm run dev
```

If `node_modules/electron/dist` is missing after installation, fetch Electron's platform binary before starting the app:

```bash
node node_modules/electron/install.js
npm run dev
```

`npm install --ignore-scripts` skips both Electron's platform download and the native dependency rebuild, so it is not enough on its own for running GooeyPi from source. If you used it, the recovery sequence below runs those two steps explicitly.

`node-pty` is a native dependency. If Electron cannot rebuild it with your default Python environment, point npm at a Python installation with the required build tools:

```bash
export npm_config_python=/path/to/python3
npm install --ignore-scripts
node node_modules/electron/install.js
npx electron-builder install-app-deps
```

## Keyboard shortcuts

Use `⌘` on macOS and `Ctrl` on Linux or Windows.

| Shortcut | Action |
|---|---|
| `⌘/Ctrl+N` | New session |
| `⌘/Ctrl+K` | Command palette |
| `⌘/Ctrl+B` | Toggle the project sidebar |
| `⌘/Ctrl+Shift+B` | Open the browser |
| `⌘/Ctrl+J` | Toggle the terminal |
| `⌘/Ctrl+,` | Open Settings |
| `Enter` | Queue a message while the agent is working |
| `⌘/Ctrl+Enter` | Steer the current turn while the agent is working |
| `Shift+Enter` | Add a new line |
| `Esc` | Close the active menu, dialog, or overlay |

The Queue and Steer shortcuts can be swapped in **Settings → Harness → Message shortcuts**.

## Local data and safety

GooeyPi is built around local projects and local harness sessions. It does not rewrite session history or take ownership of Pi or Prime Agent credentials.

Remote pages open in a separate browser profile with Node access disabled. Project paths and desktop actions are checked in the main process, and third-party capabilities still run with your operating-system permissions. Review packages, commands, MCP servers, and projects before allowing them to act.

For suspected vulnerabilities, follow the [security policy](.github/SECURITY.md) and do not post sensitive details publicly. See [docs/安全模型.md](docs/安全模型.md) for the full technical security model.

## Development checks

Run these before submitting a code change:

```bash
npm run typecheck
npm run check
npm test
npm run test:e2e
npm run build
```

See the [validation guide](docs/测试与验收说明.md) for the source-of-truth checks and reproducible commands.

To make an installable local QA build, run the command for your operating system:

```bash
npm run package:mac:local-qa
npm run package:linux:local-qa
npm run package:win:local-qa
```

Build packages on their target operating system so native dependencies match the release.

## License

This directory is released under the [MIT License](LICENSE), inherited from GooeyPi (Copyright (c) 2026 GooeyPi contributors). The repository as a whole is Apache-2.0; see [NOTICE](../NOTICE).
