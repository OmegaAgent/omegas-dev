import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "../src/env.js";
import * as dotenv from "../src/core/formats/dotenv.js";
import * as json from "../src/core/formats/json.js";
import * as jsonc from "../src/core/formats/jsonc.js";
import * as mdFrontmatter from "../src/core/formats/md-frontmatter.js";
import * as toml from "../src/core/formats/toml.js";
import { FORMATS, formatFor } from "../src/core/formats/index.js";
import { byteIndex, byteTable, codeUnitIndex, lineAt, lineOffsets } from "../src/core/formats/spans.js";

const fixtures = fileURLToPath(new URL("./fixtures/formats/", import.meta.url));

// filename -> the format name the descriptor would carry.
const CORPUS = [
  ["settings.json", "json"],
  ["unicode.json", "json"],
  ["settings.jsonc", "jsonc"],
  ["config.toml", "toml"],
  ["unicode.toml", "toml"],
  ["skill.md", "md+frontmatter"],
  ["unicode.md", "md+frontmatter"],
  ["no-frontmatter.md", "md+frontmatter"],
  ["sample.env", "dotenv"],
  ["edge.env", "dotenv"],
];

function fixture(name) {
  return readFileSync(fixtures + name, "utf8");
}

function sliceBytes(text, span) {
  return Buffer.from(text, "utf8").subarray(span.byte_start, span.byte_end).toString("utf8");
}

// The property the whole write path rests on: a targeted edit moves the bytes of one key and
// nothing else — comments, key order and whitespace included.
function assertOnlyRangeChanged(before, after, span, replacement) {
  const source = Buffer.from(before, "utf8");
  const result = Buffer.from(after, "utf8");
  const width = Buffer.byteLength(replacement, "utf8");
  assert.equal(
    result.subarray(0, span.byte_start).toString("utf8"),
    source.subarray(0, span.byte_start).toString("utf8"),
    "bytes before the edited span changed",
  );
  assert.equal(result.subarray(span.byte_start, span.byte_start + width).toString("utf8"), replacement);
  assert.equal(
    result.subarray(span.byte_start + width).toString("utf8"),
    source.subarray(span.byte_end).toString("utf8"),
    "bytes after the edited span changed",
  );
  assert.equal(result.length, source.length - (span.byte_end - span.byte_start) + width);
}

test("every registered format answers the uniform contract", () => {
  for (const [name, format] of Object.entries(FORMATS)) {
    assert.equal(typeof format.id, "string", `${name} has no id`);
    for (const member of ["parse", "patch", "serialize"]) {
      assert.equal(typeof format[member], "function", `${name}.${member} is missing`);
    }
  }
  assert.deepEqual(Object.keys(FORMATS), [
    "json",
    "jsonc",
    "toml",
    "md+frontmatter",
    "md",
    "dotenv",
    "starlark",
    "opaque",
    "binary",
  ]);
  assert.equal(formatFor("md+frontmatter").id, "md+frontmatter");
  assert.equal(formatFor("md").id, "md");
});

test("formatFor names the format it does not know", () => {
  assert.throws(() => formatFor("yaml"), /no parser registered for format "yaml"/);
  assert.throws(() => formatFor("__proto__"), /no parser registered/);
});

test("opaque carries an unparseable file without a special case", () => {
  const opaque = formatFor("opaque");
  const text = "\u0000binary-ish\u0001";
  assert.deepEqual(opaque.parse(text), { value: null, key_order: {}, spans: {} });
  assert.equal(opaque.patch(text, []), text);
  assert.equal(
    opaque.patch("abcdef", [{ span: { byte_start: 2, byte_end: 4 }, replacement: "ZZ" }]),
    "abZZef",
  );
  assert.throws(() => opaque.patch("abc", [{ key_path: "a", replacement: "x" }]), /unknown key_path/);
  assert.equal(formatFor("binary").id, "binary");
});

test("patch(text, []) is byte-exact for every fixture in the corpus", () => {
  for (const [name, format] of CORPUS) {
    const text = fixture(name);
    const patched = formatFor(format).patch(text, []);
    assert.equal(patched, text, `${name} changed under an empty patch`);
    assert.ok(
      Buffer.from(patched, "utf8").equals(Buffer.from(text, "utf8")),
      `${name} is not byte-identical`,
    );
  }
});

test("every parsed key has a span, and every span slices back to real source bytes", () => {
  for (const [name, format] of CORPUS) {
    const text = fixture(name);
    const parsed = formatFor(format).parse(text);
    assert.ok(parsed.spans.$, `${name} has no root span`);
    for (const [path, span] of Object.entries(parsed.spans)) {
      assert.ok(Number.isInteger(span.byte_start), `${name} ${path} byte_start`);
      assert.ok(span.byte_end >= span.byte_start, `${name} ${path} is inverted`);
      assert.ok(span.line_start >= 1 && span.line_end >= span.line_start, `${name} ${path} lines`);
      assert.ok(
        span.byte_end <= Buffer.byteLength(text, "utf8"),
        `${name} ${path} runs past the end of the file`,
      );
      // A span that is not on a character boundary would make patch unable to splice it.
      assert.doesNotThrow(() => codeUnitIndex(text, span.byte_start), `${name} ${path}`);
      assert.doesNotThrow(() => codeUnitIndex(text, span.byte_end), `${name} ${path}`);
    }
  }
});

test("byte offsets are true UTF-8 byte offsets, not code-unit indices", () => {
  const text = fixture("unicode.json");
  const { spans } = json.parse(text);
  assert.equal(sliceBytes(text, spans.title), '"Ωmegas — évidence d\'abord"');
  assert.equal(sliceBytes(text, spans.note), '"多言語のテスト"');
  assert.equal(sliceBytes(text, spans["nested.emoji"]), '"🜲 sigil"');
  assert.equal(sliceBytes(text, spans["nested.plain"]), '"ascii-after-the-multibyte-values"');
  assert.equal(sliceBytes(text, spans.tail), "7");
  // The spike recorded code-unit indices here, which is the defect this proves fixed: a key after
  // multibyte content must sit at a HIGHER byte offset than its code-unit index.
  assert.ok(spans.tail.byte_start > text.indexOf("7\n"));
  assert.equal(spans.tail.byte_start, byteIndex(text, text.indexOf("7\n")));
});

test("toml byte offsets survive a multibyte comment and multibyte values", () => {
  const text = fixture("unicode.toml");
  const { spans } = toml.parse(text);
  assert.equal(sliceBytes(text, spans.title), '"Ωmegas — évidence d\'abord"');
  assert.equal(sliceBytes(text, spans.tagline), '"多言語のテスト"');
  assert.equal(sliceBytes(text, spans.plain), '"ascii-after-the-multibyte-keys"');
  assert.equal(sliceBytes(text, spans["section.label"]), '"café"');
  assert.equal(sliceBytes(text, spans["section.count"]), "3");
  assert.ok(spans.title.byte_start > text.indexOf('"Ωmegas'), "the leading comment is multibyte");
  assert.equal(spans["section.count"].line_start, 8);
});

test("md and dotenv byte offsets survive multibyte content", () => {
  const markdown = fixture("unicode.md");
  const parsedMarkdown = mdFrontmatter.parse(markdown);
  assert.equal(sliceBytes(markdown, parsedMarkdown.spans.description), "Ωmegas — évidence d'abord, 多言語");
  assert.equal(sliceBytes(markdown, parsedMarkdown.spans.tail), "plain");
  assert.equal(sliceBytes(markdown, parsedMarkdown.spans.$body), parsedMarkdown.body);
  assert.equal(parsedMarkdown.body_offset, Buffer.byteLength(markdown.slice(0, markdown.length - parsedMarkdown.body.length), "utf8"));

  const env = fixture("sample.env");
  const parsedEnv = dotenv.parse(env);
  assert.equal(sliceBytes(env, parsedEnv.spans.UNICODE_LABEL), '"café — 多言語"');
  assert.equal(sliceBytes(env, parsedEnv.spans.API_TOKEN), "'tok-FAKEFAKEFAKE'");
});

test("the byte table agrees with Buffer for every fixture", () => {
  for (const [name] of CORPUS) {
    const text = fixture(name);
    const table = byteTable(text);
    assert.equal(table[text.length], Buffer.byteLength(text, "utf8"), name);
    for (let i = 0; i <= text.length; i += 1) {
      const previous = i > 0 ? text.charCodeAt(i - 1) : 0;
      // A position between the halves of a surrogate pair is not a byte boundary. The table
      // reports the end of the whole character there, so no span can ever land inside one;
      // Buffer.byteLength of a half-cut slice would count a U+FFFD instead.
      if (previous >= 0xd800 && previous <= 0xdbff) continue;
      assert.equal(table[i], Buffer.byteLength(text.slice(0, i), "utf8"), `${name} at ${i}`);
    }
  }
});

test("codeUnitIndex inverts byteIndex and rejects a mid-character offset", () => {
  const text = 'a"🜲"é';
  for (let i = 0; i <= text.length; i += 1) {
    assert.equal(codeUnitIndex(text, byteIndex(text, i)), text.charCodeAt(i - 1) >= 0xd800 && text.charCodeAt(i - 1) <= 0xdbff ? i + 1 : i);
  }
  assert.throws(() => codeUnitIndex(text, 3), /not a UTF-8 character boundary/);
  assert.throws(() => codeUnitIndex(text, 9999), /not a UTF-8 character boundary/);
  assert.throws(() => byteIndex(text, -1), /outside the text/);
});

test("line offsets are 1-based and inclusive", () => {
  const offsets = lineOffsets("a\nbb\n\nccc");
  assert.deepEqual(offsets, [0, 2, 5, 6]);
  assert.equal(lineAt(offsets, 0), 1);
  assert.equal(lineAt(offsets, 2), 2);
  assert.equal(lineAt(offsets, 5), 3);
  assert.equal(lineAt(offsets, 8), 4);
});

test("a targeted json edit changes only that key's bytes", () => {
  const text = fixture("settings.json");
  const { spans } = json.parse(text);
  const replacement = '"${OMEGAS_SECRET_1}"';
  const patched = json.patch(text, [{ key_path: "env.ANTHROPIC_API_KEY", replacement }]);
  assertOnlyRangeChanged(text, patched, spans["env.ANTHROPIC_API_KEY"], replacement);
  const reparsed = json.parse(patched);
  assert.equal(reparsed.value.env.ANTHROPIC_API_KEY, "${OMEGAS_SECRET_1}");
  assert.equal(reparsed.value.env.OMEGA_FEATURE_FLAGS, "teams");
  assert.deepEqual(reparsed.key_order, json.parse(text).key_order);
});

test("a targeted jsonc edit leaves comments, trailing commas and key order alone", () => {
  const text = fixture("settings.jsonc");
  const parsed = jsonc.parse(text);
  assert.deepEqual(parsed.key_order.$, [
    "editor.tabSize",
    "files.associations",
    "omegas.enabled",
    "omegas.docs",
    "omegas.model",
  ]);
  assert.equal(parsed.value["omegas.docs"], "https://docs.example.test/guide");
  const replacement = '"claude-sonnet-4-6"';
  const patched = jsonc.patch(text, [{ key_path: "omegas.model", replacement }]);
  assertOnlyRangeChanged(text, patched, parsed.spans["omegas.model"], replacement);
  assert.ok(patched.includes("// Comments and a trailing comma"));
  assert.ok(patched.includes("/* an inline block comment */"));
  assert.ok(patched.includes('"*.pen": "json",\n  }'));
  assert.deepEqual(jsonc.parse(patched).key_order, parsed.key_order);
});

test("a targeted toml edit inside an inline table changes only that value", () => {
  const text = fixture("config.toml");
  const { spans } = toml.parse(text);
  const span = spans["mcp_servers.slack.env.SLACK_BOT_TOKEN"];
  assert.equal(sliceBytes(text, span), '"xoxb-FAKE-FAKE-FAKE"');
  const replacement = '"${OMEGAS_SECRET_2}"';
  const patched = toml.patch(text, [{ key_path: "mcp_servers.slack.env.SLACK_BOT_TOKEN", replacement }]);
  assertOnlyRangeChanged(text, patched, span, replacement);
  const reparsed = toml.parse(patched);
  assert.equal(reparsed.value.mcp_servers.slack.env.SLACK_BOT_TOKEN, "${OMEGAS_SECRET_2}");
  assert.equal(reparsed.value.mcp_servers.slack.env.SLACK_TEAM_ID, "T000FAKE");
  assert.ok(patched.includes("# dotted keys land in the same table"));
});

test("a targeted toml edit inside an array of tables changes only that element", () => {
  const text = fixture("config.toml");
  const { spans } = toml.parse(text);
  const span = spans["hooks.PreToolUse[1].command"];
  assert.equal(sliceBytes(text, span), "'C:\\tools\\audit.exe'");
  const replacement = '"./scripts/audit.sh"';
  const patched = toml.patch(text, [{ key_path: "hooks.PreToolUse[1].command", replacement }]);
  assertOnlyRangeChanged(text, patched, span, replacement);
  const reparsed = toml.parse(patched);
  assert.equal(reparsed.value.hooks.PreToolUse[0].command, "./scripts/guard.sh");
  assert.equal(reparsed.value.hooks.PreToolUse[1].command, "./scripts/audit.sh");
  assert.ok(patched.includes("# a literal string keeps its backslashes"));
});

test("two non-overlapping toml edits apply right to left", () => {
  const text = fixture("config.toml");
  const parsed = toml.parse(text);
  const patched = toml.patch(text, [
    { key_path: "model", replacement: '"gpt-5"' },
    { key_path: "notice.mixed_array[1]", replacement: '"TWO"' },
  ]);
  const reparsed = toml.parse(patched);
  assert.equal(reparsed.value.model, "gpt-5");
  assert.deepEqual(reparsed.value.notice.mixed_array, [1, "TWO", true, 4.5]);
  assert.deepEqual(reparsed.key_order.$, parsed.key_order.$);
});

test("a targeted md+frontmatter edit leaves the body and the other keys alone", () => {
  const text = fixture("skill.md");
  const parsed = mdFrontmatter.parse(text);
  const replacement = "A shorter description.";
  const patched = mdFrontmatter.patch(text, [{ key_path: "description", replacement }]);
  assertOnlyRangeChanged(text, patched, parsed.spans.description, replacement);
  const reparsed = mdFrontmatter.parse(patched);
  assert.equal(reparsed.frontmatter.description, replacement);
  assert.equal(reparsed.body, parsed.body);
  assert.deepEqual(reparsed.key_order, parsed.key_order);
  assert.ok(patched.includes("# the underscore variant outnumbers"));
});

test("toml reads tables, dotted keys, inline tables and arrays of tables", () => {
  const parsed = toml.parse(fixture("config.toml"));
  assert.deepEqual(parsed.value.tools, { web_search: true, view_image: false });
  assert.deepEqual(parsed.value.mcp_servers.slack.env, {
    SLACK_BOT_TOKEN: "xoxb-FAKE-FAKE-FAKE",
    SLACK_TEAM_ID: "T000FAKE",
  });
  assert.deepEqual(parsed.value.mcp_servers.notion.env, { NOTION_TOKEN: "ntn_FAKEFAKEFAKE" });
  assert.equal(parsed.value.hooks.PreToolUse.length, 2);
  assert.deepEqual(parsed.value.hooks.PreToolUse[0], {
    matcher: "Bash",
    command: "./scripts/guard.sh",
    timeout_sec: 5,
  });
  assert.deepEqual(parsed.value.shell_environment_policy.exclude, ["AWS_*", "AZURE_*"]);
  assert.deepEqual(parsed.value.notice.mixed_array, [1, "two", true, 4.5]);
  assert.deepEqual(parsed.key_order["mcp_servers.slack.env"], ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"]);
  assert.deepEqual(parsed.key_order["hooks.PreToolUse[1]"], ["matcher", "command", "timeout_sec"]);
  assert.deepEqual(parsed.key_order.tools, ["web_search", "view_image"]);
  assert.deepEqual(parsed.key_order.$.slice(0, 6), [
    "model",
    "model_provider",
    "approval_policy",
    "startup_timeout_sec",
    "disable_response_storage",
    "tools",
  ]);
});

test("toml dotted keys build containers with their own key_order and covering spans", () => {
  const text = "a.b.c = 1\na.b.d = 2\ne.f = { g.h = 3, i = 4 }\n\n[t]\nx.y = 5\n\n[[t.list]]\nz = 6\n\n[[t.list]]\nz = 7\n";
  const parsed = toml.parse(text);
  assert.deepEqual(parsed.value, {
    a: { b: { c: 1, d: 2 } },
    e: { f: { g: { h: 3 }, i: 4 } },
    t: { x: { y: 5 }, list: [{ z: 6 }, { z: 7 }] },
  });
  assert.deepEqual(parsed.key_order.$, ["a", "e", "t"]);
  assert.deepEqual(parsed.key_order["a.b"], ["c", "d"]);
  assert.deepEqual(parsed.key_order["e.f"], ["g", "i"]);
  assert.deepEqual(parsed.key_order["t.list[1]"], ["z"]);
  assert.equal(sliceBytes(text, parsed.spans["a.b"]), "a.b.c = 1\na.b.d = 2");
  assert.equal(sliceBytes(text, parsed.spans["e.f"]), "{ g.h = 3, i = 4 }");
  assert.equal(sliceBytes(text, parsed.spans["e.f.g.h"]), "3");
  assert.equal(sliceBytes(text, parsed.spans["t.list[0]"]), "[[t.list]]\nz = 6");
  assert.equal(toml.patch(text, [{ key_path: "a.b.d", replacement: "99" }]), text.replace("d = 2", "d = 99"));
});

test("toml numbers, booleans and datetimes", () => {
  const value = toml.parse(fixture("config.toml")).value;
  assert.equal(value.hex_mask, 0xdeadbeef);
  assert.equal(value.octal_mode, 0o755);
  assert.equal(value.binary_flags, 0b10101101);
  assert.equal(value.big_number, 1000000);
  assert.equal(value.negative, -17);
  assert.equal(value.startup_timeout_sec, 10);
  assert.equal(value.exponent, 6.626e-34);
  assert.equal(value.positive_infinity, Infinity);
  assert.ok(Number.isNaN(value.not_a_number));
  assert.equal(value.disable_response_storage, false);
  assert.equal(value.tools.web_search, true);
  // Datetimes keep their literal string form on purpose: losslessness over typing.
  assert.equal(value.created_at, "2026-07-30T09:15:00Z");
  assert.equal(value.local_day, "2026-07-30");
  assert.equal(value.local_moment, "2026-07-30 09:15:00");
  assert.equal(value.alarm, "07:32:00");
  const extra = toml.parse("a = -0b11\nb = +1_0\nc = 1e3\nd = -inf\ne = -0.5\nf = 1979-05-27T07:32:00-08:00\n").value;
  assert.deepEqual(extra, { a: -3, b: 10, c: 1000, d: -Infinity, e: -0.5, f: "1979-05-27T07:32:00-08:00" });
});

test("toml multi-line strings honour the leading-newline trim and the line-ending backslash", () => {
  const value = toml.parse(fixture("config.toml")).value;
  assert.equal(
    value.notice.banner,
    "Omegas continuity fixture banner.\nThis line ends with a backslash so it continues onto the same logical line.\n",
  );
  assert.equal(value.notice.pattern, "^\\d{3}-\\d{2}$\n");
  const quotes = toml.parse('a = """he said ""hi"" """\nb = \'\'\'raw \\n stays\'\'\'\nc = """\\u00e9\\t."""\n').value;
  assert.equal(quotes.a, 'he said ""hi"" ');
  assert.equal(quotes.b, "raw \\n stays");
  assert.equal(quotes.c, "é\t.");
});

test("a toml table span covers its children", () => {
  const text = fixture("config.toml");
  const { spans } = toml.parse(text);
  const covers = (parent, child) =>
    spans[parent].byte_start <= spans[child].byte_start && spans[parent].byte_end >= spans[child].byte_end;
  assert.ok(covers("mcp_servers", "mcp_servers.slack"));
  assert.ok(covers("mcp_servers", "mcp_servers.notion.env.NOTION_TOKEN"));
  assert.ok(covers("mcp_servers.slack", "mcp_servers.slack.env.SLACK_TEAM_ID"));
  assert.ok(covers("hooks", "hooks.PreToolUse[1]"));
  assert.ok(covers("hooks.PreToolUse", "hooks.PreToolUse[1].timeout_sec"));
  assert.ok(covers("tools", "tools.view_image"));
  assert.ok(spans["mcp_servers.slack"].byte_end <= spans["mcp_servers.notion"].byte_start);
  assert.equal(sliceBytes(text, spans["mcp_servers.notion.env"]).startsWith("[mcp_servers.notion.env]"), true);
  // Replacing a whole table replaces its header and its body together.
  const patched = toml.patch(text, [{ key_path: "profiles", replacement: "[profiles.audit]\nmodel = \"o4\"" }]);
  assert.deepEqual(toml.parse(patched).value.profiles, { audit: { model: "o4" } });
});

test("toml tolerates crlf, comments everywhere and a super-table declared late", () => {
  const crlf = "# lead\r\n[a]\r\nx = 1  # tail\r\n\r\n[b]\r\ny = [\r\n  1, # one\r\n  2,\r\n]\r\n";
  const parsed = toml.parse(crlf);
  assert.deepEqual(parsed.value, { a: { x: 1 }, b: { y: [1, 2] } });
  assert.equal(toml.patch(crlf, []), crlf);
  assert.equal(parsed.spans["b.y"].line_start, 6);
  assert.deepEqual(toml.parse("[a.b]\nx = 1\n[a]\ny = 2\n").value, { a: { b: { x: 1 }, y: 2 } });
});

test("toml refuses to redefine a key or a table", () => {
  assert.throws(() => toml.parse("a = 1\na = 2\n"), /key "a" is defined more than once/);
  assert.throws(() => toml.parse("[t]\nx = 1\n[t]\ny = 2\n"), /table "t" is defined more than once/);
  assert.throws(() => toml.parse("[t]\nx = 1\nx = 2\n"), /key "t.x" is defined more than once/);
  assert.throws(() => toml.parse("a.b = 1\na.b = 2\n"), /key "a.b" is defined more than once/);
  assert.throws(() => toml.parse("a = 1\n[a]\n"), /already defined as a value/);
  assert.throws(() => toml.parse("[[t]]\nx = 1\n[t]\n"), /already defined as an array of tables/);
  assert.throws(() => toml.parse("[t]\nx = 1\n[[t]]\n"), /already defined as a table/);
  assert.deepEqual(toml.parse("[[t]]\nx = 1\n[t.deep]\ny = 2\n").value, { t: [{ x: 1, deep: { y: 2 } }] });
  assert.throws(() => toml.parse("env = { A = \"1\", A = \"2\" }\n"), /defined more than once/);
});

test("toml names the byte offset of a syntax error", () => {
  assert.throws(() => toml.parse("a = \n"), SyntaxError);
  assert.throws(() => toml.parse('a = "unterminated\n'), /newline inside a single-line string at byte 17/);
  assert.throws(() => toml.parse('a = """unterminated\n'), /unterminated multi-line string at byte/);
  assert.throws(() => toml.parse("[a\n"), /expected '\]' at byte/);
  assert.throws(() => toml.parse("a = [1, 2\n"), /unterminated array/);
  assert.throws(() => toml.parse("a = maybe\n"), /unrecognized value "maybe"/);
  assert.throws(() => toml.parse("a = 1 b = 2\n"), /unexpected content after a value/);
});

test("toml serialize creates a file a parser reads back", () => {
  const source = toml.parse(fixture("config.toml"));
  const created = toml.serialize(source.value, source.key_order);
  const reparsed = toml.parse(created);
  assert.equal(reparsed.value.model, "gpt-5-codex");
  assert.equal(reparsed.value.hex_mask, 0xdeadbeef);
  assert.deepEqual(reparsed.value.tools, { web_search: true, view_image: false });
  assert.deepEqual(reparsed.value.hooks.PreToolUse, source.value.hooks.PreToolUse);
  assert.deepEqual(reparsed.value.mcp_servers.slack.env, source.value.mcp_servers.slack.env);
  // TOML forces sub-tables after their parent's bare keys, so key_order survives as a set and
  // within the scalar run, not as the author's exact interleaving.
  assert.deepEqual(new Set(reparsed.key_order.$), new Set(source.key_order.$));
  assert.deepEqual(reparsed.key_order.$.slice(0, 5), source.key_order.$.slice(0, 5));
  assert.deepEqual(
    new Set(reparsed.key_order["mcp_servers.slack"]),
    new Set(source.key_order["mcp_servers.slack"]),
  );
  assert.ok(created.includes("[[hooks.PreToolUse]]"));
  assert.ok(created.includes("[mcp_servers.slack]"));
  assert.ok(created.includes("positive_infinity = inf"));
  assert.equal(toml.serialize({}), "");
  assert.equal(
    toml.serialize({ b: 1, a: 2, t: { z: "x" } }, { $: ["a", "b"] }),
    'a = 2\nb = 1\n\n[t]\nz = "x"\n',
  );
});

test("md+frontmatter keeps unrecognized keys, both allowed-tools spellings and author order", () => {
  const parsed = mdFrontmatter.parse(fixture("skill.md"));
  assert.deepEqual(parsed.key_order, [
    "name",
    "description",
    "allowed_tools",
    "allowed-tools",
    "preamble-tier",
    "model.provider",
    "metadata",
    "summary",
  ]);
  assert.deepEqual(parsed.frontmatter.allowed_tools, ["Read", "Grep", "Bash"]);
  assert.deepEqual(parsed.frontmatter["allowed-tools"], ["Read", "Write"]);
  assert.deepEqual(parsed.frontmatter.metadata, { owner: "platform", visibility: "private" });
  assert.equal(parsed.frontmatter["preamble-tier"], "2");
  assert.equal(parsed.frontmatter["model.provider"], "anthropic");
  assert.equal(parsed.frontmatter.summary, "A folded block scalar that runs onto a second line.");
  assert.equal(parsed.body.startsWith("\n# design-review"), true);
  assert.equal(parsed.value.frontmatter, parsed.frontmatter);
  assert.equal(parsed.value.body, parsed.body);
});

test("md+frontmatter records a span for every key, list item and nested child", () => {
  const text = fixture("skill.md");
  const { spans } = mdFrontmatter.parse(text);
  assert.equal(sliceBytes(text, spans.name), "design-review");
  assert.equal(sliceBytes(text, spans.allowed_tools), "[Read, Grep, Bash]");
  assert.equal(sliceBytes(text, spans["allowed_tools[1]"]), "Grep");
  assert.equal(sliceBytes(text, spans["allowed-tools[0]"]), "Read");
  assert.equal(sliceBytes(text, spans["metadata.visibility"]), "private");
  assert.equal(sliceBytes(text, spans["model.provider"]), "anthropic");
  const replacement = "public";
  const patched = mdFrontmatter.patch(text, [{ key_path: "metadata.visibility", replacement }]);
  assertOnlyRangeChanged(text, patched, spans["metadata.visibility"], replacement);
  assert.deepEqual(mdFrontmatter.parse(patched).frontmatter.metadata, { owner: "platform", visibility: "public" });
});

test("md+frontmatter handles a file with no frontmatter and the plain md format", () => {
  const text = fixture("no-frontmatter.md");
  const parsed = mdFrontmatter.parse(text);
  assert.equal(parsed.frontmatter, null);
  assert.equal(parsed.body, text);
  assert.equal(parsed.body_offset, 0);
  assert.deepEqual(parsed.key_order, []);
  assert.equal(mdFrontmatter.patch(text, []), text);

  const plain = formatFor("md");
  const asMarkdown = plain.parse(fixture("skill.md"));
  assert.equal(asMarkdown.frontmatter, null);
  assert.equal(asMarkdown.body, fixture("skill.md"));
  assert.equal(plain.patch(fixture("skill.md"), []), fixture("skill.md"));
  assert.equal(plain.serialize({ body: "hello" }), "hello");
});

test("a leading byte-order mark does not cost the user the file", () => {
  const bom = "\uFEFF";
  assert.deepEqual(json.parse(`${bom}{"a": 1}`).value, { a: 1 });
  assert.deepEqual(toml.parse(`${bom}a = 1\n`).value, { a: 1 });
  assert.deepEqual(mdFrontmatter.parse(`${bom}---\nname: x\n---\nbody\n`).frontmatter, { name: "x" });
  assert.deepEqual(dotenv.parse(`${bom}A=1\n`).value, { A: "1" });
  for (const [format, text] of [
    ["json", `${bom}{"a": 1}`],
    ["toml", `${bom}a = 1\n`],
    ["md+frontmatter", `${bom}---\nname: x\n---\nbody\n`],
    ["dotenv", `${bom}A=1\n`],
  ]) {
    assert.equal(formatFor(format).patch(text, []), text);
  }
  // The BOM is three bytes, so every span after it must be offset by three.
  assert.equal(toml.parse(`${bom}a = 1\n`).spans.a.byte_start, toml.parse("a = 1\n").spans.a.byte_start + 3);
});

test("md+frontmatter parses an empty fence, a bare key and a comment-only block", () => {
  const empty = mdFrontmatter.parse("---\n---\nbody\n");
  assert.deepEqual(empty.frontmatter, {});
  assert.equal(empty.body, "body\n");
  const bare = mdFrontmatter.parse("---\nname: x\nempty:\n# note\n---\n");
  assert.deepEqual(bare.frontmatter, { name: "x", empty: "" });
  assert.deepEqual(bare.key_order, ["name", "empty"]);
  assert.equal(bare.body, "");
  assert.equal(bare.spans.empty.byte_start, bare.spans.empty.byte_end);
});

test("md+frontmatter serialize creates a file it can read back", () => {
  const source = mdFrontmatter.parse(fixture("skill.md"));
  const created = mdFrontmatter.serialize(source.value, source.key_order);
  const reparsed = mdFrontmatter.parse(created);
  assert.deepEqual(reparsed.key_order, source.key_order);
  assert.deepEqual(reparsed.frontmatter.allowed_tools, source.frontmatter.allowed_tools);
  assert.deepEqual(reparsed.frontmatter["allowed-tools"], source.frontmatter["allowed-tools"]);
  assert.deepEqual(reparsed.frontmatter.metadata, source.frontmatter.metadata);
  assert.equal(reparsed.body, source.body);
  assert.equal(mdFrontmatter.serialize({ frontmatter: null, body: "just body" }), "just body");
});

test("dotenv matches src/env.js exactly on the same inputs", () => {
  const inputs = [
    fixture("sample.env"),
    fixture("edge.env"),
    "A=one\nexport B='two words'\nC=three # comment\n",
    "GOOD=yes\nbad-key=no\nnot an assignment\n",
    "\uFEFFBOM=yes\r\nCRLF=ok\r\n",
    "MULTI=\"line\nbroken\"\n",
    "  PADDED_KEY  =  padded value  \n",
    "EQUALS=a=b=c\n",
    "",
  ];
  for (const text of inputs) {
    const reference = parseEnvFile(text);
    const parsed = dotenv.parse(text);
    assert.deepEqual(parsed.value, reference.entries, JSON.stringify(text));
    assert.deepEqual(parsed.skipped_lines, reference.skippedLines, JSON.stringify(text));
    assert.deepEqual(parsed.key_order.$, Object.keys(reference.entries));
    assert.equal(dotenv.patch(text, []), text);
  }
});

test("dotenv spans point at the raw value and patch replaces only it", () => {
  const text = fixture("sample.env");
  const parsed = dotenv.parse(text);
  assert.equal(sliceBytes(text, parsed.spans.COMMENTED), "plain-value");
  assert.equal(sliceBytes(text, parsed.spans.QUOTED_MESSAGE), '"line one\\nline two"');
  assert.equal(sliceBytes(text, parsed.spans.SPACED), "padded");
  assert.equal(parsed.value.QUOTED_MESSAGE, "line one\nline two");
  const replacement = "${OMEGAS_SECRET_3}";
  const patched = dotenv.patch(text, [{ key_path: "API_TOKEN", replacement }]);
  assertOnlyRangeChanged(text, patched, parsed.spans.API_TOKEN, replacement);
  assert.ok(patched.includes("# fixture: fake values only"));
  assert.ok(patched.includes("COMMENTED=plain-value # this trailing comment is stripped"));
  assert.equal(dotenv.parse(patched).value.API_TOKEN, "${OMEGAS_SECRET_3}");
});

test("dotenv serialize and environmentFromFilename", () => {
  const created = dotenv.serialize({ A: "one", B: "two words", C: "" }, { $: ["C", "A"] });
  assert.equal(created, 'C=\nA=one\nB="two words"\n');
  assert.deepEqual(parseEnvFile(created).entries, { C: "", A: "one", B: "two words" });
  assert.equal(dotenv.environmentFromFilename(".env.local"), "local");
  assert.equal(dotenv.environmentFromFilename(".env.production"), "production");
  assert.equal(dotenv.environmentFromFilename(".env.whatever"), "custom");
});

test("json rejects invalid input with a SyntaxError naming the offset", () => {
  assert.throws(() => json.parse("{ bad }"), SyntaxError);
  assert.throws(() => json.parse('{"a": 1,}'), /expected a string at byte 8/);
  assert.throws(() => json.parse('{"a" 1}'), /expected ':' at byte 5/);
  assert.throws(() => json.parse('{"a": 01}'), /expected '}' or ',' at byte 7/);
  assert.throws(() => json.parse('{"a": "x"} trailing'), /unexpected trailing content at byte 11/);
  assert.throws(() => json.parse('{"a": "unterminated'), /unterminated string at byte 19/);
  assert.throws(() => json.parse("// comment\n{}"), /unexpected token at byte 0/);
  assert.throws(() => json.parse(""), /unexpected end of input at byte 0/);
  assert.throws(() => json.parse('{"a": "\\q"}'), /invalid escape/);
  // jsonc accepts exactly the two things json rejects here.
  assert.deepEqual(jsonc.parse('// comment\n{"a": 1,}').value, { a: 1 });
});

test("patch rejects overlapping, malformed and unknown edits", () => {
  const text = fixture("settings.json");
  assert.throws(
    () =>
      json.patch(text, [
        { span: { byte_start: 0, byte_end: 20 }, replacement: "x" },
        { span: { byte_start: 10, byte_end: 30 }, replacement: "y" },
      ]),
    /overlapping edits: bytes 0-20 and 10-30/,
  );
  assert.throws(
    () =>
      json.patch(text, [
        { span: { byte_start: 5, byte_end: 5 }, replacement: "x" },
        { span: { byte_start: 5, byte_end: 5 }, replacement: "y" },
      ]),
    /overlapping edits/,
  );
  assert.throws(() => json.patch(text, [{ key_path: "no.such.key", replacement: "x" }]), /unknown key_path "no.such.key"/);
  assert.throws(() => json.patch(text, [{ key_path: "model" }]), /needs a string replacement/);
  assert.throws(() => json.patch(text, [{ replacement: "x" }]), /needs either a key_path or a span/);
  assert.throws(() => json.patch(text, "nope"), TypeError);
  assert.throws(
    () => json.patch(text, [{ span: { byte_start: 9, byte_end: 2 }, replacement: "x" }]),
    /byte_end before byte_start/,
  );
  // Adjacent, non-overlapping edits are fine.
  assert.equal(
    json.patch("abcdef", [
      { span: { byte_start: 0, byte_end: 2 }, replacement: "AB" },
      { span: { byte_start: 2, byte_end: 4 }, replacement: "CD" },
    ]),
    "ABCDef",
  );
});

test("json serialize honours key_order and json parses a root array", () => {
  const created = json.serialize({ b: 1, a: { d: 2, c: 3 } }, { $: ["a", "b"], a: ["c", "d"] });
  assert.equal(created, '{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}\n');
  const rootArray = json.parse('["a", {"b": 1}]');
  assert.deepEqual(rootArray.value, ["a", { b: 1 }]);
  assert.equal(rootArray.spans["$[0]"].byte_start, 1);
  assert.deepEqual(rootArray.key_order["$[1]"], ["b"]);
  assert.equal(json.parse('{"__proto__": {"polluted": true}}').value.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});
