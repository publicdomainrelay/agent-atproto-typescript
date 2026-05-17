import { parseArgs } from "jsr:@std/cli/parse-args";
import { exists } from "https://deno.land/std@0.136.0/fs/mod.ts";
import { stringify as yamlStringify } from "https://deno.land/std@0.136.0/encoding/yaml.ts";
import { Hono } from "hono";
import { InferenceClient } from "@digitalocean/dots";
import { Agent, CredentialSession } from "@atproto/api";
import { IdResolver } from "@atproto/identity";
import { getPdsEndpoint } from "@atproto/common-web";

// Lexicon: com.publicdomainrelay.temp.agent.skill
type StrongRef = {
  $type: "com.atproto.repo.strongRef";
  uri: string;
  cid: string;
};

type AgentSkill = {
  $type: "com.publicdomainrelay.temp.agent.skill";
  name: string;
  description: string;
  examples: StrongRef[];
  createdAt: string;
};

type AgentResponse = {
  description: string;
  createdRecords: StrongRef[];
};

const SKILL_COLLECTION = "com.publicdomainrelay.temp.agent.skill";

const idResolver = new IdResolver();

async function getPdsForDid(did: string): Promise<string> {
  const didDoc = await idResolver.did.resolve(did);
  if (!didDoc) throw new Error(`Could not resolve DID: ${did}`);
  const pds = getPdsEndpoint(didDoc);
  if (!pds) throw new Error(`No PDS endpoint in DID doc for ${did}`);
  return pds;
}

async function resolveStrongRef(ref: StrongRef): Promise<unknown> {
  const atUri = ref.uri;
  const withoutPrefix = atUri.slice("at://".length);
  const [did, collection, rkey] = withoutPrefix.split("/");
  const pds = await getPdsForDid(did);

  const readAgent = new Agent(new URL(pds));
  const result = await readAgent.com.atproto.repo.getRecord({
    repo: did,
    collection,
    rkey,
  });
  return result.data;
}

function isStrongRef(val: unknown): val is StrongRef {
  return (
    typeof val === "object" &&
    val !== null &&
    (val as StrongRef).$type === "com.atproto.repo.strongRef"
  );
}

async function resolveStrongRefs(val: unknown): Promise<unknown> {
  if (isStrongRef(val)) return resolveStrongRefs(await resolveStrongRef(val));
  if (Array.isArray(val)) return Promise.all(val.map(resolveStrongRefs));
  if (typeof val === "object" && val !== null) {
    const out: Record<string, unknown> = {};
    await Promise.all(
      Object.entries(val as Record<string, unknown>).map(async ([k, v]) => {
        out[k] = await resolveStrongRefs(v);
      }),
    );
    return out;
  }
  return val;
}

async function listAgentSkills(did: string): Promise<unknown[]> {
  const pds = await getPdsForDid(did);

  const readAgent = new Agent(new URL(pds));
  const result = await readAgent.com.atproto.repo.listRecords({
    repo: did,
    collection: SKILL_COLLECTION,
  });

  return Promise.all(result.data.records.map((r) => resolveStrongRefs(r)));
}

function collectExampleTypes(skills: unknown[]): Set<string> {
  const types = new Set<string>();
  for (const skill of skills) {
    const s = skill as { value?: { examples?: unknown[] } };
    if (!s.value?.examples) continue;
    for (const ex of s.value.examples) {
      const e = ex as { value?: { $type?: string } };
      if (e.value?.$type) types.add(e.value.$type);
    }
  }
  return types;
}

function collectExampleRecords(skills: unknown[]): unknown[] {
  const records: unknown[] = [];
  for (const skill of skills) {
    const s = skill as { value?: { examples?: unknown[] } };
    if (!s.value?.examples) continue;
    for (const ex of s.value.examples) {
      records.push(ex);
    }
  }
  return records;
}

async function createAtprotoRecord(
  agent: Agent,
  collection: string,
  record: Record<string, unknown>,
  dryRun: boolean,
  knownCollections: Set<string>,
  exampleRecords: unknown[],
): Promise<StrongRef> {
  if (!knownCollections.has(collection)) {
    throw new Error(
      `Unknown collection "${collection}". Valid collections from skill examples: ${
        [...knownCollections].join(", ")
      }`,
    );
  }

  if (record.$type !== collection) {
    throw new Error(
      `Record $type "${record.$type}" must match collection "${collection}"`,
    );
  }

  console.error(
    "createRecord: validating against",
    exampleRecords.length,
    "example records for collection",
    collection,
  );

  console.log(
    JSON.stringify({
      log: "debug",
      func: "createAtprotoRecord",
      msg: "creating record...",
      data: {
        repo: agent.assertDid,
        collection,
        record,
      },
    }),
  );

  // Toggleable debug
  if (dryRun) {
    return {
      $type: "com.atproto.repo.strongRef",
      uri: "example",
      cid: "example",
    };
  }

  const result = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection,
    record,
  });

  return {
    $type: "com.atproto.repo.strongRef",
    uri: result.data.uri,
    cid: result.data.cid,
  };
}

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

type PostRecord = {
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
  record: PostRecord;
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
  useDoModels: boolean;
  digitalOceanToken: string;
  createRecordDryRun: boolean;
  atprotoPassword: string;
  agentDid: string;
  agent: Agent;
};

function makeEnv(): Config {
  const airglowWebhookSecret = Deno.env.get("AIRGLOW_WEBHOOK_SECRET");
  if (!airglowWebhookSecret) {
    console.error("AIRGLOW_WEBHOOK_SECRET is not set");
    Deno.exit(1);
  }

  const atprotoPassword = Deno.env.get("ATPROTO_PASSWORD");
  if (!atprotoPassword) {
    console.error("ATPROTO_PASSWORD is not set");
    Deno.exit(1);
  }

  const agentDid = Deno.env.get("AGENT_DID");
  if (!agentDid) {
    console.error("AGENT_DID is not set");
    Deno.exit(1);
  }

  const doModels = Deno.env.get("DO_MODELS") === "1";
  const digitalOceanToken = Deno.env.get("DIGITALOCEAN_TOKEN");
  if (!digitalOceanToken && doModels) {
    console.error("DIGITALOCEAN_TOKEN is not set");
    Deno.exit(1);
  }

  const flags = parseArgs(Deno.args, {
    string: ["unix_socket"],
    alias: { "unix-socket": "unix_socket" },
  });

  return {
    unixSocket: flags.unix_socket,
    airglowWebhookSecret,
    useDoModels: doModels,
    digitalOceanToken: digitalOceanToken,
    createRecordDryRun: Deno.env.get("CREATE_RECORD_DRY_RUN") === "1",
    atprotoPassword,
    agentDid,
    agent: null as unknown as Agent, // filled in by main() after login
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
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const sig = signature.replace(/^sha256=/, "");
  if (sig.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0;
}

function makeInferenceClient(config: Config): InferenceClient {
  if (config.useDoModels) {
    return new InferenceClient({
      apiKey: config.DigitalOceanToken ?? "",
    });
  }
  return new InferenceClient({
    apiKey: "local",
    baseURL: "http://127.0.0.1:12434/v1",
  });
}

const LOCAL_MODEL = "Qwen3.6-35B-A3B-MTP-GGUF:UD-Q2_K_XL";
const DO_MODEL = "llama3.3-70b-instruct";

const CREATE_RECORD_TOOL = {
  type: "function" as const,
  function: {
    name: "create_atproto_record",
    description:
      "Create an ATProto record in the agent's repository. The collection must match one of the valid types defined by the agent's skills. The record is an arbitrary object whose $type must match the collection.",
    parameters: {
      type: "object",
      properties: {
        collection: {
          type: "string",
          description:
            "The NSID collection for the record (must be a type known from skill examples)",
        },
        record: {
          type: "object",
          description:
            "The record object to create. Must include a $type field matching the collection.",
          additionalProperties: true,
        },
      },
      required: ["collection", "record"],
    },
  },
};

function makeApp(config: Config): Hono<AppEnv> {
  const inference = makeInferenceClient(config);
  const model = config.useDoModels ? DO_MODEL : LOCAL_MODEL;
  const app = new Hono<AppEnv>();

  app.post("/v1/hooks/airglow", async (c) => {
    const contents = await c.req.text();

    console.log(contents);
    const body = JSON.parse(contents) as WebhookPayload;

    let skills: unknown[] = [];
    try {
      skills = await listAgentSkills(config.agentDid);
      console.log(
        JSON.stringify({
          log: "debug",
          msg: "Loaded agent skills",
          data: skills,
        }),
      );
    } catch (err) {
      console.error("Failed to list agent skills:", (err as Error).message);
    }

    const knownCollections = collectExampleTypes(skills);
    const exampleRecords = collectExampleRecords(skills);

    const skillsYaml = yamlStringify(skills as Record<string, unknown>[]);

    const systemPrompt = [
      "IMPORTANT! IMPORTANT! IMPORTANT! If you have a skill which might allow you to respond/reply to the user, then you MUST ensure that you call create_atproto_record per that skill in order to respond/reply to them and let them know what you're doing / did for this request. IMPORTANT! IMPORTANT! IMPORTANT! IMPORTANT!",
      "",
      "Make sure to think about your plan. If you are going to call a tool whose function is not to respond/reply to a user then you probably want to include that tools output AT URI in your message which is a response to the user. Example:",
      "",
      "    Here are outputs from the tools I called:",
      "      - https://pdsls.dev/at://did:plc:lpfuqerea3deuoyrn7ojser4/com.publicdomainrelay.ccrfp/3mlz3oy63gz2a",
      "",
      "You are an agent that processes webhook payloads from an ATProto social network automation system.",
      "After completing all actions, respond with plain-english description of the actions taken and brief reasoning for why these actions were appropriate",
      "",
      "Based on the webhook payload and available skills, decide what actions to take.",
      "You may call the create_atproto_record tool to create records in the ATProto repository.",
      "",
      "Valid record collections (from skill examples): " +
      "",
      ([...knownCollections].join(", ") || "(none)"),
      "",
      "You have access to the following skills (in YAML format):",
      "```yaml",
      skillsYaml,
      "```",
    ].join("\n");

    const userMessage = `Webhook payload:\n\n${JSON.stringify(body, null, 2)}`;

    console.error("=== PROMPT ===");
    console.error("SYSTEM:", systemPrompt);
    console.error("USER:", userMessage);
    console.error("==============");

    // deno-lint-ignore no-explicit-any
    const messages: any[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    const createdRecords: StrongRef[] = [];

    let agentResponse: AgentResponse = {
      description: "",
      createdRecords: [],
    };
    for (let step = 0; step < 10; step++) {
      const completion = await inference.chat.completions.create({
        model,
        messages,
        tools: [CREATE_RECORD_TOOL],
        tool_choice: "auto",
        /*
          // type: "json_schema", seems to be messing up tool calls with qwen3.6
        response_format: {
          type: "json_object",
          /*
          json_schema: {
            name: "agent_response",
            schema: {
              type: "object",
              properties: {
                description: { type: "string" },
                reasoning: { type: "string" },
                createdRecords: { type: "array", items: { type: "object" } },
              },
              required: ["description", "reasoning", "createdRecords"],
            },
          },
        },
        */
      });

      const choice = completion.choices[0];
      const msg = choice.message;
      messages.push(msg);

      if (choice.finish_reason === "tool_calls" && msg.tool_calls?.length) {
        for (const toolCall of msg.tool_calls) {
          if (toolCall.function.name !== "create_atproto_record") continue;

          let toolResult: string;
          try {
            const args = JSON.parse(toolCall.function.arguments) as {
              collection: string;
              record: Record<string, unknown>;
            };
            const ref = await createAtprotoRecord(
              config.agent,
              args.collection,
              args.record,
              config.createRecordDryRun,
              knownCollections,
              exampleRecords,
            );
            createdRecords.push(ref);
            toolResult = JSON.stringify({ success: true, strongRef: ref });
          } catch (err) {
            toolResult = JSON.stringify({
              success: false,
              error: (err as Error).message,
            });
          }

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: toolResult,
          });
        }
        continue;
      }

      agentResponse = {
        description: msg.content,
        createdRecords,
      };
      break;
    }

    console.error("Agent response:", JSON.stringify(agentResponse, null, 2));

    return c.json({
      received: true,
      payload: body,
      response: agentResponse,
      skills,
    });
  });

  return app;
}

const main = async () => {
  const config = makeEnv();

  const pds = await getPdsForDid(config.agentDid);
  const session = new CredentialSession(new URL(pds));
  await session.login({
    identifier: config.agentDid,
    password: config.atprotoPassword,
  });
  config.agent = new Agent(session);
  console.error(`Logged in as ${session.did}`);

  const app = makeApp(config);
  const controller = new AbortController();

  const options = {
    signal: controller.signal,
    path: config.unixSocket,
    transport: "unix",
    onListen({ path }: { path: string }) {
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
