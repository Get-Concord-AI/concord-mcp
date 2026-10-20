#!/usr/bin/env bash
# Build the standalone tarball for the current platform: a pinned Node runtime
# plus the built package and its production dependencies, so `install.sh` can
# install Concord without npm. Run after `pnpm build`, on the platform being
# packaged: only that platform's better-sqlite3 addon is kept, and the smoke
# test runs the bundled Node.
#
# Output: release/concord-<os>-<arch>.tar.gz and its .sha256.
set -euo pipefail

# Not NODE_VERSION: official node images set that, which would unpin the runtime.
NODE_VERSION="${CONCORD_NODE_VERSION:-24.21.0}"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

root="$(cd "$(dirname "$0")/.." && pwd)"
target="${os}-${arch}"
out="${root}/release"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
stage="${work}/concord"
mkdir -p "$stage/lib" "$stage/node/bin" "$out"

[[ -f "${root}/dist/cli/index.js" ]] || { echo "dist/ is missing; run pnpm build first" >&2; exit 1; }

# Node runtime, verified against the release's published checksums.
node_dist="node-v${NODE_VERSION}-${target}"
curl -fsSL -o "${work}/${node_dist}.tar.gz" \
  "https://nodejs.org/dist/v${NODE_VERSION}/${node_dist}.tar.gz"
curl -fsSL -o "${work}/SHASUMS256.txt" "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
(cd "$work" && grep " ${node_dist}.tar.gz\$" SHASUMS256.txt | shasum -a 256 -c -)
tar -xzf "${work}/${node_dist}.tar.gz" -C "$work"
cp "${work}/${node_dist}/bin/node" "$stage/node/bin/node"
cp "${work}/${node_dist}/LICENSE" "$stage/node/LICENSE"

# The package exactly as npm would publish it, then its locked production
# dependencies. The bundled Node runs the install so native addons match its ABI.
cp "${root}/package.json" "${root}/pnpm-lock.yaml" "${root}/LICENSE" "${root}/README.md" "$stage/lib/"
cp -R "${root}/dist" "${root}/plugin" "$stage/lib/"
(
  cd "$stage/lib"
  PATH="${stage}/node/bin:${PATH}" pnpm install --prod --frozen-lockfile \
    --config.node-linker=hoisted --ignore-pnpmfile
  rm -f pnpm-lock.yaml
  # better-sqlite3 ships every platform's addon and the SQLite sources; keep
  # only the addon this tarball runs.
  sqlite=node_modules/better-sqlite3
  rm -rf "$sqlite/deps" "$sqlite/src" "$sqlite/build" "$sqlite/binding.gyp"
  find "$sqlite/prebuilds" -type f ! -name "${target}.node" -delete
)

version="$(node -p "require('${root}/package.json').version")"
echo "$version" > "$stage/VERSION"

# Smoke test with the bundled runtime: the CLI starts and SQLite loads.
reported="$("$stage/node/bin/node" "$stage/lib/dist/cli/index.js" --version)"
[[ "$reported" == "$version" ]] || { echo "CLI reported ${reported}, expected ${version}" >&2; exit 1; }
(cd "$stage/lib" && "$stage/node/bin/node" -e "new (require('better-sqlite3'))(':memory:').close()")

archive="concord-${target}.tar.gz"
tar -czf "${out}/${archive}" -C "$work" concord
(cd "$out" && shasum -a 256 "$archive" > "${archive}.sha256")
echo "Built ${out}/${archive} (Concord ${version}, Node ${NODE_VERSION})"
