#!/bin/bash
set -euo pipefail

exec bun run --cwd apps/web start
