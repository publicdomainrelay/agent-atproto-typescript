/**
 * compute-requester entry tool.
 *
 * Called by agent_template (in deterministic mode) when this tool is named
 * as the agent class's `entryTool`. The default export receives the live
 * `SubprocessBridge` so it can stream progress events back to the parent's
 * FlowContext while the sub-agent's ATProto session (a fresh Welcome Mat
 * DPoP-bound client) lives entirely inside this process.
 *
 * Imports of ../../../../{dffml,welcomeMat}.ts type-check against the agent
 * repo and are rewritten to absolute file:// URLs by
 * agentRuntime.materializeAgentTempDir before the source is dropped into
 * tempdir/tools/run_compute_requester_subagent/main.ts.
 */
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

  await bridge.log(
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
  await bridge.log("info", `enrolled DID=${did}`);

  // 2. Compute the workload-identity actx.
  const plcKey = did.replace(/^did:plc:/, "");
  const role = "root";
  const actx = req.acceptUri
    ? await computeActx(req.acceptUri)
    : await computeActx(did);

  // 3. RBAC — root role: full CRUD on all routes.
  const rbac = await client.createRecord(did, "com.fedproxy.rbac", {
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
  await bridge.log("info", `RBAC ${rbac.uri}`);

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
  await bridge.log("info", `VM ${vm.uri}`);

  // 5. RFP wrapping the VM.
  const rfp = await client.createRecord(
    did,
    "com.publicdomainrelay.temp.market.rfp",
    {
      $type: "com.publicdomainrelay.temp.market.rfp",
      _ref: toRef(vm),
    },
  );
  await bridge.log("info", `RFP ${rfp.uri}`);

  return {
    did,
    handle: req.handle,
    rbacUri: rbac.uri,
    vmUri: vm.uri,
    rfpUri: rfp.uri,
  };
}
