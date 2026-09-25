import type { BrowserWindow } from "electron";

export async function verifyTaskHub(window: BrowserWindow): Promise<Readonly<Record<string, unknown>>> {
  const result = await window.webContents.executeJavaScript(
    `(async () => {
      const waitFor = async (predicate) => {
        const deadline = Date.now() + 2_500;
        while (!predicate() && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return predicate();
      };
      const detailPane = document.querySelector('#task-detail-pane');
      const detailBack = document.querySelector('#task-detail-back');
      if (
        detailPane instanceof HTMLElement &&
        detailPane.hidden === false &&
        detailBack instanceof HTMLButtonElement
      ) {
        detailBack.click();
        await waitFor(() => detailPane.hidden && document.querySelector('.task-hub-shell')?.dataset.taskSelected === 'false');
      }
      const projectCards = () => Array.from(document.querySelectorAll('#task-project-grid .task-project-card'));
      const taskCards = () => Array.from(document.querySelectorAll('#task-project-grid .task-summary-card'));
      const laneButton = (lane) => document.querySelector('#task-board-lane-' + lane);
      const selectLane = async (lane, projectCount, taskCount) => {
        const button = laneButton(lane);
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click();
        const expected = { current: ['task-visual-agent-hub', 'task-visual-release'], attention: ['task-visual-sample-clipboard'],
          history: [], activity: ['task-visual-inferred'], all: ['task-visual-agent-hub', 'task-visual-release', 'task-visual-sample-clipboard', 'task-visual-inferred'] }[lane];
        return await waitFor(() => button.getAttribute('aria-pressed') === 'true' && projectCards().length === projectCount &&
          taskCards().length === taskCount && taskCards().every((card) => expected.includes(card.dataset.taskId)));
      };
      const projectSelect = document.querySelector('#task-project-select');
      const projectFilterOptions = () => Array.from(projectSelect?.options ?? []);
      const projectFilterOption = (projectId) => projectFilterOptions().find((option) => option.value === projectId);
      const selectProject = (projectId) => { projectSelect.value = projectId; projectSelect.dispatchEvent(new Event('change', { bubbles: true })); };
      const laneButtons = Array.from(document.querySelectorAll('.task-board-lane[data-lane]'));
      const projectFilterSection = document.querySelector('#task-project-filter');
      const projectFilterMode = document.querySelector('#task-project-filter-mode');
      const summary = document.querySelector('#task-hub-summary');
      const search = document.querySelector('#task-hub-search');
      const currentCount = document.querySelector('#task-board-current-count');
      const attentionCount = document.querySelector('#task-board-attention-count');
      const historyCount = document.querySelector('#task-board-history-count');
      const activityCount = document.querySelector('#task-board-activity-count');
      const allCount = document.querySelector('#task-board-all-count');
      const advisory = document.querySelector('#task-hub-progress-advisory');
      const advisoryCount = document.querySelector('#task-hub-progress-missing-count');
      const projectFilterReady = await waitFor(() => projectFilterOptions().length === 3);
      const currentSelectedBeforeFilter = await selectLane('current', 1, 2);
      if (
        !projectFilterReady ||
        !(projectSelect instanceof HTMLSelectElement) ||
        !currentSelectedBeforeFilter ||
        !(projectFilterSection instanceof HTMLElement) ||
        projectFilterSection.hidden ||
        !(projectFilterMode instanceof HTMLElement) ||
        !(summary instanceof HTMLElement) ||
        !(search instanceof HTMLInputElement) ||
        !(currentCount instanceof HTMLElement) ||
        !(attentionCount instanceof HTMLElement) ||
        !(historyCount instanceof HTMLElement) ||
        !(activityCount instanceof HTMLElement) ||
        !(allCount instanceof HTMLElement) ||
        !(advisory instanceof HTMLElement) ||
        !(advisoryCount instanceof HTMLElement)
      ) {
        return { ok: false, reason: 'task board queues or project filter controls missing' };
      }
      const allProjectsOption = projectFilterOption('');
      const sovereignProjectOption = projectFilterOption('project-visual-sovereign');
      const sampleClipboardProjectOption = projectFilterOption('project-visual-sample-clipboard');
      const projectFilterInitialChecks = {
        optionCount: projectFilterOptions().length,
        filterMode: projectFilterMode.textContent?.trim(),
        allSelected: projectSelect.value === '',
        allLabel: allProjectsOption?.textContent?.trim(),
        sovereignLabel: sovereignProjectOption?.textContent?.trim(),
        sovereignRoot: sovereignProjectOption?.title,
        sampleClipboardLabel: sampleClipboardProjectOption?.textContent?.trim(),
        sampleClipboardRoot: sampleClipboardProjectOption?.title,
        labelled: document.querySelector('label[for="task-project-select"]') !== null,
      };
      const projectFilterInitial =
        projectFilterInitialChecks.optionCount === 3 &&
        projectFilterInitialChecks.filterMode === 'All projects' &&
        projectFilterInitialChecks.allSelected &&
        projectFilterInitialChecks.allLabel === 'All projects' &&
        projectFilterInitialChecks.sovereignLabel === 'Sovereign Code Runtime' &&
        projectFilterInitialChecks.sovereignRoot?.endsWith('sovereign-code-runtime') === true &&
        projectFilterInitialChecks.sampleClipboardLabel === 'Sample Clipboard' &&
        projectFilterInitialChecks.sampleClipboardRoot?.endsWith('sample-clipboard') === true &&
        projectFilterInitialChecks.labelled;
      selectProject('project-visual-sovereign');
      const singleProjectFilter = await waitFor(() => projectSelect.value === 'project-visual-sovereign' &&
        projectFilterMode.textContent?.trim() === 'Single project' &&
        currentCount.textContent?.trim() === '2' &&
        attentionCount.textContent?.trim() === '0' &&
        historyCount.textContent?.trim() === '0' &&
        activityCount.textContent?.trim() === '1' &&
        allCount.textContent?.trim() === '3' &&
        projectCards().length === 1 &&
        taskCards().length === 2
      );
      projectSelect.focus();
      document.querySelector('#task-hub-refresh')?.click();
      const projectSelectFocusRetained = await waitFor(() => !document.querySelector('#task-hub-refresh')?.disabled &&
        document.querySelector('#task-project-select') === projectSelect && document.activeElement === projectSelect);
      selectProject('');
      const projectFilterRestored = await waitFor(() =>
        projectSelect.value === '' &&
        projectFilterMode.textContent?.trim() === 'All projects' &&
        currentCount.textContent?.trim() === '2' &&
        attentionCount.textContent?.trim() === '1' &&
        historyCount.textContent?.trim() === '0' &&
        activityCount.textContent?.trim() === '1' &&
        allCount.textContent?.trim() === '4' &&
        projectCards().length === 1 &&
        taskCards().length === 2
      );
      const projectFilterNavigation = projectFilterInitial && singleProjectFilter && projectSelectFocusRetained && projectFilterRestored;
      const currentSelected = await selectLane('current', 1, 2);
      const firstProject = projectCards()[0];
      let firstTask = document.querySelector('#task-project-grid [data-task-id="task-visual-agent-hub"]');
      let releaseTask = document.querySelector('#task-project-grid [data-task-id="task-visual-release"]');
      const currentList = firstProject?.querySelector('.task-project-task-list');
      const currentLane = laneButton('current');
      if (
        !projectFilterNavigation ||
        !currentSelected ||
        !(firstProject instanceof HTMLElement) ||
        !(firstTask instanceof HTMLButtonElement) ||
        !(releaseTask instanceof HTMLButtonElement) ||
        !(currentList instanceof HTMLElement) ||
        !(currentLane instanceof HTMLButtonElement)
      ) {
        return {
          ok: false,
          reason: 'project filter navigation or current work cards missing',
          projectFilterInitialChecks,
          singleProjectFilter,
          projectFilterRestored,
        projectSelectFocusRetained,
        };
      }
      const queueNavigation =
        laneButtons.length === 5 &&
        currentCount.textContent?.trim() === '2' &&
        attentionCount.textContent?.trim() === '1' &&
        historyCount.textContent?.trim() === '0' &&
        activityCount.textContent?.trim() === '1' &&
        allCount.textContent?.trim() === '4' &&
        laneButton('current')?.getAttribute('aria-pressed') === 'true' &&
        document.querySelector('#task-board-view-title')?.textContent?.trim() === 'Current work' &&
        document.querySelector('#task-board-sync-state')?.textContent?.includes('4 records') === true;
      const firstStyle = getComputedStyle(firstProject);
      const firstProjectRect = firstProject.getBoundingClientRect();
      const firstProjectHeight = firstProjectRect.height;
      const firstProjectWidth = firstProjectRect.width;
      const firstProjectDisplay = firstStyle.display;
      const projectBlocks =
        firstProject.querySelector('h3')?.textContent?.trim() === 'Sovereign Code Runtime' &&
        firstProjectHeight >= 120 &&
        firstProjectWidth >= 240 &&
        firstProjectRect.right <= document.querySelector('#task-hub-list-pane').getBoundingClientRect().right + 1 &&
        firstProjectDisplay === 'block' &&
        summary.textContent?.includes('2 current') === true &&
        summary.textContent?.includes('1 need action') === true &&
        summary.textContent?.includes('0 history') === true;
      const firstTaskOnScreen = firstTask.getBoundingClientRect().top >= 0 && firstTask.getBoundingClientRect().bottom <= window.innerHeight;
      const currentCards = [firstTask, releaseTask];
      const currentCardRects = currentCards.map((card) => card.getBoundingClientRect());
      const currentCardStyles = currentCards.map((card) => getComputedStyle(card));
      const currentLaneStyle = getComputedStyle(currentLane);
      const currentTitles = currentCards.map((card) =>
        card.querySelector('.task-summary-header strong'),
      );
      const currentFooters = currentCards.map((card) =>
        card.querySelector('.task-summary-footer'),
      );
      const readableRows = currentCards.map((card) => {
        const cardRect = card.getBoundingClientRect();
        const text = ['.task-summary-header strong', '.task-summary-current'].map((selector) => {
          const element = card.querySelector(selector), style = getComputedStyle(element);
          return { fontSize: Number.parseFloat(style.fontSize), lineHeight: Number.parseFloat(style.lineHeight),
            clamp: style.webkitLineClamp, height: element.getBoundingClientRect().height };
        });
        return { text, contentContained: ['.task-summary-header', '.task-summary-current', '.task-summary-progress', '.task-summary-footer'].every((selector) => {
          const rect = card.querySelector(selector).getBoundingClientRect();
          return rect.height > 0 && rect.top >= cardRect.top && rect.bottom <= cardRect.bottom + 1 && rect.right <= cardRect.right + 1;
        }) };
      });
      const scanLineLayout =
        getComputedStyle(currentList).display === 'grid' &&
        Math.abs(currentCardRects[0].width - currentCardRects[1].width) < 1 &&
        currentCardRects[1].top >= currentCardRects[0].bottom - 1 &&
        readableRows.every((row) => row.contentContained && row.text.every((text) =>
          text.fontSize >= 14 && text.lineHeight >= text.fontSize * 1.4 && text.clamp === '2' && text.height <= text.lineHeight * 2 + 1)) &&
        currentCardStyles.every(
          (style) => style.borderRadius === '0px' && style.boxShadow === 'none',
        ) &&
        currentCards.every(
          (card) =>
            getComputedStyle(card.querySelector('.task-summary-reliability')).display ===
            'none',
        ) &&
        currentTitles.every((title, index) => title instanceof HTMLElement &&
          currentCards[index].getAttribute('aria-label')?.includes(title.textContent)) &&
        currentFooters.every(
          (footer) =>
            footer instanceof HTMLElement && footer.scrollWidth <= footer.clientWidth + 1,
        );
      const restrainedLaneSelection =
        currentLane.getAttribute('aria-pressed') === 'true' &&
        currentLaneStyle.backgroundImage === 'none' &&
        ['color', 'backgroundColor', 'boxShadow', 'borderBottomColor', 'borderLeftColor'].some(
          (property) => currentLaneStyle[property] !== getComputedStyle(laneButton('attention'))[property]);
      search.focus();
      const searchStyle = getComputedStyle(search);
      const singleFocusLayer =
        search.placeholder === 'Search this queue' &&
        (search.matches(':focus-visible')
          ? searchStyle.outlineStyle === 'solid' && Number.parseFloat(searchStyle.outlineWidth) >= 1.5 && Number.parseFloat(searchStyle.outlineWidth) <= 2.5
          : searchStyle.outlineStyle === 'none') &&
        searchStyle.boxShadow === 'none' &&
        searchStyle.borderTopStyle === 'solid';
      const currentQueueChecks = {
        firstLane: firstTask.dataset.boardLane,
        firstClass: firstTask.className,
        firstTrust: firstTask.querySelector('.task-summary-reliability')?.textContent?.trim() ?? null,
        releaseLane: releaseTask.dataset.boardLane,
        releaseClass: releaseTask.className,
        releaseTrust: releaseTask.querySelector('.task-summary-reliability')?.textContent?.trim() ?? null,
        inferredVisible: document.querySelector('#task-project-grid [data-task-id="task-visual-inferred"]') !== null,
        advisoryHidden: advisory.hidden,
        advisoryCount: advisoryCount.textContent?.trim() ?? null,
      };
      const currentQueueSemantics =
        currentQueueChecks.firstLane === 'current' &&
        currentQueueChecks.firstClass.includes('task-board-state-running') &&
        currentQueueChecks.firstTrust === 'The latest Agent heartbeat is current.' &&
        currentQueueChecks.releaseLane === 'current' &&
        currentQueueChecks.releaseClass.includes('task-board-state-planning') &&
        currentQueueChecks.releaseTrust === 'The latest Agent heartbeat is current.' &&
        currentQueueChecks.inferredVisible === false &&
        currentQueueChecks.advisoryHidden === true &&
        currentQueueChecks.advisoryCount === '0';
      const compactProgress = currentCards.every((card, index) => {
        const value = card.querySelector('.task-summary-progress small');
        const track = card.querySelector('.task-summary-progress-track');
        const percent = index === 0 ? '57' : '25';
        return value?.textContent?.trim() === (index === 0 ? '4 / 7' : '1 / 4') &&
          value.title.includes(percent + '%') && track.hidden === false &&
          track.getAttribute('aria-valuenow') === percent;
      });

      const activitySelected = await selectLane('activity', 1, 1);
      const inferredTask = document.querySelector('#task-project-grid [data-task-id="task-visual-inferred"]');
      if (!(inferredTask instanceof HTMLButtonElement)) {
        return { ok: false, reason: 'automatic activity queue did not render inferred work' };
      }
      const inferredCardText = inferredTask.textContent ?? '';
      const inferredProgress = inferredTask.querySelector('.task-summary-progress-track');
      const inferredSemantics =
        activitySelected &&
        laneButton('activity')?.getAttribute('aria-pressed') === 'true' &&
        document.querySelector('#task-board-view-title')?.textContent?.trim() === 'Automatic activity' &&
        inferredTask.dataset.boardLane === 'activity' &&
        inferredTask.classList.contains('task-source-inferred') &&
        inferredTask.classList.contains('task-board-state-observed-activity') &&
        inferredCardText.includes('Observed activity') &&
        inferredCardText.includes('Automatic activity is separate from tasks until an Agent claims it.') &&
        inferredCardText.includes('Activity detected · no task Agent') &&
        !inferredCardText.includes('Agent online') &&
        inferredProgress?.hidden === true && inferredProgress.getClientRects().length === 0 &&
        inferredTask.querySelector('.task-summary-progress small')?.textContent?.trim() === 'Progress not reported';

      inferredTask.click();
      await waitFor(() =>
        document.querySelector('#task-detail-title')?.textContent?.trim() === 'Unclaimed terminal activity'
      );
      const inferredDetail =
        document.querySelector('#task-detail-status')?.textContent?.trim() === 'Observed activity' &&
        document.querySelector('#task-detail-board-state')?.textContent?.trim() === 'Observed activity' &&
        document.querySelector('#task-detail-recorded-status')?.textContent?.trim() === 'Running' &&
        document.querySelector('#task-detail-trust')?.textContent?.includes('separate from tasks') === true &&
        document.querySelector('#task-detail-agent-presence')?.textContent?.trim() === 'Activity detected' &&
        document.querySelector('#task-detail-agent')?.textContent?.trim() === 'Unassigned · inferred from tool activity' &&
        document.querySelector('#task-detail-heartbeat-label')?.textContent?.trim() === 'Latest activity signal' &&
        document.querySelector('#task-conversation-title')?.textContent?.trim() === 'Leave a note for a future Agent' &&
        document.querySelector('#task-conversation-delivery')?.textContent?.trim() === 'No task Agent assigned · stored locally' &&
        document.querySelector('#task-detail-progress-note')?.textContent?.includes('inferred from tool activity') === true &&
        document.querySelector('#task-detail-steps')?.textContent?.includes('has not been claimed by an Agent') === true;
      const inferredContinuity =
        document.querySelector('#task-session-continuity')?.getAttribute('data-continuity-tone') === 'captured' &&
        document.querySelector('#task-session-continuity-title')?.textContent?.trim() ===
          'Captured activity is not a web session' &&
        document.querySelector('#task-session-continuity-next')?.textContent?.includes('Agent claim this Task') === true;
      document.querySelector('#task-detail-back')?.click();
      await waitFor(() =>
        document.querySelector('#task-detail-pane')?.hidden === true &&
        document.activeElement?.getAttribute('data-task-id') === 'task-visual-inferred'
      );
      const inferredFocusRestored =
        document.activeElement?.getAttribute('data-task-id') === 'task-visual-inferred';

      const currentRestored = await selectLane('current', 1, 2);
      firstTask = document.querySelector('#task-project-grid [data-task-id="task-visual-agent-hub"]');
      releaseTask = document.querySelector('#task-project-grid [data-task-id="task-visual-release"]');
      if (!(firstTask instanceof HTMLButtonElement) || !(releaseTask instanceof HTMLButtonElement)) {
        return { ok: false, reason: 'current work queue did not restore explicit tasks' };
      }
      const currentRestoreChecks = {
        selected: currentRestored,
        firstLane: firstTask.dataset.boardLane,
        releaseLane: releaseTask.dataset.boardLane,
        inferredVisible: document.querySelector('#task-project-grid [data-task-id="task-visual-inferred"]') !== null,
      };
      const currentQueueRestored =
        currentRestoreChecks.selected &&
        currentRestoreChecks.firstLane === 'current' &&
        currentRestoreChecks.releaseLane === 'current' &&
        currentRestoreChecks.inferredVisible === false;

      firstTask.click();
      releaseTask.click();
      await waitFor(() =>
        document.querySelector('#task-detail-title')?.textContent?.trim() === 'Package and verify the next desktop release'
      );
      await new Promise((resolve) => setTimeout(resolve, 120));
      const detailRaceSafe =
        document.querySelector('#task-detail-title')?.textContent?.trim() === 'Package and verify the next desktop release';
      const historyList = document.querySelector('#task-message-list');
      const historyButton = document.querySelector('#task-message-load-older');
      if (!(historyList instanceof HTMLElement) || !(historyButton instanceof HTMLButtonElement)) {
        return { ok: false, reason: 'conversation history controls missing' };
      }
      const latestHistoryRows = historyList.querySelectorAll('.task-message');
      historyList.scrollTop = 100;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const historyAnchor = Array.from(latestHistoryRows).find((row) => row.getBoundingClientRect().bottom > historyList.getBoundingClientRect().top);
      const anchorTopBefore = historyAnchor?.getBoundingClientRect().top ?? null;
      const historyGeometry = () => ({ listTop: historyList.getBoundingClientRect().top,
        controlsHeight: historyButton.parentElement.getBoundingClientRect().height, scrollTop: historyList.scrollTop,
        firstSequence: historyList.querySelector('.task-message')?.getAttribute('data-message-sequence') });
      const historyGeometryBefore = historyGeometry();
      historyButton.click();
      const historyLoaded = await waitFor(() => historyList.querySelectorAll('.task-message').length === 350);
      const historyAnchorDelta = anchorTopBefore === null ? null : Math.abs(historyAnchor.getBoundingClientRect().top - anchorTopBefore);
      const historyGeometryAfter = historyGeometry();
      const historyPagination = latestHistoryRows.length === 300 && historyLoaded && historyAnchorDelta !== null && historyAnchorDelta < 1 &&
        historyButton.hidden && historyList.querySelector('.task-conversation-truncated') === null &&
        historyList.querySelector('.task-message')?.getAttribute('data-message-sequence') === '1';
      document.querySelector('#task-detail-back')?.click();
      await waitFor(() => document.querySelector('#task-detail-pane')?.hidden === true);

      firstTask.click();
      await waitFor(() =>
        document.querySelector('#task-detail-title')?.textContent?.trim() === 'Build task and Agent hub'
      );
      const detailTitle = document.querySelector('#task-detail-title');
      const currentStep = document.querySelector('#task-detail-current-step');
      const progress = document.querySelector('#task-detail-progress-value');
      const progressBar = document.querySelector('#task-detail-progress-bar');
      const progressTrack = document.querySelector('#task-detail-progress-track');
      const presence = document.querySelector('#task-detail-agent-presence');
      const stepRows = Array.from(document.querySelectorAll('#task-detail-steps .task-step'));
      const messagesBefore = Array.from(document.querySelectorAll('#task-message-list .task-message'));
      const conversation = document.querySelector('.task-conversation-card');
      const continuity = document.querySelector('#task-session-continuity');
      const continuityTitle = document.querySelector('#task-session-continuity-title');
      const continuityOwner = document.querySelector('#task-session-continuity-owner');
      const continuityNext = document.querySelector('#task-session-continuity-next');
      if (
        !(detailTitle instanceof HTMLElement) ||
        !(currentStep instanceof HTMLElement) ||
        !(progress instanceof HTMLElement) ||
        !(progressBar instanceof HTMLElement) ||
        !(progressTrack instanceof HTMLElement) ||
        !(presence instanceof HTMLElement) ||
        !(conversation instanceof HTMLElement) ||
        !(continuity instanceof HTMLElement) ||
        !(continuityTitle instanceof HTMLElement) ||
        !(continuityOwner instanceof HTMLElement) ||
        !(continuityNext instanceof HTMLElement)
      ) {
        return { ok: false, reason: 'task detail controls missing' };
      }
      const conversationWidth = conversation.getBoundingClientRect().width;
      const metadataDetails = document.querySelector('.task-technical-details');
      const coordinationDetails = document.querySelector('details.task-coordination-card');
      const detailsInitiallyCollapsed = metadataDetails instanceof HTMLDetailsElement && !metadataDetails.open &&
        coordinationDetails instanceof HTMLDetailsElement && !coordinationDetails.open;
      document.querySelector('#task-info-toggle')?.click();
      const infoPopoverOpened = await waitFor(() => document.querySelector('#task-info-popover')?.matches(':popover-open'));
      metadataDetails?.querySelector('summary')?.click();
      coordinationDetails?.querySelector('summary')?.click();
      const detailsAccessible = await waitFor(() => infoPopoverOpened && detailsInitiallyCollapsed && metadataDetails.open && coordinationDetails.open &&
        document.querySelector('#task-detail-recorded-status')?.getClientRects().length > 0 &&
        document.querySelector('#task-coordination-list')?.getClientRects().length > 0 &&
        document.querySelector('#task-coordination-list')?.textContent?.includes('release checklist is ready') === true);
      metadataDetails?.querySelector('summary')?.click();
      coordinationDetails?.querySelector('summary')?.click();
      document.querySelector('#task-info-popover')?.hidePopover();
      const continuityRendered =
        continuity.hidden === false &&
        continuity.dataset.continuityTone === 'connected' &&
        continuityTitle.textContent?.trim() === 'Task context is ready to continue' &&
        continuityOwner.textContent?.trim() === 'Sovereign Agent · online' &&
        continuityNext.textContent?.includes('Browser memory is not copied') === true;
      const detailRendered =
        detailTitle.textContent?.trim() === 'Build task and Agent hub' &&
        currentStep.textContent?.includes('project cards') === true &&
        progress.textContent?.trim() === '4 / 7 · 57%' &&
        Number.parseFloat(progressBar.style.width) === 57 &&
        progressTrack.getAttribute('role') === 'progressbar' &&
        progressTrack.getAttribute('aria-valuenow') === '57' &&
        progressTrack.getAttribute('aria-valuetext')?.includes('57%') === true &&
        presence.textContent?.trim() === 'Agent online' &&
        stepRows.length === 4 &&
        stepRows.filter((row) => row.classList.contains('task-step-succeeded')).length === 2 &&
        stepRows.some((row) => row.classList.contains('task-step-running')) &&
        messagesBefore.length === 4 &&
        conversationWidth >= 400;

      const refreshButton = document.querySelector('#task-hub-refresh');
      const stepsContainer = document.querySelector('#task-detail-steps');
      const messageList = document.querySelector('#task-message-list');
      const currentWorkCard = document.querySelector('.task-current-work-card');
      if (
        !(refreshButton instanceof HTMLButtonElement) ||
        !(stepsContainer instanceof HTMLElement) ||
        !(messageList instanceof HTMLElement) ||
        !(currentWorkCard instanceof HTMLElement) ||
        !(detailPane instanceof HTMLElement)
      ) {
        return { ok: false, reason: 'task refresh stability controls missing' };
      }
      const firstStepNode = stepsContainer.firstElementChild;
      const firstMessageNode = messageList.firstElementChild;
      const detailRectBefore = detailPane.getBoundingClientRect();
      const conversationRectBefore = conversation.getBoundingClientRect();
      const messageScrollBefore = messageList.scrollTop;
      let childListMutationCount = 0;
      const mutationObserver = new MutationObserver((records) => {
        childListMutationCount += records.filter((record) => record.type === 'childList').length;
      });
      mutationObserver.observe(stepsContainer, { childList: true });
      mutationObserver.observe(messageList, { childList: true });
      refreshButton.click();
      await new Promise((resolve) => setTimeout(resolve, 400));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      mutationObserver.disconnect();
      const detailRectAfter = detailPane.getBoundingClientRect();
      const conversationRectAfter = conversation.getBoundingClientRect();
      const stableRefreshChecks = {
        stepNodePreserved: stepsContainer.firstElementChild === firstStepNode,
        messageNodePreserved: messageList.firstElementChild === firstMessageNode,
        childListMutationCount,
        detailTopDelta: Math.abs(detailRectAfter.top - detailRectBefore.top),
        detailHeightDelta: Math.abs(detailRectAfter.height - detailRectBefore.height),
        conversationTopDelta: Math.abs(conversationRectAfter.top - conversationRectBefore.top),
        conversationHeightDelta: Math.abs(conversationRectAfter.height - conversationRectBefore.height),
        messageScrollBefore,
        messageScrollAfter: messageList.scrollTop,
      };
      const stableRefresh =
        stableRefreshChecks.stepNodePreserved &&
        stableRefreshChecks.messageNodePreserved &&
        stableRefreshChecks.childListMutationCount === 0 &&
        stableRefreshChecks.detailTopDelta < 0.5 &&
        stableRefreshChecks.detailHeightDelta < 0.5 &&
        stableRefreshChecks.conversationTopDelta < 0.5 &&
        stableRefreshChecks.conversationHeightDelta < 0.5 &&
        stableRefreshChecks.messageScrollAfter === stableRefreshChecks.messageScrollBefore;

      const input = document.querySelector('#task-message-input');
      const form = document.querySelector('#task-message-form');
      if (!(input instanceof HTMLTextAreaElement) || !(form instanceof HTMLFormElement)) {
        return { ok: false, reason: 'task conversation form missing' };
      }
      const firstDraft = 'Draft for the task hub Agent';
      input.value = firstDraft;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#task-detail-back')?.click();
      await waitFor(() => document.querySelector('#task-detail-pane')?.hidden === true);
      releaseTask.click();
      await waitFor(() =>
        document.querySelector('#task-detail-title')?.textContent?.trim() === 'Package and verify the next desktop release'
      );
      const isolatedDraft = input.value === '';
      input.value = 'Draft for the release Agent';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#task-detail-back')?.click();
      await waitFor(() => document.querySelector('#task-detail-pane')?.hidden === true);
      firstTask.click();
      await waitFor(() =>
        document.querySelector('#task-detail-title')?.textContent?.trim() === 'Build task and Agent hub'
      );
      const restoredDraft = input.value === firstDraft;
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));

      const userMessage = 'Continue autonomously and publish the final validation status.';
      input.value = userMessage;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      form.requestSubmit();
      await waitFor(() =>
        Array.from(document.querySelectorAll('#task-message-list .task-message-user p'))
          .some((element) => element.textContent?.trim() === userMessage) &&
        !input.disabled &&
        form.getAttribute('aria-busy') !== 'true'
      );
      const latestUserMessage = Array.from(
        document.querySelectorAll('#task-message-list .task-message-user'),
      ).at(-1);
      const conversationWorks =
        input.value === '' &&
        Array.from(document.querySelectorAll('#task-message-list .task-message-user p'))
          .some((element) => element.textContent?.trim() === userMessage) &&
        document.querySelector('#task-conversation-delivery')?.textContent?.trim() === 'Saved · waiting for Agent' &&
        latestUserMessage?.querySelector('.task-message-delivery')?.textContent?.trim() === 'Waiting for Agent';
      const sourceMessage = 'Status';
      input.value = sourceMessage;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      form.requestSubmit();
      await waitFor(() =>
        Array.from(document.querySelectorAll('#task-message-list .task-message-user p'))
          .some((element) => element.textContent?.trim() === sourceMessage) &&
        !input.disabled &&
        form.getAttribute('aria-busy') !== 'true'
      );

      const language = document.querySelector('#ui-language');
      if (!(language instanceof HTMLSelectElement)) {
        return { ok: false, reason: 'language selector missing' };
      }
      input.value = 'Status';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const draftBeforeLanguageChange = input.value;
      language.value = 'zh-CN';
      language.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const chineseDetail =
        document.querySelector('#task-conversation-title')?.textContent?.trim() === '与 Agent 交流' &&
        input.placeholder === '发送消息给 Agent…' &&
        document.querySelector('#task-message-send')?.textContent?.trim() === '发送消息' &&
        document.querySelector('#task-detail-status')?.textContent?.trim() === '运行中' &&
        document.querySelector('#task-detail-board-state')?.textContent?.trim() === '运行中' &&
        document.querySelector('#task-detail-recorded-status')?.textContent?.trim() === '运行中' &&
        document.querySelector('#task-detail-trust')?.textContent?.trim() === '最近一次 Agent 心跳正常。' &&
        document.querySelector('#task-detail-agent-presence')?.textContent?.trim() === 'Agent 在线' &&
        document.querySelector('#task-session-continuity-title')?.textContent?.trim() === '任务上下文可继续' &&
        document.querySelector('#task-session-continuity-next')?.textContent?.includes('不会自动复制') === true;
      const draftInChinese = input.value;
      const placeholderInChinese = input.placeholder;
      const conversationContentSnapshot = Array.from(
        document.querySelectorAll('#task-message-list .task-message-user p'),
      ).map((element) => ({
        text: element.textContent?.trim() ?? '',
        noI18n: element.hasAttribute('data-no-i18n'),
      }));
      const conversationContentPreserved = conversationContentSnapshot.some(
        (message) => message.text === sourceMessage && message.noI18n,
      );
      language.value = 'en';
      language.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const languageDraftPreserved = draftBeforeLanguageChange === 'Status' && draftInChinese === 'Status' && input.value === 'Status';
      const languageInputChecks = { draftBeforeLanguageChange, draftInChinese, draftAfterEnglish: input.value,
        placeholderInChinese, placeholderAfterEnglish: input.placeholder };
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));

      const back = document.querySelector('#task-detail-back');
      if (!(back instanceof HTMLButtonElement)) {
        return { ok: false, reason: 'task back button missing' };
      }
      document.querySelector('#task-project-grid [data-task-id="task-visual-release"]')?.focus();
      back.click();
      await waitFor(() =>
        document.querySelector('#task-detail-pane')?.hidden === true &&
        document.activeElement?.getAttribute('data-task-id') === 'task-visual-agent-hub'
      );
      const explicitFocusRestored =
        document.activeElement?.getAttribute('data-task-id') === 'task-visual-agent-hub';
      const explicitFocusEvidence = { activeId: document.activeElement?.id, activeTag: document.activeElement?.tagName,
        activeTask: document.activeElement?.getAttribute('data-task-id'), detailHidden: document.querySelector('#task-detail-pane')?.hidden,
        activeConnected: document.activeElement?.isConnected, expectedCardConnected: document.querySelector('#task-project-grid [data-task-id="task-visual-agent-hub"]')?.isConnected,
        selectedTaskIds: taskCards().filter((card) => card.getAttribute('aria-current') === 'true').map((card) => card.dataset.taskId),
        availableTaskIds: taskCards().map((card) => card.dataset.taskId) };
      const attentionSelected = await selectLane('attention', 1, 1);
      const attentionTask = document.querySelector('#task-project-grid [data-task-id="task-visual-sample-clipboard"]');
      const attentionQueue =
        attentionSelected && attentionTask instanceof HTMLButtonElement &&
        attentionTask.dataset.boardLane === 'attention' &&
        attentionTask.classList.contains('task-board-state-blocked') &&
        attentionTask.querySelector('.task-summary-reliability')?.textContent?.includes('needs review before it can continue') === true &&
        getComputedStyle(attentionTask.querySelector('.task-summary-reliability')).display !== 'none' &&
        document.querySelector('#task-board-view-title')?.textContent?.trim() === 'Needs action';

      const historySelected = await selectLane('history', 0, 0);
      const deferredGroupingAbsent =
        document.querySelector('#task-project-grid .task-deferred-group') === null &&
        document.querySelector('#task-project-grid .task-secondary-record') === null;
      const historyQueue =
        historySelected && taskCards().length === 0 &&
        document.querySelector('#task-project-grid [data-task-id="task-visual-sample-clipboard"]') === null &&
        document.querySelector('#task-project-grid .task-hub-empty')?.textContent?.includes('No task history') === true &&
        document.querySelector('#task-board-view-title')?.textContent?.trim() === 'History' &&
        deferredGroupingAbsent;

      const allSelected = await selectLane('all', 2, 4);
      const allQueue =
        allSelected &&
        document.querySelector('#task-board-view-title')?.textContent?.trim() === 'All records' &&
        projectCards().length === 2 &&
        taskCards().length === 4 &&
        document.querySelector('#task-project-grid [data-task-id="task-visual-inferred"]') instanceof HTMLButtonElement &&
        document.querySelector('#task-project-grid [data-task-id="task-visual-sample-clipboard"]') instanceof HTMLButtonElement &&
        document.querySelector('#task-project-grid .task-deferred-group') === null &&
        document.querySelector('#task-project-grid .task-secondary-record') === null;

      const finalCurrent = await selectLane('current', 1, 2);

      return {
        ok: projectFilterNavigation && queueNavigation && projectBlocks && firstTaskOnScreen && scanLineLayout && restrainedLaneSelection && singleFocusLayer && currentQueueSemantics && compactProgress && inferredSemantics && inferredDetail && inferredContinuity && inferredFocusRestored && currentQueueRestored && detailRaceSafe && historyPagination && detailsAccessible && detailRendered && continuityRendered && stableRefresh && isolatedDraft && restoredDraft && conversationWorks && conversationContentPreserved && chineseDetail && languageDraftPreserved && explicitFocusRestored && attentionQueue && historyQueue && deferredGroupingAbsent && allQueue && finalCurrent,
        projectFilterNavigation,
        projectFilterInitialChecks,
        singleProjectFilter,
        projectFilterRestored,
        queueNavigation,
        projectBlocks,
        firstTaskOnScreen,
        historyPagination,
        historyAnchorDelta,
        historyGeometryBefore,
        historyGeometryAfter,
        detailsAccessible,
        scanLineLayout,
        readableRows,
        restrainedLaneSelection,
        currentCardWidths: currentCardRects.map((rect) => rect.width),
        currentCardHeights: currentCardRects.map((rect) => rect.height),
        currentLaneBackgroundImage: currentLaneStyle.backgroundImage,
        currentLaneBoxShadow: currentLaneStyle.boxShadow,
        singleFocusLayer,
        focusStyle: { visible:search.matches(':focus-visible'), outline:searchStyle.outlineStyle, width:searchStyle.outlineWidth, shadow:searchStyle.boxShadow },
        currentQueueSemantics,
        compactProgress,
        currentQueueChecks,
        inferredSemantics,
        inferredDetail,
        inferredContinuity,
        inferredFocusRestored,
        currentQueueRestored,
        currentRestoreChecks,
        detailRaceSafe,
        detailRendered,
        continuityRendered,
        stableRefresh,
        stableRefreshChecks,
        isolatedDraft,
        restoredDraft,
        conversationWorks,
        conversationContentPreserved,
        conversationContentSnapshot,
        chineseDetail,
        languageDraftPreserved,
        languageInputChecks,
        explicitFocusRestored,
        explicitFocusEvidence,
        attentionQueue,
        historyQueue,
        deferredGroupingAbsent,
        allQueue,
        finalCurrent,
        projectCount: projectCards().length,
        taskCount: taskCards().length,
        firstProjectHeight,
        firstProjectWidth,
        firstProjectDisplay,
        conversationWidth,
      };
    })()`,
    true,
  ) as { readonly ok: boolean; readonly [key: string]: unknown };
  return result;
}
