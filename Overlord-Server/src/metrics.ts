import os from "node:os";

export interface MetricsSnapshot {
  timestamp: number;
  clients: {
    total: number;
    online: number;
    offline: number;
    byOS: Record<string, number>;
    byCountry: Record<string, number>;
  };
  connections: {
    totalConnections: number;
    totalDisconnections: number;
    activeConnections: number;
  };
  commands: {
    total: number;
    lastMinute: number;
    lastHour: number;
    byType: Record<string, number>;
  };
  sessions: {
    console: number;
    remoteDesktop: number;
    fileBrowser: number;
    process: number;
  };
  bandwidth: {
    sent: number;
    received: number;
    sentPerSecond: number;
    receivedPerSecond: number;
  };
  server: {
    uptime: number;
    startTime: number;
    memoryUsage: NodeJS.MemoryUsage;
    systemMemory: {
      total: number;
      free: number;
      used: number;
      usedPercent: number;
    };
    cpu: {
      cores: number;
      loadAvg: [number, number, number];
    };
  };
  ping: {
    min: number | null;
    max: number | null;
    avg: number | null;
    count: number;
  };
  http: {
    total: number;
    lastMinute: number;
    lastMinuteErrors: number;
    latencyAvg: number;
    latencyP95: number;
    latencyP99: number;
    routes: HttpRouteStats[];
  };
  eventLoop: {
    avg: number;
    max: number;
    p95: number;
    sampleMs: number;
    samples: number;
  };
  internal: {
    tasks: InternalTaskStats[];
  };
  diagnostics?: {
    retained: Record<string, number | boolean>;
  };
}

export interface HttpRouteStats {
  route: string;
  countLastMinute: number;
  errorsLastMinute: number;
  latencyAvg: number;
  latencyP95: number;
  latencyP99: number;
  latencyMax: number;
  lastDuration: number;
  lastStatus: number;
}

export interface InternalTaskStats {
  task: string;
  countLastMinute: number;
  durationAvg: number;
  durationP95: number;
  durationP99: number;
  durationMax: number;
  lastDuration: number;
  lastAt: number;
}

export interface MetricsHistory {
  timestamp: number;
  clientsOnline: number;
  commandsPerMinute: number;
  bandwidthSent: number;
  bandwidthReceived: number;
  httpRequestsPerMinute?: number;
  httpErrorsPerMinute?: number;
  httpLatencyAvg?: number;
  httpLatencyP95?: number;
  httpLatencyP99?: number;
  eventLoopAvg?: number;
  eventLoopP95?: number;
  heapUsed?: number;
  rss?: number;
  systemMemoryUsedPercent?: number;
  activeSessions?: number;
}

interface TimedHttpSample {
  ts: number;
  duration: number;
  statusCode: number;
}

interface TimedInternalTaskSample {
  ts: number;
  duration: number;
}

export const MAX_HTTP_METRIC_ROUTE_KEYS = 512;
const OVERFLOW_HTTP_METRIC_ROUTE = "OTHER high-cardinality routes";

class MetricsCollector {
  private startTime: number = Date.now();

  private totalConnections: number = 0;
  private totalDisconnections: number = 0;

  private commandCount: number = 0;
  private commandTypeCount: Map<string, number> = new Map();
  private commandTimestamps: number[] = [];

  private bytesSent: number = 0;
  private bytesReceived: number = 0;
  private lastBandwidthCheck: number = Date.now();
  private lastBytesSent: number = 0;
  private lastBytesReceived: number = 0;
  private sentPerSecond: number = 0;
  private receivedPerSecond: number = 0;

  private history: MetricsHistory[] = [];
  private maxHistoryPoints: number = 7 * 24 * 60 * 12;
  private snapshotEnricher: ((snapshot: MetricsSnapshot) => void) | null = null;

  private pingValues: number[] = [];
  private maxPingHistory: number = 1000;

  private httpTotal: number = 0;
  private httpTimestamps: number[] = [];
  private httpErrorTimestamps: number[] = [];
  private httpSamples: TimedHttpSample[] = [];
  private httpRouteSamples: Map<string, TimedHttpSample[]> = new Map();
  private maxHttpLatencyHistory: number = 2000;
  private maxHttpRouteSamples: number = 300;
  private ignoredHttpMetricRoutes: Set<string> = new Set(["GET /api/metrics"]);

  private eventLoopDelays: number[] = [];
  private eventLoopSampleMs: number = Math.max(
    20,
    Number(process.env.OVERLORD_EVENT_LOOP_SAMPLE_MS || 100),
  );
  private maxEventLoopHistory: number = Math.max(
    10,
    Math.ceil((Number(process.env.OVERLORD_EVENT_LOOP_HISTORY_SECONDS || 60) * 1000) / this.eventLoopSampleMs),
  );

  private internalTaskSamples: Map<string, TimedInternalTaskSample[]> = new Map();
  private maxInternalTaskSamples: number = 300;

  private pruneTimestampWindow(list: number[], minTs: number): void {
    let removeCount = 0;
    while (removeCount < list.length && list[removeCount] <= minTs) {
      removeCount += 1;
    }
    if (removeCount > 0) {
      list.splice(0, removeCount);
    }
  }

  private countRecent(list: number[], minTs: number): number {
    let count = 0;
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (list[index] <= minTs) {
        break;
      }
      count += 1;
    }
    return count;
  }

  constructor() {
    setInterval(() => this.updateBandwidthRates(), 1000);

    setInterval(() => this.recordHistory(), 5000);

    this.trackEventLoopDelay();
  }

  recordConnection() {
    this.totalConnections++;
  }

  recordDisconnection() {
    this.totalDisconnections++;
  }

  recordCommand(type: string) {
    this.commandCount++;
    const now = Date.now();
    this.commandTimestamps.push(now);

    const count = this.commandTypeCount.get(type) || 0;
    this.commandTypeCount.set(type, count + 1);

    this.pruneTimestampWindow(this.commandTimestamps, now - 3600000);
  }

  recordBytesSent(bytes: number) {
    this.bytesSent += bytes;
  }

  recordBytesReceived(bytes: number) {
    this.bytesReceived += bytes;
  }

  private updateBandwidthRates() {
    const now = Date.now();
    const elapsed = (now - this.lastBandwidthCheck) / 1000;

    if (elapsed > 0) {
      this.sentPerSecond = (this.bytesSent - this.lastBytesSent) / elapsed;
      this.receivedPerSecond =
        (this.bytesReceived - this.lastBytesReceived) / elapsed;

      this.lastBytesSent = this.bytesSent;
      this.lastBytesReceived = this.bytesReceived;
      this.lastBandwidthCheck = now;
    }
  }

  recordPing(pingMs: number) {
    this.pingValues.push(pingMs);

    if (this.pingValues.length > this.maxPingHistory) {
      this.pingValues.shift();
    }
  }

  private getPingStats() {
    if (this.pingValues.length === 0) {
      return { min: null, max: null, avg: null, count: 0 };
    }

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    for (const ping of this.pingValues) {
      if (ping < min) min = ping;
      if (ping > max) max = ping;
      sum += ping;
    }
    const avg = sum / this.pingValues.length;

    return { min, max, avg, count: this.pingValues.length };
  }

  setSnapshotEnricher(fn: ((snapshot: MetricsSnapshot) => void) | null): void {
    this.snapshotEnricher = fn;
  }

  private recordHistory() {
    const snapshot = this.getSnapshot();
    if (this.snapshotEnricher) {
      try {
        this.snapshotEnricher(snapshot);
      } catch (err) {
        console.error("metrics snapshot enricher failed:", err);
      }
    }
    this.recordHistoryEntry(snapshot);
  }

  private trackEventLoopDelay() {
    const intervalMs = this.eventLoopSampleMs;
    let last = Date.now();
    setInterval(() => {
      const now = Date.now();
      const delay = Math.max(0, now - last - intervalMs);
      this.eventLoopDelays.push(delay);
      if (this.eventLoopDelays.length > this.maxEventLoopHistory) {
        this.eventLoopDelays.shift();
      }
      last = now;
    }, intervalMs);
  }

  private percentile(samples: number[], percentile: number): number {
    if (samples.length === 0) return 0;
    const index = Math.max(0, Math.ceil(samples.length * percentile) - 1);
    return samples[index] ?? 0;
  }

  private average(samples: number[]): number {
    return samples.length
      ? samples.reduce((sum, value) => sum + value, 0) / samples.length
      : 0;
  }

  private pruneTimedSamples(list: Array<{ ts: number }>, minTs: number): void {
    let removeCount = 0;
    while (removeCount < list.length && list[removeCount].ts <= minTs) {
      removeCount += 1;
    }
    if (removeCount > 0) {
      list.splice(0, removeCount);
    }
  }

  private countHttpErrors(samples: TimedHttpSample[]): number {
    let count = 0;
    for (const sample of samples) {
      if (sample.statusCode >= 400) count += 1;
    }
    return count;
  }

  private getTopHttpRoutes(minTs: number): HttpRouteStats[] {
    const routes: HttpRouteStats[] = [];
    for (const [route, samples] of this.httpRouteSamples.entries()) {
      this.pruneTimedSamples(samples, minTs);
      if (samples.length === 0) {
        this.httpRouteSamples.delete(route);
        continue;
      }

      const durations = samples
        .map((sample) => sample.duration)
        .sort((a, b) => a - b);
      const last = samples[samples.length - 1];
      routes.push({
        route,
        countLastMinute: samples.length,
        errorsLastMinute: this.countHttpErrors(samples),
        latencyAvg: this.average(durations),
        latencyP95: this.percentile(durations, 0.95),
        latencyP99: this.percentile(durations, 0.99),
        latencyMax: durations[durations.length - 1] ?? 0,
        lastDuration: last?.duration ?? 0,
        lastStatus: last?.statusCode ?? 0,
      });
    }

    return routes
      .sort((a, b) => {
        if (b.latencyP95 !== a.latencyP95) return b.latencyP95 - a.latencyP95;
        if (b.latencyAvg !== a.latencyAvg) return b.latencyAvg - a.latencyAvg;
        return b.countLastMinute - a.countLastMinute;
      })
      .slice(0, 8);
  }

  private getTopInternalTasks(minTs: number): InternalTaskStats[] {
    const tasks: InternalTaskStats[] = [];
    for (const [task, samples] of this.internalTaskSamples.entries()) {
      this.pruneTimedSamples(samples, minTs);
      if (samples.length === 0) {
        this.internalTaskSamples.delete(task);
        continue;
      }

      const durations = samples
        .map((sample) => sample.duration)
        .sort((a, b) => a - b);
      const last = samples[samples.length - 1];
      tasks.push({
        task,
        countLastMinute: samples.length,
        durationAvg: this.average(durations),
        durationP95: this.percentile(durations, 0.95),
        durationP99: this.percentile(durations, 0.99),
        durationMax: durations[durations.length - 1] ?? 0,
        lastDuration: last?.duration ?? 0,
        lastAt: last?.ts ?? 0,
      });
    }

    return tasks
      .sort((a, b) => {
        if (b.durationP95 !== a.durationP95) return b.durationP95 - a.durationP95;
        if (b.durationAvg !== a.durationAvg) return b.durationAvg - a.durationAvg;
        return b.countLastMinute - a.countLastMinute;
      })
      .slice(0, 8);
  }

  recordHttpRequest(durationMs: number, statusCode: number, route = "unknown") {
    if (this.ignoredHttpMetricRoutes.has(route)) return;

    this.httpTotal++;
    const now = Date.now();
    this.httpTimestamps.push(now);
    this.pruneTimestampWindow(this.httpTimestamps, now - 60000);
    if (statusCode >= 400) {
      this.httpErrorTimestamps.push(now);
      this.pruneTimestampWindow(this.httpErrorTimestamps, now - 60000);
    }
    if (Number.isFinite(durationMs)) {
      const sample = { ts: now, duration: Math.max(0, durationMs), statusCode };
      this.httpSamples.push(sample);
      if (this.httpSamples.length > this.maxHttpLatencyHistory) {
        this.httpSamples.splice(0, this.httpSamples.length - this.maxHttpLatencyHistory);
      }

      let retainedRoute = route;
      if (
        !this.httpRouteSamples.has(retainedRoute)
        && !this.httpRouteSamples.has(OVERFLOW_HTTP_METRIC_ROUTE)
        && this.httpRouteSamples.size >= MAX_HTTP_METRIC_ROUTE_KEYS - 1
      ) {
        retainedRoute = OVERFLOW_HTTP_METRIC_ROUTE;
      } else if (
        !this.httpRouteSamples.has(retainedRoute)
        && this.httpRouteSamples.size >= MAX_HTTP_METRIC_ROUTE_KEYS
      ) {
        retainedRoute = OVERFLOW_HTTP_METRIC_ROUTE;
      }
      const routeSamples = this.httpRouteSamples.get(retainedRoute) || [];
      routeSamples.push(sample);
      if (routeSamples.length > this.maxHttpRouteSamples) {
        routeSamples.splice(0, routeSamples.length - this.maxHttpRouteSamples);
      }
      this.httpRouteSamples.set(retainedRoute, routeSamples);
    }
  }

  recordInternalTask(task: string, durationMs: number) {
    if (!task || !Number.isFinite(durationMs)) return;
    const now = Date.now();
    const sample = { ts: now, duration: Math.max(0, durationMs) };
    const samples = this.internalTaskSamples.get(task) || [];
    samples.push(sample);
    if (samples.length > this.maxInternalTaskSamples) {
      samples.splice(0, samples.length - this.maxInternalTaskSamples);
    }
    this.internalTaskSamples.set(task, samples);
  }

  async withHttpMetrics<T extends Response>(
    handler: () => Promise<T>,
    route = "unknown",
  ): Promise<T> {
    const start = typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
    try {
      const response = await handler();
      const end = typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now();
      this.recordHttpRequest(end - start, response?.status ?? 0, route);
      return response;
    } catch (err) {
      const end = typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now();
      this.recordHttpRequest(end - start, 500, route);
      throw err;
    }
  }

  recordHistoryEntry(snapshot: MetricsSnapshot) {
    const historyEntry: MetricsHistory = {
      timestamp: snapshot.timestamp,
      clientsOnline: snapshot.clients.online,
      commandsPerMinute: snapshot.commands.lastMinute,
      bandwidthSent: this.sentPerSecond,
      bandwidthReceived: this.receivedPerSecond,
      httpRequestsPerMinute: snapshot.http.lastMinute,
      httpErrorsPerMinute: snapshot.http.lastMinuteErrors,
      httpLatencyAvg: snapshot.http.latencyAvg,
      httpLatencyP95: snapshot.http.latencyP95,
      httpLatencyP99: snapshot.http.latencyP99,
      eventLoopAvg: snapshot.eventLoop.avg,
      eventLoopP95: snapshot.eventLoop.p95,
      heapUsed: snapshot.server.memoryUsage.heapUsed,
      rss: snapshot.server.memoryUsage.rss,
      systemMemoryUsedPercent: snapshot.server.systemMemory.usedPercent,
      activeSessions:
        snapshot.sessions.console +
        snapshot.sessions.remoteDesktop +
        snapshot.sessions.fileBrowser +
        snapshot.sessions.process,
    };

    this.history.push(historyEntry);

    if (this.history.length > this.maxHistoryPoints) {
      this.history.shift();
    }
  }

  getSnapshot(): MetricsSnapshot {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    const oneHourAgo = now - 3600000;

    this.pruneTimestampWindow(this.commandTimestamps, oneHourAgo);
    this.pruneTimestampWindow(this.httpTimestamps, oneMinuteAgo);
    this.pruneTimestampWindow(this.httpErrorTimestamps, oneMinuteAgo);
    this.pruneTimedSamples(this.httpSamples, oneMinuteAgo);

    const commandsLastMinute = this.countRecent(this.commandTimestamps, oneMinuteAgo);
    const commandsLastHour = this.commandTimestamps.length;

    const commandsByType: Record<string, number> = {};
    for (const [type, count] of this.commandTypeCount.entries()) {
      commandsByType[type] = count;
    }

    const httpLastMinute = this.httpTimestamps.length;
    const httpErrorsLastMinute = this.httpErrorTimestamps.length;

    const httpLatencySamples = this.httpSamples
      .map((sample) => sample.duration)
      .sort((a, b) => a - b);
    const httpLatencyAvg = this.average(httpLatencySamples);
    const httpLatencyP95 = this.percentile(httpLatencySamples, 0.95);
    const httpLatencyP99 = this.percentile(httpLatencySamples, 0.99);
    const httpRoutes = this.getTopHttpRoutes(oneMinuteAgo);
    const internalTasks = this.getTopInternalTasks(oneMinuteAgo);

    const eventLoopSamples = [...this.eventLoopDelays].sort((a, b) => a - b);
    const eventLoopAvg = eventLoopSamples.length
      ? eventLoopSamples.reduce((a, b) => a + b, 0) / eventLoopSamples.length
      : 0;
    const eventLoopMax = eventLoopSamples.length
      ? eventLoopSamples[eventLoopSamples.length - 1]
      : 0;
    const eventLoopP95Index = eventLoopSamples.length
      ? Math.max(0, Math.floor(eventLoopSamples.length * 0.95) - 1)
      : 0;
    const eventLoopP95 = eventLoopSamples.length
      ? eventLoopSamples[eventLoopP95Index] ?? 0
      : 0;

    const memoryUsage = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = Math.max(0, totalMem - freeMem);
    const usedPercent = totalMem > 0 ? (usedMem / totalMem) * 100 : 0;
    const loadAvg = os.loadavg();
    const loadTuple: [number, number, number] = [
      loadAvg[0] ?? 0,
      loadAvg[1] ?? 0,
      loadAvg[2] ?? 0,
    ];

    return {
      timestamp: now,
      clients: {
        total: 0,
        online: 0,
        offline: 0,
        byOS: {},
        byCountry: {},
      },
      connections: {
        totalConnections: this.totalConnections,
        totalDisconnections: this.totalDisconnections,
        activeConnections: this.totalConnections - this.totalDisconnections,
      },
      commands: {
        total: this.commandCount,
        lastMinute: commandsLastMinute,
        lastHour: commandsLastHour,
        byType: commandsByType,
      },
      sessions: {
        console: 0,
        remoteDesktop: 0,
        fileBrowser: 0,
        process: 0,
      },
      bandwidth: {
        sent: this.bytesSent,
        received: this.bytesReceived,
        sentPerSecond: this.sentPerSecond,
        receivedPerSecond: this.receivedPerSecond,
      },
      server: {
        uptime: now - this.startTime,
        startTime: this.startTime,
        memoryUsage,
        systemMemory: {
          total: totalMem,
          free: freeMem,
          used: usedMem,
          usedPercent,
        },
        cpu: {
          cores: os.cpus().length || 0,
          loadAvg: loadTuple,
        },
      },
      ping: this.getPingStats(),
      http: {
        total: this.httpTotal,
        lastMinute: httpLastMinute,
        lastMinuteErrors: httpErrorsLastMinute,
        latencyAvg: httpLatencyAvg,
        latencyP95: httpLatencyP95,
        latencyP99: httpLatencyP99,
        routes: httpRoutes,
      },
      eventLoop: {
        avg: eventLoopAvg,
        max: eventLoopMax,
        p95: eventLoopP95,
        sampleMs: this.eventLoopSampleMs,
        samples: eventLoopSamples.length,
      },
      internal: {
        tasks: internalTasks,
      },
    };
  }

  getHistory(): MetricsHistory[] {
    return [...this.history];
  }

  reset() {
    this.commandCount = 0;
    this.commandTypeCount.clear();
    this.commandTimestamps = [];
    this.bytesSent = 0;
    this.bytesReceived = 0;
    this.lastBytesSent = 0;
    this.lastBytesReceived = 0;
    this.sentPerSecond = 0;
    this.receivedPerSecond = 0;
    this.pingValues = [];
    this.history = [];
    this.httpTotal = 0;
    this.httpTimestamps = [];
    this.httpErrorTimestamps = [];
    this.httpSamples = [];
    this.httpRouteSamples.clear();
    this.eventLoopDelays = [];
    this.internalTaskSamples.clear();
  }
}

export const metrics = new MetricsCollector();
