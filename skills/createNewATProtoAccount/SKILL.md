---
name: 'Create new ATProto account'
description: 'Use this skill to register a new ATProto account on a Welcome Mat service and grant the compute VM workload identity write access to it via RBAC. The skill carries the entry tool `run_compute_requester_subagent`, which is what the compute-requester agent class instantiates when spawned.'
---

This skill provides the `run_compute_requester_subagent` TypeScript tool —
a deterministic flow that, when invoked as the entry tool of a
compute-requester agent, does the following in a single Deno process:

1. **Enroll.** Calls `WelcomeMatClient.connect(serviceOrigin, { handle })`
   to register a fresh ATProto account via the Welcome Mat service (RFC
   9449 DPoP). The DPoP keypair, access token, and resulting `did:plc:…`
   live entirely in that one process.

2. **Compute the workload-identity actx.** `actx = SHA1(acceptUri ?? did)`.
   This becomes the subject prefix of the OIDC tokens the droplet
   dispatcher will issue to the VM.

3. **Write RBAC on the new account.** Adds a `com.fedproxy.rbac` record
   with a single role `root` and a single policy `root-all` granting
   `create`/`read`/`update`/`delete` on `"*"` (all routes). The role's
   `aud` is `api://ATProto?actx=did:plc:<key>` and its `sub` is
   `actx:<actx>:plc:<key>:role:root`, matching exactly what the OIDC
   dispatcher will put in the VM's workload token.

4. **Write the VM and RFP records** on the same new account
   (`com.publicdomainrelay.temp.compute.vm` with `role: "root"`, then
   `com.publicdomainrelay.temp.market.rfp` wrapping it via a strongRef).

5. **Return the report** `{ did, handle, rbacUri, vmUri, rfpUri }` for the
   parent agent to record in its own history as
   `network.comind.agent.profile`.

The tool's default export receives `{ input, bridge, config }`, so when
called via `agent_template`'s entryTool dispatch it bubbles
`bridge.log(...)` lines back to the parent's FlowContext.
