---
title: CLI 参考
description: 每一个 ocx 命令和参数。
---

opencodex 的命令行工具是 `ocx`。运行 `ocx help`(或 `--help` / `-h`)查看用法。

## 安装与生命周期

### `ocx init`

交互式安装向导。会依次询问 provider(预设或自定义)、API key(字面值或 `${ENV}`)、默认模型以及代理端口;保存 `~/.opencodex/config.json`;并可选择性地将代理注入到 `$CODEX_HOME/config.toml`（默认 `~/.codex/config.toml`）。

### `ocx start [--port <port>]`

启动代理服务器(默认端口 `10100`)。会写入一个 PID 文件,并拒绝启动第二个实例。启动时,它会将每个 provider 的模型同步到 Codex 的目录中。关闭时,它会恢复原生 Codex —— 除非它是作为受管服务启动的(`OCX_SERVICE=1`)。

```bash
ocx start
ocx start --port 8080
```

### `ocx stop`

停止正在运行的代理(通过 PID),删除 PID 文件,并恢复原生 Codex。

### `ocx restore` &nbsp;·&nbsp; `ocx eject`

在**不**停止代理的情况下恢复原生 Codex —— 移除注入的配置行和已路由的目录条目,使普通的 `codex` 重新以原生方式工作。`eject` 是 `restore` 的别名。

### `ocx status`

打印代理是否正在运行(及其 PID)。

## 模型与 Codex

### `ocx sync`

从每个已配置的 provider 获取实时模型列表,并将合并后的目录重新注入到 Codex 中。在添加 provider 后运行它,或用于刷新可用模型。

## 认证

### `ocx login <provider>`

为某个 provider 运行 OAuth 登录流程,并将凭据存储在 `~/.opencodex/auth.json` 中(自动刷新)。支持:`xai`、`anthropic`、`kimi`。

```bash
ocx login xai
```

### `ocx logout <provider>`

移除某个 provider 已存储的 OAuth 凭据。

## 仪表盘

### `ocx gui`

在 `http://localhost:<port>` 打开 [Web 仪表盘](/opencodex/zh-cn/guides/web-dashboard/),如果代理尚未运行,则自动启动它。

## 后台服务

### `ocx service <subcommand>`

将 opencodex 作为受登录管理的后台服务运行(macOS 上为 **launchd**,Linux 上为 **systemd user unit**,Windows 上为 **Task Scheduler**),它会在登录时自动启动,并在崩溃后自动重启。服务运行时会设置 `OCX_SERVICE=1`,因此重启不会反复改动 Codex 配置。

| Subcommand | Action |
| --- | --- |
| `install` | 创建并启动服务。 |
| `start` | 启动已安装的服务。 |
| `stop` | 停止服务并恢复原生 Codex。 |
| `status` | 报告服务是否正在运行。 |
| `uninstall` | 移除服务并恢复原生 Codex。(别名:`remove`) |

```bash
ocx service install
ocx service status
ocx service uninstall
```

## 帮助

`ocx help`、`ocx --help`、`ocx -h` —— 打印用法和示例。

:::note
`ocx gui` 可以正常工作,但未包含在简短的 `ocx help` 列表中。
:::
