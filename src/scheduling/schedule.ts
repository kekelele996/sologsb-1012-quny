import {
  equipmentLabel,
  moduleLessons,
  type CourseModule,
  type EquipmentId,
} from '../models';

/* ============================== 教务台账 ============================== */
/*
 * 教室、档期与档期容量以教务台账为准，课程工具只读不写。
 * 每个档期（如某教室周一上午）记录可排课时数（45 分钟/课时）。
 */

export interface Classroom {
  id: string;
  name: string;
  equipment: EquipmentId[];
}

export interface TeachingSlot {
  id: string;
  classroomId: string;
  /** 教务台账上的档期标识，如「10/05 周一 上午」。 */
  label: string;
  date: string;
  period: '上午' | '下午' | '晚间';
  /** 该档期可排课时。 */
  capacity: number;
}

export interface TeachingLedger {
  /** 教务侧台账版本号。 */
  version: string;
  importedAt: string;
  classrooms: Classroom[];
  slots: TeachingSlot[];
}

/* ============================== 排课结果 ============================== */

export type PlacementStatus = 'placed' | 'queued' | 'unschedulable' | 'suspended' | 'void';

export interface ModulePlacement {
  moduleId: string;
  status: PlacementStatus;
  lessons: number;
  /** 排课时用到的设备签名，与当前模块不一致则作废重排。 */
  equipmentSignature: string;
  /** 排课时用到的总时长签名（秒）。 */
  durationSignature: number;
  classroomId?: string;
  slotId?: string;
  /** 冗余名称，档期被撤档后仍可展示历史安排。 */
  classroomName?: string;
  slotLabel?: string;
  /** 排队次序，FIFO。 */
  queuedAt?: number;
  /** 挂起原因（对账差异）。 */
  suspendedReason?: string;
  /** 关联的对账条目。 */
  reconItemId?: string;
  reason?: string;
  lastPlacedAt?: string;
}

export type ReconStatus = 'classroom-removed' | 'equipment-changed' | 'slot-removed' | 'slot-changed' | 'capacity-shrunk' | 'added';

export interface ReconItem {
  id: string;
  key: string;
  status: ReconStatus;
  classroomId: string;
  classroomName: string;
  slotId?: string;
  slotLabel?: string;
  detail: string;
  /** 影响到的已排模块（需要挂起或确认）。 */
  impactedModuleIds: string[];
  acknowledged: boolean;
}

export interface ImportState {
  loading: boolean;
  lastError: string;
  attempts: number;
  lastAttemptAt?: string;
}

export interface ScheduleState {
  ledger: TeachingLedger | null;
  placements: ModulePlacement[];
  reconItems: ReconItem[];
  importState: ImportState;
  queueSeq: number;
}

export const SCHEDULE_STORAGE_KEY = 'sologsb-1012-sign-course-schedule-v1';

export function createEmptySchedule(): ScheduleState {
  return {
    ledger: null,
    placements: [],
    reconItems: [],
    importState: { loading: false, lastError: '', attempts: 0 },
    queueSeq: 0,
  };
}

export function slotKey(classroomId: string, slotId: string): string {
  return `${classroomId}::${slotId}`;
}

/* ============================== 排课引擎 ============================== */

export interface ModuleRequirement {
  module: CourseModule;
  lessons: number;
  equipment: EquipmentId[];
  equipmentSignature: string;
  durationSignature: number;
}

export function buildRequirements(modules: CourseModule[]): Map<string, ModuleRequirement> {
  const map = new Map<string, ModuleRequirement>();
  modules.forEach((module) => {
    const equipment = module.equipment ?? [];
    map.set(module.id, {
      module,
      lessons: moduleLessons(module),
      equipment,
      equipmentSignature: equipment.slice().sort().join('|'),
      durationSignature: module.steps.reduce((total, step) => total + step.duration, 0),
    });
  });
  return map;
}

function classroomSupplies(classroom: Classroom, required: EquipmentId[]): boolean {
  return required.every((id) => classroom.equipment.includes(id));
}

/**
 * 贪心排课：同一教室同一档期只放一个模块。
 * 已排队模块按 FIFO 先尝试，其余模块按课程顺序尝试；
 * 有可用档期但全被占用 -> 排队；客观条件不满足 -> 排不下。
 * 已排且模块签名未变的安排保持不动（局部作废重排）。
 */
export function runScheduling(previous: ScheduleState, modules: CourseModule[]): ScheduleState {
  const ledger = previous.ledger;
  if (!ledger) {
    // 台账未导入前不排课；若曾有挂起安排则原样保留。
    return {
      ...previous,
      placements: previous.placements.filter((item) => item.status === 'suspended'),
    };
  }

  const requirements = buildRequirements(modules);
  const liveModuleIds = new Set(modules.map((module) => module.id));

  // 保留历史安排：挂起的继续挂起占坑；已排且模块未变（时长/设备签名一致）的保持不动。
  const carried: ModulePlacement[] = [];
  const existing = new Map<string, ModulePlacement>();
  previous.placements.forEach((placement) => {
    if (!liveModuleIds.has(placement.moduleId)) return;
    const requirement = requirements.get(placement.moduleId);
    if (!requirement) return;
    if (placement.status === 'suspended') {
      carried.push({ ...placement });
      existing.set(placement.moduleId, placement);
      return;
    }
    if (
      placement.status === 'placed' &&
      placement.equipmentSignature === requirement.equipmentSignature &&
      placement.durationSignature === requirement.durationSignature
    ) {
      carried.push({ ...placement, lessons: requirement.lessons });
      existing.set(placement.moduleId, placement);
    }
  });

  // 档期占用（挂起也算占坑，未确认前不能再排）。
  const occupied = new Set<string>();
  carried.forEach((placement) => {
    if ((placement.status === 'placed' || placement.status === 'suspended') && placement.classroomId && placement.slotId) {
      occupied.add(slotKey(placement.classroomId, placement.slotId));
    }
  });

  // 需要安排的模块：先 FIFO（之前排队的），再按课程顺序。
  const queueOrder = new Map<string, number>();
  previous.placements
    .filter((item) => item.status === 'queued' && liveModuleIds.has(item.moduleId))
    .sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0))
    .forEach((item, index) => queueOrder.set(item.moduleId, index));

  let queueSeq = previous.queueSeq;
  const candidates: ModuleRequirement[] = [];
  modules.forEach((module) => {
    if (!existing.has(module.id)) candidates.push(requirements.get(module.id)!);
  });
  candidates.sort((a, b) => {
    const qa = queueOrder.has(a.module.id) ? queueOrder.get(a.module.id)! : Number.MAX_SAFE_INTEGER;
    const qb = queueOrder.has(b.module.id) ? queueOrder.get(b.module.id)! : Number.MAX_SAFE_INTEGER;
    if (qa !== qb) return qa - qb;
    return modules.findIndex((item) => item.id === a.module.id) - modules.findIndex((item) => item.id === b.module.id);
  });

  const slotsByClassroom = new Map<string, TeachingSlot[]>();
  ledger.slots.forEach((slot) => {
    const list = slotsByClassroom.get(slot.classroomId) ?? [];
    list.push(slot);
    slotsByClassroom.set(slot.classroomId, list);
  });
  slotsByClassroom.forEach((list) => list.sort((a, b) => a.date.localeCompare(b.date) || a.period.localeCompare(b.period)));
  const classrooms = ledger.classrooms;

  const result = [...carried];

  candidates.forEach((requirement) => {
    const { module, lessons, equipment } = requirement;

    // 客观条件：是否存在任意一间设备齐全的教室。
    const equippedClassrooms = classrooms.filter((classroom) => classroomSupplies(classroom, equipment));
    if (equippedClassrooms.length === 0) {
      const globallyMissing = equipment.filter((id) => !classrooms.some((room) => room.equipment.includes(id)));
      result.push({
        moduleId: module.id,
        status: 'unschedulable',
        lessons,
        equipmentSignature: requirement.equipmentSignature,
        durationSignature: requirement.durationSignature,
        reason: globallyMissing.length > 0
          ? `现有教室均缺少设备：${globallyMissing.map(equipmentLabel).join('、')}。`
          : '所需设备组合没有任何一间教室能同时满足。',
      });
      return;
    }

    // 客观条件：设备齐全教室中是否存在容量足够的档期。
    let anyFitting = false;
    let chosen: { classroom: Classroom; slot: TeachingSlot } | undefined;
    for (const classroom of equippedClassrooms) {
      const slots = slotsByClassroom.get(classroom.id) ?? [];
      for (const slot of slots) {
        if (slot.capacity >= lessons) {
          anyFitting = true;
          if (!occupied.has(slotKey(classroom.id, slot.id))) {
            chosen = { classroom, slot };
          }
        }
        if (chosen) break;
      }
      if (chosen) break;
    }

    if (chosen) {
      occupied.add(slotKey(chosen.classroom.id, chosen.slot.id));
      result.push({
        moduleId: module.id,
        status: 'placed',
        lessons,
        equipmentSignature: requirement.equipmentSignature,
        durationSignature: requirement.durationSignature,
        classroomId: chosen.classroom.id,
        slotId: chosen.slot.id,
        classroomName: chosen.classroom.name,
        slotLabel: chosen.slot.label,
        lastPlacedAt: new Date().toISOString(),
      });
      return;
    }

    if (anyFitting) {
      // 容量/设备都满足，只是档期全被占（或挂起占坑）：排队等下一个档期。
      queueSeq += 1;
      const previousQueued = previous.placements.find(
        (item) => item.moduleId === module.id && item.status === 'queued',
      );
      result.push({
        moduleId: module.id,
        status: 'queued',
        lessons,
        equipmentSignature: requirement.equipmentSignature,
        durationSignature: requirement.durationSignature,
        queuedAt: previousQueued?.queuedAt ?? queueSeq,
        reason: '匹配档期均已排满，等待下一个档期。',
      });
    } else {
      result.push({
        moduleId: module.id,
        status: 'unschedulable',
        lessons,
        equipmentSignature: requirement.equipmentSignature,
        durationSignature: requirement.durationSignature,
        reason: `没有容量 ≥ ${lessons} 课时且设备齐全的档期。`,
      });
    }
  });

  return { ...previous, placements: result, queueSeq };
}

/* ============================ 台账导入与对账 ============================ */
/*
 * 按「教室 + 档期」逐条对账：
 * - 新增档期：仅记录；
 * - 撤档 / 教室撤销 / 设备缩减：影响到已排模块的先挂起；
 * - 容量缩小到放不下已排模块：先挂起；
 * - 不影响已排模块的良性变化：登记后确认即可。
 */

function findImpacted(
  placements: ModulePlacement[],
  classroomId: string,
  slotId: string | undefined,
): ModulePlacement[] {
  return placements.filter(
    (item) =>
      (item.status === 'placed' || item.status === 'queued') &&
      item.classroomId === classroomId &&
      (slotId === undefined || item.slotId === slotId),
  );
}

export function applyLedgerImport(previous: ScheduleState, ledger: TeachingLedger, modules: CourseModule[]): ScheduleState {
  const old = previous.ledger;
  const items: ReconItem[] = [];
  let placements = previous.placements.map((item) => ({ ...item }));

  const pushItem = (
    status: ReconStatus,
    classroom: Classroom,
    slot: TeachingSlot | undefined,
    detail: string,
    impacted: ModulePlacement[],
  ) => {
    const key = slot ? slotKey(classroom.id, slot.id) : classroom.id;
    const item: ReconItem = {
      id: `recon-${Date.now().toString(36)}-${items.length}`,
      key,
      status,
      classroomId: classroom.id,
      classroomName: classroom.name,
      slotId: slot?.id,
      slotLabel: slot?.label,
      detail,
      impactedModuleIds: impacted.map((entry) => entry.moduleId),
      acknowledged: impacted.length === 0,
    };
    items.push(item);
    if (impacted.length > 0) {
      const reason = `${classroom.name}${slot ? ` ${slot.label}` : ''}：${detail}`;
      placements = placements.map((entry) => {
        if (!impacted.some((target) => target.moduleId === entry.moduleId)) return entry;
        return {
          ...entry,
          status: 'suspended',
          suspendedReason: reason,
          reconItemId: item.id,
        };
      });
    }
  };

  if (old) {
    // 教室维度。
    old.classrooms.forEach((oldRoom) => {
      const nextRoom = ledger.classrooms.find((room) => room.id === oldRoom.id);
      if (!nextRoom) {
        const impacted = findImpacted(placements, oldRoom.id, undefined);
        pushItem('classroom-removed', oldRoom, undefined, '教务侧已撤销该教室。', impacted);
        return;
      }
      const removed = oldRoom.equipment.filter((id) => !nextRoom.equipment.includes(id));
      if (removed.length > 0) {
        // 仅挂起实际依赖到被移除设备的已排/排队模块。
        const impacted = placements.filter(
          (entry) =>
            (entry.status === 'placed' || entry.status === 'queued') &&
            entry.classroomId === oldRoom.id &&
            removed.some((id) => entry.equipmentSignature.split('|').includes(id)),
        );
        pushItem(
          'equipment-changed',
          nextRoom,
          undefined,
          `教室设备缩减，移除：${removed.map(equipmentLabel).join('、')}。`,
          impacted,
        );
      }
    });
    ledger.classrooms.forEach((room) => {
      if (!old.classrooms.some((oldRoom) => oldRoom.id === room.id)) {
        items.push({
          id: `recon-${Date.now().toString(36)}-${items.length}`,
          key: room.id,
          status: 'added',
          classroomId: room.id,
          classroomName: room.name,
          detail: `新增教室：${room.name}（设备 ${room.equipment.length} 项）。`,
          impactedModuleIds: [],
          acknowledged: true,
        });
      }
    });

    // 档期维度，逐条按「教室 + 档期」对账。
    old.slots.forEach((oldSlot) => {
      const nextSlot = ledger.slots.find(
        (slot) => slot.id === oldSlot.id && slot.classroomId === oldSlot.classroomId,
      );
      const room = ledger.classrooms.find((entry) => entry.id === oldSlot.classroomId)
        ?? old.classrooms.find((entry) => entry.id === oldSlot.classroomId)!;
      if (!nextSlot) {
        const impacted = findImpacted(placements, oldSlot.classroomId, oldSlot.id);
        pushItem('slot-removed', room, oldSlot, '教务侧已撤销该档期。', impacted);
        return;
      }
      if (nextSlot.label !== oldSlot.label || nextSlot.date !== oldSlot.date || nextSlot.period !== oldSlot.period) {
        const impacted = findImpacted(placements, oldSlot.classroomId, oldSlot.id);
        pushItem('slot-changed', room, nextSlot, `档期时间调整：${oldSlot.label} → ${nextSlot.label}。`, impacted);
        return;
      }
      if (nextSlot.capacity < oldSlot.capacity) {
        const impacted = placements.filter(
          (entry) =>
            entry.status === 'placed' &&
            entry.classroomId === oldSlot.classroomId &&
            entry.slotId === oldSlot.id &&
            (entry.lessons ?? 0) > nextSlot.capacity,
        );
        pushItem(
          'capacity-shrunk',
          room,
          nextSlot,
          `档期容量由 ${oldSlot.capacity} 课时缩减为 ${nextSlot.capacity} 课时。`,
          impacted,
        );
      }
    });
    ledger.slots.forEach((slot) => {
      const existed = old.slots.some(
        (oldSlot) => oldSlot.id === slot.id && oldSlot.classroomId === slot.classroomId,
      );
      if (!existed) {
        const room = ledger.classrooms.find((entry) => entry.id === slot.classroomId)!;
        items.push({
          id: `recon-${Date.now().toString(36)}-${items.length}`,
          key: slotKey(slot.classroomId, slot.id),
          status: 'added',
          classroomId: slot.classroomId,
          classroomName: room.name,
          slotId: slot.id,
          slotLabel: slot.label,
          detail: `新增档期：${room.name} ${slot.label}，容量 ${slot.capacity} 课时。`,
          impactedModuleIds: [],
          acknowledged: true,
        });
      }
    });
  }

  const statusOrder: Record<ReconStatus, number> = {
    'classroom-removed': 0,
    'equipment-changed': 1,
    'slot-removed': 2,
    'slot-changed': 3,
    'capacity-shrunk': 4,
    added: 5,
  };
  items.sort((a, b) => Number(a.acknowledged) - Number(b.acknowledged) || statusOrder[a.status] - statusOrder[b.status]);

  const afterImport: ScheduleState = {
    ...previous,
    ledger,
    placements,
    reconItems: items,
    importState: { loading: false, lastError: '', attempts: 0, lastAttemptAt: new Date().toISOString() },
  };
  // 挂起保留占坑，其余模块按新台账重新尝试（排队的优先）。
  return runScheduling(afterImport, modules);
}

/* ============================ 挂起处理 ============================ */

export type ReconAction = 'release' | 'keep' | 'dismiss';

export function resolveReconItem(state: ScheduleState, itemId: string, action: ReconAction, modules: CourseModule[]): ScheduleState {
  const item = state.reconItems.find((entry) => entry.id === itemId);
  if (!item) return state;

  let next: ScheduleState = {
    ...state,
    reconItems: state.reconItems.map((entry) =>
      entry.id === itemId ? { ...entry, acknowledged: true } : entry,
    ),
  };

  if (action === 'release') {
    // 释放挂起安排（作废），并让占坑失效，随后整体重排让排队模块补位。
    next = {
      ...next,
      placements: next.placements.filter((placement) => placement.reconItemId !== itemId),
    };
  }
  // keep：保留挂起状态继续占坑，等待教务复核；dismiss/release 都触发重排尝试。
  if (action !== 'keep') {
    next = runScheduling(next, modules);
  }
  return next;
}

/** 释放全部挂起安排并重排（对账差异统一按教务新台账处理）。 */
export function releaseAllSuspended(state: ScheduleState, modules: CourseModule[]): ScheduleState {
  const hasSuspended = state.placements.some((item) => item.status === 'suspended');
  if (!hasSuspended) return state;
  const next: ScheduleState = {
    ...state,
    reconItems: state.reconItems.map((item) => ({ ...item, acknowledged: true })),
    placements: state.placements.filter((item) => item.status !== 'suspended'),
  };
  return runScheduling(next, modules);
}

/** 教师手动要求全部作废重排。 */
export function rescheduleAll(state: ScheduleState, modules: CourseModule[]): ScheduleState {
  const reset: ScheduleState = {
    ...state,
    placements: state.placements.filter((item) => item.status === 'suspended'),
    queueSeq: 0,
  };
  return runScheduling(reset, modules);
}

/* ======================= 模拟教务侧台账客户端 ======================= */
/*
 * 真实环境由教务系统提供接口；本地工具通过模拟客户端演示
 * 「导入失败后按教务那侧的策略重试」。
 */

export type LedgerFixture = 'baseline' | 'v2-revised' | 'failure';

const BASE_CLASSROOMS: Classroom[] = [
  { id: 'room-a101', name: 'A101 多媒体教室', equipment: ['front-camera', 'side-camera'] },
  { id: 'room-b105', name: 'B105 录播教室', equipment: ['front-camera', 'side-camera', 'wide-camera'] },
  { id: 'room-c202', name: 'C202 手语实验室', equipment: ['front-camera', 'side-camera', 'overhead-rig', 'wide-camera'] },
];

export const LEDGER_FIXTURES: Record<Exclude<LedgerFixture, 'failure'>, () => TeachingLedger> = {
  baseline: () => ({
    version: 'TJ-2026W1-0928',
    importedAt: new Date().toISOString(),
    classrooms: structuredClone(BASE_CLASSROOMS),
    slots: [
      { id: 'slot-a101-1005-am', classroomId: 'room-a101', label: '10/05 周一 上午', date: '2026-10-05', period: '上午', capacity: 2 },
      { id: 'slot-a101-1007-pm', classroomId: 'room-a101', label: '10/07 周三 下午', date: '2026-10-07', period: '下午', capacity: 2 },
      { id: 'slot-b105-1006-pm', classroomId: 'room-b105', label: '10/06 周二 下午', date: '2026-10-06', period: '下午', capacity: 3 },
      { id: 'slot-b105-1009-am', classroomId: 'room-b105', label: '10/09 周五 上午', date: '2026-10-09', period: '上午', capacity: 2 },
      { id: 'slot-c202-1008-am', classroomId: 'room-c202', label: '10/08 周四 上午', date: '2026-10-08', period: '上午', capacity: 4 },
      { id: 'slot-c202-1010-pm', classroomId: 'room-c202', label: '10/10 周六 下午', date: '2026-10-10', period: '下午', capacity: 4 },
    ],
  }),
  'v2-revised': () => ({
    version: 'TJ-2026W1-1004',
    importedAt: new Date().toISOString(),
    classrooms: structuredClone(BASE_CLASSROOMS),
    slots: [
      // A101 周三下午撤档。
      { id: 'slot-a101-1005-am', classroomId: 'room-a101', label: '10/05 周一 上午', date: '2026-10-05', period: '上午', capacity: 2 },
      // B105 周二下午容量由 3 缩为 1。
      { id: 'slot-b105-1006-pm', classroomId: 'room-b105', label: '10/06 周二 下午', date: '2026-10-06', period: '下午', capacity: 1 },
      { id: 'slot-b105-1009-am', classroomId: 'room-b105', label: '10/09 周五 上午', date: '2026-10-09', period: '上午', capacity: 2 },
      // C202 周四上午时间改到晚间（档期 id 不变）。
      { id: 'slot-c202-1008-am', classroomId: 'room-c202', label: '10/08 周四 晚间', date: '2026-10-08', period: '晚间', capacity: 4 },
      { id: 'slot-c202-1010-pm', classroomId: 'room-c202', label: '10/10 周六 下午', date: '2026-10-10', period: '下午', capacity: 4 },
      // 新增周一晚间档期。
      { id: 'slot-c202-1005-pm', classroomId: 'room-c202', label: '10/05 周一 晚间', date: '2026-10-05', period: '晚间', capacity: 2 },
    ],
  }),
};

/** 模拟教务侧：故障注入时返回 503，由调用方按重试策略处理。 */
export function fetchTeachingLedger(fixture: LedgerFixture): Promise<TeachingLedger> {
  return new Promise((resolve, reject) => {
    const wait: (handler: () => void, ms: number) => ReturnType<typeof setTimeout> =
      typeof window !== 'undefined' ? window.setTimeout.bind(window) : setTimeout;
    wait(() => {
      if (fixture === 'failure') {
        reject(new Error('教务台账服务暂不可用 (HTTP 503)'));
        return;
      }
      resolve(LEDGER_FIXTURES[fixture]());
    }, 420);
  });
}

/** 教务侧重试策略：最多 3 次，间隔 0.6s / 1.4s。 */
export const IMPORT_RETRY_DELAYS = [600, 1400];
export const IMPORT_MAX_ATTEMPTS = 3;
