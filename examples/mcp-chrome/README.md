# mcp-chrome browser bridge example

English | [中文](README.zh.md)

A **default-off reference configuration** that connects the [mcp-chrome bridge](https://github.com/davincinewton/mcp-chrome-python) to DSH through [`@deepseek-ai/dsh-mcp-client`](../../packages/mcp/mcp-client/README.md). The bridge exposes the user's real, logged-in Chrome browser — navigate, click, fill forms, screenshot, and 20+ other tools — so the agent can drive the browser the user already uses.

This third-party configuration is provided as an interoperability example only. Its inclusion does not imply endorsement, recommendation, partnership, or ongoing support by DeepSeek.

## What DSH does

DSH connects to the bridge's Streamable HTTP endpoint, discovers its MCP tools, and exposes them as `mcp__chrome__<tool>`. DSH does **not** install the Chrome extension, run the Python bridge, launch or supervise Chrome, or manage the browser's login state. The bridge must already be running when DSH starts: for Streamable HTTP the upstream service is external to the DSH plugin lifecycle.

## Run the bridge

Prerequisites: a Chrome/Chromium browser and Python (the bridge is a Python package).

1. Clone the repository and install the Python bridge:

   ```sh
   git clone https://github.com/davincinewton/mcp-chrome-python.git
   cd mcp-chrome-python
   pip install -e app/bridge-python
   ```

   Or install from source without cloning:

   ```sh
   pip install "mcp-chrome-bridge @ git+https://github.com/davincinewton/mcp-chrome-python.git#subdirectory=app/bridge-python"
   ```

2. Load the Chrome extension: open `chrome://extensions/`, enable **Developer mode**, click **Load unpacked**, and select the `app/extension` folder from the cloned repository. Click the extension icon, then **connect**.

3. Start the bridge:

   ```sh
   mcp-chrome-bridge
   ```

   The bridge starts an HTTP/SSE server on `127.0.0.1:12306` (for MCP client connections) and a WebSocket server on `127.0.0.1:12307` (for the extension). Keep it running for as long as DSH needs the browser tools.

## Connect DSH

Pass the overlay to one run:

```sh
dsh web --patch "$PWD/examples/mcp-chrome/mcp-chrome.cordis.yml"
```

To keep the connection across runs and profiles, merge the file's single `insert` patch into the home-level user patch layer, `$DSH_HOME/cordis.patch.yml` (applied over every profile on the machine). Do not copy over an existing file: it may already contain unrelated user patches.

## Verify

Create a new DSH session — initial tool discovery is asynchronous, so wait for the `mcp__chrome__*` tools to appear before the first browser prompt — and ask the agent to use the browser, for example: `Open example.com in my browser and tell me the page title.` Confirm the model called a `mcp__chrome__*` tool (such as `chrome_navigate`) and the call returned success. The committed [`web-search-chrome` skill](../../.agents/skills/web-search-chrome/SKILL.md) builds on these same tools for browser-based web search.

If the bridge is not running, the row logs a bounded series of connection warnings and exposes no chrome tools; the session and every other tool are unaffected. Start the bridge and open a new session — the generic client does not auto-reconnect a Streamable HTTP endpoint that was down at startup.
