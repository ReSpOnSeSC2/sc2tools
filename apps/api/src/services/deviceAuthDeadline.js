"use strict";

/** The actual task remains its owner's responsibility after this caller times
 * out. A timer never renews a grant or polls in the background.
 * @template T @param {Promise<T>} task @param {number} deadline
 * @param {()=>number|null} now @param {()=>void} expire @returns {Promise<T|null>} */
function beforeDeviceAuthDeadline(task, deadline, now, expire) {
  const start = now();
  if (start === null || start >= deadline) { expire(); return Promise.resolve(null); }
  return new Promise(resolve => {
    let done = false;
    /** @type {NodeJS.Timeout|undefined} */ let timer;
    /** @param {T|null} value */
    const finish = value => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    timer = setTimeout(() => { expire(); finish(null); }, Math.max(1, deadline - start));
    void task.then(value => {
      const current = now();
      if (current === null || current >= deadline) { expire(); finish(null); }
      else finish(value);
    }, () => finish(null));
  });
}

module.exports = { beforeDeviceAuthDeadline };
