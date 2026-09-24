import { app } from 'electron';
import os from 'node:os';
import type { ResourceSample } from '../shared/types.js';

/**
 * Machine load, sampled for the toolbar indicators.
 *
 * The question these answer is "can this machine cope with the panes I have running", so
 * they report the whole machine rather than per-process accounting: several Claude
 * sessions compiling at once will show up as system pressure long before any single
 * process looks remarkable.
 */

interface CpuTotals {
  idle: number;
  total: number;
}

function cpuTotals(): CpuTotals {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const [kind, value] of Object.entries(cpu.times)) {
      total += value;
      if (kind === 'idle') idle += value;
    }
  }
  return { idle, total };
}

export class ResourceMonitor {
  private previous = cpuTotals();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly emit: (sample: ResourceSample) => void,
    private readonly runningPanes: () => number,
    private readonly intervalMs = 2000,
  ) {}

  start(): void {
    this.stop();
    this.previous = cpuTotals();
    this.timer = setInterval(() => this.emit(this.sample()), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sample(): ResourceSample {
    const now = cpuTotals();
    const idleDelta = now.idle - this.previous.idle;
    const totalDelta = now.total - this.previous.total;
    this.previous = now;
    // The very first sample has no delta to work from.
    const cpuPercent = totalDelta > 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : 0;

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    // Everything Electron itself is using, which is the part this app is responsible for.
    let appMem = 0;
    try {
      for (const metric of app.getAppMetrics()) appMem += (metric.memory?.workingSetSize ?? 0) * 1024;
    } catch {
      /* metrics are unavailable very early in startup */
    }

    return {
      cpuPercent,
      memPercent: totalMem > 0 ? (usedMem / totalMem) * 100 : 0,
      usedMemBytes: usedMem,
      totalMemBytes: totalMem,
      appMemBytes: appMem,
      cores: os.cpus().length,
      runningPanes: this.runningPanes(),
      at: Date.now(),
    };
  }
}
