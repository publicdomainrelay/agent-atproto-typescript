import type { SubprocessBridge } from "../../../../dffml.ts";
import { computeActx, WelcomeMatClient } from "../../../../welcomeMat.ts";

type StrongRef = {
  $type: "com.atproto.repo.strongRef";
  uri: string;
  cid: string;
};

type VmSpec = {
  cpus: number;
  mem: string;
  disk: string;
  network?: string;
  location?: { country: string; region: string };
  user_data?: string;
};

export type SubAgentRequest = {
  serviceOrigin: string;
  handle: string;
  vmSpec: VmSpec;
  acceptUri?: string;
};

// Also accept snake_case shapes from JSON callers (Welcome-Mat-side names).
type RawInput = {
  serviceOrigin?: string;
  service_origin?: string;
  handle: string;
  vmSpec?: VmSpec;
  vm_spec?: VmSpec;
  acceptUri?: string;
  accept_uri?: string;
};

export type SubAgentReport = {
  did: string;
  handle: string;
  rbacUri: string;
  vmUri: string;
  rfpUri: string;
};

function normalize(raw: RawInput): SubAgentRequest {
  const serviceOrigin = raw.serviceOrigin ?? raw.service_origin;
  const vmSpec = raw.vmSpec ?? raw.vm_spec;
  const acceptUri = raw.acceptUri ?? raw.accept_uri;
  if (!serviceOrigin) throw new Error("missing serviceOrigin/service_origin");
  if (!raw.handle) throw new Error("missing handle");
  if (!vmSpec) throw new Error("missing vmSpec/vm_spec");
  return { serviceOrigin, handle: raw.handle, vmSpec, acceptUri };
}

const toRef = (x: { uri: string; cid: string }): StrongRef => ({
  $type: "com.atproto.repo.strongRef",
  uri: x.uri,
  cid: x.cid,
});

export default async function run(args: {
  input: unknown;
  bridge: SubprocessBridge;
  config?: unknown;
}): Promise<SubAgentReport> {
  const req = normalize(args.input as RawInput);
  const { bridge } = args;

  // 4. VM
  const vmBody: Record<string, unknown> = {
    $type: "com.publicdomainrelay.temp.compute.vm",
    cpus: req.vmSpec.cpus,
    mem: req.vmSpec.mem,
    disk: req.vmSpec.disk,
    role,
  };
  if (req.vmSpec.network) vmBody.network = req.vmSpec.network;
  if (req.vmSpec.location) vmBody.location = req.vmSpec.location;
  if (req.vmSpec.user_data) vmBody.user_data = req.vmSpec.user_data;
  const vm = await client.createRecord(
    did,
    "com.publicdomainrelay.temp.compute.vm",
    vmBody,
  );
  console.error("info", `VM ${vm.uri}`);

  // 5. RFP wrapping the VM.
  const rfp = await client.createRecord(
    did,
    "com.publicdomainrelay.temp.market.rfp",
    {
      $type: "com.publicdomainrelay.temp.market.rfp",
      _ref: toRef(vm),
    },
  );
  console.error("info", `RFP ${rfp.uri}`);

  return {
    did,
    handle: req.handle,
    rbacUri: rbac.uri,
    vmUri: vm.uri,
    rfpUri: rfp.uri,
  };
}

// ---------------------------------------------------------
// USAGE EXAMPLE & TEST CASES
// ---------------------------------------------------------

const CountStart: Definition = { name: "count_start", primitive: "int" };
const Count: Definition = { name: "count", primitive: "int" };
const NumberDef: Definition = { name: "number", primitive: "int" };

// Create distinct output definitions so operations don't consume their own outputs
const L1OutDef: Definition = { name: "l1_out_val", primitive: "int" };
const L2OutDef: Definition = { name: "l2_out_val", primitive: "int" };
const L3OutDef: Definition = { name: "l3_out_val", primitive: "int" };

// Operation: Generator that emits 5 numbers starting from count_start
const counter = op<{ count_start: number }, { count: number }>({
  name: "counter",
  inputs: { count_start: CountStart },
  outputs: { count: Count },
  run: async function* (args) {
    const start = args.count_start;
    for (let i = start; i < start + 5; i++) {
      await new Promise((res) => setTimeout(res, 50));
      yield { count: i };
    }
  },
});

const RBACRole: Definition = {
  name: "rbac_role", primitive: "object"
};

const define_rbac_role_root = op<
  {
    client: object,
  },
  {
    role: object,
  }
>({
  name: "define_rbac_role_root",
  inputs: {
    client: ATProtoClient,
  },
  outputs: {
    role: RBACRole,
  },
  run: async (args) => {
    const plcKey = did.replace(/^did:plc:/, "");
    const role = "root";
    const actx = req.acceptUri
      ? await computeActx(req.acceptUri)
      : await computeActx(did);

    const output = {
      role: {
        aud: `api://ATProto?actx=did:plc:${plcKey}`,
        iss: "https://droplet-oidc.its1337.com",
        sub: `actx:${actx}:plc:${plcKey}:role:${role}`,
      },
    };
    return output;
  },
});

const atproto_client_get_or_create_account = op<
  {
    config: object,
  },
  {
    client: object,
  }
>({
  name: "atproto_client_get_or_create_account",
  inputs: {
    config: ATProtoConfig,
  },
  outputs: {
    client: ATProtoClient,
  },
  run: async (args) => {
    if (typeof args.config.use === "object") {
      // TODO 
    }

    const req = args.config.create;

    console.error(
      "info",
      `enrolling at ${req.serviceOrigin} as @${req.handle}`,
    );

    // 1. Enroll.
    const client = await WelcomeMatClient.connect(req.serviceOrigin, {
      handle: req.handle,
    });
    const info = await client
      .fetch("/xrpc/com.atproto.server.getSession")
      .catch(() => null);
    let did: string | null = null;
    if (info?.ok) {
      did = (await info.json().catch(() => null))?.did ?? null;
    }
    if (!did) {
      throw new Error(
        "Welcome Mat signup did not yield a DID via getSession",
      );
    }
    console.error("info", `enrolled DID=${did}`);
    const output = { client: null };
    return output;
  },
});

const configure_rbac_role_root = op<
  {
    client: object,
    role: object,
  },
  {
    record: object,
  }
>({
  name: "configure_rbac_role_root",
  inputs: {
    client: ATProtoClient,
    role: RBACRole,
  },
  outputs: {
    record: ATProtoStrongRef,
  },
  run: async (args) => {
    const rbac = await args.client.createRecord(did, "com.fedproxy.rbac", {
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
            aud: args.role.aud,
            iss: args.role.iss,
            policies: ["root-all"],
            iss: args.role.sub,
          },
        },
      },
    });
    const output = { uri: rbac.uri, cid: rbac.cid };
    console.error("info", `RBAC ${JSON.stringify(output)}`);
    return output;
  },
});

// --- NESTED OPERATIONS (3 Levels) ---

// Level 3 Operation
const NestedL3 = op<{ val: number }, { l3_out: number }>({
  name: "NestedL3",
  inputs: { val: NumberDef },
  outputs: { l3_out: L3OutDef }, // Use the new distinct definition
  run: async (args) => {
    // Simulate work
    await new Promise((res) => setTimeout(res, 20));
    return { l3_out: args.val * 10 };
  },
});

// Level 2 Operation - Spawns a MemoryOrchestrator to run L3
const NestedL2 = op<{ val: number }, { l2_out: number }>({
  name: "NestedL2",
  inputs: { val: NumberDef },
  outputs: { l2_out: L2OutDef },
  run: async function* (args, ctx) {
    const l3Flow = DataFlow.auto(NestedL3).withEvents({ inputs: "all" });
    const orc = new MemoryOrchestrator();
    let finalRes = 0;

    // Pass `ctx` down as parentCtx to maintain lineage, and tag the operation that spawned it
    for await (
      const eventTuple of orc.run(
        l3Flow,
        [{ definition: NumberDef, value: args.val }],
        ctx,
        "NestedL2",
      )
    ) {
      const [childCtx, event, data] = eventTuple;
      if (event === EventType.OUTPUT && data.l3_out !== undefined) {
        finalRes = data.l3_out;
      }
      // Bubble events up seamlessly
      yield eventTuple;
    }
    yield { l2_out: finalRes };
  },
});

// Level 1 Operation - Spawns a MemoryOrchestrator to run L2
const NestedL1 = op<{ val: number }, { l1_out: number }>({
  name: "NestedL1",
  inputs: { val: NumberDef },
  outputs: { l1_out: L1OutDef },
  run: async function* (args, ctx) {
    const l2Flow = DataFlow.auto(NestedL2).withEvents({ inputs: "all" });
    const orc = new MemoryOrchestrator();
    let finalRes = 0;

    // Tag this level with "NestedL1" so the context knows where it came from
    for await (
      const eventTuple of orc.run(
        l2Flow,
        [{ definition: NumberDef, value: args.val }],
        ctx,
        "NestedL1",
      )
    ) {
      const [childCtx, event, data] = eventTuple;
      if (event === EventType.OUTPUT && data.l2_out !== undefined) {
        finalRes = data.l2_out;
      }
      // Bubble events up seamlessly
      yield eventTuple;
    }
    yield { l1_out: finalRes };
  },
});

// Run Tests Immediately when this file is executed directly (not on import).
// Guard so subagents/main don't accidentally exercise the test dataflow on
// import (which would spam stderr and consume time at boot).
if (import.meta.main) (async function runTests() {
  console.log("=== Starting DataFlow Orchestration Tests ===\n");

  const orchestrator = new MemoryOrchestrator();

  // ---------------------------------------------------------
  // Test 1: Single DataFlow Events Logging
  // ---------------------------------------------------------
  console.log("-> Running Test 1: Single DataFlow...");

  // Define flow and configure tracking for specific input definitions
  const testDataflow1 = DataFlow.auto(counter, echoNum).withEvents({
    inputs: ["count_start", "count"], // Monitor specific inputs moving across the network
    outputs: "all",
  });

  const initialInputs1: Input[] = [
    { definition: CountStart, value: 1 },
  ];

  // Consume the orchestrator yield tuple: [ctx, event, data]
  for await (
    const [ctx, event, data] of orchestrator.run(
      testDataflow1,
      initialInputs1,
      undefined,
      "Root",
    )
  ) {
    const chainInfo = ctx.spawnedBy
      ? `[Chain: ${ctx.spawnedBy}] `
      : "[Chain: Root] ";
    if (event === EventType.OUTPUT) {
      console.log(`${chainInfo}Output from ${ctx.id}:`, data);
    } else if (event === EventType.INPUT) {
      console.log(`${chainInfo}Input to ${ctx.id}:`, data);
    } else {
      console.log(
        `${chainInfo}Lifecycle Event: ${event} for ${ctx.id}`,
        data || "",
      );
    }
  }
  console.log("   ✅ Test 1 Passed\n");

  // ---------------------------------------------------------
  // Test 2: Nested DataFlows (3 Levels deep)
  // ---------------------------------------------------------
  console.log("-> Running Test 2: Nested DataFlows (3 Levels)...");

  // open_wallet,
  // prompt_user_for_required_funds,

  // https://attested.network/#Monthly-recurring-subscription
  const await_payment = DataFlow.auto(
    atproto_client_get_account,

    create_record_market_accept,

    define_rbac_role_root,
    configure_rbac_role_root,

    acquire_receipt,
  ).withEvents({
    inputs: "all",
  });

  const bid_acceptor = DataFlow.auto(
    atproto_client_get_account,

    await_bids,
    choose_winning_bid,

    notify_needs_payment,
    configure_await_payment,

    create_record_market_accept,

    define_rbac_role_root,
    configure_rbac_role_root,

    acquire_receipt,
  ).withEvents({
    inputs: "all",
  });

  // Spawn
  const spawn_subagent_create_vm = DataFlow.auto(
    atproto_client_create_account,
    atproto_reverse_proxy_give_credentials,

    notify_user_of_new_agent,

    create_record_compute_vm_with_role_root,
    create_record_rfp,

    configure_bid_acceptor,

    configure_comms_agent_new,
  ).withEvents({
    inputs: "all",
  });

  // Extend embodiment
  const testDataflowAgentExtend = DataFlow.auto(
    atproto_client_get_account,
    define_rbac_role_post,
    configure_rbac_role_post,
    create_record_compute_vm,
    create_record_rfp,
    configure_comms_agent_extend,
  ).withEvents({
    inputs: "all",
  });

  // Transfer conciousness
  const testDataflowAgentMove = DataFlow.auto(
    atproto_client_get_account,
    define_rbac_role_root,
    configure_rbac_role_root,
    create_record_compute_vm,
    create_record_rfp,
    configure_comms_agent_move,
  ).withEvents({
    inputs: "all",
  });

  const testDataflowRoot = DataFlow.auto(
    atproto_client_get_account,
    make_op_from_dataflow(spawn_subagent_create_vm),
    create_record_bsky_post,
  ).withEvents({
    inputs: "all",
  });

  /*
   * Owner: Move yourself into a new VM
   * Agent: exec(agent_move),
   *
   * Owner: Acquire a new VM
   * Agent: exec(agent_acquire_vm),
   *
   * User: Spin me up a new VM
   * Agent: exec(subagent_new_vm),
   *
   */

  const initialInputs2: Input[] = [
    {
      definition: ComputeVM,
      value: 5,
    },
  ];

  for await (
    const [ctx, event, data] of orchestrator.run(
      testDataflow2,
      initialInputs2,
      undefined,
      "Root",
    )
  ) {
    // Calculate nesting depth and dynamically build the trace chain from contexts
    let depth = 0;
    let curr = ctx.parent;
    const chain: string[] = [];

    if (ctx.spawnedBy) chain.push(ctx.spawnedBy);

    while (curr) {
      depth++;
      if (curr.spawnedBy) chain.unshift(curr.spawnedBy);
      curr = curr.parent;
    }

    const indent = "    ".repeat(depth);
    const prefix = depth > 0 ? "↳ " : "";
    const chainInfo = chain.length > 0
      ? `[Chain: ${chain.join(" -> ")}] `
      : "[Chain: Root] ";

    if (event === EventType.OUTPUT) {
      console.log(`${indent}${prefix}${chainInfo}Output from ${ctx.id}:`, data);
    } else if (event === EventType.INPUT) {
      console.log(`${indent}${prefix}${chainInfo}Input to ${ctx.id}:`, data);
    } else {
      const dataStr = data && typeof data === "object"
        ? JSON.stringify(data)
        : String(data || "");
      console.log(
        `${indent}${prefix}${chainInfo}Lifecycle ${event} for ${ctx.id}:`,
        dataStr,
      );
    }
  }
  console.log("   ✅ Test 2 Passed\n");
})();
