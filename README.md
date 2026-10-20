# Kim

Kim 是一个桌面 AI 工作台：在本地和智能体一起处理文件，把需要多人协作或长时间运行的工作交给 [Weave](https://github.com/jinyitao123/weave-next) 上的智能体团队，结果会回到发起它的那个对话里。

## 能做什么

### 对话与本地工作

- 和智能体对话：流式回复、思考摘要、工具调用过程；一轮做完后折叠成一行，例如「做了 6 步 · 处理 3 个文件、运行 2 条命令 · 用时 1 分 12 秒」。
- 支持三种内核：Pi、Prime Agent 和 Loom（单个原生程序）。左上角切换，每种内核各自保留项目、对话、模型和运行中的工作。
- 智能体工作时可以排队追加消息，或者插话调整方向；可以粘贴或拖入图片和文件。
- 内置 Git 改动查看、终端、文件浏览，以及一个和智能体共享的应用内浏览器（可以在网页元素上做标注）。
- 定时任务、能力目录（技能、扩展、MCP），以及听写和实时语音。

### 交给团队

- 对话中提出要交给团队的工作，助手会在当前账号能用的团队里匹配，并整理好材料和授权范围后交接。
- 团队在云端独立运行，关掉窗口也不会中断。
- 运行完成、需要你补充或等你处理时：
  - 窗口在前台：应用内提示；不在前台：系统通知。
  - 点通知直接回到发起这项工作的对话，对话末尾会出现「团队结果已返回」卡片，包括结论和待补充的事项。
  - 助手不会自己开始，你回复以后它在同一个对话里接着处理。
- 「我的工作」汇总待你处理的事项、你发起的运行和工作消息。

## 连接

Kim 目前通过组织连接配置连接服务端：身份由 Forge（基于 ObjectStack）验证，团队运行在 Weave 上。开发调试时可以用成对的环境变量 `WORKBENCH_FORGE_URL` 和 `WORKBENCH_WEAVE_URL` 覆盖。

计划中的个人模式：直接用 ObjectStack 账号连接一个 Weave，Forge 变为可选。尚未实现。

## 从源码运行

需要 Node.js 24.15.0 或更新版本、npm 12.0.2 或更新版本。仓库在 `.nvmrc` 里固定了 Node.js 版本。

```bash
npm run toolchain:bootstrap
npm install
npm run dev
```

`toolchain:bootstrap` 会校验仓库内置的 npm 安装包（大小和 SHA-512），在离线、禁用安装脚本的情况下，把它安装到当前 npm 配置的全局前缀，再核对版本。

如果安装后缺少 `node_modules/electron/dist`，先下载 Electron 的平台运行时：

```bash
node node_modules/electron/install.js
npm run dev
```

`node-pty` 是原生依赖。如果 Electron 用默认的 Python 环境重新编译失败，可以指定一个带构建工具的 Python：

```bash
export npm_config_python=/path/to/python3
npm install --ignore-scripts
node node_modules/electron/install.js
npx electron-builder install-app-deps
```

## 快捷键

macOS 用 `⌘`，Windows 和 Linux 用 `Ctrl`。

| 快捷键 | 作用 |
|---|---|
| `⌘/Ctrl+N` | 新对话 |
| `⌘/Ctrl+K` | 命令面板 |
| `⌘/Ctrl+B` | 显示或隐藏侧栏 |
| `⌘/Ctrl+Shift+B` | 打开浏览器 |
| `⌘/Ctrl+J` | 显示或隐藏终端 |
| `⌘/Ctrl+,` | 设置 |
| `Enter` | 智能体工作时排队发送 |
| `⌘/Ctrl+Enter` | 智能体工作时插话调整本轮 |
| `Shift+Enter` | 换行 |
| `Esc` | 关闭当前菜单、对话框或浮层 |

## 本地数据与安全

内核自己的服务商凭据仍由内核管理，Kim 不改写会话历史。远程网页在独立的浏览器配置中打开，并禁用 Node 访问；项目路径和桌面操作都在主进程里校验。第三方能力仍以你的系统权限运行，允许它们执行前请先确认。

可疑漏洞请按 [security policy](.github/SECURITY.md) 私下报告，不要公开发布细节。完整的技术安全模型见 [docs/安全模型.md](docs/安全模型.md)。

## 开发检查

提交代码前运行：

```bash
npm run typecheck
npm run check
npm test
npm run test:e2e
npm run build
```

各项检查的权威说明见[测试与验收说明](docs/测试与验收说明.md)。没有启用云端 CI：`npm run ci:local` 在本机依次跑类型检查、格式、构建、体积预算和依赖审计。`ci/workflows/` 保存着 GitHub Actions 的 CI、发行和依赖审计工作流，需要时把它们移到 `.github/workflows/` 即可启用。

生成本机可安装的测试包（在目标系统上构建，保证原生依赖匹配）：

```bash
npm run package:mac:local-qa
npm run package:linux:local-qa
npm run package:win:local-qa
```

## 来源与许可证

Kim 改造自 [GooeyPi](https://github.com/am-will/gooey-pi)，以 [MIT License](LICENSE) 发布，保留原作者版权声明（Copyright (c) 2026 GooeyPi contributors）。随仓库附带的 Prime Agent 包见 `vendor/` 和[参考来源与授权说明](docs/参考来源与授权说明.md)。Pi、Prime Agent、ObjectStack 等名称归各自所有者，此处仅用于说明兼容性。
