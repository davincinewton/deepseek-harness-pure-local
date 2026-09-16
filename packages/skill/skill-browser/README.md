# @deepseek-ai/dsh-skill-browser

English | [中文](README.zh.md)

Bundled skill provider that contributes the four mcp-chrome browser skills to `ctx.skills`: `web-search-chrome`, `web-search-chrome-url`, `web-search-multi-engine`, and `browser-research-report`. The skill bodies are packaged in this package's `assets/` directory, so every deployment that mounts the plugin knows the browser capability regardless of working directory or user skill roots.

Mount the plugin to enable the provider; it has no configuration. The shipped `dsh-base` composition mounts the plugin alongside the built-in `mcp-chrome` row, which exposes the `mcp__chrome__*` tools while the [mcp-chrome bridge](https://github.com/davincinewton/mcp-chrome-python) is running. With the bridge down no chrome tools are exposed and each skill body falls back to the built-in `web_search` tool or reports the capability unavailable.

## Model Experience

Indirectly, through `@deepseek-ai/dsh-tool-skill`, which renders the four catalog entries (about 1.7 KB of descriptions per request) and the selected skill body on demand.

#### KV Cache effect

The catalog entries sit at a stable system-prompt position and do not change for the life of the process, so they do not invalidate the cache across turns.

## Known Limitations and Deferred Work

- The provider contributes four fixed skills and has no runtime customization.
- The skills require the `mcp__chrome__*` tools of the built-in `mcp-chrome` row; with the bridge down they degrade to `web_search` or report unavailability, per each body's bridge-unavailable branch.
