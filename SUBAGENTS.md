# Sub-agents, agent classes, and process isolation

This document describes how the agent runtime is structured around three
ATProto lexicons — `com.publicdomainrelay.temp.agent.skill`,
`com.publicdomainrelay.temp.agent.class`, and the records each agent creates
on its own account — and how the dataflow + subprocess primitives in
`dffml.ts` let us spawn N levels of sub-agents that each live in their own
Deno process, with their own ATProto identity, while still bubbling their
orchestrator events back into the parent's `FlowContext`.

## Why sub-agents are process-isolated

Before this iteration, sub-agents were nested in-process via
`MemoryOrchestrator`. That gave us per-call FlowContext lineage but kept
three things tangled that we want separate:

1. **Module state.** The `enrolledClients` map in `welcomeMat.ts` is module
   global. With everything in one process, a sub-agent's freshly enrolled
   DPoP keypair lives next to the parent's; one accidental reference could
   sign a request for the wrong identity.
2. **ATProto session.** The parent's `Agent` (logged in as
   `did:plc:lpfu…`) and the sub-agent's WelcomeMat client share the same
   global `fetch`, the same retry state, the same in-memory token table.
   Anything that walks "all sessions" sees both.
3. **Failure blast radius.** An exception inside a sub-agent's dataflow
   propagated up the parent generator. A panic in the sub-agent's
   provisioning logic would tear down the parent webhook handler.

The fix: sub-agents are now full **child processes**. The parent forks a
Deno subprocess; the child runs the sub-agent dataflow against its own
ATProto identity in its own memory; the parent never sees the sub-agent's
tokens or modules. Events bubble back over a unix-domain socket in a
tempdir, decoded as if they had come from an in-process nested orchestrator.

## Lexicons

### `com.publicdomainrelay.temp.agent.skill`

A skill record describes a capability:

```
name            human-readable skill name
description     when/how to use it (consumed by the LLM)
content         body of the SKILL.md (the prompt-side content)
examples        array of strongRef → example records for this collection
property_references  optional path/value annotations
tools           array of toolSpec — TypeScript tools this skill provides
```

The new `tools` field carries interface descriptions for TS code that
implements parts of the skill:

```json
{
  "name": "spawn_compute_requester_subagent",
  "description": "...",
  "inputSchema": { ...JSON Schema for input args... },
  "spawnsSubAgent": true
}
```

The actual source lives in the deployment repo at
`skills/<skill-dir>/tools/<tool-name>/{main.ts,deno.json,deno.lock}`. The
record only carries the interface so a remote consumer (another agent
reading the skill record off ATProto) knows what arguments the tool takes
without needing to fetch source.

### `com.publicdomainrelay.temp.agent.class`

A class record bundles a name + description + an ordered list of strongRefs
to skill records, with an optional `parent` strongRef for single
inheritance and a `spawnsSubAgent` flag.

Two seed classes are published from `classes/`:

- `top-level-agent.yaml` — long-running webhook handler. Skills:
  `replyOnBsky`, `spawnComputeRequester`.
- `compute-requester.yaml` — `spawnsSubAgent: true`. Skills:
  `createNewATProtoAccount`, `computeContractCreate`. Instantiated once per
  compute job by the top-level agent.

### `network.comind.agent.profile`

Written by a parent agent into its OWN repo after a sub-agent finishes:
"I spawned a sub-agent, here is its DID, here are the records it created on
its own account." This is what makes the lineage walkable from the parent's
account without having to find the sub-agent's DID by other means.

## gitops: classes drive skill publication

`agentClass.ts` is the unified gitops entrypoint. The flow:

1. Walk `classes/*.yaml`.
2. For each class, look up each entry in its `skills:` list under
   `skills/<skill-dir>/`. Each skill dir has an `SKILL.md` with frontmatter
   (`name`, `description`), an optional `examples/*.yaml`, and an optional
   `tools/<tool-name>/spec.json` per TS tool.
3. Compute the union of referenced skill directories across all classes,
   then publish each one EXACTLY once via `prepareSkill` →
   `publishPreparedSkill` (from `skills.ts`). The published record
   includes the example refs and the `tools` array.
4. For each class, write the `agent.class` record. Its `skills` field is
   the ordered list of (uri, cid) strongRefs to the skills published in
   step 3.
5. Two-pass on parent: classes without a `parent` first, classes with one
   second, so children can resolve their parent strongRef in the same run.

So class YAMLs are the source of truth: they point at skill directories,
the gitops creates the skill records, then references them by strongRef in
the class record. Republishing always produces a consistent (uri, cid) pair
between the class and its skills — no drift.

`./publish.sh` is the single command:

```
./agentClass.ts --classes-dir classes --skills-dir skills --overwrite
```

## Runtime: subprocess-bridged dataflows (`dffml.ts`)

`dffml.ts` is unchanged at the operation/orchestrator level — the same
`Definition`, `op`, `DataFlow`, `MemoryOrchestrator` primitives — and adds
two pieces:

### `SubprocessBridge` (child side)

```ts
const bridge = await SubprocessBridge.connect(socketPath);
await bridge.emit(ctx, event, data);
await bridge.result(finalReport);
await bridge.close();
```

The child uses this to push events through the unix socket. Messages are
newline-delimited JSON of one of three kinds: `event`, `result`, `log`.

### `SubprocessOrchestrator` (parent side)

```ts
const orc = new SubprocessOrchestrator();
for await (
  const evt of orc.run(
    { scriptPath, input },     // child script + JSON to put on its stdin
    parentCtx,
    spawnedBy,
  )
) {
  // evt is [FlowContext, EventType, data] — same shape as in-process
}
```

Internally `.run()` creates a tempdir, listens on `tempdir/bridge.sock`,
spawns `deno run --allow-all <scriptPath> --socket <sock>`, accepts the
child's single bridge connection, and yields every bubbled event. The
child's root `FlowContext` is re-parented onto a fresh parent-side
`FlowContext`, so `ctx.parent` walks cleanly across the process boundary.
The generator's `return` value is whatever the child sent via
`bridge.result(...)`.

Cleanup is automatic: the tempdir is removed after the subprocess exits.

This is the "transparent bubbling up" the architecture demands — operations
or top-level handlers don't care whether the events came from an
in-process nested orchestrator or another Deno process; the consuming loop
is identical.

## A spawn, end to end

```
LLM in top-level agent calls tool spawn_compute_requester_subagent({...})
       │
       ▼  (main.ts dispatchToolCall)
subagents.ts: spawnComputeRequester(request, parentCtx)
       │
       ▼  (SubprocessOrchestrator.run)
   tempdir/bridge.sock created and listened on
   deno run skills/spawnComputeRequester/tools/spawn_compute_requester_subagent/main.ts
                                            --socket /tmp/.../bridge.sock
                                            (request JSON on stdin)
       │
       ▼  (child process)
   SubprocessBridge.connect(socket)
   MemoryOrchestrator runs DataFlow.auto(
     enrollAccount,           // POST /api/signup against welcome-m.at
     provisionRecords,        // dispatchers: com.fedproxy.rbac, .vm, .rfp
     emitReport,              // build SubAgentReport
   )
   For each event from the local orchestrator:
       await bridge.emit(ctx, event, data)   ─┐
       │                                     │
       ▼                                     │
       parent's SubprocessOrchestrator       │
       reparents ctx onto parentCtx, yields  │
       │                                     │
       ▼                                     │
       subagents.ts re-yields to caller      │
       │                                     │
       ▼                                     ▼
       main.ts logs every event with chain
   On final OUTPUT carrying { report: … }, child:
       await bridge.result(report)
       console.log(JSON.stringify(report))
       process exits 0
       │
       ▼
   parent's gen.next() returns done=true, value=report
   main.ts pushes report.rfpUri into createdRecords so the parent's
   network.comind.memory record captures the sub-agent's RFP URI
   main.ts (per spawnComputeRequester SKILL.md) instructs the LLM to also
       create a network.comind.agent.profile record naming the sub-agent
```

## Dynamic tools in the sub-agent

The sub-agent dataflow keeps the same "dynamically generated tools from
skill examples" pattern the top-level agent uses (see
`buildCollectionTools` / `dispatchToolCall` in `main.ts`).
`subagents.ts:buildSubAgentDispatchers(client, did, collections)` returns

```ts
{
  "com.fedproxy.rbac": (record) => Promise<StrongRef>,
  "com.publicdomainrelay.temp.compute.vm": (record) => Promise<StrongRef>,
  "com.publicdomainrelay.temp.market.rfp": (record) => Promise<StrongRef>,
}
```

Each function is a thin wrapper over `WelcomeMatClient.createRecord` that
forces `$type` to match the collection. The deterministic `provisionRecords`
op routes its three writes through this map; a future LLM-driven sub-agent
swaps the deterministic op for an LLM loop whose tools list IS this map's
keys (just like main.ts does at the top level), and the same dispatcher
code handles both.

## What an observer sees afterward

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

did:plc:<sub>          ← sub-agent's fresh account (its own process)
  ├─ com.fedproxy.rbac/<rkey>                       (role=root, root-all CRUD on *)
  ├─ com.publicdomainrelay.temp.compute.vm/<rkey>   (role: "root")
  └─ com.publicdomainrelay.temp.market.rfp/<rkey>   (strongRef → .vm)
```

The parent records on the parent's account; the sub-agent's records on the
sub-agent's account; the sub-agent's RBAC grants the workload identity
write access to its own DID and nothing else. The two processes never
shared a single byte of session state.

## Extending to N levels

`SubprocessOrchestrator` doesn't know anything about the contents of the
child script. Any TS tool can itself import `subagents.ts` and call
`spawnComputeRequester(req, ctx)` again — that spawns a third Deno process,
which connects a bridge back to the second process, which forwards through
to the first. Every level's events arrive at the top-level handler with a
full `FlowContext` chain (`Root → SpawnComputeRequester → SpawnSupervisor →
SpawnComputeRequester → enroll_account`), no code changes required at any
level.
