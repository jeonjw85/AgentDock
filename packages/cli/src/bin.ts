#!/usr/bin/env node
import { main } from "./commands.js";

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
