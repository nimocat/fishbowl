# Fishbowl（鱼缸）

<p align="center">
  <img src="docs/assets/fishbowl-logo.png" width="196" alt="Fishbowl 鱼缸 Logo" />
</p>

<h2 align="center">为开发者与编码 Agent 准备的本地优先工程记忆库。</h2>

<p align="center">
  将失败尝试、决策、证据与验证沉淀为可查询的项目知识。<br />
  下一次开始工作前先查询，任务结束后只保留值得留下的事实。
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="docs/agent-bootstrap-prompt.md">Agent 快捷启动</a> ·
  <a href="docs/mcp-client-configuration.md">MCP 配置</a> ·
  <a href="SECURITY.md">安全说明</a> ·
  <a href="LICENSE">MIT 许可证</a>
</p>

---

## 为什么需要 Fishbowl

工程团队经常重复解决同一个问题：关键上下文散落在终端滚屏、问题记录和人的记忆里。Fishbowl 为每个项目保存可审查的工程记录，但不会把每条笔记伪装成已验证的事实。

| 保留 | 避免 |
| --- | --- |
| 失败尝试、支持证据、决策、修复与验证 | 原始聊天记录、凭证、完整日志或云端依赖 |
| 跨仓库和 worktree 的同一份工程知识 | 反复从零开始做昂贵排查 |
| 本地 SQLite、仅回环地址访问和 stdio MCP | 无法审查的自动“记忆” |

## 包含什么

- **`fishbowl` 命令行**：登记项目、查询上下文、记录案例、导入导出图谱、检查数据库完整性。
- **常驻本地守护进程**：复用一个带认证的 SQLite 连接与本地缓存。
- **stdio MCP 服务**：让兼容的编码 Agent 查询和写入工程知识。
- **Trace Bench**：只读本地浏览界面，用于查看项目活动。
- **worktree 别名**：并行分支仍然会汇聚到正确的项目知识。
- **磁盘观察**：只记录可再生构建产物的受限元数据，绝不自动删除文件。

## 快速开始

### macOS / Linux

```bash
git clone https://github.com/nimocat/fishbowl.git
cd fishbowl
npm install
npm run build
npm link

fishbowl daemon install
fishbowl daemon doctor
```

### Windows（PowerShell）

先安装 Node.js 22 或更新版本、Git、带 MSVC 工具链的 Rust stable，以及 Visual Studio Build Tools 的 C++ 工作负载，再执行：

```powershell
git clone https://github.com/nimocat/fishbowl.git
Set-Location fishbowl
npm install
npm run build
npm link

fishbowl daemon install
fishbowl daemon doctor
```

守护进程仅注册在当前用户下，不需要管理员权限。

### CLI 帮助与诊断

现在直接运行 `fishbowl` 会显示完整命令概览，不会启动 daemon，也不会再报
`Missing command`。以下帮助写法等价：

```bash
fishbowl help
fishbowl help project register
fishbowl project register --help
fishbowl --version
```

命令错误或缺少选项时，CLI 会继续返回可供程序解析的 JSON，并在原始
`message` 之外提供当前命令的 `usage`、可执行的 `hint`，以及准确的 `help`
命令。连接问题可运行 `fishbowl daemon doctor`，数据库只读检查可运行
`fishbowl integrity`。这些 CLI 命令供人类操作；编码 Agent 仍然只直接调用
Fishbowl MCP 工具。

### 登记项目

```bash
cd /absolute/path/to/your-project
fishbowl project register \
  --root "$PWD" \
  --name "我的项目" \
  --description "本地工程知识"
```

复制命令返回的项目 ID，然后进入日常循环：

```bash
fishbowl query --project "<project-id>" "导出失败"
fishbowl checkpoint \
  --project "<project-id>" \
  --task "修复导出失败" \
  --outcome succeeded \
  --summary "将组合处理移出主线程，并完成聚焦验证。"
```

## 让 Codex 或其他 Agent 使用 Fishbowl

先一次性配置用户级 stdio MCP 服务，再把 [MCP Agent 会话提示](docs/agent-bootstrap-prompt.md) 原样复制给编码 Agent。它会要求 Agent：

1. 直接调用 Fishbowl MCP 工具完成项目解析和预检。
2. 开始实质工作前查询相关历史。
3. 任务结束时通过 MCP 写入简洁、脱敏的检查点。
4. MCP 不可用时上报问题，不降级到 CLI。

MCP 客户端会根据服务配置启动这个持久化 stdio 桥接进程：

```bash
node /absolute/path/to/fishbowl/dist/cli/main.js mcp --stdio
```

可直接复制的客户端配置见 [MCP 配置说明](docs/mcp-client-configuration.md)。Codex 不应自行启动该命令，也不应调用 CLI 查询或写入；进程及其 stdout 协议帧由配置好的 MCP Host 管理。

## 工程工作循环

```text
预检 -> 查询历史知识 -> 实施 -> 验证 -> 写入脱敏检查点
```

Fishbowl 会区分不同记录，让图谱在复盘时仍然可信：

| 记录 | 含义 |
| --- | --- |
| Problem | 正在排查的任务、故障或决策 |
| Attempt | 某个具体方案及其观察到的结果 |
| Root Cause | 有证据支持的因果解释，而非猜测 |
| Solution | 采用的改动、适用范围与限制 |
| Verification | 支持结论的构建、测试、度量或人工评审 |

## 本地优先的架构

```text
CLI / MCP 客户端
       |
       v
Fishbowl 守护进程（当前用户、带认证）
       |
       +-- SQLite 知识库
       +-- 受限的原始命令日志引用
       +-- 仅 127.0.0.1 可访问的 Trace Bench
```

- 不要求账号、托管服务、云同步或遥测。
- 持久化图谱文本会递归脱敏并限制大小。
- 原始命令日志只保存在本机，受保留策略限制，且不会进入图谱导出。
- 仅登记项目不会修改项目内任何文件。

公开任何数据目录或原始日志前，请先阅读 [SECURITY.md](SECURITY.md)。

## 从 Engineering Knowledge Graph 升级

首次启动 Fishbowl 会将旧版本的本地数据库、WAL 文件、令牌和原始日志迁移到新的 Fishbowl 数据目录。历史图谱导出仍可导入；新的导出统一使用 `fishbowl` 格式标识。

升级后执行一次：

```bash
fishbowl daemon install
```

### Windows 更新（PowerShell）

安装本次版本后，日常更新只需由你在 PowerShell 中执行：

```powershell
fishbowl update
```

该命令只接受干净的 Fishbowl 官方 `origin/main`：它执行 fast-forward、`npm ci`、生产构建、`npm link`、当前用户 daemon 重装、启动与健康检查。它不会使用 `reset --hard`、覆盖本地修改或切换分支。`%LOCALAPPDATA%\Fishbowl` 下的知识数据会保留。部署失败时会尽力恢复旧的 CLI 和 daemon；再次执行同一命令会继续修复尚未完成的部署，而不是因为源码已经最新就跳过。

如果旧版本返回 `Unknown command: update`，需要在最初克隆的 Fishbowl 仓库中手动引导一次。若 `git status --short` 显示你自己的修改，请先提交或暂存：

从源码构建需要 Node.js 22 或更新版本、Git、带 MSVC 工具链的 Rust stable，以及 Visual Studio Build Tools 的 C++ 工作负载。

```powershell
Set-Location C:\path\to\fishbowl
git status --short
git pull --ff-only origin main
npm ci
npm run build
npm link

fishbowl daemon install
```

每次更新成功后请完全退出并重启 MCP 客户端（例如 Codex 或 Claude Desktop），让它重新启动更新后的 stdio MCP 进程。Agent 不需要、也不应该自行查找或运行 `fishbowl update` 或其他 Fishbowl CLI。

如果 MCP 客户端保存的是仓库内 `dist\cli\main.js` 的绝对路径，只要仍使用同一个克隆目录就不必修改配置；路径变化时按 [Windows MCP 路径配置](docs/mcp-client-configuration.md#windows-paths) 更新一次。

## 参与开发

```bash
npm install
npm run typecheck
npm test
cargo test --workspace
npm run build
```

贡献流程参见 [CONTRIBUTING.md](CONTRIBUTING.md)，架构、协议、迁移和恢复资料见 [docs/](docs/)。
