import assert from "node:assert/strict";
import test from "node:test";
import { containsCredentialLike, parseCodexMcpToml } from "../src/discovery.js";

test("normalizes Codex MCP config and keeps only env variable names", () => {
  const servers = parseCodexMcpToml(`
[mcp_servers.github]
command = "npx"
args = ["-y", "server", "api_key=should-not-leak", "--token", "also-secret"]

[mcp_servers.github.env]
GITHUB_TOKEN = "should-not-leak"
`);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, "github");
  assert.deepEqual(servers[0].env_keys, ["GITHUB_TOKEN"]);
  assert.deepEqual(servers[0].args_redacted, [
    "-y",
    "server",
    "api_key=<redacted>",
    "--token",
    "<redacted>",
  ]);
  assert.ok(!JSON.stringify(servers).includes("should-not-leak"));
  assert.ok(!JSON.stringify(servers).includes("also-secret"));
});

test("removes URL credentials, query strings, fragments, and sensitive path values", () => {
  const [server] = parseCodexMcpToml(`
[mcp_servers.private]
url = "https://alice:password@example.com/mcp/token/opaque-value?signature=secret#fragment"
`);
  assert.equal(server.url, "https://example.com/mcp/token/%3Credacted%3E");
  assert.ok(!JSON.stringify(server).includes("password"));
  assert.ok(!JSON.stringify(server).includes("signature"));
  assert.ok(!JSON.stringify(server).includes("opaque-value"));
});

test("detects credential-shaped context without rejecting placeholders", () => {
  assert.equal(containsCredentialLike("API_TOKEN=actual-secret-value"), true);
  assert.equal(
    containsCredentialLike("Authorization: Bearer omega-dev:opaque-credential-value"),
    true,
  );
  assert.equal(containsCredentialLike("API_TOKEN=${API_TOKEN}"), false);
  assert.equal(containsCredentialLike("API_TOKEN=<redacted>"), false);
  assert.equal(containsCredentialLike("Authorization: Bearer $API_TOKEN"), false);
  assert.equal(containsCredentialLike("Authorization: Bearer <YOUR_TOKEN>"), false);
});
