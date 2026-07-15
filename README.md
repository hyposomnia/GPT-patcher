# GPT-patcher

![Version](https://img.shields.io/badge/version-v0.1.0-blue)
![Platform](https://img.shields.io/badge/platform-macOS%20Apple%20Silicon-black)
![License](https://img.shields.io/badge/license-MIT-green)

面向 macOS ChatGPT Desktop 的本地补丁和自动维护工具。它修复 Desktop 客户端中的运行中
追问历史问题，并为使用 API key 的自定义 OpenAI-compatible provider 恢复受运行时能力
控制的 web search 和 image generation 工具。

> [!IMPORTANT]
> 本项目会修改 `/Applications/ChatGPT.app` 内的 `app.asar` 和 bundled app-server。
> 安装、恢复或卸载前应先完全退出 ChatGPT。ChatGPT 官方更新通常会覆盖这些修改，安装的
> LaunchAgent 会在兼容性校验通过后自动重新应用。

## 项目边界

- 只处理 macOS ChatGPT Desktop app bundle；
- 不安装、不替换也不修改全局 `codex` CLI；
- 不提交预编译的 300+ MB app-server；
- 不对未知客户端版本做模糊搜索或猜测性修改。

官方源码中的 Cargo package 名仍为 `codex-cli`，应用内置文件也仍叫 `codex`。这些是上游
内部命名：本项目只把构建产物写入 ChatGPT Desktop bundle、项目 `.build/` 目录和专用
维护缓存，不会写入 `PATH`、`~/.local/bin` 或其他全局 CLI 位置。

## 修复内容

### 1. 保留运行中的 steering follow-up

Desktop 前端重建任务历史时，将：

```text
preserveServerUserMessages: false
```

等长替换为：

```text
preserveServerUserMessages: true
```

运行中的追问在 `thread/read` hydration、打开或关闭 subagent 面板以及任务历史重建后仍然
可见。现有的 client-id/content 去重逻辑继续负责避免重复气泡。

### 2. 恢复自定义 API-key provider 的 hosted tools

对于声明 `requires_openai_auth = true` 的自定义 provider：

- API-key 认证不再无条件隐藏 image generation；
- web-search extension 可以按运行时能力启用；
- 非官方 provider 使用标准 Responses `tools[]`，不强制走 Responses Lite；
- provider capability、feature flag 和模型 image modality 检查仍然保留。

### 3. ChatGPT 更新后自动维护

安装脚本会创建 `com.local.chatgpt-desktop-fixer` LaunchAgent。它每五分钟以及 ChatGPT
bundle 发生变化时执行检查：

1. 读取 Desktop 内置 app-server 版本；
2. 拉取 `openai/codex` 对应的 `rust-v<version>` tag；
3. 使用官方 `Cargo.lock` 并严格校验补丁；
4. 编译、strip、签名并验证新的 Desktop app-server；
5. 重新应用前端和后端补丁。

任何版本、锚点或 patch 校验失败都会停止修改并写入日志。

## 已验证版本

`v0.1.0` 已在以下组合完成编译、安装和重启验证：

| 组件 | 版本 |
| --- | --- |
| ChatGPT Desktop | `26.707.72221` |
| ChatGPT build | `5307` |
| Bundled app-server | `0.144.2` |
| 架构 | Apple Silicon (`arm64`) |

后续 ChatGPT 版本只有在前端精确锚点唯一且后端 patch 能干净应用时才会被修改。

## 环境要求

- Apple Silicon macOS；
- `/Applications/ChatGPT.app`，或通过 `CHATGPT_APP_PATH` 指定其他位置；
- Node.js 20 或更高版本；
- Git；
- Xcode Command Line Tools；
- rustup/Cargo；
- 数 GB 可用空间用于首次源码和 Rust release target。

构建器会安装目标 Codex tag 的 `rust-toolchain.toml` 所指定的 Rust 工具链。首次完整构建
通常需要下载接近 1 GB 的依赖，并产生数 GB 的临时 target；同版本增量构建会快很多。

## 快速开始

克隆仓库并运行检查：

```sh
git clone https://github.com/hyposomnia/GPT-patcher.git
cd GPT-patcher
npm test
```

完全退出 ChatGPT，然后安装：

```sh
./install.sh
```

首次安装如果没有可用缓存，会自动完成官方源码拉取和 release 构建。完成后重新打开
ChatGPT：

```sh
open -a ChatGPT
```

检查状态：

```sh
npm run status
```

成功状态应包含：

- `frontendOriginalAnchors: 0`；
- `frontendPatchedAnchors: 1`；
- `launchAgentInstalled: true`；
- `state.frontendStatus: "patched"`。

## 只编译 Desktop app-server

```sh
./build.sh
```

默认读取当前 ChatGPT bundle 中的 app-server 版本，产物位于：

```text
.build/bin/chatgpt-app-server-<version>
```

安装器会优先复用这个目录中的已编译产物，避免重复构建。

也可以指定版本或构建目录：

```sh
CHATGPT_APP_SERVER_VERSION=0.144.2 \
GPT_PATCHER_BUILD_DIR=/path/to/build \
./build.sh
```

`CODEX_VERSION` 作为旧版兼容变量保留。上游内部的 release build 命令为：

```text
cargo build --release -p codex-cli --bin codex
```

构建完成后会验证版本，strip 二进制，并检查或补充 ad-hoc code signature。为了避免与
Desktop app-server 无关的 `realtime-webrtc/libyuv` 下载，构建器只会在确认其他 Cargo
manifest 没有引用该 workspace member 后，将它从本次 package-only build 中排除。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm test` | 运行脚本语法、补丁标记和仓库静态检查 |
| `npm run build` | 编译当前 Desktop 版本的 patched app-server |
| `npm run install` | 安装补丁和自动维护 LaunchAgent |
| `npm run status` | 查看当前 ChatGPT、补丁和 LaunchAgent 状态 |
| `node fixer.mjs apply` | 立即执行一次维护 |
| `npm run restore` | 恢复当前 ChatGPT build 的原始文件 |
| `npm run uninstall` | 恢复文件并卸载 LaunchAgent |

恢复或卸载前同样应先完全退出 ChatGPT，完成后再重新打开。

## 配置变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CHATGPT_APP_PATH` | `/Applications/ChatGPT.app` | 自定义 ChatGPT app 路径 |
| `CHATGPT_APP_SERVER_VERSION` | 从 app bundle 读取 | 指定要构建的 app-server 版本 |
| `GPT_PATCHER_BUILD_DIR` | `<repo>/.build` | 自定义源码、target 和产物目录 |
| `CHATGPT_FIXER_STATE_DIR` | `~/Library/Application Support/ChatGPT Desktop Fixer` | 自定义维护状态目录 |
| `CHATGPT_FIXER_NODE_PATH` | 自动检测 | 指定 LaunchAgent 使用的 Node.js |
| `CODEX_SOURCE_DIR` | 空 | 测试时额外验证 patch 能否应用到已有 Codex 源码 |

## 状态、备份和日志

默认维护目录：

```text
~/Library/Application Support/ChatGPT Desktop Fixer
```

其中包含：

```text
backups/<chatgpt-build>/codex.original  原始 app-server 备份
bin/                                    编译缓存
build/                                  官方 Codex 源码和 Rust target
program/                                LaunchAgent 使用的维护脚本
maintain.log                            自动维护日志
state.json                              当前补丁状态
```

每个 ChatGPT build 的原始 app-server 只备份一次。前端修改是等长替换，因此可以直接使用
精确锚点恢复。

## 安全设计

- 前端只进行等长、精确锚点替换，并严格验证原始和补丁锚点数量；
- 后端 patch 必须通过 `git apply --check`；
- 使用官方版本 tag 和 `Cargo.lock` 从源码执行 release build；
- 安装前后验证 app-server 的版本与 SHA-256；
- 更新构建期间再次检查 ChatGPT build 和 bundled app-server 版本，防止竞态覆盖；
- 临时文件完成验证后再原子替换应用资源；
- 未知版本或不匹配结构会失败关闭，不做模糊修改。

## 已知限制与风险

- 修改 app bundle 会使官方签名的 bundle 内容发生变化；
- ChatGPT 更新会覆盖补丁，重新应用可能需要重新编译；
- 上游前端压缩结构或 Rust 源码变化后，补丁可能停止兼容；
- 首次 release 构建耗时较长并占用较多磁盘空间；
- 本项目只针对 Apple Silicon macOS，未测试 Intel Mac、Windows 或 Linux。

如果 ChatGPT 无法启动，先保持应用退出并运行：

```sh
npm run restore
```

然后重新打开 ChatGPT，并查看 `maintain.log`。请勿在未知版本上手工放宽锚点或跳过
`git apply --check`。

## 开发与测试

```sh
npm test
```

若已有对应版本的官方 Codex 源码，可同时验证 patch：

```sh
CODEX_SOURCE_DIR=/path/to/codex npm test
```

当前后端 patch 包含以下上游单元和 request-level regression test：

- `hosted_web_search_and_standalone_image_generation_follow_runtime_gates`；
- `api_key_custom_provider_uses_hosted_tools_in_standard_responses`。

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按照
[SECURITY.md](SECURITY.md) 私下报告。

## License

本项目使用 [MIT License](LICENSE)。

本项目是独立的社区工具，与 OpenAI 没有隶属、赞助或官方支持关系。ChatGPT、OpenAI 和
Codex 是其各自所有者的商标。
