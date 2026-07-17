# Fishbowl（鱼缸）

<p align="center">
  <img src="docs/assets/fishbowl-logo.png" width="220" alt="Fishbowl 鱼缸 Logo" />
</p>

<p align="center">
  <strong>面向开发者与编码 Agent 的本地优先工程记忆库。</strong><br />
  <a href="README.md">English</a> · <a href="docs/mcp-client-configuration.md">MCP 配置</a> · <a href="SECURITY.md">安全说明</a>
</p>

Fishbowl 将排障过程中的失败尝试、证据、根因、解决方案、验证记录与回归风险沉淀为可查询的本地图谱。它提供命令行工具、stdio MCP 服务和仅监听本机回环地址的 Trace Bench 浏览界面；默认不会修改已登记的业务仓库。

> Fishbowl 坚持本地优先：不要求账号、不依赖云同步、不采集遥测，也不需要托管服务。

## 能解决什么问题

- **保留失败尝试**：避免人或 Agent 反复走已经证明无效的路径。
- **区分事实与结论**：尝试、根因、方案、验证各自独立，候选结论不会被误当作已验证事实。
- **跨工作树复用经验**：通过项目主路径和 worktree 别名把同一项目知识汇聚起来。
- **本地可控**：使用 SQLite 保存；浏览界面只绑定 `127.0.0.1`；MCP 使用本机 stdio。
- **可审查、可导出**：保存追加式项目事件、受限且脱敏的图谱文本，并支持可移植图谱导入导出。

## 主要组件

| 组件 | 用途 |
| --- | --- |
| `fishbowl` CLI | 登记项目、查询上下文、记录案例、导入导出图谱、检查数据库完整性。 |
| 常驻守护进程 | 复用本地 Node 进程、SQLite 连接、缓存与 Trace Bench 服务。 |
| MCP stdio 服务 | 让兼容的编码 Agent 查询既有工程知识并写入简洁检查点。 |
| Trace Bench | 只读的本地浏览界面，用于检查图谱与项目活动。 |
| 磁盘观察 | 只记录可再生构建产物的受限元数据，不会自动删除任何文件。 |

## 安装

### Windows（PowerShell）

先安装 Node.js 22 或更新版本以及 Git，然后执行：

```powershell
git clone https://github.com/nimocat/fishbowl.git
Set-Location fishbowl
npm install
npm run build
npm link

fishbowl daemon install
fishbowl daemon status
```

Windows 守护进程仅注册在当前用户的启动项中，不需要管理员权限。默认数据目录为 `%LOCALAPPDATA%\Fishbowl`。

### macOS / Linux

```bash
git clone https://github.com/nimocat/fishbowl.git
cd fishbowl
npm install
npm run build
npm link

fishbowl daemon install
fishbowl daemon status
```

不想执行 `npm link` 时，可以用以下方式直接运行：

```bash
node /absolute/path/to/fishbowl/dist/cli/main.js project list
```

## 快速开始

在需要保存工程知识的项目根目录执行：

```bash
fishbowl project register --root "$PWD" --name "我的项目" --description "本地工程知识"
fishbowl project list
```

复制返回的项目 ID 后，就可以查询历史经验或写入简洁检查点：

```bash
fishbowl query --project "<project-id>" "导出失败"
fishbowl checkpoint --project "<project-id>" --task "修复导出失败" --outcome succeeded --summary "将组合处理移出主线程，并完成聚焦测试验证"
```

## 从旧版迁移

首次运行时，Fishbowl 会将旧版本的本地知识库整体迁移到新的 Fishbowl 数据目录，包含数据库、WAL 侧文件、令牌和原始日志。请在升级后执行一次：

```bash
fishbowl daemon install
```

这会用 Fishbowl 的守护进程注册替换旧启动项。已有图谱导出也保持兼容：Fishbowl 会继续导入旧格式，但新导出统一使用 `fishbowl` 格式标识。

## MCP 接入

启动 MCP stdio 服务：

```bash
node /absolute/path/to/fishbowl/dist/cli/main.js mcp --stdio
```

不要在该命令外包裹会向 stdout 输出横幅的命令，否则会破坏 MCP 协议。各客户端配置见 [MCP 配置说明](docs/mcp-client-configuration.md)。

### 一段提示词即可交给 Agent

将 [Agent 快捷启动提示](docs/agent-bootstrap-prompt.md) 直接复制给编码 Agent。它会完成 Fishbowl 安装、当前仓库登记、任务开始前的历史查询，以及结束时仅保存脱敏的工程检查点。

## 隐私与安全

- 所有项目知识保存在本地 SQLite。
- Trace Bench HTTP 服务只绑定 `127.0.0.1`。
- 持久化图谱文本会递归脱敏并限制大小。
- 原始命令日志可能包含敏感输出，仅保存在本机，受保留策略限制，且不会进入图谱导出文件。
- Fishbowl 是本地单用户工具，不是云端协作服务。

在公开任何数据目录或原始日志前，请先阅读 [SECURITY.md](SECURITY.md)。

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。项目采用 [MIT License](LICENSE)。
