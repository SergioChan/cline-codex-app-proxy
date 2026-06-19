---
title: 快速开始
description: 配置你的第一个 provider,用三条命令让 OpenAI Codex 通过 opencodex 进行路由。
---

本指南将带你从全新安装,一路走到用一个非 OpenAI 模型运行 Codex。

## 1. 运行设置向导

```bash
ocx init
```

`ocx init` 会引导你完成:

1. **选择一个 provider** —— 选择一个预设(opencode zen、Anthropic、OpenAI、OpenRouter、Groq、Google、
   Azure),或选择 `custom` 来输入 base URL 和 adapter。
2. **API key** —— 粘贴一个 key,或引用一个环境变量,例如 `${ANTHROPIC_API_KEY}`。
3. **默认模型** —— 当某个请求未匹配到其他 provider 时所使用的模型。
4. **代理端口** —— 默认为 `10100`。
5. **注入到 Codex?** —— 当你接受时,opencodex 会将 `[model_providers.opencodex]` 表写入
   `$CODEX_HOME/config.toml`（默认 `~/.codex/config.toml`）,并设置 `model_provider = "opencodex"`,使 Codex 通过该代理进行路由。

结果会保存到 `~/.opencodex/config.json`。

## 2. 启动代理

```bash
ocx start            # defaults to port 10100
ocx start --port 8080
```

启动时,opencodex 会:

- 将其 PID 写入 `~/.opencodex/ocx.pid`(并拒绝重复启动),
- 获取每个 provider 的实时模型列表,并**将它们同步进 Codex 的模型目录**,以及
- 在 `http://localhost:<port>/v1` 上监听。

检查它:

```bash
ocx status
```

## 3. 使用 Codex

Codex 现在会透明地与 opencodex 通信:

```bash
codex "Refactor this function for readability"
```

若要指定某个已路由的模型,请使用 Codex 模型选择器所显示的 `provider/model` 形式:

```bash
codex -m "anthropic/claude-opus-4-8" "Explain this stack trace"
codex -m "ollama-cloud/glm-5.2"      "Write a SQL migration"
```

## 登录而非粘贴 key

部分 provider 支持真正的账号登录(OAuth,自动刷新):

```bash
ocx login xai          # or: anthropic, kimi
ocx logout xai
```

OpenAI 本身**无需 key** —— 默认 provider 会直接转发你现有的 `codex login`
凭据(参见 [Provider](/opencodex/zh-cn/guides/providers/))。

## 停止与恢复

```bash
ocx stop      # stop the proxy and restore native Codex
ocx restore   # restore native Codex without stopping (alias: ocx eject)
```

## 下一步

- [工作原理](/opencodex/zh-cn/getting-started/how-it-works/) —— 每个请求都发生了什么。
- [Provider](/opencodex/zh-cn/guides/providers/) —— 各种认证方式。
- [配置](/opencodex/zh-cn/reference/configuration/) —— 完整的 `config.json` 参考。
