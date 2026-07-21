import { useMemo, useState } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { Modal, ModalFooter, ModalHeader } from '../primitives/Modal';
import { Button } from '../primitives/Button';
import { Select } from '../primitives/Select';
import type { SelectOption } from '../primitives/Select';
import { TYPE_META } from '../../lib/types';
import type { UnitType } from '../../lib/types';
import type { CadGroup } from '../../lib/cadAnalyze';
import styles from './AutoMapModal.module.css';

type Mapping = UnitType | 'ignore';

const POINT_OPTIONS: SelectOption<Mapping>[] = [
  { value: 'workstation', label: TYPE_META.workstation.name },
  { value: 'locker', label: TYPE_META.locker.name },
  { value: 'parking', label: TYPE_META.parking.name },
  { value: 'ignore', label: 'Ignore' },
];

/** Poly groups can become rooms (true polygons) or point units (placed at each polygon's centroid). */
const POLY_OPTIONS: SelectOption<Mapping>[] = [
  { value: 'room', label: `${TYPE_META.room.name} (polygon)` },
  { value: 'workstation', label: `${TYPE_META.workstation.name} (centroid)` },
  { value: 'locker', label: `${TYPE_META.locker.name} (centroid)` },
  { value: 'parking', label: `${TYPE_META.parking.name} (centroid)` },
  { value: 'ignore', label: 'Ignore' },
];

const KIND_LABEL: Record<CadGroup['kind'], string> = {
  block: 'Block inserts',
  circle: 'Circles',
  polyline: 'Closed polylines',
};

export function AutoMapModal() {
  const { state, actions } = useFloorplan();
  const groups = state.autoMapGroups;
  const [mapping, setMapping] = useState<Record<string, Mapping>>({});

  const effective = useMemo(() => {
    const out: Record<string, Mapping> = {};
    for (const g of groups ?? []) out[g.key] = mapping[g.key] ?? g.suggested;
    return out;
  }, [groups, mapping]);

  if (!groups) return null;

  const mappedUnitCount = groups.reduce(
    (n, g) => (effective[g.key] !== 'ignore' ? n + g.items.length : n),
    0,
  );
  const mappedGroupCount = groups.filter((g) => effective[g.key] !== 'ignore').length;

  return (
    <Modal onClose={actions.closeAutoMap} width={560}>
      <ModalHeader
        title="Auto-map CAD metadata"
        subtitle="Match the drawing's layers and blocks to floorplan modules"
        onClose={actions.closeAutoMap}
      />
      <div className={styles.body}>
        <p className={styles.hint}>
          Found {groups.length} mappable groups in the file. Block inserts and circles become
          point units at their insertion point; closed polylines can become rooms with their real
          shape.
        </p>
        <div className={styles.list}>
          {groups.map((g) => (
            <div key={g.key} className={styles.row}>
              <div className={styles.rowInfo}>
                <div className={styles.rowName}>
                  {g.blockName ? (
                    <>
                      <span className={styles.blockName}>{g.blockName}</span>
                      <span className={styles.layerName}>on {g.layer}</span>
                    </>
                  ) : (
                    <span className={styles.blockName}>{g.layer}</span>
                  )}
                </div>
                <div className={styles.rowMeta}>
                  {KIND_LABEL[g.kind]} · {g.count}
                  {g.truncated ? ` (first ${g.items.length} mapped)` : ''}
                </div>
              </div>
              <div className={styles.rowSelect}>
                <Select<Mapping>
                  size="sm"
                  value={effective[g.key]}
                  options={g.geometry === 'poly' ? POLY_OPTIONS : POINT_OPTIONS}
                  onChange={(value) => setMapping((m) => ({ ...m, [g.key]: value }))}
                  aria-label={`Map ${g.blockName ?? g.layer}`}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
      <ModalFooter>
        <Button variant="secondary" onClick={actions.closeAutoMap}>
          Skip
        </Button>
        <Button
          disabled={mappedUnitCount === 0}
          onClick={() => actions.applyAutoMap(effective)}
        >
          Map {mappedUnitCount} units from {mappedGroupCount} groups
        </Button>
      </ModalFooter>
    </Modal>
  );
}
