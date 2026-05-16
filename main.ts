import { parseArgs } from "jsr:@std/cli/parse-args";
import { exists } from "https://deno.land/std@0.136.0/fs/mod.ts";
import { Hono } from "hono";

type Condition = {
  field: string;
  operator: string;
  value: string;
  comment?: string;
};

type CidUri = {
  cid: string;
  uri: string;
};

type Reply = {
  parent: CidUri;
  root: CidUri;
};

type Record = {
  $type: string;
  createdAt: string;
  langs?: string[];
  reply?: Reply;
  text: string;
};

type Commit = {
  operation: string;
  collection: string;
  rkey: string;
  record: Record;
  cid: string;
};

type Event = {
  did: string;
  time_us: number;
  kind: string;
  commit: Commit;
};

type WebhookPayload = {
  automation: string;
  lexicon: string;
  conditions: Condition[];
  event: Event;
};

type AppEnv = {
  Variables: {
    airglowWebhookSecret: string;
  };
};

type Config = {
  unixSocket: string;
  airglowWebhookSecret: string;
};

function makeEnv(): Config {
  const airglowWebhookSecret = Deno.env.get("AIRGLOW_WEBHOOK_SECRET");
  if (!airglowWebhookSecret) {
    console.error("AIRGLOW_WEBHOOK_SECRET is not set");
    Deno.exit(1);
  }

  const flags = parseArgs(Deno.args, {
    string: ["unix_socket"],
    alias: { "unix-socket": "unix_socket" },
  });

  return {
    unixSocket: flags.unix_socket,
    airglowWebhookSecret,
  };
}

async function verifyWebhookSignature(
  secret: string,
  body: string,
  signature: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // constant-time comparison via fixed-length hex strings
  const sig = signature.replace(/^sha256=/, "");
  if (sig.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0;
}

function makeApp(config: Config): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const webhookRoutes = ["/v1/hooks/airglow"];

  /*
  app.use(...webhookRoutes, async (c, next) => {
    c.set("airglowWebhookSecret", config.airglowWebhookSecret);
    await next();
  });
  */

  app.post("/v1/hooks/airglow", async (c) => {
    // const secret = c.get("airglowWebhookSecret");

    const contents = await c.req.text();
    /*
    const signature = c.req.header("x-airglow-signature") ?? "";

    if (!await verifyWebhookSignature(secret, contents, signature)) {
      return c.json({ error: "invalid signature" }, 401);
    }
    */

    console.log(contents);
    const body = JSON.parse(contents) as WebhookPayload;

    return c.json({
      received: true,
      payload: body,
    });
  });

  return app;
}

const main = async () => {
  const config = makeEnv();
  const app = makeApp(config);
  const controller = new AbortController();

  const options = {
    signal: controller.signal,
    path: config.unixSocket,
    transport: "unix",
    onListen({ path }) {
      console.error(`Server started at ${path}`);
    },
  };

  if (await exists(options.path)) {
    await Deno.remove(options.path);
  }

  Deno.addSignalListener("SIGINT", () => {
    console.error("Shutting down...");
    controller.abort();
  });

  Deno.addSignalListener("SIGTERM", () => {
    console.error("Shutting down...");
    controller.abort();
  });

  const server = Deno.serve(options, app.fetch);
  server.finished.then(() => console.error("Server closed"));
};

await main();
