# Sub-agents, agent classes, and context isolation

This document describes how the agent runtime is structured around three
ATProto lexicons — `com.publicdomainrelay.temp.agent.skill`,
`com.publicdomainrelay.temp.agent.class`, and the records each agent creates
on its own account — and how the dataflow primitives in `dffml.ts` let us
spawn N levels of sub-agents, each with its own ATProto identity.

## Why sub-agents

Before this change, every record the runtime created went into the
top-level agent's repo (`config.agent`, e.g.
`did:plc:lpfuqerea3deuoyrn7ojser4`). That conflates three different things:

1. **Identity of the requester.** Each compute RFP should originate from an
   identity that has *only* the rights needed for that one job. Bundling all
   RFPs onto the long-lived agent's account means anyone who gets a workload
   credential for one job inherits the trust history of the whole agent.
2. **Audit trail.** When a single account is the author of everything, you
   can't tell from outside whether record `X` was created on behalf of job
   `A` or job `B`. With a per-job DID the link is intrinsic.
3. **Blast radius.** RBAC on the agent's main account would grant the
   workload identity write access to *all* the agent's records. Isolating
   each request under its own DID means the worst case is leakage of one
   job's state.

The fix: when a job needs compute, the top-level agent **spawns a
sub-agent** with a freshly enrolled ATProto identity (via Welcome Mat) and
has *that* sub-agent submit the RFP from *its own* account.

## Lexicons

### `com.publicdomainrelay.temp.agent.class`

Lives in
`compute-contract/lexicons/com/publicdomainrelay/temp/agent/class.json`.

A class record bundles a name + description + list of strongRefs to
`com.publicdomainrelay.temp.agent.skill` records. Optional `parent`
strongRef gives single inheritance, and `spawnsSubAgent: true` flags
classes that are intended to be instantiated as ephemeral sub-agents rather
than long-lived runtimes.

Two seed classes are published in `classes/`:

- `top-level-agent.yaml` — the long-running webhook handler. Has the
  reply/post skill and the spawn skill.
- `compute-requester.yaml` — `spawnsSubAgent: true`. Has the
  account-creation and compute-contract skills. Instantiated each time the
  top-level agent decides a VM is needed.

### `network.comind.agent.profile`

Written by the parent agent into *its own* repo after a sub-agent finishes,
to mark "I spawned a sub-agent, here is its DID, here are the records it
created on its own account." This is what makes the lineage walkable from
the parent's history.

## CLI: gitops for classes

`agentClass.ts` is a CLI mirroring `skills.ts`. It reads YAML class files
from `classes/`, resolves each named skill by listing the agent's published
`com.publicdomainrelay.temp.agent.skill` records, and writes one
`com.publicdomainrelay.temp.agent.class` record per file. It's two-pass: it
publishes parentless classes first so children can resolve their `parent:`
references in the same run.

`./publish_skills.sh` runs the skill publisher then the class publisher so
a single command keeps both collections in sync with the git tree.

## Runtime: dataflows + nested contexts (`dffml.ts` + `subagents.ts`)

The runtime piece is `subagents.ts`, built on the `MemoryOrchestrator` and
`DataFlow` primitives in `dffml.ts`. The key affordance is `FlowContext`:
every orchestrator run gets a unique context with a parent pointer and a
`spawnedBy` tag, and orchestrators bubble events from nested runs up to
their parent with the child's context attached. That gives us:

- N-level nesting for free — any operation can spawn a nested
  `MemoryOrchestrator.run(...)` passing its own `ctx` as `parentCtx`.
- A lineage chain you can walk by following `ctx.parent` upward.
- Per-level audit: every event emitted by any depth of nested flow is
  visible to the top-level consumer, tagged with which level produced it.

The compute-requester sub-agent is a three-operation dataflow:

1. **`enroll_account`** — calls `WelcomeMatClient.connect(serviceOrigin,
   { handle })` against `https://welcome-m.at`. This generates a DPoP
   keypair, signs the ToS, posts to `/api/signup`, and stores the
   resulting `WelcomeMatClient` in the module-level `enrolledClients` map
   keyed by service origin. Outputs `{ did, client_origin }`.

2. **`provision_records`** — looks up the stored client and uses it to
   call `/xrpc/com.atproto.repo.createRecord` on the new account's PDS via
   DPoP auth. Writes three records:
   - **`com.fedproxy.rbac`** with one role `root` and one policy
     `root-all` that grants `create`, `read`, `update`, `delete` on `"*"`
     (all routes). The role's `sub` field is
     `actx:<sha1(acceptUri or did)>:plc:<key>:role:root` to match what
     `droplet-oidc.its1337.com` will issue in workload tokens, and `aud`
     is `api://ATProto?actx=did:plc:<key>` so the token is bound to *this*
     account specifically.
   - **`com.publicdomainrelay.temp.compute.vm`** with `role: "root"` so
     the VM's workload identity gets the root role on its own account
     (and *only* on its own account — RBAC is per-DID).
   - **`com.publicdomainrelay.temp.market.rfp`** strongRef'ing the VM
     record. Same double-record pattern as before, but now both records
     live under the sub-agent's DID.

3. **`emit_report`** — packages `{ did, handle, rbacUri, vmUri, rfpUri,
   ctxId, parentCtxId }` and emits it as an `OUTPUT` event so the parent
   can see exactly which records to track in its memory.

`spawnComputeRequester(request, parentCtx?)` is an async generator that
yields every orchestrator event and returns the final `SubAgentReport`.
The parent passes its own `FlowContext` (if any) as `parentCtx` so lineage
is preserved through arbitrary depth.

## Wiring: the parent-agent tool

In `main.ts` the LLM gets a new tool, `spawn_compute_requester_subagent`.
Its dispatch handler:

1. Builds a `SubAgentRequest` from the LLM's arguments.
2. Iterates `spawnComputeRequester(...)`, logging every bubbled event
   (each one carries `ctx.id`, `ctx.parent?.id`, `ctx.spawnedBy`) so the
   sub-agent's full dataflow is visible in `stderr`.
3. Captures the returned `SubAgentReport`.
4. **Pushes the sub-agent's RFP URI into the top-level
   agent's `createdRecords` list.** That list is what
   `writeMemoryRecord` later writes into the parent's
   `network.comind.memory` record (paired with the parent's reply post by
   rkey). So the parent's memory now has, alongside any normal reply post,
   the sub-agent's RFP URI as a related record.
5. Returns the `report` JSON back to the LLM, with instructions in the
   `Spawn compute requester sub-agent` skill to also call
   `create_atproto_record` for collection `network.comind.agent.profile`
   capturing `{ did, handle, spawnedBy, records: [rbacUri, vmUri, rfpUri]
   }`. That gives the parent an explicit "I made a sub-agent" record on
   its own repo, in addition to the implicit linkage via memory.

## What an observer sees afterward

Walking the trail from the top-level agent's account:

```
did:plc:lpfuqerea3deuoyrn7ojser4
  └─ network.comind.memory/<reply-rkey>
       ├─ content: "spawned sub-agent for compute job"
       └─ related:
            ├─ at://did:plc:<sub>/com.publicdomainrelay.temp.market.rfp/<rkey>
            └─ at://did:plc:lpfu.../app.bsky.feed.post/<reply-rkey>
  └─ network.comind.agent.profile/<rkey>
       ├─ did: did:plc:<sub>
       ├─ handle: <sub-agent handle>
       └─ records: [<rbacUri>, <vmUri>, <rfpUri>]

did:plc:<sub>          ← sub-agent's fresh account
  ├─ com.fedproxy.rbac/<rkey>                     (root role / root-all)
  ├─ com.publicdomainrelay.temp.compute.vm/<rkey>  (role: root)
  └─ com.publicdomainrelay.temp.market.rfp/<rkey>  (strongRef → .vm)
```

The fact that the parent created the sub-agent is on the parent's account;
the records the sub-agent created are on the sub-agent's account; the
sub-agent's RBAC is on the sub-agent's account so the workload identity
can write back to it but not to the parent. Each layer is independently
auditable.

## Extending to N levels

Nothing about `subagents.ts` is specific to two levels. Any operation can
spawn its own nested orchestrator with `parentCtx = ctx`, and the events
keep bubbling. A future "Spawn supervisor sub-agent" skill could spawn a
sub-agent that itself spawns compute-requesters — the lineage chain in
each event's `ctx` would be `Root → SpawnSupervisor → SpawnComputeRequester
→ enroll_account` and the orchestrator emits at every level. The
top-level handler in `main.ts` doesn't need to change: it consumes the
bubbled events generically.
