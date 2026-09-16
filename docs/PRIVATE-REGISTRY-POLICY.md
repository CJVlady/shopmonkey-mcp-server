# Private registry policy

The Northwest Motors Shopmonkey bridge is intentionally absent from public MCP registries.

HAPI and the official MCP Registry are discovery layers; listing the live Railway URL would increase discovery and attack exposure without improving the existing ChatGPT or Claude connection. The deployment is single-tenant and authenticates one owner, so it is not offered as a public hosted service.

Repository metadata may identify the `CJVlady` fork, but this repository must not contain an official `server.json` or npm `mcpName` unless CJ separately approves a generic self-hosted distribution release. A future public package must omit the Northwest Motors Railway URL, credentials, location IDs and operational data.

Acceptance for the current private design includes confirming that registry searches for `shopmonkey`, `shopmonkey-mcp-server` and `CJVlady` do not return this deployment.
