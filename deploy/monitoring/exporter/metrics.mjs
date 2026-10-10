// Translate the game's JSON contract, not the exporter's own CPU or memory. Missing data stays absent.
const numeric = (v) => typeof v === 'number' && Number.isFinite(v);
const escape = (v) => String(v).replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
const pathValue = (obj, path) => path.split('.').reduce((v, key) => v?.[key], obj);
const messageTypes = new Set(['invalid', 'hello', 'ping', 'g.ready', 'g.rerollVote', 'g.move', 'g.buy', 'g.sell', 'g.equip', 'g.refresh',
  'g.levelUp', 'g.freeze', 'g.choice', 'g.band', 'g.bandSkip', 'g.bandFocus', 'g.infoReady', 'g.reward', 'g.unitStats', 'g.watch',
  'g.leave', 'g.pause', 'g.autoplay', 'g.console', 'g.destroy', 'g.art', 'g.emote', 'b.result', 'b.progress',
  'room.create', 'room.join', 'room.leave', 'room.ready', 'room.start', 'room.setDifficulty', 'room.setAiPicksLast', 'room.rerollSetup', 'room.cancelReroll', 'room.addBot',
  'room.removeBot', 'room.kick', 'room.loadout', 'room.ownership', 'room.diy', 'room.spectate',
  'room.removeSpectator', 'room.console.enable', 'room.console.disable', 'match.join', 'match.leave', 'state.resync']);
const fields = [
  ['uptime_seconds', 'uptimeSec'],
  ...['sockets', 'sessions', 'rooms', 'matches', 'roomMatches', 'standaloneMatches', 'humans', 'bots', 'spectators', 'queued']
    .map((k) => ['players_' + k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase()), k]),
  ['process_rss_bytes', 'memory.rss'], ['main_heap_used_bytes', 'memory.heapUsed'],
  ['main_heap_total_bytes', 'memory.heapTotal'], ['main_external_bytes', 'memory.external'],
  ['main_array_buffers_bytes', 'memory.arrayBuffers'],
  ['socket_buffer_total_bytes', 'socketBuffers.total'], ['socket_buffer_max_bytes', 'socketBuffers.max'],
  ['static_gzip_bytes', 'staticCache.gzipBytes'], ['static_gzip_limit_bytes', 'staticCache.gzipLimitBytes'],
  ['worker_size', 'workers.size'], ['worker_busy', 'workers.busy'], ['worker_queued', 'workers.queued'],
  ['worker_queue_limit', 'workers.maxQueue'], ['worker_avg_compute_seconds_since_start', 'workers.avgComputeMs', 0.001],
  ['persist_checkpoints', 'persist.checkpoints'], ['persist_snapshot_bytes', 'persist.snapshotBytes'],
  ['persist_heap_used_bytes', 'persist.workerMemory.heapUsed'], ['persist_heap_total_bytes', 'persist.workerMemory.heapTotal'],
  ['persist_memory_sample_timestamp_seconds', 'persist.workerMemory.sampledAt', 0.001],
  ['limit_sockets', 'limits.maxConnections'], ['limit_rooms', 'limits.maxRooms'],
  ['event_loop_utilization_since_start', 'websocket.diagnostics.eventLoop.utilization'],
  ...['meanMs', 'maxMs', 'p95Ms', 'p99Ms'].map((k) => [
    'event_loop_' + k.replace('Ms', '') + '_seconds_since_start', 'websocket.diagnostics.eventLoop.' + k, 0.001]),
  ['event_loop_window_utilization', 'websocket.diagnostics.recentEventLoop.utilization'],
  ['event_loop_window_seconds', 'websocket.diagnostics.recentEventLoop.windowMs', 0.001],
  ['event_loop_window_samples', 'websocket.diagnostics.recentEventLoop.sampleCount'],
  ...['meanMs', 'maxMs', 'p95Ms', 'p99Ms'].map((k) => [
    'event_loop_window_' + k.replace('Ms', '') + '_seconds', 'websocket.diagnostics.recentEventLoop.' + k, 0.001]),
];
const counters = [
  ['process_cpu_user_seconds_total', 'websocket.diagnostics.processCpu.userSeconds'],
  ['process_cpu_system_seconds_total', 'websocket.diagnostics.processCpu.systemSeconds'],
  ['ws_received_frames_total', 'websocket.diagnostics.receivedFrames'],
  ['ws_sent_frames_total', 'websocket.diagnostics.sentFrames'],
  ['ws_received_application_bytes_total', 'websocket.diagnostics.receivedBytes'],
  ['ws_sent_application_bytes_total', 'websocket.diagnostics.sentBytes'],
  ['ws_dropped_snapshots_total', 'websocket.diagnostics.droppedSnapshots'],
  ['ws_slow_disconnects_total', 'websocket.diagnostics.slowDisconnects'],
  ['persist_writes_total', 'persist.writes'],
  ...['submitted', 'completed', 'failed', 'cancelled', 'rejected'].map((k) => ['worker_' + k + '_total', 'workers.' + k]),
  ['worker_queue_seconds_total', 'workers.queueMs', 0.001],
  ['worker_compute_seconds_total', 'workers.computeMs', 0.001],
];

/** @param {Array<{name:string, url:string}>} targets @param {Map} states */
export function renderMetrics(targets, states, nowSeconds = Date.now() / 1000) {
  const lines = [], declared = new Set();
  const emit = (name, value, labels, type = 'gauge', help = name) => {
    if (!numeric(value)) return;
    name = 'sp_' + name;
    if (!declared.has(name)) {
      declared.add(name);
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    }
    const formatted = Object.entries(labels).map(([k, v]) => `${k}="${escape(v)}"`).join(',');
    lines.push(`${name}{${formatted}} ${value}`);
  };
  const histogram = (name, h, labels) => {
    if (!h || !numeric(h.count) || !numeric(h.sumMs) || !Array.isArray(h.buckets)) return;
    if (h.count < 0 || h.sumMs < 0 || h.buckets.length > 32) return;
    let previous = 0, bound = -Infinity, final = null;
    for (const b of h.buckets) {
      const le = b.leMs === '+Inf' ? Infinity : b.leMs;
      if (!((numeric(le) && le >= 0) || le === Infinity) || le <= bound || !numeric(b.count)
        || !Number.isInteger(b.count) || b.count < previous || b.count > h.count) return;
      previous = b.count; bound = le; final = b;
    }
    if (final?.leMs !== '+Inf' || final.count !== h.count) return;
    const family = 'sp_' + name;
    if (!declared.has(family)) {
      declared.add(family);
      lines.push(`# HELP ${family} Cumulative bounded server-side timing histogram in seconds.`,
        `# TYPE ${family} histogram`);
    }
    const formatted = (extra = {}) => Object.entries({ ...labels, ...extra })
      .map(([k, v]) => `${k}="${escape(v)}"`).join(',');
    for (const b of h.buckets) {
      if (numeric(b.leMs) || b.leMs === '+Inf') {
        lines.push(`${family}_bucket{${formatted({ le: b.leMs === '+Inf' ? '+Inf' : b.leMs / 1000 })}} ${b.count}`);
      }
    }
    lines.push(`${family}_sum{${formatted()}} ${h.sumMs / 1000}`,
      `${family}_count{${formatted()}} ${h.count}`);
  };
  for (const target of targets) {
    const s = states.get(target.name), labels = { game: target.name };
    emit('target_up', s?.up ? 1 : 0, labels);
    emit('exporter_scrape_errors_total', s?.errors || 0, labels, 'counter');
    emit('exporter_scrape_duration_seconds', s?.durationSeconds, labels);
    emit('exporter_last_success_timestamp_seconds', s?.lastSuccess, labels);
    emit('exporter_snapshot_age_seconds', s?.lastSuccess ? Math.max(0, nowSeconds - s.lastSuccess) : undefined, labels);
    if (target.wsUrl) {
      emit('ws_probe_up', s?.probe?.up ? 1 : 0, labels);
      emit('ws_probe_rtt_seconds', s?.probe?.rttSeconds, labels);
      emit('ws_probe_connect_seconds', s?.probe?.connectSeconds, labels);
    }
    // A failed poll does not present old game gauges/counters as a current, healthy sample.
    if (!s?.up || !s.data) continue;
    const m = s.data;
    emit('game_info', 1, { ...labels, app: String(m.app || 'unknown'), build: String(m.build || 'unknown') });
    emit('worker_enabled', m.workers ? 1 : 0, labels);
    emit('persist_enabled', m.persist?.redis ? 1 : 0, labels);
    emit('ws_compression_enabled', m.websocket?.compression ? 1 : 0, labels);
    emit('announcement_config_error', m.announcements?.configError ? 1 : 0, labels);
    emit('latency_histograms_available', Array.isArray(m.websocket?.diagnostics?.sendCompletionMs?.buckets) ? 1 : 0, labels);
    emit('process_cpu_available', m.websocket?.diagnostics?.processCpu ? 1 : 0, labels);
    emit('event_loop_window_available', m.websocket?.diagnostics?.recentEventLoop ? 1 : 0, labels);
    for (const [name, path, scale = 1] of fields) {
      const value = pathValue(m, path);
      if (numeric(value)) emit(name, value * scale, labels);
    }
    for (const [name, path, scale = 1] of counters) {
      const value = pathValue(m, path);
      if (numeric(value)) emit(name, value * scale, labels, 'counter');
    }
    const recent = m.websocket?.diagnostics?.recentEventLoop;
    if (numeric(recent?.sampledAt)) emit('event_loop_window_age_seconds', Math.max(0, nowSeconds - recent.sampledAt / 1000), labels);
    const memory = m.workers?.memory;
    if (Array.isArray(memory)) {
      // Aggregate only, no per-thread labels. Samples may be old and belong to different instants.
      const used = memory.map((w) => w.sample?.heapUsed).filter(numeric);
      if (used.length) emit('simulation_heap_sampled_bytes', used.reduce((a, b) => a + b, 0), labels);
      emit('simulation_memory_samples', used.length, labels);
      const ages = memory.map((w) => w.sample?.sampledAt).filter(numeric).map((at) => Math.max(0, nowSeconds - at / 1000));
      if (ages.length) emit('simulation_memory_oldest_sample_age_seconds', Math.max(...ages), labels);
    }
    const diagnostics = m.websocket?.diagnostics;
    histogram('ws_send_completion_seconds', diagnostics?.sendCompletionMs, labels);
    for (const [message, h] of Object.entries(diagnostics?.handlerMs || {})) {
      // Current protocol has <64 fixed types. Never expose supplied names/addresses/message contents.
      if (messageTypes.has(message)) {
        histogram('ws_handler_seconds', h, { ...labels, message });
        if (numeric(h.p95UpperMs)) emit('ws_handler_p95_upper_seconds_since_start', h.p95UpperMs / 1000, { ...labels, message });
      }
    }
    const sendP95 = diagnostics?.sendCompletionMs?.p95UpperMs;
    if (numeric(sendP95)) emit('ws_send_completion_p95_upper_seconds_since_start', sendP95 / 1000, labels);
  }
  return lines.join('\n') + '\n';
}
