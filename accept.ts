import { parseArgs } from "jsr:@std/cli/parse-args";
import { exists } from "https://deno.land/std@0.136.0/fs/mod.ts";
import { Hono } from "hono";
import { Agent, CredentialSession } from "@atproto/api";
import { IdResolver } from "@atproto/identity";
import { getPdsEndpoint } from "@atproto/common-web";

// Lexicon NSIDs (mirror models/publicdomainrelay.py).
const RFP_NSID = "com.publicdomainrelay.temp.market.rfp";
const BID_NSID = "com.publicdomainrelay.temp.market.bid";
const ACCEPT_NSID = "com.publicdomainrelay.temp.market.accept";
const BIDS_X402_NSID = "com.publicdomainrelay.temp.market.bids.x402";

type StrongRef = {
  $type: "com.atproto.repo.strongRef";
  uri: string;
  cid: string;
};

type BidRecord = {
  $type: typeof BID_NSID;
  rfp: StrongRef;
  payload: StrongRef;
  config?: StrongRef;
};

type CollectedBid = {
  did: string;
  uri: string;
  cid: string;
  record: BidRecord;
  payload?: Record<string, unknown>;
};

// --- webhook envelope (matches main.ts) ---------------------------------

type Commit = {
  operation: string;
  collection: string;
  rkey: string;
  cid: string;
  record: { $type: string; payload?: StrongRef };
};
type Event = { did: string; time_us: number; kind: string; commit: Commit };
type WebhookPayload = {
  automation: string;
  lexicon: string;
  conditions?: unknown[];
  event: Event;
};

// --- config -------------------------------------------------------------

type Config = {
  unixSocket: string | undefined;
  listenSeconds: number;
  allowBidDids: Set<string>;
  denyBidDids: Set<string>;
  agentDid: string;
  atprotoPassword: string;
  createRecordDryRun: boolean;
  x402Pay: boolean;
  jetstreamUrl: string;
  agent: Agent;
};

function toArray(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v.map(String) : [String(v)];
}

function makeConfig(): Config {
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
  const flags = parseArgs(Deno.args, {
    string: ["unix_socket", "allow_bid_did", "deny_bid_did", "jetstream_url"],
    default: { listen_seconds: 5 },
    alias: {
      "unix-socket": "unix_socket",
      "listen-seconds": "listen_seconds",
      "allow-bid-did": "allow_bid_did",
      "deny-bid-did": "deny_bid_did",
      "jetstream-url": "jetstream_url",
    },
    collect: ["allow_bid_did", "deny_bid_did"],
  });
  return {
    unixSocket: flags.unix_socket,
    listenSeconds: Number(flags.listen_seconds) || 5,
    allowBidDids: new Set(toArray(flags.allow_bid_did)),
    denyBidDids: new Set(toArray(flags.deny_bid_did)),
    agentDid,
    atprotoPassword,
    createRecordDryRun: Deno.env.get("CREATE_RECORD_DRY_RUN") === "1",
    x402Pay: Deno.env.get("X402_PAY") === "1",
    jetstreamUrl: flags.jetstream_url ??
      "wss://jetstream2.us-east.bsky.network/subscribe",
    agent: null as unknown as Agent,
  };
}

// --- atproto helpers ----------------------------------------------------

const idResolver = new IdResolver();

async function getPdsForDid(did: string): Promise<string> {
  const doc = await idResolver.did.resolve(did);
  if (!doc) throw new Error(`Could not resolve DID: ${did}`);
  const pds = getPdsEndpoint(doc);
  if (!pds) throw new Error(`No PDS endpoint for ${did}`);
  return pds;
}

async function getRecord(
  did: string,
  collection: string,
  rkey: string,
): Promise<{ uri: string; cid: string; value: Record<string, unknown> }> {
  const pds = await getPdsForDid(did);
  const read = new Agent(new URL(pds));
  const r = await read.com.atproto.repo.getRecord({ repo: did, collection, rkey });
  return {
    uri: r.data.uri,
    cid: r.data.cid ?? "",
    value: r.data.value as Record<string, unknown>,
  };
}

function parseAtUri(uri: string): { did: string; collection: string; rkey: string } {
  const parts = uri.slice("at://".length).split("/");
  return { did: parts[0], collection: parts[1], rkey: parts[2] };
}

async function resolveStrongRef(ref: StrongRef): Promise<Record<string, unknown>> {
  const { did, collection, rkey } = parseAtUri(ref.uri);
  const r = await getRecord(did, collection, rkey);
  return r.value;
}

// --- jetstream collection-filtered firehose ------------------------------

type JetstreamMsg = {
  did: string;
  time_us: number;
  kind: string;
  commit?: {
    operation: string;
    collection: string;
    rkey: string;
    cid?: string;
    record?: Record<string, unknown>;
  };
};

async function collectBidsForRfp(
  config: Config,
  rfpUri: string,
  seconds: number,
): Promise<CollectedBid[]> {
  const url = `${config.jetstreamUrl}?wantedCollections=${encodeURIComponent(BID_NSID)}`;
  console.error(`[accept] connecting jetstream ${url} for ${seconds}s, filtering bid.rfp.uri=${rfpUri}`);
  const collected: CollectedBid[] = [];
  const ws = new WebSocket(url);
  const done = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* noop */ }
      resolve();
    }, seconds * 1000);
    ws.onclose = () => { clearTimeout(timer); resolve(); };
    ws.onerror = (e) => {
      console.error("[accept] jetstream error:", (e as ErrorEvent).message ?? e);
    };
    ws.onmessage = (ev) => {
      let msg: JetstreamMsg;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ""); }
      catch { return; }
      const c = msg.commit;
      if (!c || c.operation !== "create") return;
      if (c.collection !== BID_NSID) return;
      const rec = c.record as BidRecord | undefined;
      if (!rec?.rfp?.uri || rec.rfp.uri !== rfpUri) return;
      const uri = `at://${msg.did}/${c.collection}/${c.rkey}`;
      collected.push({ did: msg.did, uri, cid: c.cid ?? "", record: rec });
      console.error(`[accept] collected bid ${uri}`);
    };
  });
  await done;
  console.error(`[accept] collected ${collected.length} bid(s) for ${rfpUri}`);
  return collected;
}

// --- policy + scoring ---------------------------------------------------

function policyFilter(
  config: Config,
  bids: CollectedBid[],
): CollectedBid[] {
  const allow = config.allowBidDids;
  const deny = config.denyBidDids;
  const kept: CollectedBid[] = [];
  for (const b of bids) {
    if (allow.size > 0) {
      if (!allow.has(b.did)) {
        console.error(`[policy] drop ${b.uri} (did ${b.did} not in allowlist)`);
        continue;
      }
    } else if (deny.size > 0 && deny.has(b.did)) {
      console.error(`[policy] drop ${b.uri} (did ${b.did} on denylist)`);
      continue;
    }
    kept.push(b);
  }
  return kept;
}

async function resolveBidPayloads(bids: CollectedBid[]): Promise<void> {
  await Promise.all(bids.map(async (b) => {
    try {
      b.payload = await resolveStrongRef(b.record.payload);
    } catch (err) {
      console.error(`[score] failed to resolve payload for ${b.uri}: ${(err as Error).message}`);
    }
  }));
}

function costOf(payload: Record<string, unknown> | undefined): number {
  if (!payload) return Number.POSITIVE_INFINITY;
  const c = payload.cost;
  if (typeof c === "number") return c;
  if (typeof c === "string") { const n = Number(c); return isNaN(n) ? Number.POSITIVE_INFINITY : n; }
  return Number.POSITIVE_INFINITY;
}

function scoreLowestCost(bids: CollectedBid[]): CollectedBid | null {
  if (bids.length === 0) return null;
  let best = bids[0];
  let bestCost = costOf(best.payload);
  for (const b of bids.slice(1)) {
    const c = costOf(b.payload);
    console.error(`[score] ${b.uri} cost=${c}`);
    if (c < bestCost) { best = b; bestCost = c; }
  }
  console.error(`[score] winner=${best.uri} cost=${bestCost}`);
  return best;
}

// --- accept record creation ---------------------------------------------

async function createAccept(
  config: Config,
  rfp: StrongRef,
  bid: StrongRef,
): Promise<StrongRef> {
  const record = {
    $type: ACCEPT_NSID,
    rfp,
    bid,
  };
  if (config.createRecordDryRun) {
    const fakeRkey = `dryrun-${Date.now().toString(36)}`;
    const ref: StrongRef = {
      $type: "com.atproto.repo.strongRef",
      uri: `at://${config.agentDid}/${ACCEPT_NSID}/${fakeRkey}`,
      cid: "bafyreidryrunacceptcidplaceholder000000000000000000000000000",
    };
    console.error("[accept] dry-run accept:", JSON.stringify({ record, ref }));
    return ref;
  }
  const res = await config.agent.com.atproto.repo.createRecord({
    repo: config.agent.assertDid,
    collection: ACCEPT_NSID,
    record,
  });
  const ref: StrongRef = {
    $type: "com.atproto.repo.strongRef",
    uri: res.data.uri,
    cid: res.data.cid,
  };
  console.error(`[accept] created ${ref.uri}`);
  return ref;
}

// --- post-accept plugin system ------------------------------------------

type PluginCtx = {
  config: Config;
  accept: StrongRef;
  bid: CollectedBid;
  payload: Record<string, unknown>;
};
type Plugin = (ctx: PluginCtx) => Promise<void>;

const plugins: Map<string, Plugin> = new Map();

async function x402Plugin(ctx: PluginCtx): Promise<void> {
  const baseUrl = String(ctx.payload.url ?? "");
  if (!baseUrl) {
    console.error("[x402] payload missing url");
    return;
  }
  const fullUrl = `${baseUrl}/${ctx.accept.uri}/${ctx.accept.cid}`;
  if (ctx.config.x402Pay) {
    console.error(`[x402] X402_PAY=1, calling: npx awal x402 pay ${fullUrl}`);
    const cmd = new Deno.Command("npx", {
      args: ["awal", "x402", "pay", fullUrl],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    console.error(`[x402] npx exit=${code}`);
    console.error(`[x402] stdout: ${new TextDecoder().decode(stdout)}`);
    console.error(`[x402] stderr: ${new TextDecoder().decode(stderr)}`);
  } else {
    console.error(`[x402] X402_PAY!=1, GET ${fullUrl}`);
    try {
      const res = await fetch(fullUrl);
      const body = await res.text();
      console.error(`[x402] GET status=${res.status} body=${body.slice(0, 1024)}`);
    } catch (err) {
      console.error(`[x402] GET failed: ${(err as Error).message}`);
    }
  }
}
plugins.set(BIDS_X402_NSID, x402Plugin);

async function dispatchPostAcceptPlugin(
  config: Config,
  accept: StrongRef,
  bid: CollectedBid,
): Promise<void> {
  const payload = bid.payload;
  if (!payload) {
    console.error(`[plugin] no resolved payload for ${bid.uri}, skipping`);
    return;
  }
  const t = String(payload.$type ?? "");
  const plugin = plugins.get(t);
  if (!plugin) {
    console.error(`[plugin] no handler for payload $type=${t}`);
    return;
  }
  console.error(`[plugin] dispatching ${t} for ${bid.uri}`);
  try {
    await plugin({ config, accept, bid, payload });
  } catch (err) {
    console.error(`[plugin] ${t} failed: ${(err as Error).message}`);
  }
}

// --- background workflow ------------------------------------------------

async function processRfpBackground(
  config: Config,
  body: WebhookPayload,
): Promise<void> {
  const ev = body.event;
  if (ev?.commit?.collection !== RFP_NSID) {
    console.error(`[bg] ignoring non-rfp event collection=${ev?.commit?.collection}`);
    return;
  }
  const rfpUri = `at://${ev.did}/${ev.commit.collection}/${ev.commit.rkey}`;
  const rfpRef: StrongRef = {
    $type: "com.atproto.repo.strongRef",
    uri: rfpUri,
    cid: ev.commit.cid,
  };
  try {
    const bids = await collectBidsForRfp(config, rfpUri, config.listenSeconds);
    const kept = policyFilter(config, bids);
    if (kept.length === 0) {
      console.error(`[bg] no bids passed policy for ${rfpUri}`);
      return;
    }
    await resolveBidPayloads(kept);
    const handled = kept.filter((b) => {
      const t = String(b.payload?.$type ?? "");
      if (!t) {
        console.error(`[policy] drop ${b.uri} (payload missing $type)`);
        return false;
      }
      if (!plugins.has(t)) {
        console.error(`[policy] drop ${b.uri} (no plugin for payload $type=${t})`);
        return false;
      }
      return true;
    });
    if (handled.length === 0) {
      console.error(`[bg] no bids with handleable payload type for ${rfpUri}`);
      return;
    }
    const winner = scoreLowestCost(handled);
    if (!winner) return;
    const bidRef: StrongRef = {
      $type: "com.atproto.repo.strongRef",
      uri: winner.uri,
      cid: winner.cid,
    };
    const acceptRef = await createAccept(config, rfpRef, bidRef);
    await dispatchPostAcceptPlugin(config, acceptRef, winner);
  } catch (err) {
    console.error(`[bg] unhandled error: ${(err as Error).message}`);
  }
}

// --- http app -----------------------------------------------------------

function makeApp(config: Config): Hono {
  const app = new Hono();
  app.post("/v1/hooks/airglow", async (c) => {
    const text = await c.req.text();
    let body: WebhookPayload;
    try { body = JSON.parse(text) as WebhookPayload; }
    catch { return c.json({ received: false, error: "invalid json" }, 400); }
    processRfpBackground(config, body).catch((err) => {
      console.error(`[hook] background failure: ${(err as Error).message}`);
    });
    return c.json({
      received: true,
      queued: true,
      rfp: body.event?.commit
        ? `at://${body.event.did}/${body.event.commit.collection}/${body.event.commit.rkey}`
        : null,
      listenSeconds: config.listenSeconds,
    });
  });
  return app;
}

// --- main ---------------------------------------------------------------

const main = async () => {
  const config = makeConfig();
  const pds = await getPdsForDid(config.agentDid);
  const session = new CredentialSession(new URL(pds));
  await session.login({
    identifier: config.agentDid,
    password: config.atprotoPassword,
  });
  config.agent = new Agent(session);
  console.error(`[accept] logged in as ${session.did}`);
  console.error(`[accept] listen_seconds=${config.listenSeconds} allow=${[...config.allowBidDids].join(",") || "(none)"} deny=${[...config.denyBidDids].join(",") || "(none)"} x402_pay=${config.x402Pay}`);

  const app = makeApp(config);
  const controller = new AbortController();
  // deno-lint-ignore no-explicit-any
  const options: any = {
    signal: controller.signal,
    onListen(addr: { path?: string; port?: number }) {
      console.error(`[accept] server started at ${addr.path ?? addr.port ?? "<unknown>"}`);
    },
  };
  if (config.unixSocket) {
    options.path = config.unixSocket;
    options.transport = "unix";
    if (await exists(config.unixSocket)) await Deno.remove(config.unixSocket);
  } else {
    options.port = Number(Deno.env.get("PORT") ?? 4022);
  }
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    Deno.addSignalListener(sig, () => {
      console.error("[accept] shutting down...");
      controller.abort();
    });
  }
  const server = Deno.serve(options, app.fetch);
  server.finished.then(() => console.error("[accept] server closed"));
};

await main();
