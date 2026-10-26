/** Dismissal layers and modal Tab domains share ownership, not behavior. */
export type FocusScope = {
  root: HTMLElement;
  trapFocus: boolean;
  previous: Element | null;
  owner: FocusScope | null;
};
const scopes: FocusScope[] = [];
const topScope = (trappingOnly = false) => scopes.findLast(scope => scope.root.isConnected && (!trappingOnly || scope.trapFocus));
const SELECTOR = ["a[href]", "button:not([disabled])", "input:not([disabled])", "select:not([disabled])", "textarea:not([disabled])", "summary", "[tabindex]:not([tabindex='-1'])"].join(",");

function visibleInScope(element: HTMLElement, root: HTMLElement): boolean {
  if (element.hasAttribute("data-focus-trap-skip") || element.tabIndex < 0 || element.matches(":disabled") || element.closest("[hidden],[inert],[aria-hidden='true']")) return false;
  for (let node: HTMLElement | null = element; node && node !== root.parentElement; node = node.parentElement) {
    if (node.tagName === "DETAILS" && !node.hasAttribute("open")) {
      const summary = Array.from(node.children).find(child => child.tagName === "SUMMARY");
      if (!summary?.contains(element)) return false;
    }
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

export function focusableInside(root: HTMLElement | null): HTMLElement[] {
  return root ? Array.from(root.querySelectorAll<HTMLElement>(SELECTOR)).filter(element => visibleInScope(element, root)) : [];
}

function ownedBy(scope: FocusScope, parent: FocusScope): boolean {
  for (let owner = scope.owner; owner; owner = owner.owner) if (owner === parent) return true;
  return false;
}

function tabDomain(scope: FocusScope): FocusScope[] {
  return [scope, ...scopes.filter(child => child.root.isConnected && !child.trapFocus && ownedBy(child, scope))];
}

export function registerFocusScope(root: HTMLElement, trapFocus: boolean, previous: Element | null): FocusScope {
  const owner = scopes.findLast(scope => previous && scope.root.contains(previous)) ?? null;
  const scope = { root, trapFocus, previous, owner };
  scopes.push(scope);
  return scope;
}

/** Transfer a disappearing parent's return target before children clean up. */
export function removeFocusScope(scope: FocusScope): boolean {
  const wasTop = scopes.at(-1) === scope;
  const index = scopes.lastIndexOf(scope);
  if (index >= 0) scopes.splice(index, 1);
  for (const remaining of scopes) {
    if (remaining.previous && scope.root.contains(remaining.previous)) remaining.previous = scope.previous;
    if (remaining.owner === scope) remaining.owner = scope.owner;
  }
  return wasTop;
}

export function isTopFocusLayer(root: HTMLElement | null): boolean {
  return !!root && topScope()?.root === root;
}

export function canReturnFocus(target: HTMLElement): boolean {
  const trapping = topScope(true);
  return !trapping || tabDomain(trapping).some(member => member.root.contains(target));
}

export function isFocusTrapRoot(target: Element | null): boolean {
  return scopes.some(scope => scope.trapFocus && scope.root === target);
}

function tabStops(elements: HTMLElement[]): HTMLElement[] {
  // Native Tab visits the checked member of a named radio group (or one
  // eligible member when no selection exists); arrow keys still select it.
  const radios = elements.filter((element): element is HTMLInputElement => element instanceof HTMLInputElement && element.type === "radio" && !!element.name);
  return elements.filter(element => {
    if (!radios.includes(element as HTMLInputElement)) return true;
    const radio = element as HTMLInputElement;
    const group = radios.filter(member => member.name === radio.name && member.form === radio.form);
    return radio === (group.find(member => member.checked) ?? group[0]);
  }).map((element, index) => ({ element, index })).sort((a, b) => {
    const priorityA = a.element.tabIndex > 0 ? a.element.tabIndex : Infinity;
    const priorityB = b.element.tabIndex > 0 ? b.element.tabIndex : Infinity;
    return priorityA - priorityB || a.index - b.index;
  }).map(item => item.element);
}

function activeDialog(event: KeyboardEvent): Element | null {
  const target = event.target instanceof Element ? event.target : document.activeElement;
  return target?.closest('[role="dialog"]') ?? null;
}

function trapTab(scope: FocusScope, event: KeyboardEvent): void {
  if (!scope.trapFocus || topScope(true) !== scope) return;
  const dialog = activeDialog(event);
  const domain = tabDomain(scope);
  // Unknown/custom child dialogs retain their own keyboard behavior. Known
  // nonmodal descendants belong to this Tab domain, including outside portals.
  if (dialog && !domain.some(member => member.root === dialog)) return;
  const elements = tabStops([...new Set(domain.flatMap(member => focusableInside(member.root)))]);
  if (!elements.length) { event.preventDefault(); scope.root.focus(); return; }
  const active = document.activeElement;
  const hasOutsidePortal = domain.some(member => !scope.root.contains(member.root));
  if (!hasOutsidePortal) {
    const inside = active instanceof Node && scope.root.contains(active);
    if (event.shiftKey && (active === elements[0] || !inside)) {
      event.preventDefault(); elements.at(-1)!.focus();
    } else if (!event.shiftKey && (active === elements.at(-1) || !inside)) {
      event.preventDefault(); elements[0].focus();
    }
    return;
  }
  // Browser Tab order cannot bridge a logical child portal that lives before
  // its modal (or across unrelated controls). Own the full ordered traversal.
  const index = elements.indexOf(active as HTMLElement);
  const next = index < 0 ? (event.shiftKey ? elements.length - 1 : 0)
    : (index + (event.shiftKey ? -1 : 1) + elements.length) % elements.length;
  event.preventDefault(); elements[next].focus();
}

export function handleFocusScopeKey(scope: FocusScope, event: KeyboardEvent, onClose: () => void): void {
  if (event.defaultPrevented) return;
  if (event.key === "Tab") { trapTab(scope, event); return; }
  if (event.key !== "Escape" || topScope() !== scope) return;
  const dialog = activeDialog(event);
  if (dialog && dialog !== scope.root && !scopes.some(member => member.root === dialog)) return;
  event.preventDefault(); event.stopPropagation(); onClose();
}
