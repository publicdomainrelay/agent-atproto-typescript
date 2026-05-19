import { parseArgs } from "jsr:@std/cli/parse-args";
import { exists } from "https://deno.land/std@0.136.0/fs/mod.ts";
import { stringify as yamlStringify } from "https://deno.land/std@0.136.0/encoding/yaml.ts";
import { Hono } from "hono";
import { InferenceClient } from "@digitalocean/dots";
import { Agent, CredentialSession, RichText } from "@atproto/api";
import { IdResolver } from "@atproto/identity";
import { getPdsEndpoint } from "@atproto/common-web";
import { WelcomeMatClient, enrolledClients, computeActx } from "./welcomeMat.ts";
import {
  spawnComputeRequester,
  SubAgentReport,
  SubAgentRequest,
} from "./subagents.ts";
import { EventType, FlowContext } from "./dffml.ts";

// Lexicon: com.publicdomainrelay.temp.agent.skill
type StrongRef = {
  $type: "com.atproto.repo.strongRef";
  uri: string;
  cid: string;
};

type PropertyReference =
  | { path: string; string: string }
  | { path: string; $type: "com.atproto.repo.strongRef"; uri: string; cid: string };

type AgentSkill = {
  $type: "com.publicdomainrelay.temp.agent.skill";
  name: string;
  description: string;
  content: string;
  examples: StrongRef[];
  property_references?: PropertyReference[];
  createdAt: string;
};

type AgentResponse = {
  description: string;
  createdRecords: StrongRef[];
};

const SKILL_COLLECTION = "com.publicdomainrelay.temp.agent.skill";
const MEMORY_COLLECTION = "network.comind.memory";
const SIGNAL_COLLECTION = "network.comind.signal";
const POST_COLLECTION = "app.bsky.feed.post";

// network.comind.memory shape — see central/lexicons/network.comind.memory.json
type ComindMemoryRecord = {
  $type: typeof MEMORY_COLLECTION;
  content: string;
  type?: string;
  actors?: string[];
  context?: string;
  related?: string[];
  source?: string;
  tags?: string[];
  createdAt: string;
};

// Conversation history surfaced to the LLM, derived from the post tree
// (app.bsky.feed.getPostThread) and paired network.comind.memory records.
type HistoryTurn = {
  uri: string;
  cid: string;
  author: string;
  isAgent: boolean;
  createdAt?: string;
  text?: string;
  memory?: ComindMemoryRecord;
};

type HistoryResult =
  | { found: false; reason: string; triggerUri: string }
  | { found: true; triggerUri: string; turns: HistoryTurn[] };

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

function rkeyFromAtUri(uri: string): string {
  const withoutPrefix = uri.startsWith("at://") ? uri.slice("at://".length) : uri;
  const parts = withoutPrefix.split("/");
  return parts[2] ?? "";
}

function didFromAtUri(uri: string): string {
  const withoutPrefix = uri.startsWith("at://") ? uri.slice("at://".length) : uri;
  return withoutPrefix.split("/")[0] ?? "";
}

function collectionFromAtUri(uri: string): string {
  const withoutPrefix = uri.startsWith("at://") ? uri.slice("at://".length) : uri;
  return withoutPrefix.split("/")[1] ?? "";
}

async function getMemoryRecord(
  agent: Agent,
  did: string,
  rkey: string,
): Promise<ComindMemoryRecord | null> {
  try {
    const result = await agent.com.atproto.repo.getRecord({
      repo: did,
      collection: MEMORY_COLLECTION,
      rkey,
    });
    return result.data.value as ComindMemoryRecord;
  } catch {
    return null;
  }
}

async function putMemoryRecord(
  agent: Agent,
  rkey: string,
  record: ComindMemoryRecord,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    console.log(
      JSON.stringify({
        log: "debug",
        func: "putMemoryRecord",
        msg: "dry-run putRecord",
        data: { collection: MEMORY_COLLECTION, rkey, record },
      }),
    );
    return;
  }
  await agent.com.atproto.repo.putRecord({
    repo: agent.assertDid,
    collection: MEMORY_COLLECTION,
    rkey,
    record,
  });
}

// Write a network.comind.signal ack keyed by the trigger's rkey so
// hasExistingReply can find it via a single getRecord call.
async function writeAckSignal(
  agent: Agent,
  triggerUri: string,
  replyUri: string | null,
  dryRun: boolean,
): Promise<void> {
  const rkey = rkeyFromAtUri(triggerUri);
  const record = {
    $type: SIGNAL_COLLECTION,
    signalType: "ack",
    content: replyUri ?? triggerUri,
    context: replyUri ?? triggerUri,
    createdAt: new Date().toISOString(),
  };
  if (dryRun) {
    console.log(
      JSON.stringify({
        log: "debug",
        func: "writeAckSignal",
        msg: "dry-run putRecord",
        data: { collection: SIGNAL_COLLECTION, rkey, record },
      }),
    );
    return;
  }
  try {
    await agent.com.atproto.repo.putRecord({
      repo: agent.assertDid,
      collection: SIGNAL_COLLECTION,
      rkey,
      record,
    });
  } catch (err) {
    console.error("writeAckSignal failed:", (err as Error).message);
  }
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

// Flatten a getPostThread response into an ancestor chain (root → ... → leaf).
// Returns posts from oldest to newest.
// deno-lint-ignore no-explicit-any
function flattenAncestorChain(thread: any): any[] {
  const chain: any[] = [];
  // Walk up via .parent links until we hit the root.
  // deno-lint-ignore no-explicit-any
  let cursor: any = thread;
  while (cursor) {
    if (cursor.post) chain.push(cursor.post);
    cursor = cursor.parent;
  }
  return chain.reverse();
}

// Walk the post tree's ancestor chain from a leaf post URI, pairing each
// agent-authored post with its network.comind.memory record (same rkey).
// This is what the LLM sees as the prior-actions history for this branch.
async function checkThreadStatus(
  agent: Agent,
  triggerUri: string,
  agentDid: string,
  parentHeight = 20,
): Promise<HistoryResult> {
  // deno-lint-ignore no-explicit-any
  let threadResp: any;
  try {
    threadResp = await agent.app.bsky.feed.getPostThread({
      uri: triggerUri,
      depth: 0,
      parentHeight,
    });
  } catch (err) {
    return {
      found: false,
      reason: `getPostThread failed: ${(err as Error).message}`,
      triggerUri,
    };
  }

  const chain = flattenAncestorChain(threadResp.data.thread);
  if (chain.length === 0) {
    return { found: false, reason: "empty-chain", triggerUri };
  }

  // For each agent-authored post, fetch the paired memory in parallel.
  const turns: HistoryTurn[] = await Promise.all(
    // deno-lint-ignore no-explicit-any
    chain.map(async (post: any): Promise<HistoryTurn> => {
      const uri = post.uri as string;
      const cid = post.cid as string;
      const author = post.author?.did as string;
      const isAgent = author === agentDid;
      // deno-lint-ignore no-explicit-any
      const record = post.record as any;
      const text = typeof record?.text === "string" ? record.text : undefined;
      const createdAt = typeof record?.createdAt === "string"
        ? record.createdAt
        : undefined;
      const turn: HistoryTurn = { uri, cid, author, isAgent, createdAt, text };
      if (isAgent) {
        const rkey = rkeyFromAtUri(uri);
        const memory = await getMemoryRecord(agent, author, rkey);
        if (memory) turn.memory = memory;
      }
      return turn;
    }),
  );

  return { found: true, triggerUri, turns };
}

// Render the history into a markdown block for the LLM user message.
function renderHistoryForLlm(history: HistoryResult): string {
  if (!history.found) {
    return `\n\n(No prior history available for this branch: ${history.reason})`;
  }
  if (history.turns.length === 0) return "";
  const lines: string[] = [
    "",
    "",
    "Prior conversation on this branch (root → trigger, oldest first).",
    "Each agent turn includes its paired network.comind.memory record if present.",
    "",
  ];
  history.turns.forEach((turn, i) => {
    const who = turn.isAgent ? "agent" : "user";
    lines.push(`[${i + 1}] ${who} — ${turn.uri}`);
    if (turn.createdAt) lines.push(`    createdAt: ${turn.createdAt}`);
    if (turn.text) lines.push(`    text: ${JSON.stringify(turn.text)}`);
    if (turn.memory) {
      lines.push(`    memory.content: ${JSON.stringify(turn.memory.content)}`);
      if (turn.memory.type) lines.push(`    memory.type: ${turn.memory.type}`);
      if (turn.memory.related && turn.memory.related.length > 0) {
        lines.push(`    memory.related (createdRecords):`);
        for (const r of turn.memory.related) lines.push(`      - ${r}`);
      }
    } else if (turn.isAgent) {
      lines.push(`    memory: (none — pre-migration or write failed)`);
    }
    lines.push("");
  });
  return lines.join("\n");
}

function isPropertyRefStrongRef(
  pr: PropertyReference,
): pr is { path: string; $type: "com.atproto.repo.strongRef"; uri: string; cid: string } {
  return "$type" in pr && pr.$type === "com.atproto.repo.strongRef";
}

async function resolvePropertyReferences(
  propertyRefs: PropertyReference[],
): Promise<PropertyReference[]> {
  return Promise.all(
    propertyRefs.map(async (pr): Promise<PropertyReference> => {
      if (!isPropertyRefStrongRef(pr)) return pr;
      const resolved = await resolveStrongRefs(await resolveStrongRef(pr));
      return { path: pr.path, string: JSON.stringify(resolved) } as PropertyReference;
    }),
  );
}

async function listAgentSkills(did: string): Promise<unknown[]> {
  const pds = await getPdsForDid(did);

  const readAgent = new Agent(new URL(pds));
  const result = await readAgent.com.atproto.repo.listRecords({
    repo: did,
    collection: SKILL_COLLECTION,
  });

  return Promise.all(
    result.data.records.map(async (r) => {
      const resolved = await resolveStrongRefs(r) as Record<string, unknown>;
      const value = resolved.value as Record<string, unknown> | undefined;
      if (value?.property_references && Array.isArray(value.property_references)) {
        value.property_references = await resolvePropertyReferences(
          value.property_references as PropertyReference[],
        );
      }
      return resolved;
    }),
  );
}

function collectTypesDeep(val: unknown, out: Set<string>): void {
  if (typeof val !== "object" || val === null) return;
  if (Array.isArray(val)) {
    for (const item of val) collectTypesDeep(item, out);
    return;
  }
  const obj = val as Record<string, unknown>;
  if (typeof obj.$type === "string" && obj.$type.includes(".")) {
    out.add(obj.$type);
  }
  for (const v of Object.values(obj)) collectTypesDeep(v, out);
}

function collectExampleTypes(skills: unknown[]): Set<string> {
  const types = new Set<string>();
  for (const skill of skills) {
    collectTypesDeep(skill, types);
  }
  // Remove meta-types that aren't writable collections
  types.delete("com.atproto.repo.strongRef");
  types.delete("com.publicdomainrelay.temp.agent.skill");
  types.delete("com.publicdomainrelay.temp.agent.thread");
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

  if (collection === "app.bsky.feed.post" && typeof record.text === "string") {
    const rt = new RichText({ text: record.text });
    await rt.detectFacets(agent);
    record.text = rt.text;
    if (rt.facets && rt.facets.length > 0) record.facets = rt.facets;
  }

  console.error(
    "createRecord: validating against",
    exampleRecords.length,
    "example records for collection",
    collection,
  );

  if (dryRun) {
    console.log(
      JSON.stringify({
        log: "debug",
        func: "createAtprotoRecord",
        msg: "dry-run createRecord",
        data: { collection, record },
      }),
    );
    return {
      $type: "com.atproto.repo.strongRef",
      uri: `at://did:plc:lpfuqerea3deuoyrn7ojser4/${collection}/1290312093821`,
      cid: "kj3498u342i34mp3654xsmrwjpihbsjyxzbcyvvnwhry2cci5fh2ubjtf74",
    };
  }

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

  const createRecordDryRun = Deno.env.get("CREATE_RECORD_DRY_RUN") === "1";

  const atprotoPassword = Deno.env.get("ATPROTO_PASSWORD");
  if (!atprotoPassword && !createRecordDryRun) {
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
    createRecordDryRun,
    atprotoPassword: atprotoPassword ?? "",
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

type PreparedEvent = {
  triggerUri: string;
  triggerRef: StrongRef;
  triggerDid: string;
};

type PrepareResult =
  | { ok: true; prepared: PreparedEvent }
  | { ok: false; reason: string; replyUri?: string };

// In-process guard against the narrow race where two webhook deliveries for
// the same trigger arrive before our first reply is on the PDS.
const inFlightTriggers = new Set<string>();

// Idempotency check: have we already replied to this trigger? Survives
// restarts via a network.comind.signal ack record keyed by the trigger rkey —
// O(1) getRecord instead of paginating all posts.
async function hasExistingReply(
  agent: Agent,
  agentDid: string,
  triggerUri: string,
): Promise<string | null> {
  const rkey = rkeyFromAtUri(triggerUri);
  try {
    const result = await agent.com.atproto.repo.getRecord({
      repo: agentDid,
      collection: SIGNAL_COLLECTION,
      rkey,
    });
    // deno-lint-ignore no-explicit-any
    const rec = result.data.value as any;
    return rec?.context ?? result.data.uri;
  } catch {
    // 404 or any error means no ack record exists
  }
  return null;
}

async function prepareEvent(
  config: Config,
  body: WebhookPayload,
): Promise<PrepareResult> {
  if (body.event.did === config.agentDid) {
    console.error(
      `Ignoring self-authored event (did=${config.agentDid}, collection=${body.event.commit.collection}, rkey=${body.event.commit.rkey}) to avoid feedback loop`,
    );
    return { ok: false, reason: "self-authored-event" };
  }

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

  if (inFlightTriggers.has(triggerUri)) {
    return { ok: false, reason: "in-flight" };
  }
  const existingReply = await hasExistingReply(
    config.agent,
    config.agentDid,
    triggerUri,
  );
  if (existingReply) {
    return { ok: false, reason: "already-replied", replyUri: existingReply };
  }

  inFlightTriggers.add(triggerUri);
  return {
    ok: true,
    prepared: { triggerUri, triggerRef, triggerDid },
  };
}

type AgentTools = {
  skills: unknown[];
  knownCollections: Set<string>;
  exampleRecords: unknown[];
  collectionTools: CollectionTool[];
  lexiconlessCollections: Set<string>;
  toolNameToCollection: Map<string, string>;
  // deno-lint-ignore no-explicit-any
  genericCreateTool: any | null;
};

async function loadAgentTools(config: Config): Promise<AgentTools> {
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
  return {
    skills,
    knownCollections,
    exampleRecords,
    collectionTools,
    lexiconlessCollections,
    toolNameToCollection,
    genericCreateTool,
  };
}

function buildSystemPrompt(
  skills: unknown[],
  knownCollections: Set<string>,
): string {
  const skillsYaml = yamlStringify(skills as Record<string, unknown>[]);
  return [
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
    "Valid record collections (from skill examples): " + "",
    ([...knownCollections].join(", ") || "(none)"),
    "",
    "You have access to the following skills (in YAML format):",
    "```yaml",
    skillsYaml,
    "```",
  ].join("\n");
}

async function buildUserMessage(
  config: Config,
  body: WebhookPayload,
  triggerUri: string,
): Promise<string> {
  const history = await checkThreadStatus(
    config.agent,
    triggerUri,
    config.agentDid,
  );
  const priorHistory = renderHistoryForLlm(history);
  return `Webhook payload:\n\n${JSON.stringify(body, null, 2)}${priorHistory}`;
}

const WELCOME_MAT_TOOL = {
  type: "function" as const,
  function: {
    name: "create_welcome_mat_account",
    description:
      "Create a new ATProto account on a Welcome Mat service (https://github.com/solpbc/welcome-mat). Discovers /.well-known/welcome.md, generates a DPoP keypair, fetches and signs the ToS, and POSTs to the signup endpoint. Returns the DID of the newly created account.",
    parameters: {
      type: "object",
      properties: {
        service_origin: {
          type: "string",
          description: "Base URL of the Welcome Mat service, e.g. https://welcome-m.at",
        },
        extra_fields: {
          type: "object",
          description: "Optional service-specific signup fields (e.g. handle, subject).",
          additionalProperties: true,
        },
      },
      required: ["service_origin"],
    },
  },
};

const SPAWN_COMPUTE_REQUESTER_TOOL = {
  type: "function" as const,
  function: {
    name: "spawn_compute_requester_subagent",
    description:
      "Spawn a sub-agent in a fresh ATProto account (via Welcome Mat) and have it submit a compute RFP from that account. Use whenever a VM is needed instead of creating compute.vm / market.rfp records from your own account. Returns { did, handle, rbacUri, vmUri, rfpUri }.",
    parameters: {
      type: "object",
      properties: {
        service_origin: {
          type: "string",
          description: "Welcome Mat service base URL, e.g. https://welcome-m.at",
        },
        handle: {
          type: "string",
          description: "Handle for the new sub-agent account.",
        },
        vm_spec: {
          type: "object",
          description: "Spec for the compute.vm record the sub-agent will create on its own account.",
          properties: {
            cpus: { type: "integer" },
            mem: { type: "string" },
            disk: { type: "string" },
            network: { type: "string" },
            location: {
              type: "object",
              properties: {
                country: { type: "string" },
                region: { type: "string" },
              },
            },
            user_data: { type: "string" },
          },
          required: ["cpus", "mem", "disk"],
        },
        accept_uri: {
          type: "string",
          description: "Optional AT-URI of the accept record used as actx seed.",
        },
      },
      required: ["service_origin", "handle", "vm_spec"],
    },
  },
};

const CREATE_RECORD_ON_ENROLLED_ACCOUNT_TOOL = {
  type: "function" as const,
  function: {
    name: "create_record_on_enrolled_account",
    description:
      "Create an ATProto record on a previously enrolled Welcome Mat account (NOT the agent's own account). " +
      "Use this after create_welcome_mat_account to write records (e.g. com.fedproxy.rbac) to the new account's PDS via DPoP auth. " +
      "The service_origin must match a prior create_welcome_mat_account call.",
    parameters: {
      type: "object",
      properties: {
        service_origin: {
          type: "string",
          description: "Base URL of the Welcome Mat service used during enrollment, e.g. https://welcome-m.at",
        },
        repo: {
          type: "string",
          description: "DID of the account to write the record to (returned by create_welcome_mat_account).",
        },
        collection: {
          type: "string",
          description: "NSID collection, e.g. com.fedproxy.rbac",
        },
        record: {
          type: "object",
          description: "Record body. $type must match collection.",
          additionalProperties: true,
        },
      },
      required: ["service_origin", "repo", "collection", "record"],
    },
  },
};

const COMPUTE_ACTX_TOOL = {
  type: "function" as const,
  function: {
    name: "compute_actx",
    description:
      "Compute the actx value (SHA1 hex) from an accept record URI. " +
      "Used to construct the 'sub' field in a com.fedproxy.rbac role definition: " +
      "sub = actx:{actx}:plc:{did-plc-key}:role:{role}",
    parameters: {
      type: "object",
      properties: {
        accept_uri: {
          type: "string",
          description: "The AT-URI of the accepted compute contract (at://did:plc:.../com.publicdomainrelay.temp.market.accept/rkey)",
        },
      },
      required: ["accept_uri"],
    },
  },
};

async function dispatchToolCall(
  config: Config,
  // deno-lint-ignore no-explicit-any
  toolCall: any,
  tools: AgentTools,
  createdRecords: StrongRef[],
): Promise<string> {
  const {
    toolNameToCollection,
    lexiconlessCollections,
    knownCollections,
    exampleRecords,
  } = tools;
  const targetCollection = toolNameToCollection.get(toolCall.function.name);
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
      return JSON.stringify({ success: true, strongRef: ref });
    } catch (err) {
      return JSON.stringify({ success: false, error: (err as Error).message });
    }
  }
  if (toolCall.function.name === "create_atproto_record") {
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
      return JSON.stringify({ success: true, strongRef: ref });
    } catch (err) {
      return JSON.stringify({ success: false, error: (err as Error).message });
    }
  }
  if (toolCall.function.name === "create_welcome_mat_account") {
    try {
      const args = JSON.parse(toolCall.function.arguments) as {
        service_origin: string;
        extra_fields?: Record<string, unknown>;
      };
      const client = await WelcomeMatClient.connect(
        args.service_origin,
        args.extra_fields ?? {},
      );
      // Try to get the DID from the session endpoint.
      const infoRes = await client.fetch("/xrpc/com.atproto.server.getSession").catch(() =>
        null
      );
      let did: string | null = null;
      if (infoRes?.ok) {
        const info = await infoRes.json().catch(() => null);
        did = info?.did ?? null;
      }
      return JSON.stringify({
        success: true,
        service: args.service_origin,
        did,
        note: "Account created via Welcome Mat enrollment. " +
          "Next: call create_record_on_enrolled_account to write a com.fedproxy.rbac record on this account. " +
          "The $key portion of did:plc:$key must be used as the 'role' field in compute contracts.",
      });
    } catch (err) {
      return JSON.stringify({ success: false, error: (err as Error).message });
    }
  }
  if (toolCall.function.name === "create_record_on_enrolled_account") {
    try {
      const args = JSON.parse(toolCall.function.arguments) as {
        service_origin: string;
        repo: string;
        collection: string;
        record: Record<string, unknown>;
      };
      const key = args.service_origin.replace(/\/$/, "").toLowerCase();
      const client = enrolledClients.get(key);
      if (!client) {
        throw new Error(
          `No enrolled client for ${args.service_origin}. Call create_welcome_mat_account first.`,
        );
      }
      if (!args.record.$type) args.record.$type = args.collection;
      const result = await client.createRecord(args.repo, args.collection, args.record);
      return JSON.stringify({ success: true, uri: result.uri, cid: result.cid });
    } catch (err) {
      return JSON.stringify({ success: false, error: (err as Error).message });
    }
  }
  if (toolCall.function.name === "spawn_compute_requester_subagent") {
    try {
      const args = JSON.parse(toolCall.function.arguments) as {
        service_origin: string;
        handle: string;
        vm_spec: SubAgentRequest["vmSpec"];
        accept_uri?: string;
      };
      const request: SubAgentRequest = {
        serviceOrigin: args.service_origin,
        handle: args.handle,
        vmSpec: args.vm_spec,
        acceptUri: args.accept_uri,
      };
      // Run the sub-agent flow; collect all bubbled-up events so we can log
      // the full lineage. The dffml MemoryOrchestrator gives every operation
      // its own FlowContext, so any future N-level nesting (sub-sub-agents)
      // shows up here automatically.
      const gen = spawnComputeRequester(request);
      const events: Array<{ ctx: string; parent?: string; spawnedBy?: string; event: string; data: unknown }> = [];
      let report: SubAgentReport | undefined;
      while (true) {
        const next = await gen.next();
        if (next.done) {
          report = next.value;
          break;
        }
        const [ctx, event, data] = next.value as [FlowContext, EventType, unknown];
        events.push({
          ctx: ctx.id,
          parent: ctx.parent?.id,
          spawnedBy: ctx.spawnedBy,
          event,
          data,
        });
        console.error(
          `[subagent ${ctx.spawnedBy ?? "root"}/${ctx.id}] ${event}:`,
          JSON.stringify(data).slice(0, 200),
        );
      }
      if (!report) throw new Error("sub-agent produced no report");

      // Track the sub-agent in createdRecords so the parent's memory record
      // captures it. Use a synthetic strongRef pointing at the sub-agent's
      // RFP (the user-visible artifact of the spawn).
      if (report.rfpUri) {
        createdRecords.push({
          $type: "com.atproto.repo.strongRef",
          uri: report.rfpUri,
          cid: "", // sub-agent flow returns uri+cid in its own report; cid is on report.rfpUri's record
        });
      }
      return JSON.stringify({ success: true, report, events: events.length });
    } catch (err) {
      return JSON.stringify({ success: false, error: (err as Error).message });
    }
  }
  if (toolCall.function.name === "compute_actx") {
    try {
      const args = JSON.parse(toolCall.function.arguments) as { accept_uri: string };
      const actx = await computeActx(args.accept_uri);
      return JSON.stringify({ success: true, actx });
    } catch (err) {
      return JSON.stringify({ success: false, error: (err as Error).message });
    }
  }
  return JSON.stringify({
    success: false,
    error: `Unknown tool: ${toolCall.function.name}`,
  });
}

async function runAgentLoop(
  config: Config,
  inference: InferenceClient,
  model: string,
  // deno-lint-ignore no-explicit-any
  messages: any[],
  tools: AgentTools,
): Promise<AgentResponse> {
  const createdRecords: StrongRef[] = [];
  const llmTools = [
    SPAWN_COMPUTE_REQUESTER_TOOL,
    WELCOME_MAT_TOOL,
    CREATE_RECORD_ON_ENROLLED_ACCOUNT_TOOL,
    COMPUTE_ACTX_TOOL,
    ...tools.collectionTools.map((c) => c.tool),
    ...(tools.genericCreateTool ? [tools.genericCreateTool] : []),
  ];
  console.error(llmTools);

  for (let step = 0; step < 10; step++) {
    console.error(`=== LLM STEP ${step} ===`);

    const completion = await inference.chat.completions.create({
      model,
      messages,
      tools: llmTools,
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
      return { description: msg.content ?? "", createdRecords };
    }

    for (const toolCall of msg.tool_calls!) {
      const toolResult = await dispatchToolCall(
        config,
        toolCall,
        tools,
        createdRecords,
      );
      console.error(`tool result for ${toolCall.id}: ${toolResult}`);
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: toolResult,
      });
    }
  }
  return { description: "", createdRecords };
}

// Pick the agent's reply post out of createdRecords (the one that replies to
// the trigger). Falls back to any app.bsky.feed.post the agent created.
function findAgentReply(
  createdRecords: StrongRef[],
  triggerUri: string,
): StrongRef | null {
  let postFallback: StrongRef | null = null;
  for (const r of createdRecords) {
    if (collectionFromAtUri(r.uri) !== POST_COLLECTION) continue;
    if (postFallback === null) postFallback = r;
    if (r.uri.includes(triggerUri)) return r;
  }
  return postFallback;
}

// Write a network.comind.memory record paired (by rkey) with the agent's
// reply post. This is the structured machine-readable record of what the
// agent did for this trigger. Comind-protocol-compatible.
async function writeMemoryRecord(
  config: Config,
  prepared: PreparedEvent,
  description: string,
  createdRecords: StrongRef[],
): Promise<void> {
  const replyRef = findAgentReply(createdRecords, prepared.triggerUri);
  // Pair rkey with the agent's reply post if present, else fresh TID via
  // letting the PDS allocate one (createRecord, not putRecord).
  const nowIso = new Date().toISOString();
  const actors = Array.from(
    new Set(
      [config.agentDid, prepared.triggerDid].concat(
        createdRecords
          .map((r) => didFromAtUri(r.uri))
          .filter((d) => d.length > 0),
      ),
    ),
  );
  const related = Array.from(
    new Set(
      (replyRef ? [replyRef.uri] : []).concat(
        createdRecords
          .filter((r) => r.uri !== replyRef?.uri)
          .map((r) => r.uri),
      ),
    ),
  );
  const memory: ComindMemoryRecord = {
    $type: MEMORY_COLLECTION,
    content: description,
    type: "agent.reply",
    actors,
    context: `trigger=${prepared.triggerUri}`,
    related,
    source: prepared.triggerUri,
    tags: ["agent", "bluesky", "webhook"],
    createdAt: nowIso,
  };

  if (!replyRef) {
    // No reply post produced — write the memory with createRecord so the PDS
    // assigns a fresh TID. The pairing convention is lost but the record is
    // still queryable by source.
    if (config.createRecordDryRun) {
      console.log(
        JSON.stringify({
          log: "debug",
          func: "writeMemoryRecord",
          msg: "dry-run createRecord (no agent reply found, fresh TID)",
          data: { collection: MEMORY_COLLECTION, record: memory },
        }),
      );
      return;
    }
    try {
      await config.agent.com.atproto.repo.createRecord({
        repo: config.agentDid,
        collection: MEMORY_COLLECTION,
        record: memory,
      });
    } catch (err) {
      console.error(
        "Failed to write memory record (unpaired):",
        (err as Error).message,
      );
    }
    return;
  }

  const rkey = rkeyFromAtUri(replyRef.uri);
  try {
    await putMemoryRecord(config.agent, rkey, memory, config.createRecordDryRun);
  } catch (err) {
    console.error("Failed to write memory record:", (err as Error).message);
  }
}

async function processWebhookBackground(
  config: Config,
  inference: InferenceClient,
  model: string,
  body: WebhookPayload,
  prepared: PreparedEvent,
): Promise<void> {
  try {
    const tools = await loadAgentTools(config);
    const systemPrompt = buildSystemPrompt(tools.skills, tools.knownCollections);
    const userMessage = await buildUserMessage(config, body, prepared.triggerUri);

    console.error("=== PROMPT ===");
    console.error("SYSTEM:", systemPrompt);
    console.error("USER:", userMessage);
    console.error("==============");

    // deno-lint-ignore no-explicit-any
    const messages: any[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    const agentResponse = await runAgentLoop(
      config,
      inference,
      model,
      messages,
      tools,
    );
    console.error("Agent response:", JSON.stringify(agentResponse, null, 2));
    await writeMemoryRecord(
      config,
      prepared,
      agentResponse.description,
      agentResponse.createdRecords,
    );
    const replyRef = findAgentReply(agentResponse.createdRecords, prepared.triggerUri);
    await writeAckSignal(
      config.agent,
      prepared.triggerUri,
      replyRef?.uri ?? null,
      config.createRecordDryRun,
    );
  } catch (err) {
    console.error(
      "Background webhook processing failed:",
      (err as Error).message,
    );
    await writeMemoryRecord(
      config,
      prepared,
      `Error: ${(err as Error).message}`,
      [],
    );
    // Still write the ack so we don't retry a hard-failing trigger forever
    await writeAckSignal(
      config.agent,
      prepared.triggerUri,
      null,
      config.createRecordDryRun,
    );
  } finally {
    inFlightTriggers.delete(prepared.triggerUri);
  }
}

function makeApp(config: Config): Hono<AppEnv> {
  const inference = makeInferenceClient(config);
  const model = config.useDoModels ? DO_MODEL : LOCAL_MODEL;
  const app = new Hono<AppEnv>();

  app.post("/v1/hooks/airglow", async (c) => {
    const contents = await c.req.text();
    console.log(contents);
    const body = JSON.parse(contents) as WebhookPayload;

    const result = await prepareEvent(config, body);
    if (!result.ok) {
      return c.json({
        received: true,
        ignored: true,
        reason: result.reason,
        ...(result.replyUri ? { replyUri: result.replyUri } : {}),
      });
    }

    processWebhookBackground(config, inference, model, body, result.prepared)
      .catch((err) => {
        console.error(
          "Background webhook unhandled error:",
          (err as Error).message,
        );
        inFlightTriggers.delete(result.prepared.triggerUri);
      });

    return c.json({
      received: true,
      queued: true,
      triggerUri: result.prepared.triggerUri,
    });
  });

  return app;
}

const main = async () => {
  const config = makeEnv();
  console.error(`Config ${JSON.stringify(config)}`);

  const pds = await getPdsForDid(config.agentDid);
  console.error(`PDS ${JSON.stringify(pds)}`);
  if (config.createRecordDryRun) {
    // Dry-run: skip auth. Public reads (getPostThread, listRecords) still work
    // against the PDS unauthenticated; writes are short-circuited before any
    // auth-required call is reached.
    config.agent = new Agent(new URL(pds));
    console.error(
      `[dry-run] skipping ATProto login; PDS=${pds}, agentDid=${config.agentDid}`,
    );
  } else {
    const session = new CredentialSession(new URL(pds));
    console.error(`Session ${JSON.stringify(session)}`);
    await session.login({
      identifier: config.agentDid,
      password: config.atprotoPassword,
    });
    config.agent = new Agent(session);
    console.error(`Logged in as ${session.did}`);
  }

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
