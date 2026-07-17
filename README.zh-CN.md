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

先安装 Node.js 22 或更新版本以及 Git，再执行：

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

## 一段提示词交给 Agent

把 [Agent 快捷启动提示](docs/agent-bootstrap-prompt.md) 原样复制给编码 Agent。它会要求 Agent：

1. 在本机安装 Fishbowl 并启动守护进程。
2. 登记或解析当前仓库。
3. 开始实质工作前查询相关历史。
4. 任务结束时写入简洁、脱敏的检查点。

需要持久化 MCP 接入时，启动 stdio 服务：

```bash
node /absolute/path/to/fishbowl/dist/cli/main.js mcp --stdio
```

可直接复制的客户端配置见 [MCP 配置说明](docs/mcp-client-configuration.md)。该进程通过 stdout 输出协议帧，不要外包会向 stdout 打印横幅的命令。

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

## 参与开发

```bash
npm install
npm run typecheck
npm test
cargo test --workspace
npm run build
```

贡献流程参见 [CONTRIBUTING.md](CONTRIBUTING.md)，架构、协议、迁移和恢复资料见 [docs/](docs/)。
