import assert from "node:assert/strict";
import test from "node:test";
import { parseEnvFile } from "../src/env.js";

test("parses standard dotenv values without exposing them through diagnostics", () => {
  const parsed = parseEnvFile("A=one\nexport B='two words'\nC=three # comment\n");
  assert.deepEqual(parsed.entries, { A: "one", B: "two words", C: "three" });
  assert.deepEqual(parsed.skippedLines, []);
});

test("skips invalid keys", () => {
  const parsed = parseEnvFile("GOOD=yes\nbad-key=no\nnot an assignment\n");
  assert.deepEqual(parsed.entries, { GOOD: "yes" });
  assert.deepEqual(parsed.skippedLines, [2, 3]);
});
