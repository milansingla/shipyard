#!/usr/bin/env node
import readline from "node:readline/promises";

import { main } from "./main.js";

const code = await main(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readLine: async () => {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    try {
      return await rl.question("");
    } finally {
      rl.close();
    }
  },
});
process.exitCode = code;
