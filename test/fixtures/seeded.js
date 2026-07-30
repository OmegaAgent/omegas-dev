// The Gate-2 recall corpus (THR §5, Gate 2): a fixture home with ≥200 seeded credentials
// spread across EVERY surface the scanner reads, so recall is a measured number rather
// than an assertion about the pattern table.
//
// Every value here is FAKE and generated locally. No value on this machine, or any other,
// is read to build this corpus: each one is a shape assembled from the vendor's published
// token format plus a per-placement counter, which is also what makes them distinct enough
// to attribute a miss to a specific surface.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { materializeHome } from "./materialize.js";

const alnum = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Deterministic, distinct, and high-entropy enough to be a plausible credential body. */
function body(id, length, alphabet = alnum) {
  let out = "";
  let seed = Number(id) * 2654435761;
  for (let index = 0; index < length; index += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    out += alphabet[(seed >>> 7) % alphabet.length];
  }
  return out;
}

const HEX = "0123456789abcdef";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// class, tier, the key name a real config would store it under, and the shape.
// `deep_only` marks a class the generic entropy layer is the only detector for, so it is
// seeded exclusively at positions a surface DECLARED as a deep-scan sink.
export const MAKERS = [
  { class: "anthropic.api_key", tier: "HIGH", key: "ANTHROPIC_API_KEY", make: (id) => `sk-ant-api03-${body(id, 28)}` },
  { class: "openai.api_key", tier: "HIGH", key: "OPENAI_API_KEY", make: (id) => `sk-proj-${body(id, 32)}` },
  { class: "aws.access_key_id", tier: "HIGH", key: "AWS_ACCESS_KEY_ID", make: (id) => `AKIA${body(id, 16, UPPER)}` },
  { class: "aws.secret_key", tier: "HIGH", key: "AWS_SECRET_ACCESS_KEY", make: (id) => body(id, 40) },
  { class: "github.token", tier: "HIGH", key: "GITHUB_TOKEN", make: (id) => `ghp_${body(id, 36)}` },
  { class: "github.fine_grained_pat", tier: "HIGH", key: "GITHUB_PAT", make: (id) => `github_pat_${body(id, 30)}` },
  { class: "gitlab.token", tier: "HIGH", key: "GITLAB_TOKEN", make: (id) => `glpat-${body(id, 20)}` },
  { class: "slack.token", tier: "HIGH", key: "SLACK_BOT_TOKEN", make: (id) => `xoxb-000000000000-${body(id, 24)}` },
  { class: "slack.app_token", tier: "HIGH", key: "SLACK_APP_TOKEN", make: (id) => `xapp-1-A00000000-${body(id, 20)}` },
  {
    class: "slack.webhook",
    tier: "HIGH",
    key: "SLACK_WEBHOOK_URL",
    make: (id) => `https://hooks.slack.com/services/T00000000/B00000000/${body(id, 24)}`,
  },
  { class: "stripe.secret_key", tier: "HIGH", key: "STRIPE_SECRET_KEY", make: (id) => `sk_live_${body(id, 24)}` },
  { class: "stripe.webhook_secret", tier: "HIGH", key: "STRIPE_WEBHOOK_SECRET", make: (id) => `whsec_${body(id, 24)}` },
  { class: "google.api_key", tier: "HIGH", key: "GOOGLE_API_KEY", make: (id) => `AIza${body(id, 35)}` },
  {
    class: "google.oauth_client_secret",
    tier: "HIGH",
    key: "GOOGLE_CLIENT_SECRET",
    make: (id) => `GOCSPX-${body(id, 20)}`,
  },
  { class: "groq.api_key", tier: "HIGH", key: "GROQ_API_KEY", make: (id) => `gsk_${body(id, 24)}` },
  { class: "npm.token", tier: "HIGH", key: "NPM_TOKEN", make: (id) => `npm_${body(id, 30)}` },
  { class: "huggingface.token", tier: "HIGH", key: "HF_TOKEN", make: (id) => `hf_${body(id, 30)}` },
  {
    class: "sendgrid.api_key",
    tier: "HIGH",
    key: "SENDGRID_API_KEY",
    make: (id) => `SG.${body(id, 22)}.${body(Number(id) + 7, 22)}`,
  },
  { class: "pypi.token", tier: "HIGH", key: "PYPI_TOKEN", make: (id) => `pypi-${body(id, 40)}` },
  { class: "twilio.api_key", tier: "HIGH", key: "TWILIO_API_KEY", make: (id) => `SK${body(id, 32, HEX)}` },
  {
    class: "jwt.token",
    tier: "HIGH",
    key: "SESSION_JWT",
    make: (id) => `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ${body(id, 16)}.${body(Number(id) + 3, 24)}`,
  },
  {
    class: "db.dsn_credential",
    tier: "HIGH",
    key: "DATABASE_URL",
    make: (id) => `postgres://svc_user:${body(id, 20)}@db.example.test:5432/app`,
    // The endpoint is portable and stays in the clear; only the password has to go.
    secret: (id) => body(id, 20),
  },
  {
    class: "url.credential",
    tier: "HIGH",
    key: "MCP_ENDPOINT",
    make: (id) => `https://mcp.example.test/sse?access_token=${body(id, 28)}`,
    secret: (id) => body(id, 28),
  },
  {
    class: "http.authorization",
    tier: "HIGH",
    key: "Authorization",
    make: (id) => `Bearer ${body(id, 28)}`,
    // The scheme word is structure, not credential (RFC 6750): it stays.
    secret: (id) => body(id, 28),
  },
  { class: "env.kv", tier: "HIGH", key: "PGPASSWORD", make: (id) => `pw${body(id, 18)}` },
  { class: "twilio.account_sid", tier: "MEDIUM", key: "TWILIO_ACCOUNT_SID", make: (id) => `AC${body(id, 32, HEX)}` },
  { class: "figma.token", tier: "MEDIUM", key: "FIGMA_TOKEN", make: (id) => `figd_${body(id, 22)}` },
  { class: "linear.api_key", tier: "MEDIUM", key: "LINEAR_API_KEY", make: (id) => `lin_api_${body(id, 20)}` },
  { class: "provider.sk_opaque", tier: "MEDIUM", key: "ELEVENLABS_API_KEY", make: (id) => `sk_${body(id, 32, HEX)}` },
  { class: "card.number", tier: "LOW", key: "TEST_CARD", make: () => "4242424242424242" },
  {
    class: "unknown.high_entropy",
    tier: "LOW",
    key: "OPAQUE_BLOB",
    deep_only: true,
    make: (id) => body(id, 32),
  },
  {
    class: "pem.private_key",
    tier: "HIGH",
    key: "SIGNING_KEY",
    multiline: true,
    make: (id) =>
      `-----BEGIN RSA PRIVATE KEY-----\n${body(id, 60)}\n${body(Number(id) + 11, 60)}\n-----END RSA PRIVATE KEY-----`,
  },
];

class Corpus {
  constructor() {
    this.counter = 0;
    this.cursor = 0;
    this.placements = [];
  }

  /** Next secret, optionally restricted to classes a given surface can actually detect. */
  next({ deep = false, unique = true, noMultiline = false } = {}) {
    for (let attempts = 0; attempts < MAKERS.length * 2; attempts += 1) {
      const maker = MAKERS[this.cursor % MAKERS.length];
      this.cursor += 1;
      if (maker.deep_only && !deep) continue;
      if (maker.multiline && noMultiline) continue;
      this.counter += 1;
      const id = unique ? String(this.counter) : "1";
      return { ...maker, id, value: maker.make(id), key_name: `${maker.key}` };
    }
    throw new Error("no maker available");
  }

  place(secret, surface, { refused = false, detectable = true, detect = null } = {}) {
    const part = secret.secret ? secret.secret(secret.id) : secret.value;
    this.placements.push({
      value: secret.value,
      // The substring that must not appear in the bundle. For a DSN or a bearer header
      // that is a fragment of the value: the rest is structure the bundle keeps on purpose.
      secret: part,
      // What the detector is expected to have recorded. Usually the secret itself; for a
      // base64-wrapped value it is the wrapper, because an encoded blob cannot be spliced.
      detect: detect ?? part,
      class: secret.class,
      tier: secret.tier,
      key_name: secret.key_name,
      surface,
      refused,
      detectable,
    });
    return secret;
  }
}

async function editJson(file, mutate) {
  const parsed = JSON.parse(await readFile(file, "utf8"));
  mutate(parsed);
  await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`);
}

async function append(file, text) {
  const current = await readFile(file, "utf8").catch(() => "");
  await writeFile(file, `${current}${current.endsWith("\n") || current === "" ? "" : "\n"}${text}`);
}

/**
 * Materializes the standard fixture home and seeds it. Returns the placement table so a
 * test can compute recall per tier and attribute every miss to a surface.
 */
export async function seededHome({ perSurface = 14 } = {}) {
  const fixture = await materializeHome();
  const corpus = new Corpus();
  const home = fixture.home;
  const take = (count, options) => Array.from({ length: count }, () => corpus.next(options));

  // ── MCP env and headers, JSON (THR A2/A3) ────────────────────────────────────────
  await editJson(path.join(home, ".claude.json"), (store) => {
    const env = {};
    for (const secret of take(perSurface)) {
      env[`${secret.key_name}_${secret.id}`] = corpus.place(secret, "claude.mcp.env").value;
    }
    store.mcpServers.seeded_env = { command: "node", args: ["server.js"], env };

    const headers = {};
    for (const secret of take(3)) {
      headers[secret.class === "http.authorization" ? "Authorization" : `X-${secret.key_name}-${secret.id}`] =
        corpus.place(secret, "claude.mcp.headers").value;
    }
    const urlSecret = corpus.place(corpus.next({ noMultiline: true }), "claude.mcp.url");
    store.mcpServers.seeded_remote = {
      url: `https://mcp.example.test/sse?access_token=${urlSecret.value}`,
      headers,
    };
    const userinfo = corpus.place(corpus.next({ noMultiline: true }), "claude.mcp.url_userinfo");
    store.mcpServers.seeded_userinfo = { url: `https://svc:${userinfo.value}@mcp.example.test/sse` };
  });

  // ── settings: env block, permission rules, hooks, statusline (THR A1/B1) ─────────
  await editJson(path.join(home, ".claude", "settings.json"), (settings) => {
    for (const secret of take(perSurface)) {
      settings.env[`${secret.key_name}_${secret.id}`] = corpus.place(secret, "claude.settings.env").value;
    }

    // The live finding, reproduced: two provider keys inline in an env-prefix assignment
    // inside a permission rule string.
    for (const secret of take(perSurface, { deep: true, noMultiline: true })) {
      settings.permissions.allow.push(
        `Bash(${secret.key_name}_${secret.id}=${corpus.place(secret, "claude.permissions").value} cargo run:*)`,
      );
    }

    const hookSecrets = take(4, { noMultiline: true });
    settings.hooks.SessionStart = [
      {
        matcher: "*",
        hooks: hookSecrets.map((secret) => ({
          type: "command",
          command: `curl -H "Authorization: Bearer ${corpus.place(secret, "claude.hooks.argv").value}" https://api.example.test/ping`,
          timeout: 5,
        })),
      },
    ];
    const statusSecret = corpus.place(corpus.next({ noMultiline: true }), "claude.statusline.argv");
    settings.statusLine = {
      type: "command",
      command: `/usr/local/bin/status --token ${statusSecret.value}`,
    };
  });

  // ── Codex config: TOML mcp env, http_headers, shell env policy (THR A2/A3/B7) ───
  const tomlEnv = take(perSurface, { noMultiline: true }).map(
    (secret) => `${secret.key_name}_${secret.id} = "${corpus.place(secret, "codex.mcp.env").value}"`,
  );
  const tomlHeaders = take(3, { noMultiline: true }).map((secret) => {
    const name = secret.class === "http.authorization" ? "Authorization" : `X-${secret.key_name}-${secret.id}`;
    return `${name} = "${corpus.place(secret, "codex.mcp.http_headers").value}"`;
  });
  const shellEnv = take(4, { noMultiline: true }).map(
    (secret) => `${secret.key_name}_${secret.id} = "${corpus.place(secret, "codex.shell_env_policy").value}"`,
  );
  const codexUrl = corpus.place(corpus.next({ noMultiline: true }), "codex.mcp.url");
  await append(
    path.join(home, ".codex", "config.toml"),
    [
      "",
      "[mcp_servers.seeded_env]",
      'command = "node"',
      `env = { ${tomlEnv.join(", ")} }`,
      "",
      "[mcp_servers.seeded_remote]",
      `url = "https://mcp.example.test/sse?access_token=${codexUrl.value}"`,
      `http_headers = { ${tomlHeaders.join(", ")} }`,
      "",
      "[shell_environment_policy]",
      `set = { ${shellEnv.join(", ")} }`,
      "",
    ].join("\n"),
  );

  // ── prose: instructions, project instructions, memories (THR B3/B5) ─────────────
  const prose = (secrets, heading) =>
    [
      "",
      `## ${heading}`,
      "",
      ...secrets.map(
        (secret, index) =>
          [
            `Use \`${secret.key_name}_${secret.id}=${secret.value}\` for the smoke test.`,
            `The ${secret.class} value is ${secret.value} until it is rotated.`,
            `export ${secret.key_name}_${secret.id}=${secret.value}`,
          ][index % 3],
      ),
      "",
    ].join("\n");

  for (const [file, heading] of [
    [path.join(home, ".claude", "CLAUDE.md"), "Seeded operator notes"],
    [path.join(home, "projects", "app", "CLAUDE.md"), "Seeded project notes"],
    [path.join(home, ".codex", "AGENTS.md"), "Seeded agent notes"],
    [path.join(home, ".codex", "memories", "MEMORY.md"), "Seeded memory"],
    [path.join(home, ".codex", "prompts", "review.md"), "Seeded prompt notes"],
    [path.join(home, ".claude", "rules", "style.md"), "Seeded rule notes"],
    [path.join(home, ".claude", "output-styles", "terse.md"), "Seeded style notes"],
  ]) {
    const secrets = take(perSurface, { deep: true }).map((secret) =>
      corpus.place(secret, `prose:${path.basename(path.dirname(file))}/${path.basename(file)}`),
    );
    await append(file, prose(secrets, heading));
  }

  // Claude auto-memory lives in a munged project directory materialize.js already renamed.
  const memoryDir = path.join(home, ".claude", "projects");
  const munged = (await readdir(memoryDir)).find((name) => name.includes("projects-app"));
  if (munged) {
    const secrets = take(perSurface, { deep: true }).map((secret) => corpus.place(secret, "claude.memory.auto"));
    await append(path.join(memoryDir, munged, "memory", "decisions.md"), prose(secrets, "Seeded decisions"));
  }

  // ── skill frontmatter AND body, subagent frontmatter (THR B6) ───────────────────
  const skillDir = path.join(home, ".claude", "skills", "seeded-skill");
  await mkdir(skillDir, { recursive: true });
  const frontmatterSecrets = take(3, { deep: true, noMultiline: true }).map((secret) => corpus.place(secret, "claude.skill.frontmatter"));
  const bodySecrets = take(perSurface, { deep: true }).map((secret) => corpus.place(secret, "claude.skill.body"));
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: seeded-skill",
      "description: a skill whose frontmatter and body both carry seeded credentials",
      ...frontmatterSecrets.map((secret) => `${secret.key_name.toLowerCase()}_${secret.id}: ${secret.value}`),
      "---",
      "",
      "# Seeded skill",
      "",
      ...bodySecrets.map((secret) => `- \`${secret.key_name}_${secret.id}=${secret.value}\``),
      "",
    ].join("\n"),
  );

  const subagentSecrets = take(4, { deep: true }).map((secret) => corpus.place(secret, "claude.subagent"));
  await append(
    path.join(home, ".claude", "agents", "reviewer.md"),
    prose(subagentSecrets, "Seeded reviewer notes"),
  );

  // ── base64-wrapped (T-R10) ──────────────────────────────────────────────────────
  const wrapped = take(3, { deep: true }).map((secret) => {
    const encoded = Buffer.from(`${secret.key_name}=${secret.value}`).toString("base64");
    corpus.place(secret, "base64", { detect: encoded });
    return { secret, encoded };
  });
  await append(
    path.join(home, ".claude", "CLAUDE.md"),
    [
      "",
      "## Seeded encoded blobs",
      "",
      ...wrapped.map((entry) => `Decode this before use: ${entry.encoded}`),
      "",
    ].join("\n"),
  );

  // ── a scan-and-refuse surface: the bytes must never reach the bundle at all ─────
  const ruleSecrets = take(3, { noMultiline: true }).map((secret) => corpus.place(secret, "codex.rules", { refused: true, detectable: false }));
  await append(
    path.join(home, ".codex", "rules", "default.rules"),
    `${ruleSecrets
      .map((secret) => `prefix_rule(["curl", "-H", "Authorization: Bearer ${secret.value}"], decision = "allow")`)
      .join("\n")}\n`,
  );

  // ── the same value in two different surfaces: one ref, two sites (T-R5) ─────────
  const shared = corpus.next({ noMultiline: true });
  shared.value = `ghp_${body(999, 36)}`;
  corpus.place(shared, "shared:settings.env");
  corpus.place(shared, "shared:prose");
  await editJson(path.join(home, ".claude", "settings.json"), (settings) => {
    settings.env.SHARED_GITHUB_TOKEN = shared.value;
  });
  await append(
    path.join(home, ".codex", "AGENTS.md"),
    `\nThe same token is also pasted here: ${shared.value}\n`,
  );

  return { ...fixture, placements: corpus.placements, sharedValue: shared.value };
}

/** The precision corpus (Gate 2's paired half): none of this may be redacted. */
export const PRECISION_LINES = [
  "API_TOKEN=${API_TOKEN}",
  "API_TOKEN=$API_TOKEN",
  "API_TOKEN=<YOUR_TOKEN>",
  "SESSION_SECRET=changeme",
  "SLACK_TOKEN=xoxb-your-token-here",
  "STRIPE_KEY=sk_live_your-key-here",
  "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
  "Authorization: Bearer $API_TOKEN",
  "Authorization: Bearer <YOUR_TOKEN>",
  "DATABASE_URL=postgres://user:password@localhost:5432/app",
  "GitHub tokens start with ghp_ and Slack tokens with xoxb-.",
  "Replace the value with <redacted> and keep the key name.",
  "Redact any value assigned to a key matching `token`, `secret`, or `password`.",
  "- keywords: everything the reader should know",
  "author: Jane Doe",
  "Token: describe the token you want to use here",
  "MY_TOKEN=abcdefg",
  "API_KEY=",
];
