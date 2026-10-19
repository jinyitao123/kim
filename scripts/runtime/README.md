# 桌面内置运行时

本目录只准备与验证 `resources/runtime`。桌面入口、用户配置隔离与 Electron 打包接线仍由原有主进程和发布脚本负责。

```sh
node scripts/runtime/prepare.mjs --platform=darwin --arch=arm64
node scripts/runtime/verify.mjs --platform=darwin --arch=arm64 --execute
node --test tests/runtime/runtime.test.mjs
```

产物仅写入已忽略的 `.build/runtime/<platform>-<arch>`。支持的目标由 `runtime-lock.json` 列出，非本机目标可以准备并检查文件，执行验证必须在对应的原生运行器进行。

- `runtime-lock.json` 固定 Node 官方校验清单及各平台分发包摘要、本地 vendor 摘要、npm 闭包锁摘要。
- `package-lock.json` 固定完整依赖及 SRI。Pi 与 Prime 的依赖覆盖范围分开，不能套用桌面根包针对 Prime 的全局覆盖。
- 准备过程使用已审核的 vendor npm，禁用安装脚本；不读取用户 npm 配置，不使用全局 Pi、Prime 或 npm。包内同时提供 npm 与 npx，插件安装仍由产品的私有配置环境控制。
- Node 分发包下载后必须匹配官方摘要。离线构建可通过 `--node-archive FILE` 提供相同字节的本地分发包，仍须匹配固定摘要。
- Loom按 `runtime-lock.json` 锁定的提交与Go版本从源码编译（`CGO_ENABLED=0`、`-trimpath`），也可用 `--loom-binary` 放入已编好的程序。源码来自 `--loom-source` 或 `LOOM_SOURCE_DIR` 指向的、正处于锁定提交且无改动的检出；都未提供时下载锁定提交的源码包。Loom仓库现为私有：设置 `LOOM_READ_TOKEN`（只读令牌）时经GitHub接口下载，令牌只放在请求头、不进命令行；发行流水线仅在打包步骤的环境变量中提供仓库密钥 `LOOM_READ_TOKEN`，并按锁定版本安装Go。CI打包没有密钥，设 `GOOEYPI_RUNTIME_WITHOUT_LOOM=1`（或 `--without-loom`）准备不含Loom的运行环境，清单记 `loomOmitted`，桌面此时不显示Loom；公开发行拒绝该设置。
- `runtime-manifest.json` 记录完整文件清单。打包后使用 `verify.mjs --root <resources/runtime> --expected-manifest <准备产物/runtime-manifest.json>`，同时检查嵌入清单与外部准备记录一致。准备与校验默认要求包含Loom，复用旧缓存也不能跳过；仅CI或本地QA校验省略Loom的产物时，同样显式传 `--without-loom` 或设置 `GOOEYPI_RUNTIME_WITHOUT_LOOM=1`。
- `--execute` 检查本机的 Node、Pi、Prime、npm 版本、Pi 的离线 RPC 目录以及产品实际使用的 Prime 公开 SDK 目录。Prime 的 RPC 会启动 daemon，不属于本探针的目录验证。探针保留 HOME，用独立空配置目录和私有 ADC 路径运行，并拦截共享配置访问、网络连接及子进程。验证器只放行当次新建空配置目录、已核对运行时和探针源码；工作树在`.codex`内也不把这些自有文件当共享账号配置。它是 Node API 层的验证仪器，不是操作系统沙箱，也不代表模型请求已验证。

启动器只调用同目录 Node；Windows 应用使用既有的 shim 转换机制直接运行对应 JS 入口。准备及探针不会改 Electron fuses、签名或系统安全设置，也不安装可选的 Python 内核与搜索工具。

升级时一起审查机器锁、npm 清单/闭包锁及 vendor 来源。先完成原生准备与执行验证，再由既有发布流程检查实际包内产物；不得只更新版本字符串或跳过摘要失败。
