import type { BrowserWindow } from "electron";

type ActivateView = (window: BrowserWindow, view: string) => Promise<void>;

const delay = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function verifyAgentConnectionSurface(
  window: BrowserWindow,
  activateView: ActivateView,
): Promise<void> {
  await activateView(window, "agent");
  await delay(100);
  const permissionResult = (await window.webContents.executeJavaScript(
    `(async () => {
      const nextFrame = () => new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      );
      const language = document.querySelector('#ui-language');
      const view = document.querySelector('#view-agent');
      const statusStrip = document.querySelector('.agent-status-strip-compact');
      const sessionBadge = document.querySelector('#web-session-badge');
      const group = document.querySelector('#web-permission-profiles');
      const tiles = Array.from(group?.querySelectorAll('button') ?? []);
      const selected = tiles.find((tile) => tile.getAttribute('aria-pressed') === 'true');
      const advanced = Array.from(document.querySelectorAll('#view-agent details.agent-advanced'));
      const primaryInputs = Array.from(
        document.querySelectorAll('#view-agent .agent-field-grid-primary .agent-input')
      );
      const runtimeKeyInput = document.querySelector('#secure-tunnel-api-key');
      const runtimeKeyStorage = document.querySelector('#secure-tunnel-key-storage');
      const proxyStorage = document.querySelector('#secure-tunnel-proxy-storage');
      const backupStorage = document.querySelector('#secure-tunnel-backup-proxy-storage');
      const bridgeStatus = document.querySelector('#web-bridge-status');
      const connectionTarget = document.querySelector('#web-connection-target');
      const routeDetail = document.querySelector('#secure-tunnel-route-detail');
      const instructions = document.querySelector('#secure-tunnel-instructions');
      const tunnelStatus = document.querySelector('#secure-tunnel-status');
      const gatewayStatus = document.querySelector('#web-agent-gateway');
      const clientStatus = document.querySelector('#web-agent-client');
      const startButton = document.querySelector('#secure-tunnel-start');
      if (
        !(language instanceof HTMLSelectElement) ||
        !(view instanceof HTMLElement) ||
        !(statusStrip instanceof HTMLElement) ||
        !(sessionBadge instanceof HTMLElement) ||
        !(group instanceof HTMLElement) ||
        !(selected instanceof HTMLButtonElement) ||
        !(runtimeKeyInput instanceof HTMLInputElement) ||
        !(runtimeKeyStorage instanceof HTMLElement) ||
        !(proxyStorage instanceof HTMLElement) ||
        !(backupStorage instanceof HTMLElement) ||
        !(bridgeStatus instanceof HTMLElement) ||
        !(connectionTarget instanceof HTMLElement) ||
        !(routeDetail instanceof HTMLElement) ||
        !(instructions instanceof HTMLElement) ||
        !(tunnelStatus instanceof HTMLElement) ||
        !(gatewayStatus instanceof HTMLElement) ||
        !(clientStatus instanceof HTMLElement) ||
        !(startButton instanceof HTMLButtonElement)
      ) {
        return { ok: false, reason: 'connection view controls missing' };
      }

      const groupStyle = getComputedStyle(group);
      const tileStyles = tiles.map((tile) => getComputedStyle(tile));
      const tileRects = tiles.map((tile) => tile.getBoundingClientRect());
      const selectedStyle = getComputedStyle(selected);
      const visibleStatusItems = Array.from(
        statusStrip.querySelectorAll('.agent-status-item')
      ).filter((item) =>
        item instanceof HTMLElement && getComputedStyle(item).display !== 'none'
      );
      const statusHeight = statusStrip.getBoundingClientRect().height;
      const statusRects = visibleStatusItems.map((item) => item.getBoundingClientRect());
      const statusLabels = visibleStatusItems.map((item) =>
        item.querySelector('span')?.textContent?.trim(),
      );
      const statusTextFits = visibleStatusItems.every((item) => {
        const value = item.querySelector('strong');
        return (
          value instanceof HTMLElement &&
          value.scrollWidth <= value.clientWidth + 1 &&
          value.scrollHeight <= value.clientHeight + 1
        );
      });
      const hiddenSessionStatus =
        sessionBadge.parentElement?.classList.contains('visually-hidden') === true &&
        sessionBadge.parentElement?.getAttribute('aria-live') === 'polite';
      const inputHeights = primaryInputs.map((input) => input.getBoundingClientRect().height);
      const isVisibleInside = (element, container) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility === 'visible' &&
          Number.parseFloat(style.opacity) > 0 &&
          rect.width > 0 && rect.height > 0 &&
          rect.left >= container.left - 1 && rect.right <= container.right + 1 &&
          rect.top >= container.top - 1 && rect.bottom <= container.bottom + 1 &&
          element.scrollWidth <= element.clientWidth + 1 &&
          element.scrollHeight <= element.clientHeight + 1
        );
      };
      const permissionContents = tiles.map((tile, index) => {
        const title = tile.querySelector('.permission-profile-title');
        const description = tile.querySelector('.permission-profile-description');
        const level = tile.querySelector('.permission-profile-level');
        const indicator = tile.querySelector('.permission-profile-indicator');
        return {
          title: title?.textContent?.trim(),
          description: description?.textContent?.trim(),
          level: level?.textContent?.trim(),
          visible: [title, description, level, indicator].every((element) =>
            isVisibleInside(element, tileRects[index])
          ),
          indicatorDecorative: indicator?.getAttribute('aria-hidden') === 'true',
        };
      });
      const permissionsDoNotOverlap = tileRects.every((rect, index) =>
        tileRects.slice(index + 1).every((other) =>
          rect.right <= other.left + 1 || other.right <= rect.left + 1 ||
          rect.bottom <= other.top + 1 || other.bottom <= rect.top + 1
        )
      );
      const permissionTwoColumns = tileRects.length === 4 &&
        Math.abs(tileRects[0].top - tileRects[1].top) < 2 &&
        Math.abs(tileRects[2].top - tileRects[3].top) < 2 &&
        Math.abs(tileRects[0].left - tileRects[2].left) < 2 &&
        Math.abs(tileRects[1].left - tileRects[3].left) < 2 &&
        tileRects[1].left > tileRects[0].right &&
        tileRects[2].top > tileRects[0].bottom;
      const selectedPermissionVisible =
        tiles.filter((tile) => tile.getAttribute('aria-pressed') === 'true').length === 1 &&
        (
          (Number.parseFloat(selectedStyle.outlineWidth) > 0 &&
            selectedStyle.outlineStyle !== 'none') ||
          (Number.parseFloat(selectedStyle.borderTopWidth) > 0 &&
            selectedStyle.borderTopStyle !== 'none' &&
            tileStyles.some((style, index) =>
              tiles[index] !== selected &&
              style.borderTopColor !== selectedStyle.borderTopColor
            ))
        );
      const clearPermissions =
        tiles.length === 4 &&
        Math.max(...tileRects.map((rect) => rect.width)) -
          Math.min(...tileRects.map((rect) => rect.width)) < 2 &&
        Math.min(...tileRects.map((rect) => rect.height)) >= 44 &&
        permissionsDoNotOverlap &&
        permissionTwoColumns &&
        permissionContents.every((content, index) =>
          content.title && content.description &&
          content.level?.startsWith('L' + (index + 1) + ' · ') &&
          content.visible && content.indicatorDecorative
        ) &&
        selectedPermissionVisible;
      const compactStatus =
        statusHeight >= Math.max(...statusRects.map((rect) => rect.height)) + 8 &&
        statusHeight <= 72 &&
        visibleStatusItems.length === 2 &&
        statusRects.length === 2 &&
        Math.abs(statusRects[0].width - statusRects[1].width) < 2 &&
        statusRects.every((rect) => rect.height <= statusHeight + 1) &&
        statusLabels.join('|') === 'Host|ChatGPT' &&
        statusTextFits &&
        document.querySelector('.agent-status-item-redundant') === null &&
        hiddenSessionStatus;
      const convergedStructure =
        advanced.length === 1 &&
        advanced[0]?.querySelector('summary')?.textContent?.trim() ===
          'Advanced connection options' &&
        advanced[0]?.querySelector('.agent-local-connection-options') instanceof HTMLElement &&
        document.querySelectorAll(
          '#view-agent .agent-authority-section, #view-agent .agent-connect-section'
        ).length === 2 &&
        inputHeights.length === 2 &&
        inputHeights.every((height) => height >= 29 && height <= 36);

      language.value = 'zh-CN';
      language.dispatchEvent(new Event('change', { bubbles: true }));
      await nextFrame();
      const routeDisplays = Array.from(
        document.querySelectorAll('#secure-tunnel-route-list .agent-route-row div span')
      ).map((element) => element.textContent?.trim());
      const englishLeaks = [
        'Saved with Windows DPAPI',
        'Available for this session only',
        'Advanced connection options',
        'ChatGPT permissions',
        'Start connection',
      ].filter((value) => view.textContent?.includes(value));
      const localized =
        document.documentElement.lang === 'zh-CN' &&
        document.querySelector('.agent-authority-heading h2')?.textContent?.trim() ===
          'ChatGPT 权限' &&
        document.querySelector('.agent-section-heading h2')?.textContent?.trim() ===
          '安全 MCP 隧道' &&
        advanced[0]?.querySelector('summary')?.textContent?.trim() === '高级连接选项' &&
        startButton.textContent?.trim() === '启动连接' &&
        runtimeKeyInput.placeholder === '已安全保存 · 留空即可复用' &&
        runtimeKeyStorage.textContent?.trim() ===
          '已使用 Windows DPAPI 保存 · 此字段留空即可在重启后复用。' &&
        proxyStorage.textContent?.trim() ===
          '已使用 Windows DPAPI 保存 · http://proxy.example.test:8080。仅 OpenAI 控制平面请求使用此代理；本机 MCP 保持直连。' &&
        backupStorage.textContent?.trim() ===
          '已使用 Windows DPAPI 保存 · https://backup-proxy.example.test:8443。请尽可能使用独立服务或独立出口。' &&
        bridgeStatus.textContent?.trim() ===
          '已保存网桥 · https://sovereign.example.test/mcp' &&
        connectionTarget.textContent?.trim() ===
          '安全 MCP 隧道已就绪；请在 ChatGPT 中使用其 Tunnel ID。此连接包仍用于本机或备用连接。' &&
        routeDetail.textContent?.trim() ===
          '主要代理 · http://proxy.example.test:8080 · 已切换 0 次。' &&
        routeDisplays.join('|') ===
          '主要代理 · http://proxy.example.test:8080|备用代理 · https://backup-proxy.example.test:8443|直连回退' &&
        instructions.textContent?.trim() === 'ChatGPT 已连接。' &&
        tunnelStatus.textContent?.trim() === '隧道已就绪' &&
        gatewayStatus.textContent?.trim() === '主机在线' &&
        clientStatus.textContent?.trim() === 'ChatGPT 已连接 · 2' &&
        englishLeaks.length === 0;

      language.value = 'en';
      language.dispatchEvent(new Event('change', { bubbles: true }));
      await nextFrame();
      const restoredEnglish =
        document.documentElement.lang === 'en' &&
        document.querySelector('.agent-authority-heading h2')?.textContent?.trim() ===
          'ChatGPT permissions' &&
        advanced[0]?.querySelector('summary')?.textContent?.trim() ===
          'Advanced connection options' &&
        runtimeKeyInput.placeholder === 'Saved securely · leave blank to reuse' &&
        runtimeKeyStorage.textContent?.trim() ===
          'Saved with Windows DPAPI · leave this field blank to reuse it after restart.' &&
        routeDetail.textContent?.trim() ===
          'Primary proxy · http://proxy.example.test:8080 · 0 switches.';

      return {
        ok:
          clearPermissions &&
          compactStatus &&
          convergedStructure &&
          localized &&
          restoredEnglish,
        clearPermissions,
        permissionContents,
        permissionsDoNotOverlap,
        permissionTwoColumns,
        selectedPermissionVisible,
        compactStatus,
        convergedStructure,
        localized,
        restoredEnglish,
        groupGap: groupStyle.columnGap,
        groupBorder: groupStyle.borderTopWidth,
        groupBackground: groupStyle.backgroundColor,
        tileWidths: tileRects.map((rect) => rect.width),
        tileHeights: tileRects.map((rect) => rect.height),
        tileBackgrounds: tileStyles.map((style) => style.backgroundColor),
        tileRadii: tileStyles.map((style) => style.borderTopLeftRadius),
        selectedBackground: selectedStyle.backgroundColor,
        selectedBoxShadow: selectedStyle.boxShadow,
        statusHeight,
        statusRects: statusRects.map((rect) => ({ width: rect.width, height: rect.height })),
        visibleStatusItems: visibleStatusItems.length,
        statusLabels,
        statusTextFits,
        hiddenSessionStatus,
        advancedCount: advanced.length,
        inputHeights,
        englishLeaks,
        routeDisplays,
        proxyStorage: proxyStorage.textContent?.trim(),
        routeDetail: routeDetail.textContent?.trim(),
      };
    })()`,
    true,
  )) as Readonly<Record<string, unknown>> & { readonly ok: boolean };
  if (!permissionResult.ok) {
    throw new Error(
      `Connection view convergence failed: ${JSON.stringify(permissionResult)}`,
    );
  }
}
