const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function environmentFromFilename(filename) {
  if (filename === ".env.local") return "local";
  if (filename === ".env.test") return "test";
  if (filename === ".env.prod" || filename === ".env.production") return "production";
  if (filename === ".env.dev" || filename === ".env.development") return "development";
  return "custom";
}

// Deliberately conservative dotenv parser. Invalid/multiline entries are skipped instead of being
// guessed. Variable names and values are never printed by the CLI.
export function parseEnvFile(text) {
  const entries = {};
  const skippedLines = [];
  for (const [index, rawLine] of text.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trimStart();
    const equals = line.indexOf("=");
    if (equals <= 0) {
      skippedLines.push(index + 1);
      continue;
    }
    const key = line.slice(0, equals).trim();
    if (!VALID_KEY.test(key)) {
      skippedLines.push(index + 1);
      continue;
    }
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
      }
    } else {
      value = value.replace(/\s+#.*$/, "").trimEnd();
    }
    entries[key] = value;
  }
  return { entries, skippedLines };
}
