import { h } from "./dom";

/** A tab on the options page. Later stages add "Resume import" and "Metrics" by appending to the list in index.ts. */
export interface OptionsSection {
  id: string;
  title: string;
  mount(panel: HTMLElement): void | Promise<void>;
}

/** Fired on a panel each time its tab is opened, so a section can refresh what it shows. */
export const SECTION_SHOWN = "ghost:section-shown";

function select(id: string, tabs: HTMLElement[], panels: HTMLElement[]): void {
  for (const tab of tabs) tab.setAttribute("aria-selected", String(tab.dataset.section === id));
  for (const panel of panels) {
    panel.hidden = panel.dataset.section !== id;
    if (!panel.hidden) panel.dispatchEvent(new CustomEvent(SECTION_SHOWN));
  }
}

export async function mountSections(nav: HTMLElement, host: HTMLElement, sections: OptionsSection[]): Promise<void> {
  const tabs: HTMLElement[] = [];
  const panels: HTMLElement[] = [];
  for (const section of sections) {
    const tab = h("button", { type: "button", role: "tab", class: "tab", "data-section": section.id, "data-testid": `tab-${section.id}` }, section.title);
    const panel = h("section", { role: "tabpanel", class: "panel", "data-section": section.id, "aria-label": section.title });
    tab.addEventListener("click", () => {
      select(section.id, tabs, panels);
      history.replaceState(null, "", `#${section.id}`);
    });
    tabs.push(tab);
    panels.push(panel);
  }
  nav.append(...tabs);
  host.append(...panels);
  const fromHash = location.hash.slice(1);
  const initial = sections.find((s) => s.id === fromHash) ?? sections[0];
  if (initial) select(initial.id, tabs, panels);
  await Promise.all(sections.map((section, i) => section.mount(panels[i] as HTMLElement)));
}
