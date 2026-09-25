import type { BrowserWindow } from "electron";

type ActivateView = (window: BrowserWindow, view: string) => Promise<void>;

interface OverviewVerificationResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly overviewRendered?: boolean;
  readonly recentActivityAbsent?: boolean;
  readonly activeWorkMotion?: boolean;
  readonly activeWorkMotionDiagnostics?: Readonly<Record<string, unknown>>;
  readonly wheelContained?: boolean;
  readonly wheelDiagnostics?: Readonly<Record<string, unknown>>;
  readonly activeTaskNavigation?: boolean;
  readonly historyNavigation?: boolean;
  readonly auditNavigation?: boolean;
  readonly chineseOverview?: boolean;
  readonly restoredEnglish?: boolean;
  readonly statusTask?: string;
  readonly activeWorkCount?: string;
  readonly activeWorkRows?: number;
  readonly activeWorkTitle?: string;
  readonly activeWorkDetail?: string;
  readonly activeWorkDisplay?: string;
  readonly activeWorkPosition?: string;
  readonly activeWorkHeight?: number;
  readonly activeWorkRole?: string;
}

export interface OverviewVerificationEvidence extends OverviewVerificationResult {
  readonly nativeWindowStable: boolean;
  readonly nativeBoundsBefore: Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  readonly nativeBoundsAfter: Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}

export async function verifyOverviewActivity(
  window: BrowserWindow,
  activateView: ActivateView,
): Promise<OverviewVerificationEvidence> {
  await activateView(window, "overview");
  const nativeBoundsBefore = window.getBounds();
  const result = (await window.webContents.executeJavaScript(
    `(async () => {
      const waitFor = async (predicate) => {
        const deadline = Date.now() + 2_500;
        while (!predicate() && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return predicate();
      };
      const activeWorkRows = () => Array.from(
        document.querySelectorAll('#home-active-work-carousel .active-work-line'),
      );
      const taskActiveWork = () => activeWorkRows().find((row) =>
        row.querySelector('.active-work-line-title')?.textContent?.trim() === 'Build task and Agent hub'
      );
      const selectedPosition = () => {
        const selected = activeWorkRows().find((row) => row.getAttribute('aria-selected') === 'true');
        return selected instanceof HTMLButtonElement
          ? Number.parseInt(selected.getAttribute('aria-posinset') ?? '', 10)
          : Number.NaN;
      };
      const durationMs = (value) => {
        const trimmed = value.trim();
        if (trimmed.endsWith('ms')) return Number.parseFloat(trimmed);
        if (trimmed.endsWith('s')) return Number.parseFloat(trimmed) * 1_000;
        return 0;
      };
      const rowSnapshot = (row) => {
        const style = getComputedStyle(row);
        const rect = row.getBoundingClientRect();
        return {
          id: row.dataset.activeWorkId ?? null,
          className: row.className,
          selected: row.getAttribute('aria-selected'),
          position: row.getAttribute('aria-posinset'),
          top: rect.top,
          height: rect.height,
          transform: style.transform,
          shift: style.getPropertyValue('--active-work-shift').trim(),
          scale: style.getPropertyValue('--active-work-scale').trim(),
          opacity: style.opacity,
        };
      };
      const rowsSnapshot = () => activeWorkRows().map((row) => rowSnapshot(row));

      const viewOverview = document.querySelector('#view-overview');
      const homeTaskAction = document.querySelector('#home-task-action');
      const legacyHomeTask = document.querySelector('#home-task');
      const legacyHomeTaskDetail = document.querySelector('#home-task-detail');
      const statusTask = document.querySelector('#status-task');
      const activeWorkCarousel = document.querySelector('#home-active-work-carousel');
      const activeWorkCount = document.querySelector('#home-active-work-count');
      const contentScroll = document.querySelector('.content-scroll');
      const activeWorkCard = document.querySelector('.home-active-work-card');
      const summaryGrid = document.querySelector('.home-summary-grid');
      const activeWorkHeading = document.querySelector('.home-active-work-heading');
      const technicalDetails = document.querySelector('#view-overview .home-technical-details');
      const overviewNavigation = document.querySelector('.navigation-item[data-view="overview"]');
      const historyNavigationItem = document.querySelector('.navigation-item[data-view="runs"]');
      const historyTab = document.querySelector('#runs-tab-runs');
      const auditTab = document.querySelector('#runs-tab-audit');
      const language = document.querySelector('#ui-language');

      const ready = await waitFor(() =>
        activeWorkRows().length >= 2 &&
        Number.parseInt(activeWorkCount?.textContent?.split('/')[1]?.trim() ?? '0', 10) >= 2
      );
      activeWorkCarousel?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
      );
      await waitFor(() => taskActiveWork() instanceof HTMLButtonElement);
      let activeWorkRow = taskActiveWork();

      if (
        !ready ||
        !(viewOverview instanceof HTMLElement) ||
        !(homeTaskAction instanceof HTMLButtonElement) ||
        legacyHomeTask !== null ||
        legacyHomeTaskDetail !== null ||
        !(statusTask instanceof HTMLElement) ||
        !(activeWorkCarousel instanceof HTMLElement) ||
        !(activeWorkCount instanceof HTMLElement) ||
        !(contentScroll instanceof HTMLElement) ||
        !(activeWorkCard instanceof HTMLElement) ||
        !(summaryGrid instanceof HTMLElement) ||
        !(activeWorkHeading instanceof HTMLElement) ||
        !(technicalDetails instanceof HTMLDetailsElement) ||
        !(overviewNavigation instanceof HTMLButtonElement) ||
        !(historyNavigationItem instanceof HTMLButtonElement) ||
        !(historyTab instanceof HTMLButtonElement) ||
        !(auditTab instanceof HTMLButtonElement) ||
        !(language instanceof HTMLSelectElement) ||
        !(activeWorkRow instanceof HTMLButtonElement)
      ) {
        return {
          ok: false,
          reason: 'overview convergence controls missing',
          ready,
          activeWorkTitles: activeWorkRows().map((row) =>
            row.querySelector('.active-work-line-title')?.textContent?.trim() ?? ''
          ),
        };
      }

      if (activeWorkRow.getAttribute('aria-selected') !== 'true') {
        activeWorkRow.click();
      }
      const overviewReady = await waitFor(() => {
        const row = taskActiveWork();
        return (
          row instanceof HTMLButtonElement &&
          row.getAttribute('aria-selected') === 'true' &&
          row.querySelector('.active-work-line-detail')?.textContent?.trim() ===
            'The latest Agent heartbeat is current.' &&
          statusTask.textContent?.trim() === '2 Agent tasks' &&
          activeWorkCarousel.getAttribute('role') === 'listbox' &&
          activeWorkRows().length >= 2 &&
          activeWorkCount.textContent?.trim() ===
            row.getAttribute('aria-posinset') + ' / ' + row.getAttribute('aria-setsize') &&
          Math.abs(row.getBoundingClientRect().height - 54) < 0.5 &&
          getComputedStyle(row).opacity === '1'
        );
      });
      activeWorkRow = taskActiveWork();
      if (!overviewReady || !(activeWorkRow instanceof HTMLButtonElement)) {
        return { ok: false, reason: 'active work fixture changed during selection', rows: rowsSnapshot(), statusTask: statusTask.textContent?.trim(), activeWorkCount: activeWorkCount.textContent?.trim() };
      }

      const activeRowsAtRender = activeWorkRows();
      const focusedActiveWork = activeRowsAtRender.find(
        (row) => row.getAttribute('aria-selected') === 'true',
      );
      const activeWorkLayout = getComputedStyle(activeWorkRow);
      const recentActivityAbsent =
        document.querySelector('#overview-run-list') === null &&
        document.querySelector('.home-activity-panel') === null &&
        !viewOverview.textContent?.includes('Recent activity') &&
        !viewOverview.textContent?.includes('最近活动');
      const overviewChecks = {
        overviewReady,
        recentActivityAbsent,
        focusedExists: focusedActiveWork instanceof HTMLButtonElement,
        sameActiveWorkId:
          focusedActiveWork instanceof HTMLButtonElement &&
          focusedActiveWork.dataset.activeWorkId === activeWorkRow.dataset.activeWorkId,
        selected: activeWorkRow.getAttribute('aria-selected') === 'true',
        title:
          focusedActiveWork?.querySelector('.active-work-line-title')?.textContent?.trim() ===
          'Build task and Agent hub',
        detail:
          focusedActiveWork?.querySelector('.active-work-line-detail')?.textContent?.trim() ===
          'The latest Agent heartbeat is current.',
        statusTask: statusTask.textContent?.trim() === '2 Agent tasks',
        listboxRole: activeWorkCarousel.getAttribute('role') === 'listbox',
        positionLabel:
          activeWorkCount.textContent?.trim() ===
          activeWorkRow.getAttribute('aria-posinset') +
            ' / ' +
            activeWorkRow.getAttribute('aria-setsize'),
        activeRows: activeRowsAtRender.length >= 2,
        blockedWorkRetained: activeRowsAtRender.some(
          (row) => row.dataset.activeWorkId === 'task:task-visual-sample-clipboard' &&
            row.querySelector('.active-work-line-state-label')?.textContent?.trim() === 'Blocked' &&
            row.querySelector('.active-work-line-detail')?.textContent?.includes('needs review before it can continue'),
        ),
        display: activeWorkLayout.display === 'grid',
        position: activeWorkLayout.position === 'absolute',
        height: Math.abs(activeWorkRow.getBoundingClientRect().height - 54) < 0.5,
      };
      const overviewRendered = Object.values(overviewChecks).every(Boolean);

      contentScroll.scrollTop = 0;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const geometry = () => {
        const card = activeWorkCard.getBoundingClientRect();
        const carousel = activeWorkCarousel.getBoundingClientRect();
        const grid = summaryGrid.getBoundingClientRect();
        const heading = activeWorkHeading.getBoundingClientRect();
        const open = homeTaskAction.getBoundingClientRect();
        return {
          contentScrollTop: contentScroll.scrollTop,
          contentClientHeight: contentScroll.clientHeight,
          contentScrollHeight: contentScroll.scrollHeight,
          documentScrollHeight: document.documentElement.scrollHeight,
          bodyScrollHeight: document.body.scrollHeight,
          innerHeight: window.innerHeight,
          cardTop: card.top,
          cardLeft: card.left,
          cardWidth: card.width,
          cardHeight: card.height,
          carouselTop: carousel.top,
          carouselHeight: carousel.height,
          gridTop: grid.top,
          gridHeight: grid.height,
          headingTop: heading.top,
          openTop: open.top,
        };
      };
      const sameGeometry = (before, after) =>
        Object.keys(before).every((key) => Math.abs(after[key] - before[key]) < 0.5);
      const dispatchWheel = (deltaY) => {
        const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
        const dispatchResult = activeWorkCarousel.dispatchEvent(event);
        return { defaultPrevented: event.defaultPrevented, dispatchResult };
      };
      const activeWorkTotal = Number.parseInt(
        activeWorkRow.getAttribute('aria-setsize') ?? '0',
        10,
      );

      activeWorkCarousel.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 340));
      const geometryBeforeWheel = geometry();
      let outerWheelEvents = 0;
      const observeOuterWheel = () => {
        outerWheelEvents += 1;
      };
      contentScroll.addEventListener('wheel', observeOuterWheel);
      const motionRow = activeWorkRows().find(
        (row) => row.getAttribute('aria-selected') === 'true',
      );
      if (!(motionRow instanceof HTMLButtonElement)) {
        contentScroll.removeEventListener('wheel', observeOuterWheel);
        return { ok: false, reason: 'selected Active Work row missing before motion probe' };
      }
      const motionStyle = getComputedStyle(motionRow);
      const reducedMotionClass = document.documentElement.classList.contains('reduce-motion');
      const reducedMotionMedia = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const motionReduced = reducedMotionClass || reducedMotionMedia;
      const transitionDurations = motionStyle.transitionDuration
        .split(',')
        .map(durationMs);
      const transitionProperties = motionStyle.transitionProperty
        .split(',')
        .map((value) => value.trim());
      const hasTimedTransformTransition = transitionProperties.some(
        (property, index) =>
          (property === 'transform' || property === 'all') &&
          (transitionDurations[index] ?? transitionDurations[0] ?? 0) > 0,
      );
      const motionStart = rowSnapshot(motionRow);
      const rowsAtMotionStart = rowsSnapshot();
      const motionStartTop = motionStart.top;
      const forwardWheel = dispatchWheel(120);
      const motionAfterDispatch = rowSnapshot(motionRow);
      const rowsAfterDispatch = rowsSnapshot();
      await new Promise((resolve) => setTimeout(resolve, 75));
      const motionMid = rowSnapshot(motionRow);
      const rowsAtMotionMid = rowsSnapshot();
      const motionMidTop = motionMid.top;
      const motionRowConnectedAtMid = motionRow.isConnected;
      await new Promise((resolve) => setTimeout(resolve, 325));
      const motionEnd = rowSnapshot(motionRow);
      const rowsAtMotionEnd = rowsSnapshot();
      const motionEndTop = motionEnd.top;
      const motionRowRetainedAtEnd = activeWorkRows().includes(motionRow);
      await waitFor(() => selectedPosition() === Math.min(2, activeWorkTotal));
      const advancedPosition = selectedPosition();
      const motionDistance = Math.abs(motionEndTop - motionStartTop);
      const motionMidProgress =
        motionDistance < 0.5
          ? 0
          : Math.abs(motionMidTop - motionStartTop) / motionDistance;
      const motionMin = Math.min(motionStartTop, motionEndTop);
      const motionMax = Math.max(motionStartTop, motionEndTop);
      const motionMidIsIntermediate =
        motionMidTop > motionMin + 0.75 && motionMidTop < motionMax - 0.75;
      const activeWorkMotion =
        !motionReduced &&
        hasTimedTransformTransition &&
        motionRowConnectedAtMid &&
        motionRowRetainedAtEnd &&
        motionDistance > 20 &&
        motionMidProgress > 0.02 &&
        motionMidProgress < 0.98 &&
        motionMidIsIntermediate;

      activeWorkCarousel.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 340));
      const firstPositionBefore = selectedPosition();
      const topBoundaryWheel = dispatchWheel(-120);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const firstPositionAfter = selectedPosition();

      activeWorkCarousel.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 340));
      const lastPositionBefore = selectedPosition();
      const bottomBoundaryWheel = dispatchWheel(120);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const lastPositionAfter = selectedPosition();
      const geometryAfterWheel = geometry();
      contentScroll.removeEventListener('wheel', observeOuterWheel);

      const wheelContained =
        topBoundaryWheel.defaultPrevented &&
        topBoundaryWheel.dispatchResult === false &&
        forwardWheel.defaultPrevented &&
        forwardWheel.dispatchResult === false &&
        bottomBoundaryWheel.defaultPrevented &&
        bottomBoundaryWheel.dispatchResult === false &&
        outerWheelEvents === 0 &&
        firstPositionBefore === 1 &&
        firstPositionAfter === firstPositionBefore &&
        advancedPosition === Math.min(2, activeWorkTotal) &&
        lastPositionBefore === activeWorkTotal &&
        lastPositionAfter === lastPositionBefore &&
        sameGeometry(geometryBeforeWheel, geometryAfterWheel);

      activeWorkRow = taskActiveWork();
      if (!(activeWorkRow instanceof HTMLButtonElement)) {
        return { ok: false, reason: 'task fixture left active work window after wheel checks' };
      }
      if (activeWorkRow.getAttribute('aria-selected') !== 'true') {
        activeWorkRow.click();
        await waitFor(() => taskActiveWork()?.getAttribute('aria-selected') === 'true');
        activeWorkRow = taskActiveWork();
      }
      if (!(activeWorkRow instanceof HTMLButtonElement)) {
        return { ok: false, reason: 'task fixture did not restore after wheel checks' };
      }

      homeTaskAction.click();
      await waitFor(() =>
        document.querySelector('#task-detail-pane')?.hidden === false &&
        document.querySelector('#task-detail-title')?.textContent?.trim() ===
          'Build task and Agent hub'
      );
      const activeTaskNavigation =
        document.querySelector('#view-tasks')?.classList.contains('is-active') === true &&
        document.querySelector('#task-detail-title')?.textContent?.trim() ===
          'Build task and Agent hub';

      overviewNavigation.click();
      await waitFor(() => document.querySelector('#view-overview')?.classList.contains('is-active'));
      historyNavigationItem.click();
      await waitFor(() =>
        document.querySelector('#view-runs')?.classList.contains('is-active') === true &&
        historyTab.getAttribute('aria-selected') === 'true'
      );
      const historyNavigation =
        document.querySelector('#view-runs')?.classList.contains('is-active') === true &&
        historyTab.getAttribute('aria-selected') === 'true';
      auditTab.click();
      await waitFor(() => auditTab.getAttribute('aria-selected') === 'true');
      const auditNavigation =
        document.querySelector('#view-runs')?.classList.contains('is-active') === true &&
        auditTab.getAttribute('aria-selected') === 'true';

      overviewNavigation.click();
      await waitFor(() => document.querySelector('#view-overview')?.classList.contains('is-active'));
      language.value = 'zh-CN';
      language.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const chineseOverview =
        document.documentElement.lang === 'zh-CN' &&
        document.querySelector('#overview-run-list') === null &&
        document.querySelector('.home-activity-panel') === null &&
        !viewOverview.textContent?.includes('Recent activity') &&
        !viewOverview.textContent?.includes('最近活动') &&
        activeWorkCount.textContent?.trim() ===
          activeWorkRow.getAttribute('aria-posinset') +
            ' / ' +
            activeWorkRow.getAttribute('aria-setsize');

      language.value = 'en';
      language.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const restoredEnglish =
        document.documentElement.lang === 'en' &&
        document.querySelector('#overview-run-list') === null &&
        document.querySelector('.home-activity-panel') === null &&
        !viewOverview.textContent?.includes('Recent activity') &&
        activeWorkCount.textContent?.trim() ===
          activeWorkRow.getAttribute('aria-posinset') +
            ' / ' +
            activeWorkRow.getAttribute('aria-setsize');

      return {
        ok:
          overviewRendered &&
          activeWorkMotion &&
          wheelContained &&
          activeTaskNavigation &&
          historyNavigation &&
          auditNavigation &&
          chineseOverview &&
          restoredEnglish,
        overviewRendered,
        overviewChecks,
        recentActivityAbsent,
        activeWorkMotion,
        activeWorkMotionDiagnostics: {
          motionReduced,
          reducedMotionClass,
          reducedMotionMedia,
          hasTimedTransformTransition,
          transitionDuration: motionStyle.transitionDuration,
          transitionProperty: motionStyle.transitionProperty,
          motionStart,
          motionAfterDispatch,
          motionMid,
          motionEnd,
          rowsAtMotionStart,
          rowsAfterDispatch,
          rowsAtMotionMid,
          rowsAtMotionEnd,
          motionRowConnectedAtMid,
          motionRowRetainedAtEnd,
          motionStartTop,
          motionMidTop,
          motionEndTop,
          motionDistance,
          motionMidProgress,
          motionMidIsIntermediate,
          intermediateSampleCount: motionMidIsIntermediate ? 1 : 0,
        },
        wheelContained,
        wheelDiagnostics: {
          outerWheelEvents,
          firstPositionBefore,
          firstPositionAfter,
          advancedPosition,
          lastPositionBefore,
          lastPositionAfter,
          topBoundaryWheel,
          forwardWheel,
          bottomBoundaryWheel,
          geometryBeforeWheel,
          geometryAfterWheel,
        },
        activeTaskNavigation,
        historyNavigation,
        auditNavigation,
        chineseOverview,
        restoredEnglish,
        statusTask: statusTask.textContent?.trim(),
        activeWorkCount: activeWorkCount.textContent?.trim(),
        activeWorkRows: activeRowsAtRender.length,
        activeWorkTitle: focusedActiveWork?.querySelector('.active-work-line-title')?.textContent?.trim(),
        activeWorkDetail: focusedActiveWork?.querySelector('.active-work-line-detail')?.textContent?.trim(),
        activeWorkDisplay: activeWorkLayout.display,
        activeWorkPosition: activeWorkLayout.position,
        activeWorkHeight: activeWorkRow.getBoundingClientRect().height,
        activeWorkRole: activeWorkCarousel.getAttribute('role'),
      };
    })()`,
    true,
  )) as OverviewVerificationResult;
  const nativeBoundsAfter = window.getBounds();
  const nativeWindowStable =
    nativeBoundsBefore.x === nativeBoundsAfter.x &&
    nativeBoundsBefore.y === nativeBoundsAfter.y &&
    nativeBoundsBefore.width === nativeBoundsAfter.width &&
    nativeBoundsBefore.height === nativeBoundsAfter.height;
  const evidence: OverviewVerificationEvidence = {
    ...result,
    nativeWindowStable,
    nativeBoundsBefore,
    nativeBoundsAfter,
  };
  return evidence;
}
