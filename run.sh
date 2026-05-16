#!/usr/bin/env bash
set -euo pipefail

DIGITALOCEAN_TOKEN=$(doctl auth token) deno run --allow-all main.ts
