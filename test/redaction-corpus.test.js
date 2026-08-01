import assert from "node:assert/strict";
import test from "node:test";
import { containsCredentialLike, parseCodexMcpToml } from "../src/discovery.js";

// The corpus below is the empirically probed leak table from the transfer-flow inventory
// (research/cli-inventory.md §5.2). Every value is a shape-accurate FAKE; none is live.
const SLACK_BOT = "xoxb-000000000000-000000000000-FAKE0000FAKE0000FAKE0000";
const SLACK_APP = "xapp-1-A00000000-0000000000000-FAKE0000FAKE0000FAKE0000";
const STRIPE_LIVE = "sk_live_FAKE0000FAKE0000FAKE0000";
const STRIPE_RESTRICTED = "rk_live_FAKE0000FAKE0000FAKE0000";
const GOOGLE_KEY = "AIzaSyFAKE00000000000000000000000000000";
const NPM_TOKEN = "npm_FAKE0000FAKE0000FAKE0000FAKE0000";
const HF_TOKEN = "hf_FAKE0000FAKE0000FAKE0000FAKE0000";
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMDAwIiwibmFtZSI6IkZBS0UifQ.FAKE0000FAKE0000FAKE0000";
const OPENAI_PROJECT = "sk-proj-FAKE0000FAKE0000FAKE0000FAKE0000";
const ANTHROPIC = "sk-ant-api03-FAKE0000FAKE0000FAKE0000";

function serverWithArgument(argument) {
  const [server] = parseCodexMcpToml(
    `[mcp_servers.probe]\ncommand = "uvx"\nargs = ["server", "${argument}"]\n`,
  );
  return { argument: server.args_redacted[1], json: JSON.stringify(server) };
}

// One argument per row, exactly how the inventory probed the flow.
const ARGV_CORPUS = [
  // [label, argument, the substring that must not survive, an optional substring that must]
  ["postgres DSN", "postgresql://user:hunter2@db.host/app", "hunter2", "db.host"],
  ["mongodb DSN", "mongodb+srv://admin:s3cretpw@cluster0.mongodb.net", "s3cretpw", "cluster0.mongodb.net"],
  ["redis DSN", "redis://:password123@10.0.0.1:6379", "password123", "10.0.0.1"],
  ["Slack bot token", SLACK_BOT, SLACK_BOT, null],
  ["Slack app token", SLACK_APP, SLACK_APP, null],
  ["Google API key", GOOGLE_KEY, GOOGLE_KEY, null],
  ["Stripe live key", STRIPE_LIVE, STRIPE_LIVE, null],
  ["Stripe restricted key", STRIPE_RESTRICTED, STRIPE_RESTRICTED, null],
  ["JWT", JWT, JWT, null],
  ["npm token", NPM_TOKEN, NPM_TOKEN, null],
  ["Hugging Face token", HF_TOKEN, HF_TOKEN, null],
  // Rows the inventory found already handled: they must stay handled.
  ["Anthropic key", ANTHROPIC, ANTHROPIC, null],
  ["OpenAI project key", OPENAI_PROJECT, OPENAI_PROJECT, null],
  ["URL query token", "https://api.example.com/mcp?access_token=FAKE0000FAKE0000", "FAKE0000FAKE0000", "api.example.com"],
  ["password flag", "--password=hunter2secret", "hunter2secret", null],
  ["postgres env assignment", "PGPASSWORD=hunter2secret", "hunter2secret", null],
];

for (const [label, argument, secret, keep] of ARGV_CORPUS) {
  test(`redacts an MCP argument carrying a ${label}`, () => {
    const { argument: redacted, json } = serverWithArgument(argument);
    assert.ok(!json.includes(secret), `${label} survived redaction as ${redacted}`);
    if (keep) {
      assert.ok(redacted.includes(keep), `${label} lost the non-secret part: ${redacted}`);
    }
  });
}

test("keeps a plain MCP endpoint and a plain positional argument intact", () => {
  const [server] = parseCodexMcpToml(
    `[mcp_servers.docs]\ncommand = "npx"\nargs = ["mcp-remote", "https://mcp.example.com/sse", "--transport", "sse"]\n`,
  );
  assert.deepEqual(server.args_redacted, [
    "mcp-remote",
    "https://mcp.example.com/sse",
    "--transport",
    "sse",
  ]);
});

test("a header-shaped argument is still redacted rather than parsed as a URL", () => {
  // `Authorization: Bearer …` parses as a URL whose scheme is `authorization:`, so routing every
  // parseable value through sanitizeUrl would hand the token straight back.
  const { argument, json } = serverWithArgument("Authorization: Bearer FAKE0000FAKE0000FAKE0000");
  assert.equal(argument, "Authorization: <redacted>");
  assert.ok(!json.includes("FAKE0000FAKE0000FAKE0000"));
});

// Whole-file exclusion: the second §5.2 table.
const EXCLUDED_CORPUS = [
  ["bare PASSWORD assignment", "PASSWORD=hunter2secret"],
  ["bare TOKEN assignment", "TOKEN=hunter2secret"],
  ["bare KEY assignment", "KEY=hunter2secret"],
  ["bare SECRET assignment", "SECRET=hunter2secret"],
  ["bare CREDENTIAL assignment", "CREDENTIAL=hunter2secret"],
  ["bare SIGNATURE assignment", "SIGNATURE=hunter2secret"],
  ["prefixed assignment", "X_PASSWORD=hunter2secret"],
  ["prefixed token assignment", "MY_TOKEN=abcdefghij"],
  ["Slack token in an assignment", `SLACK_BOT=${SLACK_BOT}`],
  ["Stripe key in prose", `Use ${STRIPE_LIVE} when charging the live account.`],
  ["DSN in prose", "Connect with postgres://u:hunter2@h/db from the worker."],
  ["header in a shell example", 'curl -H "x-api-key: abc123def456" https://api.example.com'],
  ["JWT in prose", `The session token is ${JWT} until it expires.`],
  ["code-span assignment", "Set `MY_TOKEN=abcdefghij` before running the server."],
  ["backtick-framed assignment", "`MY_TOKEN=abcdefghij`"],
  ["list-item assignment", "- MY_TOKEN=abcdefghij"],
  ["asterisk-list assignment", "* MY_TOKEN=abcdefghij"],
  ["block-quoted assignment", "> MY_TOKEN=abcdefghij"],
  ["list item wrapping a code span", "- `MY_TOKEN=abcdefghij`"],
  ["export line", "export API_TOKEN=abcdefghij"],
];

for (const [label, content] of EXCLUDED_CORPUS) {
  test(`excludes a file containing a ${label}`, () => {
    assert.equal(containsCredentialLike(content), true, `not detected: ${label}`);
  });
}

// The paired precision corpus: a false positive here costs the user a whole file.
const KEPT_CORPUS = [
  ["shell variable reference", "API_TOKEN=${API_TOKEN}"],
  ["bare variable reference", "API_TOKEN=$API_TOKEN"],
  ["redaction placeholder", "API_TOKEN=<redacted>"],
  ["angle-bracket placeholder", "API_TOKEN=<YOUR_TOKEN>"],
  ["bearer variable", "Authorization: Bearer $API_TOKEN"],
  ["bearer placeholder", "Authorization: Bearer <YOUR_TOKEN>"],
  ["short value", "MY_TOKEN=abcdefg"],
  ["empty assignment", "API_KEY="],
  ["documented placeholder token", "SLACK_TOKEN=xoxb-your-token-here"],
  ["documented example key", "STRIPE_KEY=sk_live_your-key-here"],
  [
    ".env.example content",
    [
      "# Copy this file to .env and fill in the values",
      "DATABASE_URL=postgres://user:password@localhost:5432/app",
      "SLACK_TOKEN=xoxb-your-token-here",
      "API_KEY=",
      "SESSION_SECRET=changeme",
    ].join("\n"),
  ],
  [
    "a skill documenting credential shapes",
    [
      "# Redaction patterns",
      "",
      "Redact any value assigned to a key matching `token`, `secret`, or `password`.",
      "GitHub tokens start with ghp_ and Slack tokens with xoxb-.",
      "Replace the value with <redacted> and keep the key.",
    ].join("\n"),
  ],
  ["prose with a colon", "Token: describe the token you want to use here"],
  ["a markdown list of key names", "- keywords: everything the reader should know"],
];

for (const [label, content] of KEPT_CORPUS) {
  test(`keeps a file containing ${label}`, () => {
    assert.equal(containsCredentialLike(content), false, `false positive: ${label}`);
  });
}
