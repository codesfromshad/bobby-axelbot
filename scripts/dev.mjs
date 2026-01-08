import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { context } from "esbuild";

const entry = "src/main.ts";
const outfile = "dist/main.js";

let nodeProcess;

dotenv.config({
  path: fileURLToPath(new URL("../.env", import.meta.url))
});

function startNode() {
  if (nodeProcess) {
    nodeProcess.kill();
    nodeProcess = undefined;
  }

  nodeProcess = spawn(process.execPath, [outfile], {
    stdio: "inherit",
  });
}

const ctx = await context({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
  sourcemap: true,
  logLevel: "info",
  plugins: [
    {
      name: "restart-on-success",
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length > 0) return;
          startNode();
        });
      },
    },
  ],
});

await ctx.watch();
await ctx.rebuild();

function shutdown() {
  if (nodeProcess) nodeProcess.kill();
  ctx.dispose();
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
