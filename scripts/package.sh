#!/usr/bin/env bash
set -euo pipefail
# Run from the repository root, after tests and build, and after committing source.
archive_path=${1:-/tmp/blue-capital-deploy.tar.gz}
tar -czf "$archive_path" .openai/hosting.json dist/server drizzle
printf 'Packaged %s\n' "$archive_path"
