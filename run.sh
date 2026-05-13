#!/usr/bin/env bash
set -xeuo pipefail

DIGITALOCEAN_TOKEN=$(doctl auth token) deno run --allow-all main.ts
