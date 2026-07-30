import { spawn } from "node:child_process";
import { chmod, mkdir, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import {
  createApiClient,
  PRODUCTION_API_ORIGIN,
  validateVerificationUrl,
  waitForClaim,
} from "./api.js";
import { discoverTransfer, readFingerprintedText } from "./discovery.js";
import { environmentFromFilename, parseEnvFile } from "./env.js";

function parseArgs(argv) {
  const options = { roots: [], api: PRODUCTION_API_ORIGIN };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") options.roots.push(argv[++i]);
    else if (arg === "--api") options.api = argv[++i];
    else if (arg === "--unsafe-development-api") options.unsafeDevelopmentApi = true;
    else if (arg === "--output") options.output = argv[++i];
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--no-open") options.noOpen = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.roots.some((root) => !root)) throw new Error("--root requires a directory");
  if (options.api !== PRODUCTION_API_ORIGIN && !options.unsafeDevelopmentApi) {
    throw new Error("--api requires --unsafe-development-api; production uploads are pinned to api.omegas.dev");
  }
  return options;
}

export function help() {
  return `Usage: npx omegas-dev [options]\n\n` +
    `Two things live under this command, and they do not touch each other:\n\n` +
    `Continuity — local-only. Read, share and re-apply your Claude Code and Codex setup.\n` +
    `No account, no network, no subprocess. Run \`omegas-dev <command> --help\` for detail.\n` +
    `  omegas-dev scan      Read every declared configuration surface and print what was found\n` +
    `  omegas-dev report    The same scan, rendered as a multi-section report (--html for a page)\n` +
    `  omegas-dev compat    The derived compatibility matrix, its losses, and per-item exceptions\n` +
    `  omegas-dev export    Write a redacted, content-addressed bundle you can share\n` +
    `  omegas-dev diff      Preview exactly what importing a bundle would write. Writes nothing\n` +
    `  omegas-dev import    Walk the same plan and apply only what you consent to, item by item\n` +
    `  omegas-dev enable    Turn on one quarantined item, after showing you what it is\n\n` +
    `Hosted transfer (this bare invocation) — the only path that contacts a server:\n` +
    `  --root <dir>   Root to scan (repeatable; defaults to the current directory)\n` +
    `  --api <url>    Omegas API base URL\n` +
    `  --unsafe-development-api  Allow an alternate HTTPS or loopback API for local testing\n` +
    `  --output <file> Sensitive local preview path (default: ~/${PREVIEW_SEGMENTS.join("/")})\n` +
    `  --dry-run      Discover and write the preview without contacting Omegas\n` +
    `  --no-open      Print the browser link without opening it\n` +
    `  --yes          Open the browser automatically; secrets still require a separate answer\n` +
    `  --help, -h     Show this help\n`;
}

async function askYesNo(rl, question, fallback = false) {
  const answer = (await rl.question(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
  if (!answer) return fallback;
  return answer === "y" || answer === "yes";
}

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

// The preview holds the full plaintext of everything discovered. It belongs in the tool's own
// state directory, not in a directory that is routinely synced, backed up, and indexed.
const PREVIEW_SEGMENTS = [".omegas", "state", "previews"];

export function previewDirectory(home) {
  return path.join(home, ...PREVIEW_SEGMENTS);
}

export async function ensurePreviewDirectory(home) {
  const directory = previewDirectory(home);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by the umask, so each level is set back to owner-only explicitly.
  for (let level = PREVIEW_SEGMENTS.length; level > 0; level -= 1) {
    await chmod(path.join(home, ...PREVIEW_SEGMENTS.slice(0, level)), 0o700);
  }
  return directory;
}

export function previewFilename(home, now = new Date()) {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return path.join(previewDirectory(home), `omegas-transfer-preview-${timestamp}.json`);
}

export async function offerPreviewDeletion(rl, filename, interactive) {
  if (!interactive) return false;
  const remove = await askYesNo(rl, `\nDelete the local preview now?\n${filename}`);
  if (!remove) {
    process.stdout.write("Kept. Delete it yourself when you are done reviewing it.\n");
    return false;
  }
  await rm(filename, { force: true });
  process.stdout.write("Deleted the local preview.\n");
  return true;
}

function manifestCounts(manifest) {
  const scopes = [manifest.global, ...manifest.projects];
  return {
    projects: manifest.projects.length,
    context: scopes.reduce((sum, scope) => sum + scope.context_files.length, 0),
    skills: scopes.reduce((sum, scope) => sum + scope.skills.length, 0),
    mcp: scopes.reduce((sum, scope) => sum + scope.mcp_servers.length, 0),
  };
}

async function chooseSecretFiles(rl, envFiles) {
  if (envFiles.length === 0) return [];
  const include = await askYesNo(
    rl,
    `Transfer selected .env files as encrypted secret bundles? ${envFiles.length} file(s) found.`,
  );
  if (!include) return [];
  process.stdout.write("\nFiles (names only; variables and values remain hidden):\n");
  envFiles.forEach((file, index) => process.stdout.write(`  ${index + 1}. ${file.sourceLabel}\n`));
  const answer = (await rl.question("Select file numbers separated by commas, or 'all': ")).trim().toLowerCase();
  if (!answer) return [];
  if (answer === "all") return envFiles;
  const indexes = new Set(
    answer.split(",").map((value) => Number.parseInt(value.trim(), 10) - 1).filter((index) => Number.isInteger(index) && index >= 0 && index < envFiles.length),
  );
  return envFiles.filter((_, index) => indexes.has(index));
}

async function loadSecretBundles(selected) {
  const bundles = [];
  for (const file of selected) {
    const text = await readFingerprintedText(file);
    const { entries, skippedLines } = parseEnvFile(text);
    if (skippedLines.length > 0) {
      process.stdout.write(`Skipped ${skippedLines.length} unsupported line(s) in ${file.sourceLabel}; no values were printed.\n`);
    }
    bundles.push({
      project_key: file.projectKey,
      source_label: file.sourceLabel,
      environment: environmentFromFilename(path.basename(file.filename)),
      entries,
    });
  }
  return bundles;
}

export async function writePreview(filename, manifest, secretBundles) {
  const preview = {
    manifest,
    secret_files: secretBundles.map((bundle) => ({
      project_key: bundle.project_key,
      source_label: bundle.source_label,
      environment: bundle.environment,
      variable_count: Object.keys(bundle.entries).length,
    })),
    note: "Secret variable names and values are intentionally excluded from this preview.",
  };
  await mkdir(path.dirname(filename), { recursive: true });
  const handle = await open(filename, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(preview, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(help());
    return;
  }
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const roots = (options.roots.length ? options.roots : [process.cwd()]).map((root) => path.resolve(root));
    const api = options.dryRun
      ? null
      : createApiClient(options.api, { unsafeDevelopmentApi: options.unsafeDevelopmentApi });
    const session = api ? await api.start() : null;
    if (session) {
      session.verification_url = validateVerificationUrl(
        session.verification_url,
        options.unsafeDevelopmentApi,
      );
      process.stdout.write(`\nOpen this link to sign in and claim the transfer:\n${session.verification_url}\nCode: ${session.user_code}\n`);
      const shouldOpen = options.noOpen ? false : options.yes || (interactive && await askYesNo(rl, "Open the browser now?", true));
      if (shouldOpen) openBrowser(session.verification_url);
    }

    process.stdout.write(`\nOmegas local transfer\nScanning ${roots.join(", ")} for Claude Code and Codex setup…\n`);
    const { manifest, envFiles, warnings } = await discoverTransfer({ roots, home: os.homedir() });
    const counts = manifestCounts(manifest);
    process.stdout.write(
      `Found ${counts.projects} project(s), ${counts.context} context file(s), ${counts.skills} skill(s), and ${counts.mcp} MCP server proposal(s).\n`,
    );
    for (const warning of warnings) process.stdout.write(`Warning: ${warning}\n`);
    process.stdout.write(`Upload destination: ${options.api}\n`);

    const selectedSecrets = interactive ? await chooseSecretFiles(rl, envFiles) : [];
    let claim = null;
    if (api && session) {
      process.stdout.write("Waiting for browser confirmation");
      claim = await waitForClaim(api, session, { onTick: () => process.stdout.write(".") });
      process.stdout.write(" confirmed.\n");
      process.stdout.write(
        `Browser confirmation: ${claim.confirmation_phrase ?? "unavailable"}\nClaimed by: ${claim.claimant_hint ?? "unknown account"}\n`,
      );
      if (!interactive) {
        throw new Error("an interactive terminal confirmation is required before upload");
      }
    }
    // Secret values are not read from disk until the browser has claimed the transfer.
    const secretFiles = await loadSecretBundles(selectedSecrets);
    const home = os.homedir();
    const output = options.output ? path.resolve(options.output) : previewFilename(home);
    if (!options.output) await ensurePreviewDirectory(home);
    await writePreview(output, manifest, secretFiles);
    process.stdout.write(`Sensitive local preview: ${output}\n`);

    if (options.dryRun) {
      process.stdout.write("Dry run complete. Nothing was uploaded.\n");
    } else {
      if (!api || !session) throw new Error("transfer session was not created");
      process.stdout.write(
        "Nothing has been uploaded yet. Open the preview file above to review exactly what will be sent.\n",
      );
      const approved = await askYesNo(
        rl,
        `Upload this transfer to ${claim?.claimant_hint ?? "the claimed account"}?`,
      );
      if (!approved) throw new Error("transfer cancelled before any upload");
      process.stdout.write("Uploading the review bundle…\n");
      const result = await api.upload(session.transfer_id, session.device_token, {
        manifest,
        secret_files: secretFiles,
      });
      process.stdout.write(`\nYour transfer is complete. Edit MCP Servers, Skills, context, and project-to-Space mapping here:\n${result.edit_url}\n`);
    }
    await offerPreviewDeletion(rl, output, interactive);
  } finally {
    rl.close();
  }
}
