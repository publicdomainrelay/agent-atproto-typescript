import { parseArgs } from "jsr:@std/cli/parse-args";
import { exists } from "https://deno.land/std@0.136.0/fs/mod.ts";
import { Hono } from "hono";

const app = new Hono();

app.post("/v1/hooks/airglow", async (c) => {
  const body = await c.req.json();

  return c.json({
    received: true,
    payload: body,
  });
});

const main = async () => {
  const controller = new AbortController();

  const flags = parseArgs(Deno.args, {
    string: [ "unix_socket" ],
    alias: {
      "unix-socket": "unix_socket",
    },
  });

  const options = {
    signal: controller.signal,
    path: flags.unix_socket,
    transport: "unix",
    onListen({ path }) {
      console.log(`Server started at ${path}`);
    },
  };

  if (await exists(options.path)) {
    await Deno.remove(options.path);
  }

  Deno.addSignalListener("SIGINT", () => {
    console.log("Shutting down...");
    controller.abort();
  });

  Deno.addSignalListener("SIGTERM", () => {
    console.log("Shutting down...");
    controller.abort();
  });

  const server = Deno.serve(options, app.fetch);
  server.finished.then(() => console.log("Server closed"));
  // console.log("Server running on Unix socket:", options.path);
};

await main();
