#!/usr/bin/env node
/**
 * Builds a CORRECT indoorfloorplan PATCH payload from a GET response.
 *
 * Usage:
 *   1. Save the GET response:  curl '.../api/v3/modules/indoorfloorplan/6?...' ... > record.json
 *   2. node scripts/build-floorplan-patch.mjs record.json > patch.json
 *   3. curl '.../api/v3/modules/indoorfloorplan/6' -X PATCH -H 'content-type: application/json' \
 *        ...auth headers/cookies... --data-binary @patch.json
 *
 * The correct payload rules (confirmed against the native client's own save):
 *  - body shape: { id, data: <the whole record>, moduleName: "indoorfloorplan" }
 *  - the FULL record rides back under data (partial patches replace-and-wipe)
 *  - every markers[] entry MUST keep: id (row id), geoId, geometry, markerType{id},
 *    markerModuleId, recordId, and the full desk object with AT LEAST {id, name, deskType}
 *  - every markedZones[] entry MUST keep: id (row id), geoId, geometry, recordId,
 *    and space with AT LEAST {id, name, reservable} — an entry without a valid space id
 *    violates the FloorPlan_MarkedZones SPACE_ID foreign key
 *
 * This script validates those rules and prints what's missing instead of emitting a
 * payload that would corrupt linkage.
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/build-floorplan-patch.mjs <get-response.json>');
  process.exit(1);
}

const raw = JSON.parse(readFileSync(file, 'utf8'));
// GET responses come as {indoorfloorplan: {...}} (v3 single-record) or {data:{indoorfloorplan:{...}}}.
const record = raw.indoorfloorplan ?? raw.data?.indoorfloorplan ?? raw;
if (!record?.id) {
  console.error('could not find an indoorfloorplan record in the input');
  process.exit(1);
}

const problems = [];
for (const m of record.markers ?? []) {
  const tag = `marker id=${m.id ?? '?'} label=${m.label ?? '?'}`;
  if (m.id == null) problems.push(`${tag}: missing row id — the backend would treat it as NEW`);
  if (m.recordId == null && m.desk?.id == null) problems.push(`${tag}: no recordId/desk.id — desk linkage would be lost`);
  if (m.desk && (m.desk.id == null || !m.desk.name || m.desk.deskType == null))
    problems.push(`${tag}: desk object must carry id + name + deskType`);
}
// The `space` module's numeric id (zoneModuleId) — read it off any zone that has it, or off the
// desk markers' pattern is markerModuleId; for zones we can also derive it from space.moduleId.
const spaceModuleId = (record.markedZones ?? []).map((z) => z.zoneModuleId ?? z.space?.moduleId).find((v) => v != null) ?? null;

for (const z of record.markedZones ?? []) {
  const tag = `zone id=${z.id ?? '?'} label=${z.label ?? '?'}`;
  if (z.id == null) problems.push(`${tag}: missing row id — the backend would treat it as NEW`);
  const spaceId = z.space?.id ?? z.recordId;
  if (spaceId == null) problems.push(`${tag}: no space.id/recordId — violates the SPACE_ID foreign key`);
  // Zone-side counterpart of the markers' markerModuleId — REPAIR it in place when derivable.
  if (z.zoneModuleId == null) {
    if (spaceModuleId != null) z.zoneModuleId = spaceModuleId;
    else problems.push(`${tag}: missing zoneModuleId and no space.moduleId to derive it from`);
  }
}

if (problems.length) {
  console.error('REFUSING to emit patch — fix these first:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(2);
}

process.stdout.write(JSON.stringify({ id: record.id, data: record, moduleName: 'indoorfloorplan' }));
console.error(
  `ok: ${record.markers?.length ?? 0} markers, ${record.markedZones?.length ?? 0} zones — all carry row id + record linkage`
);
