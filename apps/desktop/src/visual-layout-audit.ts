/**
 * Layout audit executed inside the offscreen renderer. Kept apart from the
 * harness so the audit rules can grow without enlarging visual-test.ts.
 */

export interface LayoutAudit {
  readonly view: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly activeViewIds: readonly string[];
  readonly documentScrollWidth: number;
  readonly documentScrollHeight: number;
  readonly shellBounds: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly width: number;
    readonly height: number;
  } | null;
  readonly outOfViewport: readonly string[];
  readonly duplicateIds: readonly string[];
  readonly clippedText: readonly string[];
  readonly edgeCrowding: readonly string[];
  readonly pageGutter: readonly string[];
  readonly affordance: readonly string[];
  readonly cornerShapeSupported: boolean;
  readonly missingRequiredSelectors: readonly string[];
}

export const layoutAuditScript = String.raw`
((expectedView) => {
  const isVisible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    // A screen-reader-only subtree still lays out, so it has to be excluded by
    // intent rather than by measurement: sighted readers never see any of it.
    const screenReaderOnly = element.closest(".sr-only, .visually-hidden") !== null;
    return !screenReaderOnly && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
  };
  const describe = (element) => {
    const id = element.id ? "#" + element.id : "";
    const classes = Array.from(element.classList).slice(0, 3).map((value) => "." + value).join("");
    const text = (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
    return element.tagName.toLowerCase() + id + classes + (text ? " — " + text : "");
  };

  const activeViews = Array.from(document.querySelectorAll(".view.is-active"));
  const ids = new Map();
  for (const element of document.querySelectorAll("[id]")) {
    const value = element.id;
    ids.set(value, (ids.get(value) || 0) + 1);
  }

  const outOfViewport = [];
  const clippedText = [];
  const edgeCrowding = [];
  for (const element of document.querySelectorAll("body *")) {
    if (!(element instanceof HTMLElement) || !isVisible(element)) continue;
    const rect = element.getBoundingClientRect();
    const intentionallyScrollable =
      element.closest(".table-scroll, .terminal-output, .terminal-session-list, .browser-session-list, .browser-text-output, .browser-element-list, .workflow-template-list, .computer-window-list") !== null ||
      element.closest(".content-scroll") === element;
    if (!intentionallyScrollable && (rect.left < -1 || rect.right > window.innerWidth + 1)) {
      outOfViewport.push(describe(element));
    }

    const text = (element.textContent || "").trim();
    const elementStyle = getComputedStyle(element);
    const intentionalEllipsis =
      element.matches("dd, td, .tool-row strong, .workspace-copy strong, .terminal-session-row strong, .browser-session-row strong, .browser-element-row strong, .browser-element-row div > span, .computer-window-row strong, .workflow-template-card strong, .workflow-template-card span, .workflow-template-card small") ||
      elementStyle.textOverflow === "ellipsis";
    const clipsX = elementStyle.overflowX === "hidden" || elementStyle.overflowX === "clip";
    const clipsY = elementStyle.overflowY === "hidden" || elementStyle.overflowY === "clip";
    if (
      text.length > 0 &&
      element.children.length === 0 &&
      !intentionalEllipsis &&
      ((clipsX && element.scrollWidth > element.clientWidth + 1) ||
        (clipsY && element.scrollHeight > element.clientHeight + 1))
    ) {
      clippedText.push(describe(element));
    }

    const isControl = element.matches('button, a[href], input, textarea, select, [role="button"], [role="tab"]');
    const isTextLeaf = text.length > 0 && element.children.length === 0;
    if (isControl || isTextLeaf) {
      let surface = element.parentElement;
      let surfaceAxes = { x: false, y: false };
      while (surface && surface !== document.body) {
        const surfaceStyle = getComputedStyle(surface);
        const parentBackground = surface.parentElement
          ? getComputedStyle(surface.parentElement).backgroundColor
          : 'rgba(0, 0, 0, 0)';
        // Only an edge the user can see can crowd content, so each axis is
        // judged on its own borders; a painted or rounded box bounds both.
        const boxed =
          parseFloat(surfaceStyle.borderTopLeftRadius) > 0 ||
          (surfaceStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
            surfaceStyle.backgroundColor !== 'transparent' &&
            surfaceStyle.backgroundColor !== parentBackground);
        const boundedX = boxed ||
          parseFloat(surfaceStyle.borderLeftWidth) > 0 ||
          parseFloat(surfaceStyle.borderRightWidth) > 0;
        const boundedY = boxed ||
          parseFloat(surfaceStyle.borderTopWidth) > 0 ||
          parseFloat(surfaceStyle.borderBottomWidth) > 0;
        if (boundedX || boundedY) {
          surfaceAxes = { x: boundedX, y: boundedY };
          break;
        }
        surface = surface.parentElement;
      }
      const editorInternal = element.closest('.cm-editor') !== null;
      if (surface && surface !== document.body && !editorInternal) {
        const surfaceRect = surface.getBoundingClientRect();
        // Distance from the painted boundary to the content, so a control that
        // fills its wrapper but carries its own padding is not a false positive.
        const gapX = Math.round(Math.min(
          rect.left - surfaceRect.left + parseFloat(elementStyle.paddingLeft || '0'),
          surfaceRect.right - rect.right + parseFloat(elementStyle.paddingRight || '0'),
        ));
        const gapY = Math.round(Math.min(
          rect.top - surfaceRect.top + parseFloat(elementStyle.paddingTop || '0'),
          surfaceRect.bottom - rect.bottom + parseFloat(elementStyle.paddingBottom || '0'),
        ));
        // A scrolled surface measures distance to a moving edge, so its axis
        // is not evidence of crowding; a far negative gap is scrolled content.
        let scrollsX = false;
        let scrollsY = false;
        for (let node = element; node && node !== surface.parentElement; node = node.parentElement) {
          scrollsX = scrollsX || node.scrollWidth > node.clientWidth + 1;
          scrollsY = scrollsY || node.scrollHeight > node.clientHeight + 1;
        }
        const report = (axis, gap) => {
          edgeCrowding.push(axis + ' ' + Math.round(gap) + 'px — ' + describe(element) + '  ||in|| ' + describe(surface).slice(0, 44));
        };
        const fillsX = rect.width / Math.max(surfaceRect.width, 1) >= 0.85;
        const fillsY = rect.height / Math.max(surfaceRect.height, 1) >= 0.85;
        if (surfaceAxes.x && !scrollsX && !fillsX && gapX < 16 && gapX > -12 && rect.width > 8 && surfaceRect.width - rect.width > 3) {
          report('x', gapX);
        }
        if (surfaceAxes.y && !scrollsY && !fillsY && gapY < 12 && gapY > -12 && rect.height > 6 && surfaceRect.height - rect.height > 3) {
          report('y', gapY);
        }
      }
    }
  }

  // Whether something can be pressed has to be legible before the click. The
  // cursor is the one part of that a static render can check, so it stands in
  // for the whole affordance: a control without it, or a plain element that
  // borrows it, is a place where action and status have blurred again. Fields
  // carry their own cursors (text, default) and are judged by neither rule.
  const PRESSABLE = 'button, a[href], [role="button"], summary';
  const FIELD = "input, select, textarea, option, optgroup, label";
  const affordance = [];
  for (const element of document.querySelectorAll(".view.is-active *")) {
    if (!(element instanceof HTMLElement) || !isVisible(element)) continue;
    if (element.matches(FIELD) || element.closest(FIELD) !== null) continue;
    const disabled = element.matches(":disabled") || element.getAttribute("aria-disabled") === "true";
    const pointer = getComputedStyle(element).cursor === "pointer";
    if (element.matches(PRESSABLE)) {
      if (!disabled && !pointer) {
        affordance.push("control without a pointer — " + describe(element));
      }
    } else if (pointer && element.closest(PRESSABLE) === null) {
      affordance.push("pointer on a plain element — " + describe(element));
    }
  }

  // Nothing paints the page gutter, so the surface walk above cannot see it.
  // It is the edge the reader actually perceives, so measure it on its own:
  // how close the view's text comes to the scroll pane's inner boundary.
  const pageGutter = [];
  const scroller = document.querySelector(".content-scroll");
  const activeView = document.querySelector(".view.is-active");
  if (scroller instanceof HTMLElement && activeView instanceof HTMLElement) {
    // The scrollbar is reserved outside the padding box and reads as chrome,
    // so both gutters are measured to the pane's own border box.
    const scrollerStyle = getComputedStyle(scroller);
    const scrollerRect = scroller.getBoundingClientRect();
    const paneLeft = scrollerRect.left + parseFloat(scrollerStyle.borderLeftWidth || "0");
    const paneRight = scrollerRect.right - parseFloat(scrollerStyle.borderRightWidth || "0");
    const worst = new Map();
    for (const element of activeView.querySelectorAll("*")) {
      if (!(element instanceof HTMLElement) || !isVisible(element)) continue;
      if (element.children.length > 0 || (element.textContent || "").trim().length === 0) continue;
      if (element.closest(".table-scroll, .terminal-output, .cm-editor") !== null) continue;
      const rect = element.getBoundingClientRect();
      for (const [side, gap] of [["left", rect.left - paneLeft], ["right", paneRight - rect.right]]) {
        const seen = worst.get(side);
        if (seen === undefined || gap < seen.gap) worst.set(side, { gap: gap, element: element });
      }
    }
    for (const [side, entry] of worst) {
      if (entry.gap < 20 && entry.gap > -40) {
        pageGutter.push(side + " " + Math.round(entry.gap) + "px — " + describe(entry.element));
      }
    }
  }

  const requiredSelectors = [
    ".application-shell",
    ".sidebar",
    ".topbar",
    ".content-scroll",
    '.navigation-item[data-view="' + expectedView + '"]',
    "#view-" + expectedView + ".is-active",
    "#global-status-label",
  ];

  const shell = document.querySelector(".application-shell");
  const shellRect = shell?.getBoundingClientRect();
  return {
    view: expectedView,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    activeViewIds: activeViews.map((element) => element.id),
    documentScrollWidth: document.documentElement.scrollWidth,
    documentScrollHeight: document.documentElement.scrollHeight,
    shellBounds: shellRect
      ? {
          left: shellRect.left,
          top: shellRect.top,
          right: shellRect.right,
          bottom: shellRect.bottom,
          width: shellRect.width,
          height: shellRect.height,
        }
      : null,
    outOfViewport: outOfViewport.slice(0, 30),
    duplicateIds: Array.from(ids.entries()).filter(([, count]) => count > 1).map(([id]) => id),
    clippedText: clippedText.slice(0, 30),
    edgeCrowding: edgeCrowding.slice(0, 40),
    pageGutter: pageGutter,
    affordance: affordance.slice(0, 30),
    cornerShapeSupported: CSS.supports('corner-shape', 'squircle'),
    missingRequiredSelectors: requiredSelectors.filter((selector) => document.querySelector(selector) === null),
  };
})
`;
