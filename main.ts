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
const THREAD_COLLECTION = "com.publicdomainrelay.temp.agent.thread";

type ThreadEntry = {
  trigger: StrongRef;
  status: "in_progress" | "complete";
  startedAt: string;
  completedAt?: string;
  description?: string;
  createdRecords: StrongRef[];
};

type ThreadRecord = {
  $type: typeof THREAD_COLLECTION;
  root: { uri: string; cid: string };
  status: "in_progress" | "complete";
  updatedAt: string;
  entries: ThreadEntry[];
};

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

async function rkeyForRootUri(rootUri: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(rootUri),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getThreadRecord(
  agent: Agent,
  rkey: string,
): Promise<ThreadRecord | null> {
  try {
    const result = await agent.com.atproto.repo.getRecord({
      repo: agent.assertDid,
      collection: THREAD_COLLECTION,
      rkey,
    });
    return result.data.value as ThreadRecord;
  } catch {
    return null;
  }
}

async function putThreadRecord(
  agent: Agent,
  rkey: string,
  record: ThreadRecord,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    console.log(
      JSON.stringify({
        log: "debug",
        func: "putThreadRecord",
        msg: "dry-run putRecord",
        data: { rkey, record },
      }),
    );
    return;
  }
  await agent.com.atproto.repo.putRecord({
    repo: agent.assertDid,
    collection: THREAD_COLLECTION,
    rkey,
    record,
  });
}

type BacklinkRef = { did: string; collection: string; rkey: string };

async function fetchConstellationLinksAll(
  targetUri: string,
): Promise<Record<string, Record<string, { records: number }>>> {
  const url =
    `https://constellation.microcosm.blue/links/all?target=${encodeURIComponent(targetUri)}`;
  const res = await fetch(url);
  if (!res.ok) return {};
  const data = await res.json();
  return (data?.links ?? {}) as Record<
    string,
    Record<string, { records: number }>
  >;
}

async function fetchConstellationBacklinks(
  subject: string,
  source: string,
  limit = 25,
): Promise<BacklinkRef[]> {
  const url =
    `https://constellation.microcosm.blue/xrpc/blue.microcosm.links.getBacklinks?subject=${
      encodeURIComponent(subject)
    }&source=${encodeURIComponent(source)}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return (data?.records ?? []) as BacklinkRef[];
}

async function expandWithBacklinks(
  uri: string,
  depth: number,
  maxDepth: number,
  seen: Set<string>,
): Promise<unknown> {
  if (seen.has(uri) || depth > maxDepth) return { uri, truncated: true };
  seen.add(uri);

  let record: unknown = null;
  try {
    record = await resolveStrongRef({
      $type: "com.atproto.repo.strongRef",
      uri,
      cid: "",
    });
  } catch (err) {
    record = { error: (err as Error).message };
  }

  const resolved = await resolveStrongRefs(record);

  const linksMap = await fetchConstellationLinksAll(uri);
  const backlinks: Record<string, unknown[]> = {};
  for (const [collection, paths] of Object.entries(linksMap)) {
    for (const path of Object.keys(paths)) {
      const source = `${collection}:${path.replace(/^\./, "")}`;
      const refs = await fetchConstellationBacklinks(uri, source, 25);
      const expanded = await Promise.all(
        refs.map(async (r) => {
          const refUri = `at://${r.did}/${r.collection}/${r.rkey}`;
          return await expandWithBacklinks(refUri, depth + 1, maxDepth, seen);
        }),
      );
      backlinks[source] = expanded;
    }
  }

  return { uri, record: resolved, backlinks };
}

async function checkThreadStatus(
  agent: Agent,
  rootUri: string,
  maxDepth = 1,
): Promise<unknown> {
  const rkey = await rkeyForRootUri(rootUri);
  const thread = await getThreadRecord(agent, rkey);
  if (!thread) return { found: false, rootUri, rkey };

  const seen = new Set<string>();
  const entries = await Promise.all(
    thread.entries.map(async (entry) => {
      const trigger = await expandWithBacklinks(
        entry.trigger.uri,
        0,
        maxDepth,
        seen,
      );
      const created = await Promise.all(
        entry.createdRecords.map((r) =>
          expandWithBacklinks(r.uri, 0, maxDepth, seen)
        ),
      );
      return { ...entry, triggerExpanded: trigger, createdExpanded: created };
    }),
  );

  return {
    found: true,
    rootUri,
    rkey,
    status: thread.status,
    updatedAt: thread.updatedAt,
    entries,
  };
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
      uri: `at://did:plc:lpfuqerea3deuoyrn7ojser4/${collection}/1290312093821`,
      cid: "kj3498u342i34mp3654xsmrwjpihbsjyxzbcyvvnwhry2cci5fh2ubjtf74",
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
      apiKey: config.digitalOceanToken ?? "",
    });
  }
  return new InferenceClient({
    apiKey: "local",
    baseURL: "http://127.0.0.1:12434/v1",
  });
}

const LOCAL_MODEL = "Qwen3.6-35B-A3B-MTP-GGUF:UD-Q2_K_XL";
const DO_MODEL = "nvidia-nemotron-3-super-120b";

async function resolveLexicon(nsid: string): Promise<unknown | null> {
  try {
    const parts = nsid.split(".");
    if (parts.length < 3) return null;
    const domain = parts.slice(0, -1).reverse().join(".");
    const txt = await Deno.resolveDns(`_lexicon.${domain}`, "TXT");
    let did: string | null = null;
    for (const recs of txt) {
      for (const r of recs) {
        if (r.startsWith("did=")) {
          did = r.slice(4);
          break;
        }
      }
      if (did) break;
    }
    if (!did) return null;
    const pds = await getPdsForDid(did);
    const readAgent = new Agent(new URL(pds));
    const result = await readAgent.com.atproto.repo.getRecord({
      repo: did,
      collection: "com.atproto.lexicon.schema",
      rkey: nsid,
    });
    return result.data.value;
  } catch {
    return null;
  }
}

// Best-effort conversion of an atproto lexicon object def into JSON Schema
// suitable for an LLM tool parameters block.
function lexiconObjectToJsonSchema(
  def: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { type: "object" };
  if (Array.isArray(def.required)) out.required = def.required;
  const props = (def.properties ?? {}) as Record<string, unknown>;
  const jsonProps: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(props)) {
    jsonProps[key] = lexiconTypeToJsonSchema(raw as Record<string, unknown>);
  }
  out.properties = jsonProps;
  return out;
}

function lexiconTypeToJsonSchema(
  def: Record<string, unknown>,
): Record<string, unknown> {
  const t = def.type as string | undefined;
  const description = def.description as string | undefined;
  const base: Record<string, unknown> = {};
  if (description) base.description = description;
  switch (t) {
    case "string":
    case "datetime":
    case "uri":
    case "at-uri":
    case "did":
    case "handle":
    case "nsid":
    case "language":
    case "cid-link":
    case "tid":
    case "record-key":
      return { ...base, type: "string" };
    case "integer":
      return { ...base, type: "integer" };
    case "boolean":
      return { ...base, type: "boolean" };
    case "array": {
      const items = (def.items ?? {}) as Record<string, unknown>;
      return { ...base, type: "array", items: lexiconTypeToJsonSchema(items) };
    }
    case "object":
      return { ...base, ...lexiconObjectToJsonSchema(def) };
    case "blob":
      return { ...base, type: "object", description: (description ?? "") + " (atproto blob)" };
    case "ref":
    case "union":
    case "unknown":
    default:
      return { ...base, type: "object", additionalProperties: true };
  }
}

function collectionToToolName(collection: string): string {
  return `create_${collection.replace(/[^a-zA-Z0-9]/g, "_")}`.slice(0, 64);
}

type CollectionTool = {
  // deno-lint-ignore no-explicit-any
  tool: any;
  collection: string;
  lexicon: unknown | null;
};

async function buildCollectionTools(
  collections: Set<string>,
): Promise<{ typed: CollectionTool[]; lexiconlessCollections: Set<string> }> {
  const typed: CollectionTool[] = [];
  const lexiconlessCollections = new Set<string>();
  for (const collection of collections) {
    const lex = await resolveLexicon(collection);
    let recordSchema: Record<string, unknown> | null = null;
    if (lex && typeof lex === "object") {
      const defs = (lex as { defs?: Record<string, unknown> }).defs;
      const main = defs?.main as Record<string, unknown> | undefined;
      const rec = main?.record as Record<string, unknown> | undefined;
      if (rec) recordSchema = lexiconObjectToJsonSchema(rec);
    }
    if (!recordSchema) {
      lexiconlessCollections.add(collection);
      continue;
    }
    const parameters = recordSchema;
    const props =
      (parameters as { properties?: Record<string, unknown> }).properties;
    if (props && !props.$type) {
      props.$type = {
        type: "string",
        description: `Must be \"${collection}\"`,
      };
    }
    typed.push({
      collection,
      lexicon: lex,
      tool: {
        type: "function",
        function: {
          name: collectionToToolName(collection),
          description:
            `Create a ${collection} record in the agent's repository. Parameters schema derived from the resolved lexicon.`,
          parameters,
        },
      },
    });
  }
  return { typed, lexiconlessCollections };
}

function makeGenericCreateTool(lexiconlessCollections: Set<string>) {
  const enumList = [...lexiconlessCollections];
  return {
    type: "function" as const,
    function: {
      name: "create_atproto_record",
      description:
        "Create an ATProto record in the agent's repository for a collection that has no resolvable lexicon. The collection MUST be one of the listed values. The record is an arbitrary object whose $type must match the collection — model it after the skill examples.",
      parameters: {
        type: "object",
        properties: {
          collection: {
            type: "string",
            enum: enumList,
            description:
              "NSID of the lexicon-less collection to write (one of: " +
              enumList.join(", ") + ")",
          },
          record: {
            type: "object",
            description:
              "Record body. Must include a $type field matching collection. Model after skill examples.",
            additionalProperties: true,
          },
        },
        required: ["collection", "record"],
      },
    },
  };
}

const CHECK_THREAD_TOOL = {
  type: "function" as const,
  function: {
    name: "check_thread_status",
    description:
      "Read the thread memory record for a thread root URI and recursively resolve all strongRefs and backlinks (via constellation) to understand what's happened in this thread since we last responded. Use this when the user is just asking for a status update and does not want new actions taken.",
    parameters: {
      type: "object",
      properties: {
        rootUri: {
          type: "string",
          description:
            "AT URI of the thread root post (e.g. at://did:plc:.../app.bsky.feed.post/<rkey>)",
        },
        maxDepth: {
          type: "number",
          description: "Max recursion depth for backlink expansion (default 1)",
        },
      },
      required: ["rootUri"],
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
    const { typed: collectionTools, lexiconlessCollections } =
      await buildCollectionTools(knownCollections);
    const toolNameToCollection = new Map<string, string>();
    for (const ct of collectionTools) {
      toolNameToCollection.set(ct.tool.function.name, ct.collection);
    }
    const genericCreateTool = lexiconlessCollections.size > 0
      ? makeGenericCreateTool(lexiconlessCollections)
      : null;

    // Determine thread root + triggering strongRef
    const triggerDid = body.event.did;
    const triggerCollection = body.event.commit.collection;
    const triggerRkey = body.event.commit.rkey;
    const triggerUri =
      `at://${triggerDid}/${triggerCollection}/${triggerRkey}`;
    const triggerRef: StrongRef = {
      $type: "com.atproto.repo.strongRef",
      uri: triggerUri,
      cid: body.event.commit.cid,
    };
    const rootCidUri = body.event.commit.record.reply?.root ?? {
      uri: triggerUri,
      cid: body.event.commit.cid,
    };
    const threadRkey = await rkeyForRootUri(rootCidUri.uri);
    const nowIso = new Date().toISOString();

    let threadRecord = await getThreadRecord(config.agent, threadRkey);
    if (!threadRecord) {
      threadRecord = {
        $type: THREAD_COLLECTION,
        root: { uri: rootCidUri.uri, cid: rootCidUri.cid },
        status: "in_progress",
        updatedAt: nowIso,
        entries: [],
      };
    }
    const priorEntries = [...threadRecord.entries];
    const entry: ThreadEntry = {
      trigger: triggerRef,
      status: "in_progress",
      startedAt: nowIso,
      createdRecords: [],
    };
    threadRecord.entries.push(entry);
    threadRecord.status = "in_progress";
    threadRecord.updatedAt = nowIso;
    try {
      await putThreadRecord(
        config.agent,
        threadRkey,
        threadRecord,
        config.createRecordDryRun,
      );
    } catch (err) {
      console.error("Failed to write thread record (start):", (err as Error).message);
    }

    const skillsYaml = yamlStringify(skills as Record<string, unknown>[]);

    const systemPrompt = [
      "IMPORTANT! IMPORTANT! IMPORTANT! If you have a skill which might allow you to respond/reply to the user, then you MUST call the corresponding per-collection create tool (e.g. create_app_bsky_feed_post for app.bsky.feed.post) in order to respond/reply to them and let them know what you're doing / did for this request. IMPORTANT! IMPORTANT! IMPORTANT! IMPORTANT!",
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
      "You may call any of the per-collection create tools (one per known collection) to create records in the ATProto repository. Tools whose parameters were derived from a resolvable lexicon have strict schemas; tools whose lexicon was not resolvable accept best-effort objects.",
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

    const priorHistory = priorEntries.length === 0
      ? ""
      : [
        "\n\nPrior activity in this thread (from thread memory record " +
        `at://${config.agentDid}/${THREAD_COLLECTION}/${threadRkey}):`,
        ...priorEntries.map((e, i) => {
          const createdList = e.createdRecords.map((r) => `    - ${r.uri}`)
            .join("\n");
          return [
            `\n[${i + 1}] trigger: ${e.trigger.uri}`,
            `    status: ${e.status}`,
            `    startedAt: ${e.startedAt}` +
            (e.completedAt ? ` completedAt: ${e.completedAt}` : ""),
            `    description: ${e.description ?? "(none)"}`,
            createdList ? `    createdRecords:\n${createdList}` : "",
          ].filter(Boolean).join("\n");
        }),
      ].join("\n");

    const userMessage =
      `Webhook payload:\n\n${JSON.stringify(body, null, 2)}${priorHistory}`;

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

    console.error([
          ...collectionTools.map((c) => c.tool),
          ...(genericCreateTool ? [genericCreateTool] : []),
          CHECK_THREAD_TOOL,
        ]);

    for (let step = 0; step < 10; step++) {
      console.error(`=== LLM STEP ${step} ===`);

      const completion = await inference.chat.completions.create({
        model,
        messages,
        tools: [
          ...collectionTools.map((c) => c.tool),
          ...(genericCreateTool ? [genericCreateTool] : []),
          CHECK_THREAD_TOOL,
        ],
        tool_choice: "auto",
      });

      const choice = completion.choices[0];
      const msg = choice.message;

      console.error(
        `finish_reason: ${choice.finish_reason}, tool_calls: ${msg.tool_calls?.length ?? 0}`,
      );

      messages.push(msg);

      const hasPendingToolCalls = msg.tool_calls && msg.tool_calls.length > 0;

      if (!hasPendingToolCalls) {
        agentResponse = {
          description: msg.content ?? "",
          createdRecords,
        };
        break;
      }

      for (const toolCall of msg.tool_calls!) {
        let toolResult: string;
        const targetCollection = toolNameToCollection.get(
          toolCall.function.name,
        );
        if (targetCollection) {
          try {
            const record = JSON.parse(toolCall.function.arguments) as Record<
              string,
              unknown
            >;
            if (!record.$type) record.$type = targetCollection;
            const ref = await createAtprotoRecord(
              config.agent,
              targetCollection,
              record,
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
        } else if (toolCall.function.name === "create_atproto_record") {
          try {
            const args = JSON.parse(toolCall.function.arguments) as {
              collection: string;
              record: Record<string, unknown>;
            };
            if (!lexiconlessCollections.has(args.collection)) {
              throw new Error(
                `create_atproto_record is only for lexicon-less collections (${
                  [...lexiconlessCollections].join(", ")
                }). Use the typed create_* tool for "${args.collection}".`,
              );
            }
            if (!args.record.$type) args.record.$type = args.collection;
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
        } else if (toolCall.function.name === "check_thread_status") {
          try {
            const args = JSON.parse(toolCall.function.arguments) as {
              rootUri: string;
              maxDepth?: number;
            };
            const status = await checkThreadStatus(
              config.agent,
              args.rootUri,
              args.maxDepth ?? 1,
            );
            toolResult = JSON.stringify({ success: true, status });
          } catch (err) {
            toolResult = JSON.stringify({
              success: false,
              error: (err as Error).message,
            });
          }
        } else {
          toolResult = JSON.stringify({
            success: false,
            error: `Unknown tool: ${toolCall.function.name}`,
          });
        }

        console.error(`tool result for ${toolCall.id}: ${toolResult}`);
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolResult,
        });
      }
    }

    console.error("Agent response:", JSON.stringify(agentResponse, null, 2));

    const completedAtIso = new Date().toISOString();
    entry.status = "complete";
    entry.completedAt = completedAtIso;
    entry.description = agentResponse.description;
    entry.createdRecords = createdRecords;
    threadRecord.status = "complete";
    threadRecord.updatedAt = completedAtIso;
    try {
      await putThreadRecord(
        config.agent,
        threadRkey,
        threadRecord,
        config.createRecordDryRun,
      );
    } catch (err) {
      console.error(
        "Failed to write thread record (complete):",
        (err as Error).message,
      );
    }

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
