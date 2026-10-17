/** Keep scrolling locked until every layered dialog has released its lock. */
const locks = new WeakMap<HTMLElement, { count: number; overflow: string }>();

export function lockBodyScroll(): () => void {
  const body = document.body;
  let state = locks.get(body);
  if (!state) {
    state = { count: 0, overflow: body.style.overflow };
    locks.set(body, state);
  }
  state.count += 1;
  body.style.overflow = "hidden";
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.count -= 1;
    if (state.count === 0) {
      body.style.overflow = state.overflow;
      locks.delete(body);
    }
  };
}
