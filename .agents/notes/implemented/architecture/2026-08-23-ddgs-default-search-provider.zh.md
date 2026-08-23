# Agent Note: DuckDuckGo 是免密钥的默认搜索提供方，进程内经由 `ddg-search`

Status: implemented

[English](2026-08-23-ddgs-default-search-provider.md) | 中文

## 问题

出厂默认 `searchProvider` 是 `deepseek-official`，一条依赖凭证的路线：在没有 `DEEPSEEK_API_KEY` 的部署上，`web_search` 会把调用失败为 `WEB_PROVIDER_CREDENTIAL_MISSING`，因此模型的 web 搜索工具开箱即死。其余每个已注册的搜索提供方（Exa、Perplexity、DeepSeek）也都需要密钥，所以一个全新部署根本没有任何可用的搜索路径。

## 决策

**DuckDuckGo 是出厂默认 `searchProvider`，后端是进程内的 `ddg-search` 库。** `@deepseek-ai/dsh-web-search-ddgs` 注册一个 `WebSearchProvider`（id `duckduckgo`），通过受维护的 [`ddg-search`](https://www.npmjs.com/package/ddg-search) JS/TS 抓取库**在进程内**查询 DuckDuckGo 的 HTML 端点——没有外部解释器、没有已提交的 Python runner、也没有手写 fetch 爬虫。它的 `available()` 始终为 `true`，因为没有任何东西需要解析；连通性只在搜索时才可知。base bundle 把 `searchProvider` 固定为 `duckduckgo`，并把 `defaultMaxResults` 设为 `10`；DeepSeek 路线仍保持注册，供设置了密钥并通过 `searchProvider: deepseek-official` 显式选择的部署使用。固定选择了一个 id，因此选择永远不会变成 `WEB_PROVIDER_AMBIGUOUS`。

**真正的零匹配和被限流的请求都返回 `{ sources: [] }`——提供方不检测限流。** DuckDuckGo 会对频繁快速请求限流，而 `ddg-search` 把真正的零匹配和被限流的请求都报告为空结果列表。与其用一个启发式把第二次空结果转成错误——那会把合法的无结果查询变成假失败——提供方诚实地返回空结果。权衡是：被限流的搜索会报告"无结果"而非一个可见的错误；该限制记录在包 README 中。

## 备选方案

- **基于 `ddgs` 库的 Python 子进程 runner**——直接沿用上游仓库，但会把 Python 运行时和 `pip install` 拖进 Node harness，增加解释器探测（`python3`/`py -3`），并且每次搜索都生成一个子进程。否决：进程内的 `ddg-search` 库用同样的 DuckDuckGo 检索提供了零额外基础设施。
- **基于 DuckDuckGo HTML 端点的手写 fetch 爬虫**——零外部依赖，但要手工维护 `ddg-search` 已经维护的抓取逻辑。否决：优先使用受维护的依赖，而非手写自有代码与测试。
- **保持 `deepseek-official` 为默认，让免密钥搜索继续死着**——保留当前行为，但在任何没有密钥的部署上 `web_search` 都不可用，而这正是首次运行的常见情况。

## 后果

一个全新部署拥有零凭证即可用的 `web_search`：默认路线不需要密钥，也不需要额外运行时。设置了 DeepSeek 密钥并通过 `searchProvider: deepseek-official` 固定选择的部署则得到结构化的 DeepSeek 搜索；两条路线通过该固定项互斥。

`ddg-search` 的 `postinstall` 运行一个本地构建步骤，因此该包被加入 `pnpm-workspace.yaml` 的 `allowBuilds`。该提供方是函数／命名空间插件（`inject: ['web']`），带一个包自有的 invariant 伴随插件，声明没有运行时不变量——它不暴露任何超出 seam 契约的事件序列或可变数据关系。

限流与空结果的权衡是一项常设限制，而非缺陷：它记录在包 README 的已知限制一节，也正是让免密钥默认值可以安全出厂的原因。

## 测试

`packages/web/web-search-ddgs/tests/provider.spec.ts` 固定了结果映射（url/title/snippet、空字段省略、第二次零匹配仍如实为空）、`maxResults` 解析顺序（请求级、已配置、默认）以及错误转换（提供方失败 → 带 cause 的 `WEB_PROVIDER_ERROR`；预先中止与进行中中止 → `WEB_ABORTED`）。`tests/plugin.spec.ts` 是真实组合测试：它通过 `Context` 启动真实的 `WebRuntime` + 插件，服务一次搜索，并通过释放 fiber 后观察到 `WEB_PROVIDER_CONFIGURED_MISSING` 来证明 HMR 安全性。
