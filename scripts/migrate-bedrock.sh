#!/usr/bin/env bash
set -euo pipefail

# Migrate bedrock project knowledge into OpenViking
# Uses the ov CLI to import files as resources and add searchable memories.

BEDROCK="$(cd "$(dirname "$0")/../bedrock" && pwd)"
OV="ov"
PARENT="viking://resources/guestpost"

echo "=== Bedrock → OpenViking Migration ==="
echo "Bedrock: $BEDROCK"
echo "Target:  $PARENT"
echo ""

# 1. Verify server
if ! $OV status >/dev/null 2>&1; then
  echo "ERROR: OpenViking server not reachable. Run 'ov status' to debug."
  exit 1
fi
echo "Server: OK"
echo ""

TOTAL=0

import_dir() {
  local category="$1"
  local label="$2"
  local dir="$BEDROCK/$category"

  if [ ! -d "$dir" ]; then
    return
  fi

  local parent_uri="$PARENT/$label"
  echo "--- Importing $category/ → $parent_uri ---"

  while IFS= read -r -d '' file; do
    rel="${file#$BEDROCK/}"

    # Skip generated views JSON
    if [[ "$rel" == "Views/graph/knowledge-index.json" ]]; then
      echo "  SKIP $rel (generated)"
      continue
    fi

    echo "  + $rel"

    # Import as resource (auto-create parent path)
    if ! $OV add-resource "$file" -p "$parent_uri" --wait 2>/dev/null; then
      echo "      ! resource import failed"
    fi

    # Add memory for semantic search (use content directly as argument)
    domain="$(basename "${file%.*}")"
    content_preview="$(head -c 1500 "$file")"
    memory_text="[$category] $domain

Source: bedrock/$rel

${content_preview}"

    if ! $OV add-memory "$memory_text" 2>/dev/null; then
      echo "      ! memory add failed"
    fi

    TOTAL=$((TOTAL + 1))
  done < <(find "$dir" -type f \( -name "*.md" -o -name "*.json" -o -name "*.ndjson" \) -print0)
}

import_dir "Memory"    "memory"
import_dir "Work"      "work"
import_dir "Evidence"  "evidence"
import_dir "Views"     "views"
import_dir "History"   "history"

# Import STATUS.md
if [ -f "$BEDROCK/STATUS.md" ]; then
  echo "--- Importing STATUS.md ---"
  $OV add-resource "$BEDROCK/STATUS.md" -p "$PARENT/status" --wait 2>/dev/null || true
  head -c 1000 "$BEDROCK/STATUS.md" | $OV add-memory 2>/dev/null || true
  TOTAL=$((TOTAL + 1))
fi

echo ""
echo "=== Migration Complete ==="
echo "Files imported: $TOTAL"
echo ""
echo "Verify with:"
echo "  ov tree $PARENT"
echo "  ov find \"guestpost platform\""
