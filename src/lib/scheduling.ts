import {
  moduleHours,
  moduleEffectiveEquipment,
  type CourseModule,
  type Equipment,
  type LedgerSlot,
  type Classroom,
  type ScheduleAssignment,
  type TeachingLedger,
} from '../models';

function arraysEqual(a: Equipment[], b: Equipment[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function classroomHasEquipment(classroom: Classroom, equipment: Equipment[]): boolean {
  return equipment.every((item) => classroom.equipment.includes(item));
}

/** 档期是否放得下该模块：课时容量够，且教室具备全部设备。 */
function slotFits(slot: LedgerSlot, classroom: Classroom, hours: number, equipment: Equipment[]): boolean {
  return slot.capacityHours >= hours && classroomHasEquipment(classroom, equipment);
}

function moduleFingerprint(module: CourseModule): { hours: number; equipment: Equipment[] } {
  return { hours: moduleHours(module), equipment: moduleEffectiveEquipment(module) };
}

export interface ScheduleRunResult {
  assignments: ScheduleAssignment[];
  scheduled: number;
  queued: number;
  unschedulable: number;
  invalidated: number;
}

/**
 * 按教务台账把模块排进档期。
 * - 同一个教室同一个档期只放一个模块；
 * - 已排模块若时长或设备需求发生变化，作废重排；
 * - 候选档期都被占满则排队等下一个；
 * - 没有任何档期放得下（设备不匹配或容量不足）则单独列为排不下。
 */
export function runSchedule(
  modules: CourseModule[],
  ledger: TeachingLedger,
  previous: ScheduleAssignment[],
  nowIso: string,
): ScheduleRunResult {
  const previousByModule = new Map(previous.map((item) => [item.moduleId, item]));
  const occupied = new Set<string>();
  const assignments: ScheduleAssignment[] = [];
  const pending: CourseModule[] = [];
  let scheduled = 0;
  let queued = 0;
  let unschedulable = 0;
  let invalidated = 0;

  // 1) 保留仍然有效的已排结果；时长或设备变化的作废，进入待排。
  for (const module of modules) {
    const { hours, equipment } = moduleFingerprint(module);
    const existing = previousByModule.get(module.id);
    if (existing?.status === 'scheduled') {
      const slot = ledger.slots.find((candidate) => candidate.id === existing.slotId);
      const classroom = slot ? ledger.classrooms.find((candidate) => candidate.id === slot.classroomId) : undefined;
      const unchanged = existing.hours === hours && arraysEqual(existing.equipment, equipment);
      if (unchanged && slot && classroom && slotFits(slot, classroom, hours, equipment)) {
        occupied.add(slot.id);
        assignments.push({ ...existing, hours, equipment });
        scheduled += 1;
        continue;
      }
      invalidated += 1;
      pending.push(module);
      continue;
    }
    if (existing?.status === 'suspended') {
      // 挂起的模块不自动重排，等教师核对后再重新排队。
      assignments.push(existing);
      continue;
    }
    pending.push(module);
  }

  // 2) 给待排模块逐个找档期。
  for (const module of pending) {
    const { hours, equipment } = moduleFingerprint(module);
    const candidates = ledger.slots
      .map((slot) => ({ slot, classroom: ledger.classrooms.find((room) => room.id === slot.classroomId) }))
      .filter((entry): entry is { slot: LedgerSlot; classroom: Classroom } =>
        Boolean(entry.classroom) && slotFits(entry.slot, entry.classroom as Classroom, hours, equipment));

    if (candidates.length === 0) {
      assignments.push({
        moduleId: module.id,
        status: 'unschedulable',
        hours,
        equipment,
        reason: '没有同时满足设备需求与课时容量的教室/档期',
      });
      unschedulable += 1;
      continue;
    }

    const free = candidates.find((entry) => !occupied.has(entry.slot.id));
    if (!free) {
      assignments.push({
        moduleId: module.id,
        status: 'pending',
        hours,
        equipment,
        reason: '候选档期已排满，排队等待下一个档期',
      });
      queued += 1;
      continue;
    }

    occupied.add(free.slot.id);
    assignments.push({
      moduleId: module.id,
      status: 'scheduled',
      classroomId: free.classroom.id,
      slotId: free.slot.id,
      hours,
      equipment,
      scheduledAt: nowIso,
    });
    scheduled += 1;
  }

  return { assignments, scheduled, queued, unschedulable, invalidated };
}

export interface ReconcileResult {
  assignments: ScheduleAssignment[];
  suspended: number;
}

/**
 * 导入新台账后，按教室和档期逐条对账：
 * 已排模块对应的档期若在新台账中不存在、教室被撤或容量/设备不再匹配，
 * 则该模块先挂起，不自动重排。
 */
export function reconcileSchedule(
  previous: ScheduleAssignment[],
  modules: CourseModule[],
  ledger: TeachingLedger,
): ReconcileResult {
  const assignments = previous.map((item) => {
    if (item.status !== 'scheduled') return item;
    const module = modules.find((candidate) => candidate.id === item.moduleId);
    const slot = ledger.slots.find((candidate) => candidate.id === item.slotId);
    const classroom = slot ? ledger.classrooms.find((candidate) => candidate.id === slot.classroomId) : undefined;
    const hours = module ? moduleHours(module) : item.hours;
    const equipment = module ? moduleEffectiveEquipment(module) : item.equipment;
    if (!slot || !classroom || !slotFits(slot, classroom, hours, equipment)) {
      return { ...item, status: 'suspended' as const, reason: '与教务台账对账不一致，档期或教室已变更' };
    }
    return { ...item, hours, equipment };
  });
  return { assignments, suspended: assignments.filter((item) => item.status === 'suspended').length };
}
