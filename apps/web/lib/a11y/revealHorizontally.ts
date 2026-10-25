/** Reveal a chip inside its own strip without scrolling any ancestor/page. */
export function revealHorizontally(container: HTMLElement, item: HTMLElement): void {
  if (container.scrollWidth <= container.clientWidth + 1) return;
  const bounds = container.getBoundingClientRect();
  const target = item.getBoundingClientRect();
  const left = bounds.left + container.clientLeft;
  const right = left + container.clientWidth;
  const delta = target.left < left ? target.left - left : target.right > right ? target.right - right : 0;
  if (delta) container.scrollLeft += delta;
}
