#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_NAME="diffwarden"
SKILL_SOURCE="$REPO_ROOT/skills/$SKILL_NAME"
CUSTOM_SKILLS_REPO="${CUSTOM_SKILLS_REPO:-$HOME/code/custom_skills}"

if [ ! -f "$SKILL_SOURCE/SKILL.md" ]; then
    echo "Missing skill source: $SKILL_SOURCE/SKILL.md" >&2
    exit 1
fi

link_skill() {
    local target_dir="$1"
    local target="$target_dir/$SKILL_NAME"

    mkdir -p "$target_dir"

    if [ -L "$target" ]; then
        local current
        current="$(readlink "$target")"
        if [ "$current" = "$SKILL_SOURCE" ]; then
            echo "Already linked: $target -> $SKILL_SOURCE"
            return
        fi

        echo "Updating link: $target -> $SKILL_SOURCE"
    elif [ -e "$target" ]; then
        echo "Refusing to overwrite non-symlink skill: $target" >&2
        echo "Remove it manually or move it aside before installing the local development link." >&2
        exit 1
    else
        echo "Linking: $target -> $SKILL_SOURCE"
    fi

    ln -sfn "$SKILL_SOURCE" "$target"
}

preserve_custom_skills_entry() {
    local overlay="$CUSTOM_SKILLS_REPO/.skills.local.json"

    if [ ! -d "$CUSTOM_SKILLS_REPO" ]; then
        echo "Skipping custom_skills preservation: missing $CUSTOM_SKILLS_REPO"
        return
    fi

    node --input-type=module - "$overlay" "$SKILL_NAME" <<'NODE'
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [overlayPath, skillName] = process.argv.slice(2);
const parsed = existsSync(overlayPath)
  ? JSON.parse(readFileSync(overlayPath, "utf8"))
  : {};

const data =
  parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};

const preserved = Array.isArray(data.preserveGlobalSkillNames)
  ? data.preserveGlobalSkillNames
  : [];

if (!preserved.includes(skillName)) {
  preserved.push(skillName);
}

data.preserveGlobalSkillNames = preserved;
writeFileSync(overlayPath, `${JSON.stringify(data, null, 2)}\n`);
NODE

    echo "Preserved manual skill in $overlay: $SKILL_NAME"
}

link_skill "$HOME/.agents/skills"
link_skill "$HOME/.claude/skills"
preserve_custom_skills_entry

echo "Done."
