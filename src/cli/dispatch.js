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
import { runExport } from "./export.js";
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
  VERSION_INCOMPATIBLE: 10,
};

const COMMANDS = new Set(["scan", "report", "export"]);

export function isSubcommand(argv) {
  return argv.length > 0 && COMMANDS.has(argv[0]);
}

export function commandHelp() {
  return (
    `Usage: omegas-dev <command> [options]\n\n` +
    `  scan     Read every declared configuration surface and print what was found\n` +
    `  report   The same scan, rendered as a multi-section report\n` +
    `  export   Write a redacted, content-addressed bundle you can share\n\n` +
    `Options\n` +
    `  --home <dir>   Home directory to read (default: your home directory)\n` +
    `  --root <dir>   Project root to scan for project-scope config (repeatable)\n` +
    `  --json         Emit the machine-readable result envelope on stdout\n` +
    `  --max-file-bytes <n>  Per-file read cap; a breach is truncated and reported, never dropped\n` +
    `  --out <path>          export only: where to write the bundle\n` +
    `  --payload-policy <p>  export only: ${PAYLOAD_POLICIES.join(" | ")} (default: definition)\n` +
    `  --help, -h     Show this help\n\n` +
    `scan and report are read-only. export writes exactly one shareable artifact and it\n` +
    `is the redacted one: values are replaced by {{OMEGA_REDACTED:class:ref}} placeholders,\n` +
    `there is no --include-secrets flag, and the serialized bytes are re-scanned before\n` +
    `they reach the disk (a hit aborts with exit 5 and writes nothing). No command here\n` +
    `uses the network or a subprocess. Run \`omegas-dev\` with no command for the hosted\n` +
    `transfer flow, which is the only path that contacts a server.\n`
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
  };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
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
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
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
