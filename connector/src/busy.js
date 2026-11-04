// KEEP_BUSY worker: keeps roughly BUSY_PERCENT (default 25) of one CPU busy in short bursts so that Oracle does not reclaim
// an "idle" Always Free VM (CPU 95th percentile < 20 % for 7 days). Runs as its own low-priority process (nice 19).

export function busyPlan(percent, cycleMs = 1000) {
  const p = Math.min(90, Math.max(1, Number(percent) || 25));
  const busy = Math.round((cycleMs * p) / 100);
  return { busy, idle: cycleMs - busy };
}

export async function run({ percent = process.env.BUSY_PERCENT, cycleMs = 1000, signal } = {}) {
  const plan = busyPlan(percent, cycleMs);
  let x = 1;
  while (!signal || !signal.aborted) {
    // +-20 % jitter so the load does not look like a perfect square wave.
    const j = 0.8 + Math.random() * 0.4;
    const end = performance.now() + plan.busy * j;
    while (performance.now() < end) { x = (x * 1.0000001 + Math.sqrt(x)) % 1e9; }
    await new Promise((r) => setTimeout(r, Math.max(10, plan.idle * j)));
  }
  return x;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.title = 'bikas-busy';
  run();
}
