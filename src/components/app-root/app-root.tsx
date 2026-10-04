import { Component, Host, State, h, Listen } from '@stencil/core';
import {
  CURRENT_SCHEMA_VERSION,
  EQUIPMENT_CATALOG,
  backfillModules,
  cloneProject,
  createDemoLedger,
  createDemoProject,
  moduleEffectiveEquipment,
  moduleEquipmentFromCameras,
  moduleHours,
  selectedModule,
  selectedStep,
  STORAGE_KEY,
  validateProject,
  type CameraAngle,
  type CaptionPosition,
  type CourseModule,
  type CourseProject,
  type Difficulty,
  type Equipment,
  type GestureZone,
  type LessonStep,
  type ScheduleAssignment,
  type ScheduleStatus,
  type ValidationCheck,
} from '../../models';
import { reconcileSchedule, runSchedule } from '../../lib/scheduling';

type PreviewSize = 'phone' | 'tablet';
type ActivePanel = 'editor' | 'checks' | 'schedule';

@Component({
  tag: 'app-root',
  styleUrl: 'app-root.css',
  scoped: true,
})
export class AppRoot {
  @State() project: CourseProject = createDemoProject();
  @State() previewSize: PreviewSize = 'phone';
  @State() activePanel: ActivePanel = 'editor';
  @State() playing = false;
  @State() playProgress = 0;
  @State() offline = typeof navigator !== 'undefined' ? !navigator.onLine : false;
  @State() importingLedger = false;
  @State() toast?: { color: string; message: string };
  private past: CourseProject[] = [];
  private future: CourseProject[] = [];
  private playTimer?: number;
  /** 演示用：触发下一次导入失败，以演示“按教务侧重试”流程。 */
  private failNextImport = false;

  componentWillLoad(): void {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) this.project = this.upgradeProject(JSON.parse(saved) as CourseProject);
    } catch {
      this.project = createDemoProject();
    }
  }

  /** 旧数据升级：补齐设备需求与排课字段，设备缺失时按镜头角度回填。 */
  private upgradeProject(project: CourseProject): CourseProject {
    const modules = backfillModules(Array.isArray(project.modules) ? project.modules : []);
    return {
      ...project,
      modules,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      ledgerStatus: project.ledger ? 'ready' : (project.ledgerStatus ?? 'idle'),
      schedule: Array.isArray(project.schedule) ? project.schedule : [],
    };
  }

  disconnectedCallback(): void {
    if (this.playTimer) window.clearInterval(this.playTimer);
  }

  @Listen('online', { target: 'window' })
  handleOnline(): void {
    this.offline = false;
    this.showToast('success', '网络已恢复，本地草稿无需合并即可继续编辑。');
  }

  @Listen('offline', { target: 'window' })
  handleOffline(): void {
    this.offline = true;
    this.showToast('warning', '当前处于离线状态，修改会继续保存在本机。');
  }

  @Listen('keydown', { target: 'window' })
  handleKeyboard(event: KeyboardEvent): void {
    const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement)?.tagName);
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? this.redo() : this.undo();
      return;
    }
    if (modifier && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.redo();
      return;
    }
    if (modifier && event.key.toLowerCase() === 's') {
      event.preventDefault();
      this.saveDraft(true);
      return;
    }
    if (!editing && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      this.moveStep(event.key === 'ArrowUp' ? -1 : 1);
    }
  }

  private get currentModule(): CourseModule {
    return selectedModule(this.project);
  }

  private get currentStep(): LessonStep | undefined {
    return selectedStep(this.project);
  }

  private get checks(): ValidationCheck[] {
    return validateProject(this.project);
  }

  private persist(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.project));
  }

  private commit(update: (draft: CourseProject) => CourseProject, toast?: string): void {
    if (this.project.status === 'frozen') {
      this.showToast('warning', '当前版本已冻结，请先创建修订版。');
      return;
    }
    const before = cloneProject(this.project);
    const next = update(cloneProject(this.project));
    next.revision = before.revision + 1;
    next.lastSavedAt = new Date().toISOString();
    this.past = [...this.past, before].slice(-80);
    this.future = [];
    this.project = next;
    this.persist();
    if (toast) this.showToast('success', toast);
  }

  private undo(): void {
    const previous = this.past.pop();
    if (!previous) return this.showToast('medium', '没有可撤销的修改。');
    this.future = [cloneProject(this.project), ...this.future].slice(0, 80);
    this.project = previous;
    this.persist();
  }

  private redo(): void {
    const next = this.future.shift();
    if (!next) return;
    this.past = [...this.past, cloneProject(this.project)].slice(-80);
    this.project = next;
    this.persist();
  }

  private showToast(color: string, message: string): void {
    this.toast = { color, message };
    window.setTimeout(() => {
      if (this.toast?.message === message) this.toast = undefined;
    }, 3_200);
  }

  private selectModule(moduleId: string): void {
    const module = this.project.modules.find((item) => item.id === moduleId);
    this.project = { ...this.project, selectedModuleId: moduleId, selectedStepId: module?.steps[0]?.id ?? '' };
    this.persist();
  }

  private selectStep(stepId: string): void {
    this.project = { ...this.project, selectedStepId: stepId };
    this.persist();
  }

  private updateStep(patch: Partial<LessonStep>, toast?: string): void {
    const stepId = this.currentStep?.id;
    if (!stepId) return;
    const cameraChanged = patch.camera !== undefined;
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => {
        if (module.id !== draft.selectedModuleId) return module;
        const steps = module.steps.map((step) => step.id === stepId ? { ...step, ...patch } : step);
        // 设备需求默认随镜头角度回填；教师手工维护过则保留手工值。
        const equipment = cameraChanged && !module.equipmentManual
          ? moduleEquipmentFromCameras({ ...module, steps })
          : module.equipment;
        return { ...module, steps, equipment };
      }),
    }), toast);
    // 时长或镜头角度（设备需求）变更后，已排模块作废重排。
    if (patch.duration !== undefined || cameraChanged) this.refreshScheduleAfterChange();
  }

  private updateCurrentModule(patch: Partial<CourseModule>): void {
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => module.id === draft.selectedModuleId ? { ...module, ...patch } : module),
    }));
  }

  private addModule(): void {
    const index = this.project.modules.length + 1;
    const module: CourseModule = {
      id: `module-${Date.now().toString(36)}`,
      title: `模块 ${index} · 未命名`,
      summary: '说明该模块的学习目标与适用场景。',
      color: ['#15827a', '#8a3ffc', '#b34331', '#376ea8'][index % 4],
      steps: [],
      equipment: [],
      equipmentManual: false,
    };
    this.commit((draft) => ({ ...draft, modules: [...draft.modules, module], selectedModuleId: module.id, selectedStepId: '' }), '已创建课程模块。');
  }

  private addStep(kind: LessonStep['kind'] = '示范'): void {
    const module = this.currentModule;
    if (!module) return this.addModule();
    const prior = module.steps.at(-1);
    const step: LessonStep = {
      id: `step-${Date.now().toString(36)}`,
      title: `新${kind}步骤 ${module.steps.length + 1}`,
      kind,
      duration: 45,
      demoTitle: '等待上传或录制示范片段',
      demoUrl: '',
      handshape: '描述起始手形、掌心方向和运动路径。',
      gestureZone: '中央',
      caption: '填写送给学习者的字幕说明。',
      captionPosition: '下方安全区',
      camera: '正面',
      commonMistakes: [],
      exercise: kind === '练习' ? '填写练习任务。' : '',
      exerciseFeedback: kind === '练习' ? '填写反馈方式。' : '',
      altText: '',
      prerequisiteId: prior?.id ?? '',
      difficulty: '入门',
      cuePoints: [8, 20, 32],
    };
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((item) => item.id === module.id ? { ...item, steps: [...item.steps, step] } : item),
      selectedStepId: step.id,
    }), '已新增学习步骤。');
  }

  private duplicateStep(): void {
    const step = this.currentStep;
    if (!step) return;
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => {
        if (module.id !== draft.selectedModuleId) return module;
        const index = module.steps.findIndex((item) => item.id === step.id);
        const duplicate = { ...structuredClone(step), id: `step-${Date.now().toString(36)}`, title: `${step.title}（副本）` };
        return { ...module, steps: [...module.steps.slice(0, index + 1), duplicate, ...module.steps.slice(index + 1)] };
      }),
    }), '已复制当前步骤。');
  }

  private deleteStep(stepId: string): void {
    if (this.currentModule.steps.length <= 1) {
      this.showToast('warning', '模块至少保留一个学习步骤。');
      return;
    }
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => module.id === draft.selectedModuleId ? {
        ...module,
        steps: module.steps.filter((step) => step.id !== stepId),
      } : module),
      selectedStepId: this.currentModule.steps.find((step) => step.id !== stepId)?.id ?? '',
    }), '已删除学习步骤。');
  }

  private moveStep(direction: number): void {
    const stepId = this.currentStep?.id;
    if (!stepId) return;
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => {
        if (module.id !== draft.selectedModuleId) return module;
        const index = module.steps.findIndex((step) => step.id === stepId);
        const nextIndex = Math.max(0, Math.min(module.steps.length - 1, index + direction));
        if (index === nextIndex) return module;
        const steps = [...module.steps];
        const [item] = steps.splice(index, 1);
        steps.splice(nextIndex, 0, item);
        return { ...module, steps };
      }),
    }), '已调整步骤顺序。');
  }

  private saveDraft(showMessage = true): void {
    if (this.project.status === 'frozen') {
      this.showToast('warning', '冻结版本不可覆盖，请先创建修订版。');
      return;
    }
    this.project = { ...this.project, status: 'draft', lastSavedAt: new Date().toISOString() };
    this.persist();
    if (showMessage) this.showToast('success', '草稿已保存在浏览器本地。');
  }

  private submitForReview(): void {
    const blocking = this.checks.filter((check) => check.severity === 'error');
    if (blocking.length) {
      this.activePanel = 'checks';
      this.showToast('danger', `仍有 ${blocking.length} 个阻断问题，修复后才能提交复核。`);
      return;
    }
    this.commit((draft) => ({ ...draft, status: 'review' }), '课程已提交复核。');
  }

  private returnForChanges(): void {
    this.commit((draft) => ({ ...draft, status: 'changes' }), '课程已退回修改。');
  }

  private freezeVersion(): void {
    const blocking = this.checks.filter((check) => check.severity === 'error');
    if (blocking.length) {
      this.activePanel = 'checks';
      this.showToast('danger', `冻结前仍有 ${blocking.length} 个阻断问题。`);
      return;
    }
    this.commit((draft) => {
      const { frozenVersions, ...snapshot } = cloneProject(draft);
      const version = {
        id: `frozen-${Date.now().toString(36)}`,
        label: `冻结版本 v${frozenVersions.length + 1}`,
        createdAt: new Date().toISOString(),
        snapshot,
      };
      return { ...draft, status: 'frozen', frozenVersions: [version, ...frozenVersions] };
    }, '当前课程版本已冻结。');
    this.playing = false;
  }

  private reviseFrozen(): void {
    this.commit((draft) => ({ ...draft, status: 'draft' }), '已创建修订版，可继续编辑。');
  }

  // —— 排课：教务台账导入 / 自动排课 / 作废与挂起 ——

  private assignmentFor(moduleId: string): ScheduleAssignment | undefined {
    return this.project.schedule.find((item) => item.moduleId === moduleId);
  }

  private sameEquipment(a: Equipment[], b: Equipment[]): boolean {
    return a.length === b.length && a.every((item, index) => item === b[index]);
  }

  /** 导入教务台账（模拟异步）。失败时提示，可按教务侧重试。 */
  private importLedger(): void {
    if (this.importingLedger) return;
    this.importingLedger = true;
    this.project = { ...this.project, ledgerStatus: 'importing', ledgerError: undefined };
    this.persist();
    window.setTimeout(() => {
      if (this.failNextImport) {
        this.failNextImport = false;
        this.importingLedger = false;
        this.project = { ...this.project, ledgerStatus: 'failed', ledgerError: '教务台账服务暂不可用，请稍后按教务侧重试。' };
        this.persist();
        this.showToast('danger', '导入档期失败，可按教务侧重试。');
        return;
      }
      const ledger = createDemoLedger();
      const reconciled = reconcileSchedule(this.project.schedule, this.project.modules, ledger);
      const result = runSchedule(this.project.modules, ledger, reconciled.assignments, new Date().toISOString());
      this.importingLedger = false;
      this.project = { ...this.project, ledger, ledgerStatus: 'ready', ledgerError: undefined, schedule: result.assignments };
      this.persist();
      this.showToast('success', `台账已导入并逐条对账：已排 ${result.scheduled}，排队 ${result.queued}，排不下 ${result.unschedulable}，挂起 ${reconciled.suspended}。`);
    }, 650);
  }

  /** 导入失败后按教务侧重试。 */
  private retryImport(): void {
    this.importLedger();
  }

  /** 按当前台账把待排/作废/排不下的模块重新排进档期。 */
  private runAutoSchedule(showMessage = true): void {
    const ledger = this.project.ledger;
    if (!ledger) {
      this.showToast('warning', '请先导入教务台账，再自动排课。');
      return;
    }
    const result = runSchedule(this.project.modules, ledger, this.project.schedule, new Date().toISOString());
    this.project = { ...this.project, schedule: result.assignments };
    this.persist();
    if (showMessage) {
      this.showToast('success', `排课完成：已排 ${result.scheduled}，排队 ${result.queued}，排不下 ${result.unschedulable}，作废重排 ${result.invalidated}。`);
    }
  }

  /** 挂起的模块核对无误后，重新排队进入排课。 */
  private requeueSuspended(moduleId: string): void {
    const schedule = this.project.schedule.map((item) =>
      item.moduleId === moduleId && item.status === 'suspended'
        ? { ...item, status: 'pending' as ScheduleStatus, reason: undefined }
        : item);
    this.project = { ...this.project, schedule };
    this.persist();
    this.runAutoSchedule(false);
  }

  /** 步骤时长或设备需求变更后，已排模块作废并重排；未导入台账时先标记作废。 */
  private refreshScheduleAfterChange(): void {
    const { ledger, modules, schedule } = this.project;
    if (!ledger) {
      const next = schedule.map((item) => {
        if (item.status !== 'scheduled') return item;
        const module = modules.find((candidate) => candidate.id === item.moduleId);
        if (!module) return item;
        const hours = moduleHours(module);
        const equipment = moduleEffectiveEquipment(module);
        if (item.hours !== hours || !this.sameEquipment(item.equipment, equipment)) {
          return { ...item, status: 'invalid' as ScheduleStatus, reason: '步骤时长或设备需求已变更' };
        }
        return item;
      });
      this.project = { ...this.project, schedule: next };
      this.persist();
      return;
    }
    const result = runSchedule(modules, ledger, schedule, new Date().toISOString());
    this.project = { ...this.project, schedule: result.assignments };
    this.persist();
  }

  /** 教师手工维护设备需求；变更后已排模块作废重排。 */
  private toggleEquipment(moduleId: string, equipment: Equipment): void {
    const modules = this.project.modules.map((module) => {
      if (module.id !== moduleId) return module;
      const current = moduleEffectiveEquipment(module);
      const next = current.includes(equipment) ? current.filter((item) => item !== equipment) : [...current, equipment];
      return { ...module, equipment: next, equipmentManual: true };
    });
    this.project = { ...this.project, modules };
    this.persist();
    this.refreshScheduleAfterChange();
  }

  /** 按模块内各步骤的镜头角度重新回填设备需求。 */
  private backfillEquipmentForModule(moduleId: string): void {
    const modules = this.project.modules.map((module) =>
      module.id === moduleId ? { ...module, equipment: moduleEquipmentFromCameras(module), equipmentManual: false } : module);
    this.project = { ...this.project, modules };
    this.persist();
    this.refreshScheduleAfterChange();
  }

  private slotLabel(slotId?: string): string {
    if (!slotId || !this.project.ledger) return '—';
    const slot = this.project.ledger.slots.find((item) => item.id === slotId);
    if (!slot) return '—';
    const classroom = this.project.ledger.classrooms.find((item) => item.id === slot.classroomId);
    return `${classroom?.name ?? '未知教室'} · ${slot.weekday} ${slot.period}`;
  }

  private scheduleStatusMeta(status?: ScheduleStatus): { label: string; color: string } {
    switch (status) {
      case 'scheduled': return { label: '已排课', color: 'success' };
      case 'pending': return { label: '排队中', color: 'warning' };
      case 'unschedulable': return { label: '排不下', color: 'danger' };
      case 'invalid': return { label: '已作废', color: 'danger' };
      case 'suspended': return { label: '已挂起', color: 'medium' };
      default: return { label: '未排课', color: 'medium' };
    }
  }

  private renderModuleScheduleBadge(moduleId: string) {
    const meta = this.scheduleStatusMeta(this.assignmentFor(moduleId)?.status);
    return <span class={`module-schedule-badge ${meta.color}`}>{meta.label}</span>;
  }

  private renderAssignmentRow(assignment: ScheduleAssignment) {
    const module = this.project.modules.find((item) => item.id === assignment.moduleId);
    if (!module) return null;
    const meta = this.scheduleStatusMeta(assignment.status);
    return (
      <div class={`schedule-row status-${assignment.status}`} key={assignment.moduleId}>
        <span class={`schedule-dot ${meta.color}`} />
        <div class="schedule-row-main">
          <strong>{module.title}</strong>
          <small>
            {assignment.hours} 课时 · 设备 {assignment.equipment.length ? assignment.equipment.join('、') : '无特殊设备需求'}
            {assignment.status === 'scheduled' ? ` · ${this.slotLabel(assignment.slotId)}` : ''}
          </small>
          {assignment.reason && <small class="schedule-reason">{assignment.reason}</small>}
        </div>
        {assignment.status === 'suspended' && (
          <ion-button size="small" fill="outline" class="studio-button" onClick={() => this.requeueSuspended(assignment.moduleId)}>重新排队</ion-button>
        )}
      </div>
    );
  }

  private renderLedgerBanner() {
    const status = this.project.ledgerStatus;
    if (status === 'importing') {
      return <div class="ledger-banner importing"><span class="ledger-spinner" /> 正在导入教务台账…</div>;
    }
    if (status === 'failed') {
      return (
        <div class="ledger-banner failed">
          <div><strong>导入档期失败</strong><span>{this.project.ledgerError ?? '教务侧暂时不可用。'}</span></div>
          <ion-button size="small" class="studio-button" onClick={() => this.retryImport()}>按教务侧重试</ion-button>
        </div>
      );
    }
    if (status === 'ready' && this.project.ledger) {
      const ledger = this.project.ledger;
      return (
        <div class="ledger-banner ready">
          <div>
            <strong>台账已就绪</strong>
            <span>{ledger.source} · {this.formatDate(ledger.importedAt)} · {ledger.classrooms.length} 间教室 · {ledger.slots.length} 个档期</span>
          </div>
          <button class="simulate-fail" onClick={() => { this.failNextImport = true; this.importLedger(); }}>模拟导入失败</button>
        </div>
      );
    }
    return null;
  }

  private renderSchedule() {
    const ledger = this.project.ledger;
    const assignments = this.project.schedule;
    const groups: { key: ScheduleStatus | 'unscheduled'; title: string; items: ScheduleAssignment[] }[] = [
      { key: 'suspended', title: '挂起（与教室/档期对不上，先挂起）', items: assignments.filter((item) => item.status === 'suspended') },
      { key: 'invalid', title: '已作废（步骤时长或设备已变更）', items: assignments.filter((item) => item.status === 'invalid') },
      { key: 'unschedulable', title: '排不下（没有档期放得下）', items: assignments.filter((item) => item.status === 'unschedulable') },
      { key: 'pending', title: '排队中（档期排满，等下一个）', items: assignments.filter((item) => item.status === 'pending') },
      { key: 'scheduled', title: '已排课', items: assignments.filter((item) => item.status === 'scheduled') },
    ];
    return (
      <section class="schedule-panel">
        <div class="schedule-head">
          <div>
            <span class="eyebrow">教学档期</span>
            <h2>模块排课</h2>
            <p>按模块总时长与设备需求排进档期；同一教室同一档期只排一个模块，档期以教务台账为准、工具不回改。</p>
          </div>
          <div class="schedule-actions">
            {ledger && <ion-button fill="outline" class="studio-button" onClick={() => this.importLedger()}>重新导入并对账</ion-button>}
            {ledger && <ion-button class="studio-button" onClick={() => this.runAutoSchedule()}>自动排课</ion-button>}
          </div>
        </div>

        {this.renderLedgerBanner()}

        {!ledger && this.project.ledgerStatus !== 'importing' && this.project.ledgerStatus !== 'failed' && (
          <div class="schedule-empty">
            <div class="empty-glyph">档</div>
            <h2>尚未导入教务台账</h2>
            <p>台账记录教室、档期与各档期可排课时。导入后即可把课程模块按设备需求与课时容量排进档期，排满自动排队，排不下单独列出。</p>
            <ion-button class="studio-button" onClick={() => this.importLedger()}>导入教务台账</ion-button>
          </div>
        )}

        {ledger && assignments.length === 0 && (
          <div class="schedule-empty">
            <div class="empty-glyph">排</div>
            <h2>还没有排课结果</h2>
            <p>导入台账后会自动排课；也可以点击「自动排课」按当前模块与设备需求重新排。</p>
            <ion-button class="studio-button" onClick={() => this.runAutoSchedule()}>自动排课</ion-button>
          </div>
        )}

        {ledger && assignments.length > 0 && (
          <div class="schedule-groups">
            {groups.filter((group) => group.items.length > 0).map((group) => (
              <section class="schedule-group" key={group.key}>
                <div class="schedule-group-head"><h3>{group.title}</h3><span>{group.items.length}</span></div>
                {group.items.map((item) => this.renderAssignmentRow(item))}
              </section>
            ))}
          </div>
        )}
      </section>
    );
  }

  private togglePlay(): void {
    if (this.playTimer) {
      window.clearInterval(this.playTimer);
      this.playTimer = undefined;
      this.playing = false;
      return;
    }
    const duration = Math.max(10, this.currentStep?.duration ?? 40);
    this.playing = true;
    this.playTimer = window.setInterval(() => {
      this.playProgress += 0.25 / duration;
      if (this.playProgress >= 1) {
        this.playProgress = 0;
        this.playing = false;
        if (this.playTimer) window.clearInterval(this.playTimer);
        this.playTimer = undefined;
      }
    }, 250);
  }

  private formatDate(value: string): string {
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  }

  private renderStatusBadge() {
    if (this.project.status === 'review') return <ion-badge color="warning">待复核</ion-badge>;
    if (this.project.status === 'changes') return <ion-badge color="danger">已退回</ion-badge>;
    if (this.project.status === 'frozen') return <ion-badge color="success">已冻结</ion-badge>;
    return <ion-badge color="medium">草稿</ion-badge>;
  }

  private renderStepListItem(step: LessonStep, index: number) {
    const active = step.id === this.currentStep?.id;
    const issueCount = this.checks.filter((check) => check.stepId === step.id && check.severity !== 'info').length;
    return (
      <button class={`step-list-item ${active ? 'active' : ''}`} onClick={() => this.selectStep(step.id)}>
        <span class="step-index">{String(index + 1).padStart(2, '0')}</span>
        <span class="step-copy">
          <strong>{step.title}</strong>
          <small>{step.kind} · {step.duration}s · {step.difficulty}</small>
        </span>
        {issueCount > 0 && <span class="step-issue-count">{issueCount}</span>}
      </button>
    );
  }

  private renderStepEditor() {
    const step = this.currentStep;
    if (!step) {
      return (
        <div class="empty-editor">
          <div class="empty-glyph">手</div>
          <h2>这个模块还没有学习步骤</h2>
          <p>添加示范、讲解或练习步骤，然后设置前置条件与难度。</p>
          <ion-button class="studio-button" onClick={() => this.addStep('示范')}>添加第一个步骤</ion-button>
        </div>
      );
    }
    const frozen = this.project.status === 'frozen';
    const module = this.currentModule;
    const prerequisites = module.steps.filter((candidate, index) => candidate.id !== step.id && index < module.steps.findIndex((item) => item.id === step.id));
    return (
      <div class="step-editor">
        <div class="editor-title-row">
          <div>
            <span class="eyebrow">学习步骤 {module.steps.findIndex((item) => item.id === step.id) + 1}</span>
            <h1>{step.title}</h1>
            <p>最后修改 {this.formatDate(this.project.lastSavedAt)} · 修订号 {this.project.revision}</p>
          </div>
          <div class="title-actions">
            <ion-button fill="clear" class="studio-button" onClick={() => this.moveStep(-1)} title="Alt + ↑">上移</ion-button>
            <ion-button fill="clear" class="studio-button" onClick={() => this.moveStep(1)} title="Alt + ↓">下移</ion-button>
            <ion-button fill="outline" class="studio-button" onClick={() => this.duplicateStep()}>复制</ion-button>
            <ion-button fill="outline" color="danger" class="studio-button" onClick={() => this.deleteStep(step.id)}>删除</ion-button>
          </div>
        </div>

        {frozen && (
          <div class="frozen-callout">
            <div><strong>此版本已冻结</strong><span>字段已锁定，仍可预览和运行检查。</span></div>
            <ion-button size="small" class="studio-button" onClick={() => this.reviseFrozen()}>创建修订版</ion-button>
          </div>
        )}

        <section class="form-card">
          <div class="section-title"><span>01</span><div><h2>基础设计</h2><p>标题、类型、难度和预计时长</p></div></div>
          <div class="form-grid two">
            <ion-input disabled={frozen} label="步骤标题" labelPlacement="stacked" class="studio-input" value={step.title} onIonInput={(event) => this.updateStep({ title: event.detail.value ?? '' })} />
            <ion-select disabled={frozen} label="步骤类型" labelPlacement="stacked" class="studio-input" value={step.kind} onIonChange={(event) => this.updateStep({ kind: event.detail.value as LessonStep['kind'] })}>
              <ion-select-option value="示范">示范</ion-select-option>
              <ion-select-option value="讲解">讲解</ion-select-option>
              <ion-select-option value="练习">练习</ion-select-option>
            </ion-select>
            <ion-select disabled={frozen} label="难度标签" labelPlacement="stacked" class="studio-input" value={step.difficulty} onIonChange={(event) => this.updateStep({ difficulty: event.detail.value as Difficulty })}>
              {(['入门', '进阶', '挑战'] as Difficulty[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
            </ion-select>
            <ion-input disabled={frozen} type="number" min="10" max="600" label="预计时长（秒）" labelPlacement="stacked" class="studio-input" value={String(step.duration)} onIonInput={(event) => this.updateStep({ duration: Number(event.detail.value) || 0 })} />
          </div>
        </section>

        <section class="form-card">
          <div class="section-title"><span>02</span><div><h2>示范片段与镜头</h2><p>记录素材标识、手形、镜头角度和动作区域</p></div></div>
          <div class="demo-row">
            <div class={`video-thumbnail zone-${step.gestureZone}`}>
              <span class="play-mark">▶</span>
              <strong>{step.kind}片段</strong>
              <small>{step.camera}</small>
            </div>
            <div class="demo-fields">
              <ion-input disabled={frozen} label="示范片段名称" labelPlacement="stacked" class="studio-input" value={step.demoTitle} onIonInput={(event) => this.updateStep({ demoTitle: event.detail.value ?? '' })} />
              <ion-input disabled={frozen} label="本地素材地址（可空）" labelPlacement="stacked" class="studio-input" value={step.demoUrl} placeholder="例如 assets/hello.mp4" onIonInput={(event) => this.updateStep({ demoUrl: event.detail.value ?? '' })} />
            </div>
          </div>
          <div class="form-grid two">
            <ion-select disabled={frozen} label="镜头角度" labelPlacement="stacked" class="studio-input" value={step.camera} onIonChange={(event) => this.updateStep({ camera: event.detail.value as CameraAngle })}>
              {(['正面', '左侧 45°', '右侧 45°', '俯拍手部', '全身远景'] as CameraAngle[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
            </ion-select>
            <ion-select disabled={frozen} label="主要手形区域" labelPlacement="stacked" class="studio-input" value={step.gestureZone} onIonChange={(event) => this.updateStep({ gestureZone: event.detail.value as GestureZone })}>
              {(['左侧', '中央', '右侧'] as GestureZone[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
            </ion-select>
          </div>
          <ion-textarea disabled={frozen} autoGrow label="手形说明" labelPlacement="stacked" class="studio-input" value={step.handshape} onIonInput={(event) => this.updateStep({ handshape: event.detail.value ?? '' })} />
        </section>

        <section class="form-card">
          <div class="section-title"><span>03</span><div><h2>字幕与无障碍</h2><p>检查字幕位置、动作遮挡与替代文本</p></div></div>
          <div class="form-grid two">
            <ion-select disabled={frozen} label="字幕位置" labelPlacement="stacked" class="studio-input" value={step.captionPosition} onIonChange={(event) => this.updateStep({ captionPosition: event.detail.value as CaptionPosition })}>
              {(['下方安全区', '上移 15%', '角标提示', '画面中央'] as CaptionPosition[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
            </ion-select>
            <ion-input disabled={frozen} label="替代文本状态" labelPlacement="stacked" class={`studio-input ${step.altText ? '' : 'ion-invalid'}`} value={step.altText ? '已填写' : '缺失'} readonly />
          </div>
          <ion-textarea disabled={frozen} autoGrow label="步骤字幕" labelPlacement="stacked" class="studio-input" value={step.caption} onIonInput={(event) => this.updateStep({ caption: event.detail.value ?? '' })} />
          <ion-textarea disabled={frozen} autoGrow label="替代文本（必须描述动作与表情）" labelPlacement="stacked" class={`studio-input ${step.altText ? '' : 'ion-invalid'}`} value={step.altText} onIonInput={(event) => this.updateStep({ altText: event.detail.value ?? '' })} />
        </section>

        <section class="form-card">
          <div class="section-title"><span>04</span><div><h2>学习依赖与练习</h2><p>前置步骤、常见错误、练习任务与反馈</p></div></div>
          <div class="form-grid two">
            <ion-select disabled={frozen} label="前置条件" labelPlacement="stacked" class="studio-input" value={step.prerequisiteId} onIonChange={(event) => this.updateStep({ prerequisiteId: event.detail.value ?? '' })}>
              <ion-select-option value="">无前置条件</ion-select-option>
              {prerequisites.map((item) => <ion-select-option value={item.id}>{item.title}</ion-select-option>)}
            </ion-select>
            <ion-input disabled={frozen} label="检查点（秒，用逗号分隔）" labelPlacement="stacked" class="studio-input" value={step.cuePoints.join(', ')} onIonInput={(event) => this.updateStep({ cuePoints: (event.detail.value ?? '').split(/[,，\s]+/).map(Number).filter((value) => Number.isFinite(value)) })} />
          </div>
          <ion-textarea disabled={frozen} autoGrow label="常见错误（每行一条）" labelPlacement="stacked" class="studio-input" value={step.commonMistakes.join('\n')} onIonInput={(event) => this.updateStep({ commonMistakes: (event.detail.value ?? '').split('\n').filter(Boolean) })} />
          <div class="form-grid two">
            <ion-textarea disabled={frozen} autoGrow label="练习任务" labelPlacement="stacked" class="studio-input" value={step.exercise} onIonInput={(event) => this.updateStep({ exercise: event.detail.value ?? '' })} />
            <ion-textarea disabled={frozen} autoGrow label="练习反馈" labelPlacement="stacked" class="studio-input" value={step.exerciseFeedback} onIonInput={(event) => this.updateStep({ exerciseFeedback: event.detail.value ?? '' })} />
          </div>
        </section>
      </div>
    );
  }

  private renderPreview() {
    const step = this.currentStep;
    const progress = Math.round(this.playProgress * 100);
    return (
      <section class="preview-panel">
        <div class="preview-head">
          <div><span class="eyebrow">学习者预览</span><h2>设备与安全区检查</h2></div>
          <ion-segment value={this.previewSize} class="studio-segment" onIonChange={(event) => { this.previewSize = event.detail.value as PreviewSize; }}>
            <ion-segment-button value="phone">手机</ion-segment-button>
            <ion-segment-button value="tablet">平板</ion-segment-button>
          </ion-segment>
        </div>
        {step ? (
          <div class={`device-frame ${this.previewSize}`}>
            <div class="device-top"><span>{this.previewSize === 'phone' ? '9:16' : '4:3'}</span><span>{step.camera}</span></div>
            <div class={`preview-stage zone-${step.gestureZone} caption-${step.captionPosition.replace(/\s|%/g, '')} ${step.captionPosition === '画面中央' && step.gestureZone === '中央' ? 'overlap-warning' : ''}`}>
              <div class="stage-grid" />
              <div class="signer">
                <div class="head"><span class="face"><i /><i /></span></div>
                <div class="torso" />
                <div class="arm arm-left"><span class="hand" /></div>
                <div class="arm arm-right"><span class="hand" /></div>
              </div>
              <div class="gesture-marker" style={{ left: step.gestureZone === '左侧' ? '18%' : step.gestureZone === '右侧' ? '70%' : '43%' }} />
              <div class="caption-preview">{step.caption || '未填写字幕'}</div>
              {step.captionPosition === '角标提示' && <div class="corner-caption">{step.caption.slice(0, 18) || '角标提示'}</div>}
              <div class="safe-area"><span>字幕安全区</span></div>
            </div>
            <div class="player-controls">
              <button class="play-button" onClick={() => this.togglePlay()}>{this.playing ? 'Ⅱ' : '▶'}</button>
              <div class="player-timeline">
                <span style={{ width: `${progress}%` }} />
                {step.cuePoints.map((cue) => <i style={{ left: `${Math.min(100, (cue / Math.max(1, step.duration)) * 100)}%` }} title={`检查点 ${cue}s`} />)}
              </div>
              <span class="time-code">{String(Math.floor(this.playProgress * step.duration)).padStart(2, '0')} / {step.duration}s</span>
            </div>
            <div class="preview-meta">
              <div><strong>{step.kind}</strong><span>步骤类型</span></div>
              <div><strong>{step.difficulty}</strong><span>难度标签</span></div>
              <div><strong>{step.cuePoints.length}</strong><span>检查点</span></div>
            </div>
            <p class="preview-caption-text">{step.caption}</p>
          </div>
        ) : <div class="empty-preview">选择步骤后显示设备预览。</div>}
      </section>
    );
  }

  private renderChecks() {
    const errors = this.checks.filter((check) => check.severity === 'error');
    const warnings = this.checks.filter((check) => check.severity === 'warning');
    const info = this.checks.filter((check) => check.severity === 'info');
    return (
      <section class="checks-panel">
        <div class="checks-summary">
          <div class="check-stat danger"><strong>{errors.length}</strong><span>阻断问题</span></div>
          <div class="check-stat warning"><strong>{warnings.length}</strong><span>需注意</span></div>
          <div class="check-stat"><strong>{info.length}</strong><span>优化建议</span></div>
        </div>
        <div class="check-list">
          {this.checks.length === 0 && <div class="all-clear"><strong>✓ 未发现问题</strong><p>字幕遮挡、步骤跳级和替代文本检查均已通过。</p></div>}
          {this.checks.map((check) => (
            <button class={`check-item ${check.severity}`} onClick={() => {
              if (check.moduleId) this.selectModule(check.moduleId);
              if (check.stepId) this.selectStep(check.stepId);
              this.activePanel = 'editor';
            }}>
              <span class="check-severity">{check.severity === 'error' ? '!' : check.severity === 'warning' ? '△' : 'i'}</span>
              <span><strong>{check.title}</strong><small>{check.detail}</small></span>
              <span class="check-arrow">→</span>
            </button>
          ))}
        </div>
      </section>
    );
  }

  render() {
    const module = this.currentModule;
    const errors = this.checks.filter((check) => check.severity === 'error').length;
    return (
      <Host>
        <ion-app>
          <ion-header class="studio-header">
            <ion-toolbar>
              <ion-buttons slot="start"><div class="logo-mark">手</div><div class="app-title"><strong>SignCourse Studio</strong><span>手语课程编排工具</span></div></ion-buttons>
              <ion-buttons slot="end" class="header-actions">
                <button class={`connection-status ${this.offline ? 'offline' : ''}`} onClick={() => { this.offline = !this.offline; this.showToast(this.offline ? 'warning' : 'success', this.offline ? '已进入离线模拟，编辑继续保存在本机。' : '已恢复在线模拟，本地草稿保持同步。'); }}><span />{this.offline ? '离线编辑中（点击恢复）' : '本地自动保存（点击模拟离线）'}</button>
                <ion-button fill="clear" class="studio-button" disabled={this.past.length === 0} onClick={() => this.undo()}>撤销</ion-button>
                <ion-button fill="clear" class="studio-button" disabled={this.future.length === 0} onClick={() => this.redo()}>重做</ion-button>
                <ion-button fill="outline" class="studio-button" onClick={() => this.saveDraft()}>保存草稿</ion-button>
                {this.project.status === 'review'
                  ? <ion-button color="success" class="studio-button" onClick={() => this.freezeVersion()}>冻结版本</ion-button>
                  : this.project.status === 'changes'
                    ? <ion-button color="warning" class="studio-button" onClick={() => this.submitForReview()}>重新提交</ion-button>
                    : this.project.status === 'frozen'
                      ? <ion-button class="studio-button" onClick={() => this.reviseFrozen()}>创建修订版</ion-button>
                      : <ion-button color="primary" class="studio-button" onClick={() => this.submitForReview()}>提交复核</ion-button>}
              </ion-buttons>
            </ion-toolbar>
          </ion-header>

          <ion-content fullscreen>
            <div class="project-ribbon">
              <div class="project-heading">
                {this.renderStatusBadge()}
                <ion-input value={this.project.title} class="project-title-input" onIonInput={(event) => { this.project = { ...this.project, title: event.detail.value ?? '' }; this.persist(); }} />
                <span>{this.project.teacher} · {this.project.audience}</span>
              </div>
              <div class="project-metrics">
                <div><strong>{this.project.modules.length}</strong><span>模块</span></div>
                <div><strong>{this.project.modules.reduce((sum, item) => sum + item.steps.length, 0)}</strong><span>步骤</span></div>
                <div><strong>{Math.ceil(this.project.modules.reduce((sum, item) => sum + item.steps.reduce((total, lesson) => total + lesson.duration, 0), 0) / 60)}</strong><span>分钟</span></div>
                <div class={errors ? 'has-errors' : ''}><strong>{errors}</strong><span>阻断问题</span></div>
              </div>
              <div class="workflow-actions">
                {this.project.status === 'review' && <ion-button fill="clear" color="danger" class="studio-button" onClick={() => this.returnForChanges()}>退回修改</ion-button>}
                {this.project.status === 'draft' && <ion-button fill="clear" class="studio-button" onClick={() => this.addModule()}>＋ 新建模块</ion-button>}
                <ion-button fill="clear" class="studio-button" onClick={() => this.addStep('练习')}>＋ 练习步骤</ion-button>
              </div>
            </div>

            <main class="studio-workspace">
              <aside class="course-panel">
                <div class="panel-heading"><div><span class="eyebrow">课程结构</span><h2>模块与步骤</h2></div><button class="add-step-button" onClick={() => this.addStep('示范')}>＋</button></div>
                <div class="module-list">
                  {this.project.modules.map((item) => (
                    <section class={`module-card ${item.id === module?.id ? 'active' : ''}`} key={item.id}>
                      <button class="module-head" onClick={() => this.selectModule(item.id)}>
                        <span class="module-color" style={{ background: item.color }} />
                        <span><strong>{item.title}</strong><small>{item.steps.length} 个学习步骤 · {moduleHours(item)} 课时</small></span>
                        {this.renderModuleScheduleBadge(item.id)}
                      </button>
                      {item.id === module?.id && <div class="step-list">{item.steps.map((lesson, index) => this.renderStepListItem(lesson, index))}</div>}
                    </section>
                  ))}
                </div>
                <div class="module-editor">
                  <ion-input disabled={this.project.status === 'frozen'} label="当前模块标题" labelPlacement="stacked" class="studio-input" value={module?.title ?? ''} onIonInput={(event) => this.updateCurrentModule({ title: event.detail.value ?? '' })} />
                  <ion-textarea disabled={this.project.status === 'frozen'} autoGrow label="模块目标" labelPlacement="stacked" class="studio-input" value={module?.summary ?? ''} onIonInput={(event) => this.updateCurrentModule({ summary: event.detail.value ?? '' })} />
                  {module && (
                    <div class="equipment-editor">
                      <div class="equipment-head">
                        <span>设备需求</span>
                        <button class="equipment-backfill" disabled={this.project.status === 'frozen'} onClick={() => this.backfillEquipmentForModule(module.id)}>按镜头角度回填</button>
                      </div>
                      <div class="equipment-chips">
                        {EQUIPMENT_CATALOG.map((equipment) => {
                          const active = moduleEffectiveEquipment(module).includes(equipment);
                          return (
                            <button
                              class={`equipment-chip ${active ? 'active' : ''}`}
                              disabled={this.project.status === 'frozen'}
                              onClick={() => this.toggleEquipment(module.id, equipment)}>
                              {equipment}
                            </button>
                          );
                        })}
                      </div>
                      <small class="equipment-hint">设备需求默认随镜头角度汇总，也可手工勾选；时长或设备变更后已排模块作废重排。</small>
                    </div>
                  )}
                </div>
              </aside>

              <section class="editor-panel">
                <div class="panel-switcher">
                  <button class={this.activePanel === 'editor' ? 'active' : ''} onClick={() => { this.activePanel = 'editor'; }}>步骤编排</button>
                  <button class={this.activePanel === 'checks' ? 'active' : ''} onClick={() => { this.activePanel = 'checks'; }}>发布前检查 <span>{this.checks.length}</span></button>
                  <button class={this.activePanel === 'schedule' ? 'active' : ''} onClick={() => { this.activePanel = 'schedule'; }}>排课 <span>{this.project.schedule.filter((item) => item.status === 'scheduled').length}</span></button>
                </div>
                <div class="editor-scroll">{this.activePanel === 'editor' ? this.renderStepEditor() : this.activePanel === 'checks' ? this.renderChecks() : this.renderSchedule()}</div>
              </section>

              {this.renderPreview()}
            </main>
          </ion-content>
          <ion-toast isOpen={Boolean(this.toast)} message={this.toast?.message} color={this.toast?.color} duration={3200} onDidDismiss={() => { this.toast = undefined; }} />
        </ion-app>
      </Host>
    );
  }
}
