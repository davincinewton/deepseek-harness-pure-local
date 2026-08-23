# @deepseek-ai/dsh-web-search-ddgs

[English](README.md) | 中文

由 [DuckDuckGo](https://duckduckgo.com) 支持的 `WebSearchProvider`，用于 harness [web 能力 seam](../web/README.md)（`ctx.web`）。它通过受维护的 [`ddg-search`](https://www.npmjs.com/package/ddg-search) 库**在进程内**查询 DuckDuckGo 的 HTML 端点，并把返回的 `results[]` 映射为 seam 规范化的 `WebSearchResult`。

这是一个**实现**包：它向 `ctx.web` 注册提供方，不拥有 `ctx.web` 键，也不注册面向模型的工具（后者属于 `@deepseek-ai/dsh-tool-web`）。与 `@deepseek-ai/dsh-llm-deepseek` 一样，它是函数／命名空间插件（`inject: ['web']`），负责注册后端，而非默认导出服务。

与依赖凭证的搜索提供方不同，它**不需要 API 密钥**：它在进程内运行，没有需要解析的外部解释器或已提交的 runner，因此它的 `available()` 始终为 `true`。这正是它作为出厂默认 `searchProvider` 的原因——在没有密钥的部署上，`web_search` 开箱即用；而无密钥的 DeepSeek 路线会把调用失败为 `WEB_PROVIDER_CREDENTIAL_MISSING`。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `defaultMaxResults` | `5` | 请求不含 `maxResults` 时使用的默认结果数。正整数。请求级的 `maxResults` 始终优先。 |

```yaml
- id: web-search-ddgs
  name: '@deepseek-ai/dsh-web-search-ddgs'
  config:
    defaultMaxResults: 10
```

base bundle 把 `searchProvider` 固定为 `duckduckgo`，并把 `defaultMaxResults` 设为 `10`；DeepSeek 路线仍保持注册，供设置了密钥并通过 `searchProvider: deepseek-official` 显式选择的部署使用。固定选择了一个提供方，因此不会触发 `WEB_PROVIDER_AMBIGUOUS`。

## 映射

`ddg-search` 返回扁平 `results[]`，不返回生成答案，因此省略 `content`。每项结果映射为 `WebSearchSource`：`url` ← `url`、`title` ← `title`、`snippet` ← `description`。空的 `title`／`description` 字符串会被丢弃，使 seam 不携带空字段；既无标题也无摘要的结果仍以仅 `url` 返回。`publishedAt` 缺省——`ddg-search` 不提供发布日期。

请求的 `maxResults` 优先于已配置的 `defaultMaxResults`，并传给 `ddg-search`；seam 在返回时重新强制该上限。真正的零匹配是一个有效、非错误的结果：它返回 `{ sources: [] }`。提供方失败（反爬虫检测、HTTP、网络）以 `WebError` `WEB_PROVIDER_ERROR` 呈现；已中止或进行中被中止的请求以 `WEB_ABORTED` 呈现。

## 模型体验

通过 [`dsh-tool-web`](../tool-web/README.md) 间接影响；该工具保留此提供方经 `maxResults` 限制的 URL、标题与摘要（置于消费方的错误包装层内），或确切的错误消息 `DuckDuckGo search aborted` 和 `DuckDuckGo search failed: <error>`。`ddg-search` 不产生生成答案，因此没有内容进入上下文。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **限流伪装成空结果**：DuckDuckGo 没有官方 API，会对来自同一 IP 的频繁快速请求限流。`ddg-search` 对真正的零匹配和被限流的请求都返回空结果，因此被限流的搜索报告为"无结果"而非失败。提供方刻意不区分这两种情况：第二次空结果仍返回 `{ sources: [] }`（如实），而不会被转成错误。
- **没有 `publishedAt`**：`ddg-search` 不携带发布日期，因此源永远没有日期。
- **地区与时效固定**：提供方发送 `region: ''` 与 `time: ''`；地区与时效控制等待提供方无关的 Service Definition 字段（见 [seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)）。
- **非官方端点，无 SLA**：DuckDuckGo 的 HTML 端点是非官方的，可能随时变更或自由地屏蔽爬虫；这是一个没有可用性保证的免费提供方。
