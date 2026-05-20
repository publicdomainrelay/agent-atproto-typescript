/**
 * Sub-agent runtime — parent-side helpers.
 *
 * A sub-agent is a separate Deno process that runs a TS skill tool with its
 * own ATProto identity. The parent spawns it through dffml's
 * SubprocessOrchestrator, which:
 *
 *   1. Creates a tempdir + unix-domain socket.
 *   2. Spawns `deno run <skill-tool-main.ts> --socket <sock>`.
 *   3. Accepts a single connection from the child's SubprocessBridge.
 *   4. Streams every FlowContext event the child emits back to the parent,
 *      with the child's root context re-parented under the parent's so
 *      `ctx.parent` walks across process boundaries cleanly.
 *
 * This module exports:
 *   - the dataflow operations the sub-agent runs (`enrollAccount`,
 *     `provisionRecords`, `emitReport`) — kept here so they can be unit-tested
 *     and so a future in-process variant can reuse them;
 *   - the public API: `spawnComputeRequester(request, parentCtx?)`, an
 *     async generator that drives the subprocess and resolves to a
 *     `SubAgentReport`.
 *
 * The actual `main()` that runs inside the sub-agent process lives at
 * `skills/spawnComputeRequester/tools/spawn_compute_requester_subagent/main.ts`.
 * That script is configured as a `tools` entry on the
 * `Spawn compute requester sub-agent` skill record so other agents discover
 * it through the agent.skill lexicon.
 */
import {
  DataFlow,
  Definition,
  EventType,
  FlowContext,
  Input,
  MemoryOrchestrator,
  op,
  OrchestratorEvent,
  SubprocessOrchestrator,
} from "./dffml.ts";
import { computeActx, WelcomeMatClient } from "./welcomeMat.ts";

// ── Shared Definitions / types (imported by the skill tool runner) ──────────

export const ServiceOriginDef: Definition = {
  name: "service_origin",
  primitive: "string",
};
export const HandleDef: Definition = { name: "handle", primitive: "string" };
export const NewAccountDidDef: Definition = {
  name: "new_account_did",
  primitive: "string",
};
export const ParentRequestDef: Definition = {
  name: "parent_request",
  primitive: "dict",
};
export const RbacRefDef: Definition = { name: "rbac_ref", primitive: "dict" };
export const VmRefDef: Definition = { name: "vm_ref", primitive: "dict" };
export const RfpRefDef: Definition = { name: "rfp_ref", primitive: "dict" };
export const ProfileRefDef: Definition = {
  name: "profile_ref",
  primitive: "dict",
};
export const SubAgentReportDef: Definition = {
  name: "subagent_report",
  primitive: "dict",
};

export type StrongRef = {
  $type: "com.atproto.repo.strongRef";
  uri: string;
  cid: string;
};

export type SubAgentRequest = {
  serviceOrigin: string;
  handle: string;
  vmSpec: {
    cpus: number;
    mem: string;
    disk: string;
    network?: string;
    location?: { country: string; region: string };
    user_data?: string;
  };
  acceptUri?: string;
};

export type SubAgentReport = {
  did: string;
  handle: string;
  rbacUri: string;
  vmUri: string;
  rfpUri: string;
  ctxId: string;
  parentCtxId?: string;
};

// ── Dynamic collection dispatchers ──────────────────────────────────────────
//
// Mirrors `buildCollectionTools` / `dispatchToolCall` in main.ts: each
// collection gets a small create-record function. The sub-agent dataflow
// routes its writes through these so that future LLM-driven sub-agents (which
// would have the LLM call the same functions by name) and the deterministic
// scripted flow share a single code path.

export const SUBAGENT_COLLECTIONS = [
  "com.fedproxy.rbac",
  "com.publicdomainrelay.temp.compute.vm",
  "com.publicdomainrelay.temp.market.rfp",
] as const;

export type CollectionDispatcher = (
  record: Record<string, unknown>,
) => Promise<StrongRef>;

export function buildSubAgentDispatchers(
  client: WelcomeMatClient,
  did: string,
  collections: readonly string[] = SUBAGENT_COLLECTIONS,
): Record<string, CollectionDispatcher> {
  const dispatchers: Record<string, CollectionDispatcher> = {};
  for (const collection of collections) {
    dispatchers[collection] = async (record) => {
      if (!record.$type) record.$type = collection;
      const r = await client.createRecord(did, collection, record);
      return {
        $type: "com.atproto.repo.strongRef",
        uri: r.uri,
        cid: r.cid,
      };
    };
  }
  return dispatchers;
}

// ── Operations ──────────────────────────────────────────────────────────────

export const enrollAccount = op<
  { request: SubAgentRequest },
  { did: string; origin: string }
>({
  name: "enroll_account",
  inputs: { request: ParentRequestDef },
  outputs: { did: NewAccountDidDef, origin: ServiceOriginDef },
  run: async (args) => {
    const req = args.request;
    const client = await WelcomeMatClient.connect(req.serviceOrigin, {
      handle: req.handle,
    });
    const info = await client.fetch("/xrpc/com.atproto.server.getSession")
      .catch(() => null);
    let did: string | null = null;
    if (info?.ok) {
      const body = await info.json().catch(() => null);
      did = body?.did ?? null;
    }
    if (!did) {
      throw new Error(
        "Welcome Mat signup did not yield a DID via getSession. " +
          "Sub-agent requires a did:plc identity.",
      );
    }
    return { did, origin: req.serviceOrigin };
  },
});

export const provisionRecords = op<
  { did: string; origin: string; request: SubAgentRequest },
  { rbac_ref: StrongRef; vm_ref: StrongRef; rfp_ref: StrongRef }
>({
  name: "provision_records",
  inputs: {
    did: NewAccountDidDef,
    origin: ServiceOriginDef,
    request: ParentRequestDef,
  },
  outputs: {
    rbac_ref: RbacRefDef,
    vm_ref: VmRefDef,
    rfp_ref: RfpRefDef,
  },
  run: async (args) => {
    const { did, origin, request } = args;
    const plcKey = did.replace(/^did:plc:/, "");
    const role = "root";
    const actx = request.acceptUri
      ? await computeActx(request.acceptUri)
      : await computeActx(did);

    const { enrolledClients } = await import("./welcomeMat.ts");
    const client = enrolledClients.get(origin.replace(/\/$/, "").toLowerCase());
    if (!client) {
      throw new Error(`No enrolled client for ${origin}`);
    }

    const dispatch = buildSubAgentDispatchers(client, did);

    // 1. RBAC — root role: full CRUD on all routes.
    const rbacRef = await dispatch["com.fedproxy.rbac"]({
      $type: "com.fedproxy.rbac",
      createdAt: new Date().toISOString(),
      custom_claims_roles_index: { job_workflow_ref: {} },
      policies: {
        "root-all": {
          meta: { policy: "root-all" },
          schemas: {
            "*": {
              $schema: "http://json-schema.org/draft-07/schema#",
              type: "object",
              properties: {
                capability: {
                  enum: ["create", "read", "update", "delete"],
                },
              },
              required: ["capability"],
            },
          },
        },
      },
      roles: {
        root: {
          role_name: "root",
          definition: {
            aud: `api://ATProto?actx=did:plc:${plcKey}`,
            iss: "https://droplet-oidc.its1337.com",
            policies: ["root-all"],
            sub: `actx:${actx}:plc:${plcKey}:role:${role}`,
          },
        },
      },
    });

    // 2. VM
    const vmBody: Record<string, unknown> = {
      $type: "com.publicdomainrelay.temp.compute.vm",
      cpus: request.vmSpec.cpus,
      mem: request.vmSpec.mem,
      disk: request.vmSpec.disk,
      role,
    };
    if (request.vmSpec.network) vmBody.network = request.vmSpec.network;
    if (request.vmSpec.location) vmBody.location = request.vmSpec.location;
    if (request.vmSpec.user_data) vmBody.user_data = request.vmSpec.user_data;
    const vmRef = await dispatch["com.publicdomainrelay.temp.compute.vm"](
      vmBody,
    );

    // 3. RFP wrapping the VM
    const rfpRef = await dispatch["com.publicdomainrelay.temp.market.rfp"]({
      $type: "com.publicdomainrelay.temp.market.rfp",
      _ref: {
        $type: "com.atproto.repo.strongRef",
        uri: vmRef.uri,
        cid: vmRef.cid,
      },
    });

    return { rbac_ref: rbacRef, vm_ref: vmRef, rfp_ref: rfpRef };
  },
});

export const emitReport = op<
  {
    did: string;
    request: SubAgentRequest;
    rbac_ref: StrongRef;
    vm_ref: StrongRef;
    rfp_ref: StrongRef;
  },
  { report: SubAgentReport }
>({
  name: "emit_report",
  inputs: {
    did: NewAccountDidDef,
    request: ParentRequestDef,
    rbac_ref: RbacRefDef,
    vm_ref: VmRefDef,
    rfp_ref: RfpRefDef,
  },
  outputs: { report: SubAgentReportDef },
  run: (args, ctx) => {
    return {
      report: {
        did: args.did,
        handle: args.request.handle,
        rbacUri: args.rbac_ref.uri,
        vmUri: args.vm_ref.uri,
        rfpUri: args.rfp_ref.uri,
        ctxId: ctx.id,
        parentCtxId: ctx.parent?.id,
      },
    };
  },
});

export function buildSubAgentFlow(): DataFlow {
  return DataFlow.auto(enrollAccount, provisionRecords, emitReport)
    .withEvents({ inputs: "all", outputs: "all" });
}

export function buildSubAgentSeed(request: SubAgentRequest): Input[] {
  return [{ definition: ParentRequestDef, value: request }];
}

// ── Public API ──────────────────────────────────────────────────────────────

const RUNNER_SCRIPT = new URL(
  "./skills/spawnComputeRequester/tools/spawn_compute_requester_subagent/main.ts",
  import.meta.url,
).pathname;

/**
 * Spawn a compute-requester sub-agent in its own Deno process. Returns the
 * report it produces. Yields every FlowContext event the sub-agent emits so
 * the caller can log lineage, including events bubbled from any further
 * nested sub-agents.
 */
export async function* spawnComputeRequester(
  request: SubAgentRequest,
  parentCtx?: FlowContext,
): AsyncGenerator<OrchestratorEvent, SubAgentReport, unknown> {
  const orc = new SubprocessOrchestrator();
  const gen = orc.run(
    { scriptPath: RUNNER_SCRIPT, input: request },
    parentCtx,
    "Spawn compute requester sub-agent",
  );
  let report: SubAgentReport | undefined;
  while (true) {
    const next = await gen.next();
    if (next.done) {
      const v = next.value as SubAgentReport | undefined;
      if (v) report = v;
      break;
    }
    const [, event, data] = next.value;
    if (event === EventType.OUTPUT) {
      const d = data as { report?: SubAgentReport };
      if (d?.report) report = d.report;
    }
    yield next.value;
  }
  if (!report) {
    throw new Error("sub-agent process exited without emitting a report");
  }
  return report;
}
