# @deepseek-ai/dsh-skill-browser

[English](README.md) | 中文

内置 skill（技能）提供方，向 `ctx.skills` 贡献四个 mcp-chrome 浏览器 skill：`web-search-chrome`、`web-search-chrome-url`、`web-search-multi-engine` 与 `browser-research-report`。skill 正文打包在本包的 `assets/` 目录中，因此任何挂载该插件的部署都能感知浏览器能力，与工作目录和用户 skill 根目录无关。

挂载该插件即可启用提供方；它没有配置。随附的 `dsh-base` 组合会挂载该插件，并同时挂载内置的 `mcp-chrome` 配置行——当 [mcp-chrome bridge](https://github.com/davincinewton/mcp-chrome-python) 运行时，该行暴露 `mcp__chrome__*` 工具。bridge 未运行则不暴露任何 chrome 工具，各 skill 正文会回退到内置 `web_search` 工具或报告该能力不可用。

## 模型体验

通过 `@deepseek-ai/dsh-tool-skill` 间接影响模型；该包会渲染四个目录条目（每个请求约 1.7 KB 的描述）以及按需加载的所选 skill 正文。

#### KV Cache 影响

目录条目位于系统提示词中的稳定位置，且在整个进程生命周期内不变，因此不会跨轮次使缓存失效。

## 已知限制与暂缓事项

- 该提供方只贡献四个固定 skill，不提供运行时自定义。
- 这些 skill 依赖内置 `mcp-chrome` 配置行的 `mcp__chrome__*` 工具；bridge 未运行时，按各正文的 bridge 不可用分支回退到 `web_search` 或报告不可用。
