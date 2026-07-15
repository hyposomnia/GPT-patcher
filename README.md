# GPT-patcher

![Version](https://img.shields.io/badge/version-v0.2.0-blue)
![Platform](https://img.shields.io/badge/platform-macOS%20Apple%20Silicon-black)
![License](https://img.shields.io/badge/license-MIT-green)

面向 macOS ChatGPT Desktop 的轻量本地补丁和自动维护工具。它修复 Desktop 客户端中运行中
追问的历史显示问题，并为使用 API key 的自定义 OpenAI-compatible provider 恢复 web search
和 image generation。

从 `v0.2.0` 开始，默认安装不再克隆 Codex 源码、安装 Rust 或编译 300+ MB 的 app-server。
后端补丁由一个小于 4 KiB 的启动 shim 和一份模型目录完成。

> [!IMPORTANT]
> 本项目会修改 `/Applications/ChatGPT.app` 内的 `app.asar` 和 bundled app-server 入口。
> 安装、恢复或卸载前应先完全退出 ChatGPT。官方更新通常会覆盖修改，LaunchAgent 会在
> 严格校验通过后自动重新应用。

## 轻量方案如何工作

ChatGPT Desktop 内置的原版 app-server 已经包含所需能力，只是对自定义 provider 有几层
运行时门控。GPT-patcher 不再重编译它，而是：

1. 将原版 app-server 按 ChatGPT build 备份到专用状态目录；
2. 在 app bundle 中放置一个约 1 KiB 的 zsh 启动 shim；
3. shim 从现有 `$CODEX_HOME/auth.json` 读取 API key，仅注入到子进程环境，不复制到新文件；
4. shim 使用临时 `-c` 覆盖将当前自定义 provider 暴露为 actor-authorized OpenAI-compatible
   provider；
5. 从匹配的官方 `openai/codex` tag 获取小型 `models.json`，生成
   `use_responses_lite = false` 的本地目录，让自定义 endpoint 收到标准 Responses `tools[]`。

原始 `config.toml` 和 `auth.json` 都不会被修改。启动时会额外向自定义 endpoint 发送：

```text
x-openai-actor-authorization: gpt-patcher
```

多数 OpenAI-compatible 服务会忽略未知请求头；若你的网关拒绝该头，image generation 的
原版运行时门控无法通过。

## 修复内容

### 保留运行中的 steering follow-up

Desktop 前端重建任务历史时，将：

```text
preserveServerUserMessages: false
```

等长替换为：

```text
preserveServerUserMessages: true
```

运行中的追问在 `thread/read` hydration、打开或关闭 subagent 面板以及任务历史重建后仍然
可见。现有的 client-id/content 去重逻辑继续避免重复气泡。

### 恢复自定义 provider 的工具

轻量 shim 会让原版 app-server：

- 使用标准 Responses，而不是 Responses Lite；
- 在 `tools[]` 中提供 hosted web search；
- 在普通模式或 code mode 中提供 image generation；
- 继续保留 provider capability、feature flag 和模型 image modality 检查。

### ChatGPT 更新后自动维护

安装脚本创建 `com.local.chatgpt-desktop-fixer` LaunchAgent。它每五分钟以及 ChatGPT bundle
或 `config.toml` 变化时执行检查：

1. 识别 ChatGPT build 和原版 app-server 版本；
2. 备份并验证原版 app-server；
3. 下载对应官方 tag 中的一份 `models.json`，通常只有几十到几百 KiB；
4. 生成标准 Responses 模型目录和新的轻量 shim；
5. 重新应用前端等长补丁。

任何版本、目录、哈希或前端锚点校验失败都会停止修改并写入日志。

## 已验证版本

| 组件 | 版本 |
| --- | --- |
| ChatGPT Desktop | `26.707.72221` |
| ChatGPT build | `5307` |
| Bundled app-server | `0.144.2` |
| 架构 | Apple Silicon (`arm64`) |

在原版 `0.144.2` 上进行的 request-level probe 已确认：

- Authorization 仍使用原有 API key；
- 标准 Responses 请求不带 Responses Lite header；
- `web_search` 出现在 `tools[]`；
- `image_gen__imagegen` 出现在 code-mode 工具集中。

## 环境要求

- Apple Silicon macOS；
- `/Applications/ChatGPT.app`，或通过 `CHATGPT_APP_PATH` 指定其他位置；
- Node.js 20 或更高版本；
- 当前自定义 provider 的 API key 已保存在 `$CODEX_HOME/auth.json`；
- 网络可访问 GitHub Raw，以便新 app-server 版本首次获取官方模型目录。

默认安装不需要 Rust、Cargo、Xcode Command Line Tools 或 Codex 源码。通过 Git 克隆仓库时
自然仍需要 Git，也可以直接下载源码归档。

## 快速开始

```sh
git clone https://github.com/hyposomnia/GPT-patcher.git
cd GPT-patcher
npm test
```

完全退出 ChatGPT，然后安装：

```sh
./install.sh
```

重新打开 ChatGPT：

```sh
open -a ChatGPT
```

检查状态：

```sh
npm run status
```

成功状态应包含：

- `backendIsLightweightShim: true`；
- `frontendOriginalAnchors: 0`；
- `frontendPatchedAnchors: 1`；
- `state.backendMode: "lightweight-shim"`；
- `launchAgentInstalled: true`。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm test` | 运行语法、静态检查和隔离的轻量 shim 集成测试 |
| `npm run install` | 安装轻量补丁和自动维护 LaunchAgent |
| `npm run status` | 查看 ChatGPT、shim、前端补丁和 LaunchAgent 状态 |
| `node fixer.mjs apply` | 立即执行一次维护 |
| `npm run restore` | 恢复当前 ChatGPT build 的原始文件 |
| `npm run uninstall` | 恢复文件并卸载 LaunchAgent |
| `npm run cleanup` | 删除旧版在专用状态目录留下的 Rust 构建和 patched binary 缓存 |
| `npm run legacy-build` | 开发者显式使用旧版源码编译方案 |

恢复或卸载前同样应先完全退出 ChatGPT。

若仓库本地还保留旧版 `.build/`，可显式一并清理：

```sh
GPT_PATCHER_CLEAN_LOCAL_BUILD=1 npm run cleanup
```

该命令不会卸载全局 Rust/rustup，也不会删除 ChatGPT 原版备份。

## 配置变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CHATGPT_APP_PATH` | `/Applications/ChatGPT.app` | 自定义 ChatGPT app 路径 |
| `CHATGPT_FIXER_STATE_DIR` | `~/Library/Application Support/ChatGPT Desktop Fixer` | 专用维护状态目录 |
| `CHATGPT_FIXER_NODE_PATH` | 自动检测 | LaunchAgent 使用的 Node.js |
| `CODEX_HOME` | `~/.codex` | Desktop 使用的 Codex 配置与认证目录 |
| `GPT_PATCHER_MODEL_PROVIDER` | 读取根级 `model_provider` | 显式指定要覆盖的自定义 provider id |
| `GPT_PATCHER_MODEL_CATALOG_SOURCE` | 自动查找或下载 | 使用已有官方 `models.json`，适合离线安装和测试 |
| `GPT_PATCHER_API_KEY` | 从 `auth.json` 运行时读取 | 不使用 `auth.json` 时显式提供 shim 的 API key |
| `GPT_PATCHER_CLEAN_LOCAL_BUILD` | `0` | 设为 `1` 时 cleanup 同时删除仓库 `.build/` |
| `CODEX_SOURCE_DIR` | 空 | 测试 legacy Rust patch 是否仍能应用到已有源码 |

provider id 当前只接受字母、数字、下划线和连字符。原配置表必须存在，例如：

```toml
model_provider = "custom"

[model_providers.custom]
name = "My endpoint"
base_url = "https://example.com/v1"
wire_api = "responses"
requires_openai_auth = true
```

## 状态、备份和日志

默认维护目录：

```text
~/Library/Application Support/ChatGPT Desktop Fixer
```

轻量模式使用：

```text
backups/<chatgpt-build>/codex.original            原版 app-server，也是 shim 的执行目标
catalogs/models-<version>-standard-responses.json 小型模型目录
program/fixer.mjs                                 LaunchAgent 维护程序
maintain.log                                      自动维护日志
state.json                                        当前补丁状态
```

原版 app-server 备份约 200–300 MB，但它替代了 app bundle 内原来的同一文件，整体不会再额外
保留一份 300+ MB patched binary，也不会产生数 GB Rust `target/`。

## 安全设计

- 前端只进行等长、唯一锚点替换，并严格验证修改前后数量；
- shim 只执行按当前 ChatGPT build 保存和验证过的原版 app-server；
- API key 每次启动从现有 `auth.json` 读取到环境，不写入 shim、状态或模型目录；
- 模型目录只接受非空、slug 唯一的 JSON，并将所有 `use_responses_lite` 精确设为 `false`；
- 新版本目录只从匹配的官方 `openai/codex` `rust-v<version>` tag 获取；
- app、config 或 bundled backend 在维护过程中变化时会拒绝安装；
- 未知前端锚点和非托管 backend 会失败关闭。

## 已知限制与风险

- 修改 app bundle 会使官方签名的 bundle 内容发生变化；
- ChatGPT 更新会覆盖 shim，重新应用需要能获取匹配版本的官方模型目录；
- 轻量模式目前面向使用 `auth.json` API key 的自定义 Responses provider；
- actor authorization 请求头会发送到自定义 endpoint；
- 上游删除 `model_catalog_json`、改变 provider 门控或模型目录格式后，需要兼容性更新；
- 仅测试 Apple Silicon macOS，未测试 Intel Mac、Windows 或 Linux。

如果 ChatGPT 无法启动，保持应用退出并运行：

```sh
npm run restore
```

然后重新打开 ChatGPT，并查看 `maintain.log`。

## Legacy 源码构建

`build.sh`、`build-backend.mjs` 和 `patches/desktop-hosted-tools.patch` 仍保留，供研究上游变化、
验证行为差异或轻量门控失效时使用。它们不再由安装器或 LaunchAgent 自动调用。

```sh
npm run legacy-build
```

该命令仍需要 rustup/Cargo、官方 Codex 源码和数 GB 构建空间。普通用户无需运行。

## 开发与测试

```sh
npm test
```

隔离测试会创建一个假的 ChatGPT app bundle，验证 shim 安装、幂等、模型目录归一化和恢复，
不会修改 `/Applications/ChatGPT.app`。

若已有原版 app-server 和匹配的官方 `models.json`，可执行真实 request-level probe：

```sh
node scripts/probe-lightweight.mjs /path/to/codex.original /path/to/models.json
```

若还要验证 legacy Rust patch：

```sh
CODEX_SOURCE_DIR=/path/to/codex npm test
```

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按照
[SECURITY.md](SECURITY.md) 私下报告。

## License

本项目使用 [MIT License](LICENSE)。

本项目是独立的社区工具，与 OpenAI 没有隶属、赞助或官方支持关系。ChatGPT、OpenAI 和
Codex 是其各自所有者的商标。
