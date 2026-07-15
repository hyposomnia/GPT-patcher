# GPT-patcher

面向 macOS ChatGPT Desktop 的本地补丁与自动维护工具。它修改的是 ChatGPT 应用内置的
Codex app-server，不会替换全局 `codex` CLI。

## 修复内容

1. **运行中追问消失**

   将 Desktop 前端历史重建参数从
   `preserveServerUserMessages: false` 改为 `true`。运行中的 steering follow-up 在
   `thread/read` hydration、打开/关闭 subagent 面板或重建主任务历史后仍显示，并继续由现有
   client-id/content 去重逻辑避免重复气泡。

2. **自定义 API-key endpoint 缺少内置工具**

   对声明 `requires_openai_auth = true` 的自定义 provider：

   - API-key 认证不再强制隐藏 image generation；
   - web-search extension 可用；
   - 非官方 provider 不使用 Responses Lite，改走标准 Responses `tools[]`；
   - 仍保留 provider capability、feature flag 和模型 image modality 检查。

3. **ChatGPT 更新后自动重打补丁**

   安装后创建 `com.local.chatgpt-desktop-fixer` LaunchAgent。它每五分钟及 ChatGPT bundle
   变化时检查一次。遇到新版本会读取应用内置 `codex-cli` 版本、拉取对应的官方
   `openai/codex` `rust-v<version>` tag、应用本仓库补丁并重新编译 app-server。

## 环境要求

- Apple Silicon macOS；
- `/Applications/ChatGPT.app`，或通过 `CHATGPT_APP_PATH` 指定其他路径；
- Node.js 20+；
- Git、Xcode Command Line Tools；
- rustup/Cargo。构建器会安装目标 tag 的 `rust-toolchain.toml` 所指定工具链；
- 足够的源码与 Rust target 空间。首次构建可能占用数 GB。

仓库不提交预编译的 300+ MB app-server。`bin/`、`.build/` 和 `dist/` 均被忽略。

## 只编译

```sh
./build.sh
```

默认读取当前 ChatGPT bundle 中的版本，产物位于：

```text
.build/bin/codex-<version>
```

也可以指定版本或构建目录：

```sh
CODEX_VERSION=0.144.2 GPT_PATCHER_BUILD_DIR=/path/to/build ./build.sh
```

构建器使用官方 tag 和 Cargo.lock，从源码执行 release build：

```text
cargo build --release -p codex-cli --bin codex
```

它会验证版本、strip 二进制并检查/补充 ad-hoc code signature。为了避免与 app-server
无关的 `realtime-webrtc/libyuv` 下载，构建器仅在确认其他 Cargo manifest 未引用该
workspace member 后将其从本次 package-only build 中排除。

## 安装

先退出 ChatGPT，再运行：

```sh
./install.sh
```

首次安装若没有缓存二进制，会自动编译。完成后重新打开 ChatGPT。

运行状态、编译缓存、备份和日志位于：

```text
~/Library/Application Support/ChatGPT Desktop Fixer
```

常用命令：

```sh
npm run status
node fixer.mjs apply
node fixer.mjs restore
./uninstall.sh
```

`restore` 恢复当前 ChatGPT build 的前端锚点和备份 app-server；`uninstall.sh` 会先恢复，
再卸载 LaunchAgent。

## 检查

```sh
npm test
```

若已有对应官方 Codex 源码，可同时验证 patch 是否能干净应用：

```sh
CODEX_SOURCE_DIR=/path/to/codex npm test
```

当前后端补丁包含单元测试与 request-level regression test：

- `hosted_web_search_and_standalone_image_generation_follow_runtime_gates`
- `api_key_custom_provider_uses_hosted_tools_in_standard_responses`

## 安全策略

- 前端只做等长、精确锚点替换，并验证原锚点/新锚点数量；未知版本不做模糊修改。
- 后端 patch 必须通过 `git apply --check`；不匹配时停止。
- 更新期间会再次核对 ChatGPT build 与 bundled app-server 版本，防止编译过程中应用被更新。
- 每个 ChatGPT build 的原始 app-server 只备份一次。
- 修改应用资源会改变官方 bundle 内容；ChatGPT 更新通常会覆盖这些修改，LaunchAgent 随后重新应用。
