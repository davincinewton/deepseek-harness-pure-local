# mcp-chrome 浏览器桥接示例

[English](README.md) | 中文

一份**默认关闭的参考配置**，将 [mcp-chrome 桥接器](https://github.com/davincinewton/mcp-chrome-python) 通过 [`@deepseek-ai/dsh-mcp-client`](../../packages/mcp/mcp-client/README.md) 连接到 DSH。该桥接器暴露用户真实、已登录的 Chrome 浏览器——导航、点击、填写表单、截图以及 20 多个其他工具——让 agent 能够驱动用户日常使用的浏览器。

此第三方配置仅作为互操作示例提供。其收录不代表 DeepSeek 的认可、推荐、合作或持续支持。

## DSH 做什么

DSH 连接到桥接器的 Streamable HTTP 端点，发现其 MCP 工具，并以 `mcp__chrome__<tool>` 的形式公开它们。DSH **不会**安装 Chrome 扩展、运行 Python 桥接器、启动或监管 Chrome，或管理浏览器的登录状态。DSH 启动时桥接器必须已在运行：对 Streamable HTTP 而言，上游服务位于 DSH 插件生命周期之外。

## 运行桥接器

前提条件：一个 Chrome/Chromium 浏览器和 Python（桥接器是一个 Python 包）。

1. 克隆仓库并安装 Python 桥接器：

   ```sh
   git clone https://github.com/davincinewton/mcp-chrome-python.git
   cd mcp-chrome-python
   pip install -e app/bridge-python
   ```

   或不克隆、直接从源码安装：

   ```sh
   pip install "mcp-chrome-bridge @ git+https://github.com/davincinewton/mcp-chrome-python.git#subdirectory=app/bridge-python"
   ```

2. 加载 Chrome 扩展：打开 `chrome://extensions/`，启用**开发者模式**，点击**加载已解压的扩展程序**，选择克隆仓库中的 `app/extension` 文件夹。点击扩展图标，然后**连接**。

3. 启动桥接器：

   ```sh
   mcp-chrome-bridge
   ```

   桥接器在 `127.0.0.1:12306` 启动一个 HTTP/SSE 服务器（供 MCP 客户端连接），在 `127.0.0.1:12307` 启动一个 WebSocket 服务器（供扩展通信）。在 DSH 需要浏览器工具期间保持其运行。

## 连接 DSH

将 overlay 传给单次运行：

```sh
dsh web --patch "$PWD/examples/mcp-chrome/mcp-chrome.cordis.yml"
```

要在多次运行和多个 profile 之间保持连接，将该文件的单个 `insert` 补丁合并到家级用户补丁层 `$DSH_HOME/cordis.patch.yml`（作用于本机每个 profile）。不要覆盖已有文件：其中可能已包含无关的用户补丁。

## 验证

新建一个 DSH 会话——初始工具发现是异步的，因此在发出第一条浏览器提示前，请等待 `mcp__chrome__*` 工具出现——然后让 agent 使用浏览器，例如：`在我的浏览器里打开 example.com 并告诉我页面标题。` 确认模型调用了某个 `mcp__chrome__*` 工具（如 `chrome_navigate`）且调用返回成功。已提交的 [`web-search-chrome` 技能](../../.agents/skills/web-search-chrome/SKILL.md) 基于这些相同工具实现基于浏览器的网络搜索。

如果桥接器未运行，该行会记录一系列有界的连接警告且不公开任何 chrome 工具；会话及其他所有工具不受影响。启动桥接器后新建一个会话——通用客户端不会自动重连在启动时处于关闭状态的 Streamable HTTP 端点。
