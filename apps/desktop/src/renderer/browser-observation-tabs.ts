export function mountBrowserObservationTabs(root: ParentNode = document): void {
  const tabs = ["text", "screenshot"].map(name => {
    const button = root.querySelector<HTMLButtonElement>("#browser-" + name + "-tab");
    const panel = root.querySelector<HTMLElement>("#browser-" + name + "-panel");
    if (button === null || panel === null) throw new Error("Browser observation tab is missing.");
    return { button, panel };
  });
  function select(index: number, focus = false): void {
    tabs.forEach(({ button, panel }, candidate) => {
      const active = candidate === index;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      panel.hidden = !active;
      if (active && focus) button.focus();
    });
  }
  tabs.forEach(({ button }, index) => {
    button.addEventListener("click", () => select(index));
    button.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      select(event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + 1) % tabs.length, true);
    });
  });
  select(0);
}
