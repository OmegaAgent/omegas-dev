// Subcommand routing, the `--json` result envelope, and the exit-code contract
// (adapter-architecture §6.1). Codes and the envelope are part of the published
// contract with the hosted layer and change only with a major version.

import os from "node:os";
import path from "node:path";
import process from "node:process";
import { ADAPTERS } from "../core/adapters/registry.js";
import { PAYLOAD_POLICIES } from "../core/bundle/write.js";
import { buildEnvironment } from "../core/engine/environment.js";
import { runScan } from "../core/engine/pipeline.js";
import { runDiff } from "./diff.js";
import { runExport } from "./export.js";
import { runEnable, runImport, terminalIo } from "./import.js";
import { renderReport } from "./report.js";
import { renderScan, scanEnvelope } from "./scan.js";

export const SCHEMA_VERSION = "omegas.continuity.v1";

export const EXIT = {
  OK: 0,
  USAGE: 1,
  NO_RUNTIME: 2,
  WARNINGS: 3,
  // The post-export gate. Distinct from every other failure because it means the tool
  // caught ITSELF about to write a secret, which a user must never confuse with a config
  // problem on their machine (THR §3.5).
  REDACTION_GATE: 5,
  // The import side. 6-9 are the codes the hosted layer must handle distinctly, because
  // they are the difference between "retry" and "stop and tell a human".
  INTEGRITY: 6,
  ENTRY_REFUSED: 7,
  TOCTOU: 8,
  ROLLED_BACK: 9,
  VERSION_INCOMPATIBLE: 10,
};

const COMMANDS = new Set(["scan", "report", "export", "diff", "import", "enable"]);
const IMPORT_COMMANDS = new Set(["diff", "import", "enable"]);

export function isSubcommand(argv) {
  return argv.length > 0 && COMMANDS.has(argv[0]);
}

export function commandHelp() {
  return (
    `Usage: omegas-dev <command> [options]\n\n` +
    `  scan     Read every declared configuration surface and print what was found\n` +
    `  report   The same scan, rendered as a multi-section report\n` +
    `  export   Write a redacted, content-addressed bundle you can share\n` +
    `  diff     Preview exactly what importing a bundle would write. Writes nothing\n` +
    `  import   Walk the same plan and apply only what you consent to, item by item\n` +
    `  enable   Turn on one quarantined item, after showing you what it is\n\n` +
    `Options\n` +
    `  --home <dir>   Home directory to read (default: your home directory)\n` +
    `  --root <dir>   Project root to scan for project-scope config (repeatable)\n` +
    `  --json         Emit the machine-readable result envelope on stdout\n` +
    `  --max-file-bytes <n>  Per-file read cap; a breach is truncated and reported, never dropped\n` +
    `  --out <path>          export only: where to write the bundle\n` +
    `  --payload-policy <p>  export only: ${PAYLOAD_POLICIES.join(" | ")} (default: definition)\n` +
    `  --bundle <path>       diff / import: the bundle to read\n` +
    `  --yes-inert           import only: bulk-accept inert additions. Never covers an\n` +
    `                        authority item, an executable item, or a replacement\n` +
    `  --help, -h     Show this help\n\n` +
    `scan, report and diff are read-only. export writes exactly one shareable artifact and\n` +
    `it is the redacted one: values are replaced by {{OMEGA_REDACTED:class:ref}} placeholders,\n` +
    `there is no --include-secrets flag, and the serialized bytes are re-scanned before\n` +
    `they reach the disk (a hit aborts with exit 5 and writes nothing). import applies\n` +
    `nothing without a recorded consent against a specific rendered diff, lands every\n` +
    `executable item disabled, and rolls the whole apply back on any failure. No command\n` +
    `here uses the network or a subprocess. Run \`omegas-dev\` with no command for the\n` +
    `hosted transfer flow, which is the only path that contacts a server.\n`
  );
}

export function parseArgs(argv) {
  const options = {
    command: argv[0],
    roots: [],
    home: null,
    json: false,
    help: false,
    maxFileBytes: null,
    out: null,
    payloadPolicy: "definition",
    bundle: null,
    yesInert: false,
    itemId: null,
  };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--bundle") {
      const value = argv[++i];
      if (!value) throw new UsageError("--bundle requires a path");
      if (!IMPORT_COMMANDS.has(options.command)) throw new UsageError("--bundle applies to `diff` and `import` only");
      options.bundle = value;
    } else if (arg === "--yes-inert") {
      if (options.command !== "import") throw new UsageError("--yes-inert applies to `import` only");
      options.yesInert = true;
    } else if (arg === "--yes" || arg === "-y") {
      // Named so the refusal is a sentence. There is deliberately no flag that accepts an
      // authority change or an executable item without an individual answer.
      throw new UsageError(
        "there is no blanket --yes: authority changes and executable items always need an individual answer. " +
          "--yes-inert accepts the inert additions only",
      );
    } else if (arg === "--out") {
      const value = argv[++i];
      if (!value) throw new UsageError("--out requires a path");
      if (options.command !== "export") throw new UsageError("--out applies to `export` only");
      options.out = value;
    } else if (arg === "--payload-policy") {
      const value = argv[++i];
      if (!PAYLOAD_POLICIES.includes(value)) {
        throw new UsageError(`--payload-policy must be one of ${PAYLOAD_POLICIES.join(" | ")}`);
      }
      if (options.command !== "export") throw new UsageError("--payload-policy applies to `export` only");
      options.payloadPolicy = value;
    } else if (arg === "--include-secrets") {
      // Named explicitly so the refusal is a sentence rather than "unknown argument".
      throw new UsageError(
        "there is no --include-secrets: open-core Continuity never moves a credential value",
      );
    } else if (arg === "--max-file-bytes") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0) throw new UsageError("--max-file-bytes requires a positive integer");
      options.maxFileBytes = value;
    } else if (arg === "--root") {
      const value = argv[++i];
      if (!value) throw new UsageError("--root requires a directory");
      options.roots.push(value);
    } else if (arg === "--home") {
      const value = argv[++i];
      if (!value) throw new UsageError("--home requires a directory");
      options.home = value;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (options.command === "enable" && !arg.startsWith("-") && options.itemId === null) {
      options.itemId = arg;
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  if (IMPORT_COMMANDS.has(options.command) && options.command !== "enable" && !options.bundle && !options.help) {
    throw new UsageError(`${options.command} requires --bundle <path>`);
  }
  if (options.command === "enable" && !options.itemId && !options.help) {
    throw new UsageError("enable requires an item id, e.g. `omegas-dev enable claude:user:hook:Stop.0.0`");
  }
  return options;
}

export class UsageError extends Error {}

export async function dispatch(argv, io = defaultIo()) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    io.stderr(`${error.message}\n\n${commandHelp()}`);
    return EXIT.USAGE;
  }
  if (options.help) {
    io.stdout(commandHelp());
    return EXIT.OK;
  }

  const homeDir = path.resolve(options.home ?? os.homedir());
  const roots = options.roots.map((root) => path.resolve(root));
  const env = await buildEnvironment({
    homeDir,
    roots,
    os: process.platform,
    envVars: io.envVars ?? {},
    adapters: ADAPTERS,
    caps: options.maxFileBytes ? { file_bytes: options.maxFileBytes } : undefined,
  });

  // The import side never runs a scan of the target: it reads only the files its plan
  // names, so a preview cannot become an excuse to walk someone's whole home directory.
  if (IMPORT_COMMANDS.has(options.command)) {
    const importIo = io.interactive === undefined ? terminalIo(io) : io;
    if (options.command === "diff") return runDiff({ options, env, adapters: ADAPTERS, io: importIo });
    if (options.command === "enable") return runEnable({ options, env, adapters: ADAPTERS, io: importIo });
    return runImport({ options, env, adapters: ADAPTERS, io: importIo });
  }

  const exporting = options.command === "export";
  const result = await runScan({
    adapters: ADAPTERS,
    env,
    payloadPolicy: exporting ? options.payloadPolicy : null,
  });
  const code = exitCodeFor(result);
  if (exporting) {
    return runExport({
      options,
      result,
      env,
      adapters: ADAPTERS,
      code,
      io,
      refuse: code === EXIT.NO_RUNTIME || code === EXIT.VERSION_INCOMPATIBLE,
    });
  }

  if (options.json) {
    io.stdout(`${JSON.stringify(scanEnvelope({ command: options.command, code, result, env }), null, 2)}\n`);
    return code;
  }

  io.stdout(options.command === "report" ? renderReport({ result, env }) : renderScan({ result, env }));
  return code;
}


export function exitCodeFor(result) {
  if (!result.runtimes.some((runtime) => runtime.present)) return EXIT.NO_RUNTIME;
  if (result.runtimes.some((runtime) => runtime.version_incompatible)) return EXIT.VERSION_INCOMPATIBLE;
  const warned =
    result.truncations.length > 0 ||
    result.unresolved_links > 0 ||
    result.findings.some((finding) => finding.severity === "warn" || finding.severity === "critical");
  return warned ? EXIT.WARNINGS : EXIT.OK;
}

function defaultIo() {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    envVars: process.env,
  };
}
