#!/usr/bin/env bash
# build-ngspice.sh — Build ngspice shared library from source on macOS or Linux.
#
# Produces:
#   resources/ngspice/<platform>/{libngspice.dylib|libngspice.so}
#   resources/ngspice/<platform>/lib/ngspice/*.cm   (table.cm deleted)
#   resources/ngspice/<platform>/manifest.json
#
# Usage: bash scripts/build-ngspice.sh
#
# Prerequisites (macOS): brew install autoconf automake libtool
# Prerequisites (Linux): apt-get install -y autoconf automake libtool libfftw3-dev bison flex

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Read version from package.json
VERSION="$(node -e "console.log(require('${PROJECT_ROOT}/package.json').config?.circsim?.ngspiceVersion ?? '46')")"

ARCHIVE_NAME="ngspice-${VERSION}.tar.gz"
SOURCE_URL="https://downloads.sourceforge.net/project/ngspice/ng-spice-rework/${VERSION}/${ARCHIVE_NAME}"

# Detect platform
OS="$(uname -s)"
ARCH="$(uname -m)"

case "${OS}" in
  Darwin)
    if [[ "${ARCH}" == "arm64" ]]; then
      PLATFORM="darwin-arm64"
    else
      PLATFORM="darwin-x64"
    fi
    LIB_NAME="libngspice.dylib"
    ;;
  Linux)
    PLATFORM="linux-x64"
    LIB_NAME="libngspice.so"
    ;;
  *)
    echo "ERROR: Unsupported OS '${OS}'. Use scripts/fetch-ngspice.mjs on Windows." >&2
    exit 1
    ;;
esac

DEST_DIR="${PROJECT_ROOT}/resources/ngspice/${PLATFORM}"
CM_DEST_DIR="${DEST_DIR}/lib/ngspice"

echo "=== build-ngspice v${VERSION} (${PLATFORM}) ==="
echo "Source URL: ${SOURCE_URL}"
echo "Output: ${DEST_DIR}"

# ---------------------------------------------------------------------------
# 1. Download source tarball
# ---------------------------------------------------------------------------
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

ARCHIVE_PATH="${WORK_DIR}/${ARCHIVE_NAME}"

echo ""
echo "Downloading ${ARCHIVE_NAME} ..."
curl -L --fail --show-error -o "${ARCHIVE_PATH}" "${SOURCE_URL}"
echo "Download complete: $(du -sh "${ARCHIVE_PATH}" | cut -f1)"

# ---------------------------------------------------------------------------
# 2. Extract
# ---------------------------------------------------------------------------
echo ""
echo "Extracting ..."
tar -xzf "${ARCHIVE_PATH}" -C "${WORK_DIR}"

# Find the extracted source directory (it may have version in the name)
SRC_DIR="$(find "${WORK_DIR}" -maxdepth 1 -type d -name 'ngspice*' | head -1)"
if [[ -z "${SRC_DIR}" ]]; then
  echo "ERROR: Could not find extracted ngspice source directory." >&2
  exit 1
fi
echo "Source directory: ${SRC_DIR}"

# ---------------------------------------------------------------------------
# 3. Build
# ---------------------------------------------------------------------------
echo ""
echo "Configuring ngspice ..."
cd "${SRC_DIR}"

# Run autoreconf if configure doesn't exist
if [[ ! -f configure ]]; then
  echo "Running autoreconf ..."
  autoreconf -if
fi

BUILD_DIR="${WORK_DIR}/build"
mkdir -p "${BUILD_DIR}"
cd "${BUILD_DIR}"

"${SRC_DIR}/configure" \
  --with-ngshared \
  --enable-xspice \
  --enable-cider \
  --with-x=no \
  --disable-debug \
  --disable-openmp \
  --prefix="${WORK_DIR}/install" \
  CFLAGS="-O2"
# --disable-openmp: Apple clang has no bundled <omp.h>, so an OpenMP-enabled
# build fails with "'omp.h' file not found" (misc_time.c). ngspice runs fine
# single-threaded for our use; disabling OpenMP keeps the macOS/Linux source
# build portable without a libomp dependency.

echo ""
echo "Building (make -j) ..."
make -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"

echo ""
echo "Installing ..."
make install

# ---------------------------------------------------------------------------
# 4. Locate shared library artifact and verify it is actually shared
# ---------------------------------------------------------------------------
echo ""
echo "Locating shared library ..."

INSTALL_DIR="${WORK_DIR}/install"

# Find the shared library (may have version suffix like libngspice.so.0.0.1)
FOUND_LIB="$(find "${INSTALL_DIR}" -name 'libngspice.*' \( -name '*.so' -o -name '*.so.*' -o -name '*.dylib' \) | head -1)"

if [[ -z "${FOUND_LIB}" ]]; then
  # Try the build dir in case make install placed things differently
  FOUND_LIB="$(find "${BUILD_DIR}" -name 'libngspice.*' \( -name '*.so' -o -name '*.so.*' -o -name '*.dylib' \) | head -1)"
fi

if [[ -z "${FOUND_LIB}" ]]; then
  echo "ERROR: Shared library not found after build!" >&2
  echo "This means --with-ngshared did not produce the expected output." >&2
  echo "Make sure ./configure --with-ngshared (not --enable-shared or other flags)." >&2
  find "${INSTALL_DIR}" -name 'libngspice*' 2>/dev/null || true
  exit 1
fi

echo "Found: ${FOUND_LIB}"

# Verify it IS a shared library (not an executable or static archive)
FILE_OUTPUT="$(file "${FOUND_LIB}")"
echo "file says: ${FILE_OUTPUT}"

case "${OS}" in
  Linux)
    if ! echo "${FILE_OUTPUT}" | grep -q "shared object"; then
      echo "ERROR: ${FOUND_LIB} is NOT a shared object!" >&2
      echo "file output: ${FILE_OUTPUT}" >&2
      echo "Check that --with-ngshared was accepted by configure." >&2
      exit 1
    fi
    ;;
  Darwin)
    if ! echo "${FILE_OUTPUT}" | grep -q "dynamically linked shared library"; then
      # Also accept "Mach-O.*dynamically linked"
      if ! echo "${FILE_OUTPUT}" | grep -qi "dynamically linked"; then
        echo "ERROR: ${FOUND_LIB} is NOT a dynamically linked shared library!" >&2
        echo "file output: ${FILE_OUTPUT}" >&2
        echo "Check that --with-ngshared was accepted by configure." >&2
        exit 1
      fi
    fi
    ;;
esac

echo "Verified: shared library confirmed."

# ---------------------------------------------------------------------------
# 5. Copy library + .cm files to destination
# ---------------------------------------------------------------------------
echo ""
mkdir -p "${DEST_DIR}"
mkdir -p "${CM_DEST_DIR}"

# Copy the library (use the canonical name without version suffix)
cp "${FOUND_LIB}" "${DEST_DIR}/${LIB_NAME}"
echo "Copied ${LIB_NAME} → ${DEST_DIR}/${LIB_NAME}"

# Find and copy .cm files
CM_SRC_DIR="$(find "${INSTALL_DIR}" -type d -name 'ngspice' | head -1)"
if [[ -z "${CM_SRC_DIR}" ]]; then
  CM_SRC_DIR="$(find "${BUILD_DIR}" -type d -name 'ngspice' | head -1)"
fi

# NOTE: macOS ships bash 3.2, which has no `mapfile`/`readarray`. Collect the
# .cm paths into the array with a portable while-read loop instead.
CM_FILES=()
if [[ -z "${CM_SRC_DIR}" ]] || [[ "$(find "${CM_SRC_DIR}" -name '*.cm' 2>/dev/null | wc -l)" -eq 0 ]]; then
  echo "WARNING: .cm files directory not found via install. Searching build tree ..."
  # Try to find any .cm in the build/install trees
  while IFS= read -r _cm; do CM_FILES+=("$_cm"); done < <(find "${INSTALL_DIR}" "${BUILD_DIR}" -name '*.cm' 2>/dev/null | sort -u)
else
  while IFS= read -r _cm; do CM_FILES+=("$_cm"); done < <(find "${CM_SRC_DIR}" -name '*.cm' | sort)
fi

if [[ ${#CM_FILES[@]} -eq 0 ]]; then
  echo "ERROR: No .cm files found after build!" >&2
  echo "XSPICE code models are required for digital simulation." >&2
  exit 1
fi

echo "Copying ${#CM_FILES[@]} .cm files ..."
COPIED_CM=()
for CM_FILE in "${CM_FILES[@]}"; do
  NAME="$(basename "${CM_FILE}")"
  if [[ "${NAME}" == "table.cm" ]]; then
    echo "  Skipping table.cm (GPL-licensed — excluded per spec §7.2)"
    continue
  fi
  cp "${CM_FILE}" "${CM_DEST_DIR}/${NAME}"
  COPIED_CM+=("${NAME}")
done

# Paranoia: delete table.cm from dest if it ended up there
if [[ -f "${CM_DEST_DIR}/table.cm" ]]; then
  rm "${CM_DEST_DIR}/table.cm"
  echo "  Deleted table.cm from destination"
fi

echo "Copied: ${COPIED_CM[*]}"

# ---------------------------------------------------------------------------
# 6. Verify digital.cm
# ---------------------------------------------------------------------------
if [[ ! -f "${CM_DEST_DIR}/digital.cm" ]]; then
  echo "ERROR: digital.cm is missing after build!" >&2
  echo "XSPICE digital simulation requires this file." >&2
  exit 1
fi
echo "Verified: digital.cm present"

# ---------------------------------------------------------------------------
# 7. Write manifest.json
# ---------------------------------------------------------------------------
echo ""
echo "Writing manifest.json ..."

SHA256_LIB="$( { sha256sum "${DEST_DIR}/${LIB_NAME}" 2>/dev/null || shasum -a 256 "${DEST_DIR}/${LIB_NAME}"; } | cut -d' ' -f1)"
FETCHED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Build CM file sha256 list
CM_JSON="{}"
for NAME in "${COPIED_CM[@]}"; do
  HASH="$( { sha256sum "${CM_DEST_DIR}/${NAME}" 2>/dev/null || shasum -a 256 "${CM_DEST_DIR}/${NAME}"; } | cut -d' ' -f1)"
  # Simple JSON append using node (already required)
  CM_JSON="$(node -e "
    const obj = JSON.parse(process.env.CM_JSON || '{}');
    obj['${NAME}'] = '${HASH}';
    console.log(JSON.stringify(obj));
  " CM_JSON="${CM_JSON}")"
done

node -e "
const fs = require('fs');
const manifest = {
  version: '${VERSION}',
  platform: '${PLATFORM}',
  source: '${SOURCE_URL}',
  fetched: '${FETCHED}',
  builtFromSource: true,
  files: {
    '${LIB_NAME}': '${SHA256_LIB}',
  },
  cmFiles: JSON.parse('${CM_JSON}'),
  tablecmExcluded: true,
};
fs.writeFileSync('${DEST_DIR}/manifest.json', JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
"

echo ""
echo "=== build-ngspice: SUCCESS ==="
echo "Library:  ${DEST_DIR}/${LIB_NAME}"
echo "CM files: ${CM_DEST_DIR}/"
echo "Manifest: ${DEST_DIR}/manifest.json"
echo "table.cm excluded: $([ ! -f "${CM_DEST_DIR}/table.cm" ] && echo true || echo FALSE_ERROR)"
