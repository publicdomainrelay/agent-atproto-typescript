/**
 * Sub-agent runtime built on dffml.ts dataflows.
 *
 * Model:
 *   - A "context" is the runtime identity of an agent: { did, accessToken?, ... }.
 *     The top-level agent runs against config.agent (the long-lived ATProto
 *     session); a sub-agent's context is a freshly enrolled Welcome Mat
 *     account, isolated from the parent.
 *   - Each agent is instantiated from an agent.class (lex
 *     com.publicdomainrelay.temp.agent.class) which carries strongRefs to
 *     skills. The skill set defines what tools the LLM has.
 *   - "Spawn compute requester sub-agent" is a skill on the top-level class
 *     that, when invoked, triggers a sub-agent flow. The sub-agent runs in a
 *     nested MemoryOrchestrator (see dffml.ts) with its own FlowContext —
 *     this is what gives us N-level nesting + lineage.
 *
 * Lineage:
 *   FlowContext.parent points up the tree, FlowContext.spawnedBy names the
 *   skill that spawned this level. The orchestrator yields events tagged with
 *   the originating context, so the parent's history can see every record the
 *   sub-agent created (bubbled up as OUTPUT events).
 */
import {
  DataFlow,
  Definition,
  EventType,
  FlowContext,
  Input,
  MemoryOrchestrator,
  op,
} from "./dffml.ts";
import { computeActx, WelcomeMatClient } from "./welcomeMat.ts";

// ── Definitions ──────────────────────────────────────────────────────────────

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

// Information the parent agent passes down to the sub-agent flow.
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
  // Optional accept URI to use as actx seed (sub-agents created mid-accept flow).
  acceptUri?: string;
};

// What the sub-agent reports back to the parent.
export type SubAgentReport = {
  did: string;
  handle: string;
  rbacUri?: string;
  vmUri?: string;
  rfpUri?: string;
  ctxId: string;
  parentCtxId?: string;
};

// ── Operations ───────────────────────────────────────────────────────────────

// op 1: enroll new account via Welcome Mat
const enrollAccount = op<
  { request: SubAgentRequest },
  { did: string; client_origin: string }
>({
  name: "enroll_account",
  inputs: { request: ParentRequestDef },
  outputs: { did: NewAccountDidDef, client_origin: ServiceOriginDef },
  run: async (args, _ctx) => {
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
    return { did, client_origin: req.serviceOrigin };
  },
});

// op 2: write RBAC + VM + RFP on the new account
const provisionRecords = op<
  { did: string; origin: string; request: SubAgentRequest },
  {
    rbac_ref: StrongRef;
    vm_ref: StrongRef;
    rfp_ref: StrongRef;
  }
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
    const role = "root"; // sub-agent's root role for its own account
    const actx = request.acceptUri
      ? await computeActx(request.acceptUri)
      : await computeActx(did);

    // Look up stored client (created by enrollAccount).
    const { enrolledClients } = await import("./welcomeMat.ts");
    const client = enrolledClients.get(origin.replace(/\/$/, "").toLowerCase());
    if (!client) {
      throw new Error(`No enrolled client for ${origin}`);
    }

    // 1. RBAC — root role: full CRUD on all routes
    const rbacRecord = {
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
                capability: { enum: ["create", "read", "update", "delete"] },
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
    };
    const rbac = await client.createRecord(did, "com.fedproxy.rbac", rbacRecord);

    // 2. VM
    const vmRecord = {
      $type: "com.publicdomainrelay.temp.compute.vm",
      cpus: request.vmSpec.cpus,
      mem: request.vmSpec.mem,
      disk: request.vmSpec.disk,
      ...(request.vmSpec.network ? { network: request.vmSpec.network } : {}),
      ...(request.vmSpec.location ? { location: request.vmSpec.location } : {}),
      role, // "root" — the role the workload identity will assume on this account
      ...(request.vmSpec.user_data
        ? { user_data: request.vmSpec.user_data }
        : {}),
    };
    const vm = await client.createRecord(
      did,
      "com.publicdomainrelay.temp.compute.vm",
      vmRecord,
    );

    // 3. RFP wrapping the VM
    const rfpRecord = {
      $type: "com.publicdomainrelay.temp.market.rfp",
      _ref: {
        $type: "com.atproto.repo.strongRef",
        uri: vm.uri,
        cid: vm.cid,
      },
    };
    const rfp = await client.createRecord(
      did,
      "com.publicdomainrelay.temp.market.rfp",
      rfpRecord,
    );

    const toRef = (x: { uri: string; cid: string }): StrongRef => ({
      $type: "com.atproto.repo.strongRef",
      uri: x.uri,
      cid: x.cid,
    });
    return {
      rbac_ref: toRef(rbac),
      vm_ref: toRef(vm),
      rfp_ref: toRef(rfp),
    };
  },
});

// op 3: emit the SubAgentReport (final aggregation).
const emitReport = op<
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

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Spawn a compute-requester sub-agent. Returns a SubAgentReport on completion.
 * Yields all dataflow events along the way, tagged with the sub-agent's
 * FlowContext so the caller can see the full lineage.
 */
export async function* spawnComputeRequester(
  request: SubAgentRequest,
  parentCtx?: FlowContext,
): AsyncGenerator<
  [FlowContext, EventType, unknown],
  SubAgentReport,
  unknown
> {
  const flow = DataFlow.auto(enrollAccount, provisionRecords, emitReport)
    .withEvents({ inputs: "all", outputs: "all" });
  const orc = new MemoryOrchestrator();
  let report: SubAgentReport | undefined;
  for await (
    const evt of orc.run(
      flow,
      [{ definition: ParentRequestDef, value: request }],
      parentCtx,
      "Spawn compute requester sub-agent",
    )
  ) {
    const [, event, data] = evt;
    if (
      event === EventType.OUTPUT && (data as { report?: SubAgentReport })?.report
    ) {
      report = (data as { report: SubAgentReport }).report;
    }
    yield evt;
  }
  if (!report) {
    throw new Error("sub-agent flow finished without emitting a report");
  }
  return report;
}
