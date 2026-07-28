#!/usr/bin/env node

import { main } from "../src/cli.js";

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nOmegas transfer stopped: ${message}\n`);
  process.exitCode = 1;
});
