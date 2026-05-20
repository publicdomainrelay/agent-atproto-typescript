#!/usr/bin/env bash
set -euo pipefail
# Unified gitops: agentClass.ts walks classes/, resolves each class's skill
# directories from skills/, publishes those skills (with examples + TS tools),
# then writes the agent.class records with strongRefs to the just-published
# skills. --overwrite wipes the previous skill+class collections first.
./agentClass.ts --classes-dir classes --skills-dir skills --overwrite
