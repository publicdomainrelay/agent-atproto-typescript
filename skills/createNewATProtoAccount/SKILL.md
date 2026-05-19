---
name: 'Create new ATProto account'
description: 'Use this skill to register a new ATProto account on a Welcome Mat service and grant the compute VM workload identity write access to it via RBAC'
---

## Step 1 — enroll

Call `create_welcome_mat_account`:
```json
{ "service_origin": "https://welcome-m.at", "extra_fields": { "handle": "<chosen-handle>" } }
```

Returns `{ did, service }`. Extract `$key` from `did:plc:$key` — this is required as
the `role` field when creating `com.publicdomainrelay.temp.compute.vm`.

## Step 2 — compute actx

Call `compute_actx` with the accept record URI from the current compute contract:
```json
{ "accept_uri": "at://did:plc:.../com.publicdomainrelay.temp.market.accept/rkey" }
```

Returns `{ actx }` (SHA1 hex string).

## Step 3 — create RBAC on the new account

Call `create_record_on_enrolled_account` to write a `com.fedproxy.rbac` record
**on the new account** (not the agent's account):

```json
{
  "service_origin": "https://welcome-m.at",
  "repo": "<did from step 1>",
  "collection": "com.fedproxy.rbac",
  "record": {
    "$type": "com.fedproxy.rbac",
    "createdAt": "<iso timestamp>",
    "custom_claims_roles_index": { "job_workflow_ref": {} },
    "policies": {
      "atproto-write": {
        "meta": { "policy": "atproto-write" },
        "schemas": {
          "/xrpc/com.atproto.repo.createRecord": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "properties": { "capability": { "enum": ["create"] } },
            "required": ["capability"],
            "type": "object"
          }
        }
      }
    },
    "roles": {
      "atproto-write": {
        "definition": {
          "aud": "api://ATProto?actx=did:plc:<$key>",
          "iss": "https://droplet-oidc.its1337.com",
          "policies": ["atproto-write"],
          "sub": "actx:<actx>:plc:<$key>:role:<role>"
        },
        "role_name": "atproto-write"
      }
    }
  }
}
```

Substitutions:
- `<$key>` = key portion of `did:plc:$key` from step 1
- `<actx>` = value from step 2
- `<role>` = role value from the `com.publicdomainrelay.temp.compute.vm` record

This grants the VM's droplet-oidc workload token the ability to call
`/xrpc/com.atproto.repo.createRecord` on the new account.
