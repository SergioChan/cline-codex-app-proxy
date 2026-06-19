---
title: 架构
description: opencodex 内部机制 —— 模块图、AdapterEvent 桥接、请求解析器,以及缓存。
---

opencodex 是单个 Bun 进程。一个请求以 OpenAI Responses 格式进入,被规范化为内部模型,经过路由,通过 adapter 发送给某个 provider,再被桥接回 Responses SSE。端到端流程参见 [工作原理](/opencodex/zh-cn/getting-started/how-it-works/)。

## 模块图

```
src/
├── cli.ts              # ocx command dispatch
├── index.ts            # public entry
├── server.ts           # Bun.serve: /v1/* proxy + /api/* management API
├── router.ts           # model id → provider + adapter
├── config.ts           # ~/.opencodex/config.json, defaults, PID, env resolution
├── service.ts          # launchd / systemd / Task Scheduler background service
├── init.ts             # interactive setup wizard
├── bridge.ts           # AdapterEvent stream → Responses SSE
├── codex-inject.ts     # $CODEX_HOME/config.toml injection + restore
├── codex-catalog.ts    # routed-model catalog merge + subagent ranking
├── model-cache.ts      # per-provider /models TTL cache
├── types.ts            # core interfaces + helpers (modelInList, namespacedToolName)
├── responses/
│   ├── parser.ts       # Responses request → OcxParsedRequest
│   └── schema.ts       # Zod validation
├── adapters/           # base + openai-chat, openai-responses, anthropic, google, azure, image
├── oauth/              # OAuth providers, API-key catalog, token store/refresh
├── web-search/         # web-search sidecar (synthetic tool, loop, executor, parser)
└── vision/             # vision sidecar (describe + plan)
```

## 解析器

`responses/parser.ts` 使用 `responses/schema.ts`(Zod)校验传入的请求,然后构建一个 `OcxParsedRequest`:

- **消息(Messages)** —— `input` 条目会变成规范化的 `OcxMessage[]`:user / developer / assistant / toolResult。`reasoning` 条目变成思考块;`function_call`、`custom_tool_call` 和 `tool_search_call` 条目变成工具调用;它们对应的 `*_output` 条目变成工具结果。
- **工具(Tools)** —— function 工具直接透传;**带命名空间的(MCP)工具会被扁平化**为 `namespace__name`(并在返回时还原);**自由格式(freeform)**工具(例如 `apply_patch`)和 **tool_search** 发现类工具会被打上标记;**托管工具(hosted tools)**(`web_search`、图像生成……)会被丢弃,仅当某个 sidecar 会处理它时才重新注入。
- **图像(Images)** —— 作为真实的内容部分保留(data URL 或远程 https),绝不内联为文本。
- **功能标志(Feature flags)** —— `_webSearch`(请求了托管的网络搜索)和 `_structuredOutput`(`text.format` 为 json_schema / json_object)。

## 桥接器

`bridge.ts` 将 adapter 的内部 `AdapterEvent` 流转换回 Codex 能理解的 Responses SSE:

| AdapterEvent | 发出的 Responses SSE |
| --- | --- |
| `text_delta` | `response.output_text.delta` → `…done`、`response.content_part.done`、`response.output_item.done` |
| `thinking_delta` | `response.reasoning_summary_text.delta` → `…done`、item close |
| `tool_call_start` | `response.output_item.added`(type:`function_call` / `custom_tool_call` / `tool_search_call`) |
| `tool_call_delta` | `response.function_call_arguments.delta`(对 freeform / tool_search 跳过) |
| `tool_call_end` | `response.function_call_arguments.done` → `response.output_item.done` |
| `done` | `response.completed`(带 usage) |
| `error` | `response.failed`(带 `last_error`) |

工具调用会借助解析器捕获的命名空间映射、freeform 集合和 tool-search 集合,被消歧为三种 Responses item 类型 —— 因此 MCP 命名空间、`apply_patch` 风格的 freeform 工具,以及由客户端执行的 `tool_search` 都能完整往返。一个 `buildResponseJSON()` 变体会从同一批事件中生成单个非流式的响应对象。

## 缓存与目录

- `model-cache.ts` 为每个 provider 维护一个内存中的 TTL 缓存,缓存实时 `/models` 的结果(默认 5 分钟,与 Codex 自身的缓存一致),并在请求失败时提供陈旧回退(stale-fallback)。
- `codex-catalog.ts` 将已路由的模型作为带命名空间的条目合并到 Codex 的目录中,将精选的 [subagent 模型](/opencodex/zh-cn/guides/codex-integration/#the-subagent-picker) 排在前面,过滤掉 `disabledModels`,并能从一次性备份中完全恢复原始目录。

## 核心类型

内部模型位于 `types.ts` 中:`OcxParsedRequest`、`OcxContext`、`OcxMessage` 联合类型、`OcxContentPart`(text / image)、`OcxToolCall`、`OcxTool`、`AdapterEvent`,以及配置类型(`OcxConfig`、`OcxProviderConfig`)。有两个被广泛使用的辅助函数:`namespacedToolName()` 和 `modelInList()`(为 `noVisionModels` / `noReasoningModels` 提供可容忍 `:size` 标签的匹配)。
