# Browser skills and the mcp-chrome bridge

This guide assumes you started the Web UI through the [root README](../../../README.md#run).

DSH ships four browser skills — `web-search-chrome`, `web-search-chrome-url`, `web-search-multi-engine`, and `browser-research-report` — and a built-in connection to the [mcp-chrome bridge](https://github.com/davincinewton/mcp-chrome-python). At startup DSH connects to `http://127.0.0.1:12306/mcp`; while the bridge runs, its tools appear as `mcp__chrome__*` and the skills drive your real, logged-in Chrome browser: browser-based web search, URL resolution with full-text capture, cross-engine corroboration, and synthesized research reports.

A down bridge is an expected state, not an error. DSH logs a bounded series of connection warnings, exposes no chrome tools, and every other tool keeps working. The skills degrade with it: `web-search-chrome` falls back to the built-in `web_search` tool, and the remaining three report the capability unavailable rather than producing degraded output.

## Run the bridge

Prerequisites: a Chrome/Chromium browser and Python (the bridge is a Python package).

1. Install the Python bridge:

   ```sh
   pip install "mcp-chrome-bridge @ git+https://github.com/davincinewton/mcp-chrome-python.git#subdirectory=app/bridge-python"
   ```

   Cloning the repository and running `pip install -e app/bridge-python` inside it works as well.

2. Load the Chrome extension: open `chrome://extensions/`, enable **Developer mode**, choose **Load unpacked**, and select the `app/extension` folder from the cloned repository. Click the extension icon, then **connect**.

3. Start the bridge:

   ```sh
   mcp-chrome-bridge
   ```

   The bridge serves the MCP endpoint on `127.0.0.1:12306` and the extension WebSocket on `127.0.0.1:12307`. Keep it running for as long as DSH needs the browser tools.

Start the bridge before the session that needs it: initial tool discovery is asynchronous, and a session whose bridge was down at startup does not auto-reconnect later — open a new session after the bridge is up.

## Verify

In a new session, ask the agent to use the browser, for example: `Open example.com in my browser and tell me the page title.` Confirm the model called a `mcp__chrome__*` tool such as `chrome_navigate` and the call returned success. If no `mcp__chrome__*` tools are listed, the bridge is not reachable on `127.0.0.1:12306` — check that the process is running, the extension is connected, and nothing else occupies the port.

## Change the bridge port or opt out

The built-in row assumes the default port. A patch layer replaces a row's whole config, so an override restates the complete config:

```yaml
- id: mcp-chrome
  config:
    serverName: chrome
    transport: streamable-http
    url: http://127.0.0.1:9306/mcp
```

Choose the scope by where the file lives:

- **One run**: `dsh web --patch /path/to/overlay.cordis.yml`
- **One profile**: `$DSH_HOME/profiles/<name>/cordis.patch.yml`
- **The whole machine**: `$DSH_HOME/cordis.patch.yml` (default `~/.dsh/cordis.patch.yml`)

To opt out of the browser connection entirely, disable the row in any of those layers:

```yaml
- id: mcp-chrome
  disabled: true
```

Running surfaces pick up these changes without a restart — the MCP client disconnects and reconnects when the row changes — while one-shot runs read them at startup.

The mcp-chrome bridge is a third-party project. DSH's built-in connection and bundled browser skills are provided for interoperability only; their inclusion does not imply endorsement, recommendation, partnership, or ongoing support by DeepSeek.
