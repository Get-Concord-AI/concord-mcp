#!/bin/sh
# Install Concord without npm: downloads a release that bundles its own Node
# runtime and puts `concord` and `concord-mcp` launchers on your PATH.
#
#   curl -fsSL https://getconcord.ai/install.sh | sh
#
# (getconcord.ai redirects to this script on the latest GitHub Release:
#  https://github.com/Get-Concord-AI/concord-mcp/releases/latest/download/install.sh)
#
# Environment:
#   CONCORD_VERSION      version to install, e.g. 0.15.0 (default: latest release)
#   CONCORD_INSTALL_DIR  where releases are unpacked (default: ~/.concord/standalone)
#   CONCORD_BIN_DIR      where the launchers go (default: ~/.local/bin)
#   CONCORD_DOWNLOAD_URL base URL holding the release assets (for mirrors)
#
# Rerun to upgrade. To uninstall, remove CONCORD_INSTALL_DIR and the two
# launchers in CONCORD_BIN_DIR.
set -eu

REPO="Get-Concord-AI/concord-mcp"

say() { printf '%s\n' "$*"; }
fail() { printf 'concord install: %s\n' "$*" >&2; exit 1; }

detect_target() {
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) fail "unsupported OS $(uname -s); install with npm: npm install -g @concord-ai/concord-mcp" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "unsupported architecture $(uname -m)" ;;
  esac
  # An x64 shell under Rosetta on Apple silicon should still get the native build.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] &&
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    arch=arm64
  fi
  if [ "$os" = linux ] && { ls /lib/ld-musl-* >/dev/null 2>&1 || ldd --version 2>&1 | grep -qi musl; }; then
    fail "musl-based Linux (e.g. Alpine) is not supported yet; install with npm instead"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    fail "need sha256sum or shasum to verify the download"
  fi
}

# Single-quote a value for a generated script, so `$`, quotes and backslashes in
# a path stay literal when the launcher runs.
shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

absolute_path() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$PWD" "$1" ;;
  esac
}

write_launcher() {
  # $1: launcher path, $2: entry point relative to the package root
  current="$(shell_quote "${install_dir}/current")"
  cat > "$1.tmp" <<EOF
#!/bin/sh
exec ${current}/node/bin/node ${current}/lib/$2 "\$@"
EOF
  chmod 755 "$1.tmp"
  mv -f "$1.tmp" "$1"
}

main() {
  command -v curl >/dev/null 2>&1 || fail "curl is required"
  command -v tar >/dev/null 2>&1 || fail "tar is required"
  [ -n "${HOME:-}" ] || fail "HOME is not set"

  # Launchers and the marker outlive this shell, so they need absolute paths.
  install_dir="$(absolute_path "${CONCORD_INSTALL_DIR:-$HOME/.concord/standalone}")"
  bin_dir="$(absolute_path "${CONCORD_BIN_DIR:-$HOME/.local/bin}")"
  detect_target

  archive="concord-${os}-${arch}.tar.gz"
  if [ -n "${CONCORD_DOWNLOAD_URL:-}" ]; then
    base="${CONCORD_DOWNLOAD_URL%/}"
  elif [ -n "${CONCORD_VERSION:-}" ]; then
    base="https://github.com/${REPO}/releases/download/v${CONCORD_VERSION#v}"
  else
    base="https://github.com/${REPO}/releases/latest/download"
  fi

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT INT TERM

  say "Downloading Concord for ${os}-${arch}..."
  curl -fsSL -o "${tmp}/${archive}" "${base}/${archive}" ||
    fail "download failed: ${base}/${archive}"
  curl -fsSL -o "${tmp}/${archive}.sha256" "${base}/${archive}.sha256" ||
    fail "checksum download failed: ${base}/${archive}.sha256"
  expected="$(cut -d ' ' -f 1 < "${tmp}/${archive}.sha256")"
  [ "$(sha256_of "${tmp}/${archive}")" = "$expected" ] || fail "checksum mismatch for ${archive}"

  tar -xzf "${tmp}/${archive}" -C "$tmp"
  version="$(cat "${tmp}/concord/VERSION")"
  [ -n "$version" ] || fail "release archive has no VERSION"

  # The marker tells Concord it was installed this way, so updates and client
  # configs never reach for npm, and upgrades reuse these locations. The
  # bundled Node writes it so any path is encoded as valid JSON.
  "${tmp}/concord/node/bin/node" -e '
    const [file, binDir, installDir] = process.argv.slice(1);
    require("fs").writeFileSync(file, JSON.stringify({ binDir, installDir }) + "\n");
  ' "${tmp}/concord/lib/standalone.json" "$bin_dir" "$install_dir"

  mkdir -p "${install_dir}/versions" "$bin_dir"
  previous=""
  [ -L "${install_dir}/current" ] && previous="$(basename "$(readlink "${install_dir}/current")")"
  rm -rf "${install_dir}/versions/${version}"
  mv "${tmp}/concord" "${install_dir}/versions/${version}"
  ln -sfn "versions/${version}" "${install_dir}/current"

  # Keep the previous version: MCP servers already running may still load from it.
  for dir in "${install_dir}/versions"/*; do
    name="$(basename "$dir")"
    [ "$name" = "$version" ] || [ "$name" = "$previous" ] || rm -rf "$dir"
  done

  write_launcher "${bin_dir}/concord" "dist/cli/index.js"
  write_launcher "${bin_dir}/concord-mcp" "dist/index.js"

  say "Installed Concord ${version} to ${install_dir}"
  case ":${PATH}:" in
    *":${bin_dir}:"*)
      found="$(command -v concord || true)"
      if [ "$found" != "${bin_dir}/concord" ]; then
        say "Warning: ${found} comes before ${bin_dir} on your PATH."
        say "If it is an npm install, remove it with: npm uninstall -g @concord-ai/concord-mcp"
      fi
      ;;
    *)
      say ""
      say "${bin_dir} is not on your PATH. Add this to your shell profile:"
      say "  export PATH=\"${bin_dir}:\$PATH\""
      ;;
  esac
  say ""
  say "Next: run 'concord setup' in a repository, then restart your coding agent."
}

# Everything runs from main, so a truncated download never runs half a script.
main "$@"
