// Minimal in-process queue: the HTTP request returns immediately and searches run here with bounded concurrency.
// Searches left running when the process stops are marked "interrupted" on the next start (see server.js).
export function createJobQueue({ concurrency = 2, logger }) {
  const pending = [];
  let active = 0;

  function drain() {
    while (active < concurrency && pending.length) {
      const { name, task } = pending.shift();
      active += 1;
      Promise.resolve()
        .then(task)
        .catch((error) => logger.error({ job: name, err: error.message }, 'job crashed'))
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  return {
    enqueue(name, task) {
      pending.push({ name, task });
      drain();
    },
    get size() {
      return { active, pending: pending.length };
    },
  };
}
