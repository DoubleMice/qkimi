#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
result_file="$(mktemp "${TMPDIR:-/tmp}/qkimi-smoke.XXXXXX")"
trap 'rm -f "$result_file"' EXIT

swift build --package-path "$project_root/native" -c debug --arch arm64

QKIMI_RESOURCE_ROOT="$project_root/web" \
QKIMI_SMOKE_RESULT="$result_file" \
QKIMI_SMOKE_PERMISSION="${QKIMI_SMOKE_PERMISSION:-1}" \
QKIMI_SMOKE_UPLOAD="${QKIMI_SMOKE_UPLOAD:-0}" \
QKIMI_SMOKE_WIDTH="${QKIMI_SMOKE_WIDTH:-375}" \
QKIMI_SMOKE_HEIGHT="${QKIMI_SMOKE_HEIGHT:-812}" \
  "$project_root/native/.build/arm64-apple-macosx/debug/Kimi2007"

node - "$result_file" <<'NODE'
const fs = require('fs');
const result = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const value = result.result || {};
const checks = {
  evaluation: result.ok === true,
  bootstrap: value.bootstrap === 'ready',
  connection: String(value.connection || '').includes('已连接'),
  desktopBridge: value.desktop === true && value.nodeGlobalsHidden === true && value.hasToken === true,
  permissionUi: value.permissionUi?.opened === true && value.permissionUi?.modes?.length === 3,
  permissionSwitch: value.permissionSwitch?.skipped === true || (
    value.permissionSwitch?.passed === true && value.permissionSwitch?.modelPassed === true
  ),
  permissionLabel: value.permissionLabel?.labelChanged === true && value.permissionLabel?.statusPermission === 'auto',
  fullLockPermission: value.fullLockPermission?.opened === true &&
    Array.isArray(value.fullLockPermission?.modes) && value.fullLockPermission?.modes.length === 3,
  layoutSwitch: value.layoutSwitch?.compactLocked === true && value.layoutSwitch?.restoredAuto === true,
  modelMenu: value.modelMenu?.loaded === true && value.modelMenu?.selectedCount === 1,
  toolsPanel: value.toolsPanel?.loaded === true && value.toolsPanel?.hasProviderStatus === true && value.toolsPanel?.failureVisible === true,
  keyboardPaths: value.keyboard?.commandPalette === true &&
    Number(value.keyboard?.workspaceButtons || 0) > 0 && value.keyboard?.workspaceSemantics === true,
  multiWorkspace: value.multiWorkspace?.bridgeApi === true && value.multiWorkspace?.groupRendered === true &&
    Number(value.multiWorkspace?.openButtons || 0) === Math.max(0, Number(value.keyboard?.workspaceButtons || 0) - 1),
  completion: value.completion?.slashOpened === true && value.completion?.slashFiltered === true &&
    value.completion?.slashHasServerCmds === true &&
    value.completion?.keyboardNav === true && value.completion?.slashClosed === true &&
    value.completion?.mentionLoaded === true && value.completion?.mentionClosed === true,
  orphanCleanup: value.orphanCleanup?.supported === true && value.orphanCleanup?.passed === true,
  messageOrder: Object.values(value.messageOrder || {}).every(Boolean),
  sessionTags: value.sessionTags?.writeRead === true && value.sessionTags?.groupRendered === true,
  favorites: value.favorites?.addRemove === true && value.favorites?.countSynced === true &&
    value.favorites?.panelOpened === true && value.favorites?.controlsVisible === true &&
    value.favorites?.noOverflow === true &&
    value.favorites?.noteSaved === true,
  viewport: value.fillsViewport === true && value.overflow === false,
  narrowLayout: value.narrowLayout?.enabled !== true || (
    value.narrowLayout?.sessionsDrawer === true &&
    value.narrowLayout?.activityDrawer === true &&
    value.narrowLayout?.drawersClosed === true &&
    value.narrowLayout?.scrollWidth === value.narrowLayout?.viewport?.[0]
  ),
  pet: value.pet?.areaPresent === true && value.pet?.canvasPresent === true &&
    value.pet?.canvasDpr === true && value.pet?.hookPresent === true &&
    value.pet?.spriteLoaded === true &&
    value.pet?.modeSet === true && value.pet?.revertToIdle === true &&
    value.pet?.expIsNumber === true && value.pet?.patReacted === true &&
    value.pet?.statsIsObj === true && value.pet?.feedRaised === true &&
    value.pet?.actionsPresent === true && value.pet?.actionWorks === true &&
    value.pet?.actionValueSynced === true && value.pet?.rightClickSuppressed === true,
};
const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
if (failures.length) {
  console.error(JSON.stringify({ passed: false, failures, checks, result: value }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ passed: true, checks }, null, 2));
NODE
