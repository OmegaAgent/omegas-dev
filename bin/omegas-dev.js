#!/usr/bin/env node

import { main } from "../src/cli.js";
import { dispatch, isSubcommand } from "../src/cli/dispatch.js";

const argv = process.argv.slice(2);

// A bare invocation and every legacy flag keep going to the hosted transfer flow
// unchanged. Only an explicit subcommand reaches the read-only Continuity commands.
if (isSubcommand(argv)) {
  dispatch(argv)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`\ncontinuity ${argv[0]} stopped: ${message}\n`);
      process.exitCode = 1;
    });
} else {
  main(argv).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\nOmegas transfer stopped: ${message}\n`);
    process.exitCode = 1;
  });
}
