'use strict';
/**
 * pktgen backend — kernel-space packet generator for line-rate (up to ~10G) load.
 *
 * The Node.js cap/libpcap send path tops out at tens of thousands of pps. For real
 * 10G testing we drive the in-kernel pktgen module via its /proc/net/pktgen control
 * files (requires root — the server already runs as root for cap/tcpdump).
 *
 * Control flow (verified on this host):
 *   modprobe pktgen                              → creates /proc/net/pktgen/{kpktgend_N, pgctrl}
 *   echo "rem_device_all"  > kpktgend_<cpu>      → detach any device from that thread
 *   echo "add_device <if>" > kpktgend_<cpu>      → attach the NIC to a tx thread
 *   echo "count N" / "pkt_size" / ... > <if>     → configure the run
 *   echo "start" > pgctrl                        → BLOCKS until every device hits its count
 *   cat <if>                                     → "Result: OK: ... NNNpps NNNMb/sec (NNNbps) errors: N"
 *
 * `start` blocks, so we run it in a detached child process and poll the per-device
 * file for progress/result. `stop` writes "stop" to pgctrl to abort a running (or
 * continuous, count=0) test.
 */
const fs        = require('fs');
const os        = require('os');
const { spawn } = require('child_process');

const PG_DIR   = '/proc/net/pktgen';
const PG_CTRL  = `${PG_DIR}/pgctrl`;

let _ensured   = false;       // pktgen module load attempted
let _running   = false;       // a start() is in flight
let _startChild = null;       // child running `echo start > pgctrl`
let _current   = null;        // { iface, thread, opts, startedAt }

function _pgFile(name) { return `${PG_DIR}/${name}`; }
function _write(file, line) { fs.writeFileSync(file, line + '\n'); }

// pktgen present if the proc dir exists (module loaded). Try a one-shot modprobe.
function isAvailable() {
  if (fs.existsSync(PG_DIR)) return true;
  if (_ensured) return false;
  _ensured = true;
  try { require('child_process').execFileSync('modprobe', ['pktgen']); } catch { /* no perms / no module */ }
  return fs.existsSync(PG_DIR);
}

function isRunning() { return _running; }

function getThreadFiles() {
  return fs.readdirSync(PG_DIR).filter(f => /^kpktgend_\d+$/.test(f));
}

/**
 * Configure and launch a pktgen run.
 * opts: { iface, pktSize=60, count=0(=continuous), cloneSkb=1000, delayNs=0,
 *         threads=1, dstMac='ff:ff:ff:ff:ff:ff', srcMac, dstIp='10.0.0.1', srcIp,
 *         dstPort, srcPort, vlanId }
 */
function start(opts = {}) {
  if (!isAvailable()) throw new Error('pktgen module unavailable (modprobe pktgen failed — needs root)');
  if (_running)      throw new Error('pktgen run already in progress — stop it first');

  const iface = opts.iface;
  if (!iface) throw new Error('iface required');
  if (!fs.existsSync(`/sys/class/net/${iface}`)) throw new Error(`Interface not found: ${iface}`);

  const pktSize  = Math.max(60, parseInt(opts.pktSize)  || 60);
  const count    = Math.max(0,  parseInt(opts.count)    || 0);     // 0 = run until stop()
  const cloneSkb = Math.max(0,  parseInt(opts.cloneSkb) ?? 1000);
  const delayNs  = Math.max(0,  parseInt(opts.delayNs)  || 0);
  const nThreads = Math.min(getThreadFiles().length, Math.max(1, parseInt(opts.threads) || 1));

  // Auto-fill srcMac from the NIC if not supplied
  let srcMac = opts.srcMac;
  if (!srcMac) {
    for (const [name, entries] of Object.entries(os.networkInterfaces() || {})) {
      if (name === iface) { srcMac = (entries || []).find(e => e.mac && e.mac !== '00:00:00:00:00:00')?.mac; break; }
    }
  }

  // Detach the NIC from every thread first (a stale binding makes add_device fail)
  for (const t of getThreadFiles()) {
    try { _write(_pgFile(t), 'rem_device_all'); } catch { /* ignore */ }
  }

  // pktgen names a per-thread queue clone as "<iface>@<n>" when one NIC spans threads.
  const devNames = [];
  for (let i = 0; i < nThreads; i++) {
    const thread  = `kpktgend_${i}`;
    const devName = nThreads > 1 ? `${iface}@${i}` : iface;
    _write(_pgFile(thread), `add_device ${devName}`);
    devNames.push(devName);

    const dev = _pgFile(devName);
    _write(dev, `count ${count === 0 ? 0 : Math.ceil(count / nThreads)}`);
    _write(dev, `clone_skb ${cloneSkb}`);
    _write(dev, `pkt_size ${pktSize}`);
    _write(dev, `delay ${delayNs}`);
    _write(dev, `dst_mac ${opts.dstMac || 'ff:ff:ff:ff:ff:ff'}`);
    if (srcMac)      _write(dev, `src_mac ${srcMac}`);
    _write(dev, `dst ${opts.dstIp || '10.0.0.1'}`);
    if (opts.srcIp)  _write(dev, `src_min ${opts.srcIp}`);
    if (opts.dstPort) { _write(dev, `udp_dst_min ${opts.dstPort}`); _write(dev, `udp_dst_max ${opts.dstPort}`); }
    if (opts.srcPort) { _write(dev, `udp_src_min ${opts.srcPort}`); _write(dev, `udp_src_max ${opts.srcPort}`); }
    if (opts.vlanId != null && opts.vlanId !== '') _write(dev, `vlan_id ${parseInt(opts.vlanId)}`);
    if (nThreads > 1) { _write(dev, `flag QUEUE_MAP_CPU`); }
  }

  _current = { iface, devNames, opts: { pktSize, count, cloneSkb, delayNs, nThreads }, startedAt: Date.now() };
  _running = true;

  // `echo start > pgctrl` blocks until done — run detached so we don't stall the server.
  _startChild = spawn('bash', ['-c', `echo start > ${PG_CTRL}`], { stdio: 'ignore' });
  _startChild.on('exit', () => { _running = false; _startChild = null; });
  _startChild.on('error', () => { _running = false; _startChild = null; });

  return { ok: true, iface, threads: nThreads, devNames, params: _current.opts };
}

// Abort a run (also the only way to end a count=0 continuous run).
function stop() {
  try { _write(PG_CTRL, 'stop'); } catch { /* not running */ }
  if (_startChild) { try { _startChild.kill('SIGTERM'); } catch {} }
  _running = false;
  return { ok: true };
}

const RESULT_RE = /Result:\s*(OK|Stopped|Idle)?:?\s*(\d+)\(?[^,]*,\s*(\d+)\s*\((\d+)byte/i;
const RATE_RE   = /([\d]+)pps\s+([\d]+)Mb\/sec\s+\((\d+)bps\)\s+errors:\s*(\d+)/i;
const SOFAR_RE  = /pkts-sofar:\s*(\d+)\s+errors:\s*(\d+)/i;

function _parseDev(devName) {
  let raw = '';
  try { raw = fs.readFileSync(_pgFile(devName), 'utf8'); } catch { return null; }
  const running = /^Running:\s*\S/m.test(raw) && !/^Running:\s*$/m.test(raw);
  const sofar   = SOFAR_RE.exec(raw);
  const rate    = RATE_RE.exec(raw);
  const res     = RESULT_RE.exec(raw);
  return {
    dev: devName,
    running,
    pktsSoFar: sofar ? parseInt(sofar[1]) : 0,
    errors:    sofar ? parseInt(sofar[2]) : 0,
    done:      !!rate,
    pps:       rate ? parseInt(rate[1]) : 0,
    mbps:      rate ? parseInt(rate[2]) : 0,
    bps:       rate ? parseInt(rate[3]) : 0,
    pktSize:   res  ? parseInt(res[4]) : (_current?.opts.pktSize || 0),
    raw,
  };
}

// Aggregate status across all tx threads for the current run.
function status() {
  if (!_current) return { ok: true, active: false, running: false };
  const devs = _current.devNames.map(_parseDev).filter(Boolean);
  const sum = devs.reduce((a, d) => ({
    pps:       a.pps  + d.pps,
    mbps:      a.mbps + d.mbps,
    bps:       a.bps  + d.bps,
    pktsSoFar: a.pktsSoFar + d.pktsSoFar,
    errors:    a.errors + d.errors,
  }), { pps: 0, mbps: 0, bps: 0, pktsSoFar: 0, errors: 0 });
  const anyRunning = _running || devs.some(d => d.running);
  const allDone    = devs.length > 0 && devs.every(d => d.done);
  return {
    ok: true,
    active: true,
    running: anyRunning && !allDone,
    done: allDone && !anyRunning,
    iface: _current.iface,
    params: _current.opts,
    elapsedMs: Date.now() - _current.startedAt,
    totals: { ...sum, gbps: +(sum.bps / 1e9).toFixed(3) },
    perThread: devs.map(d => ({ dev: d.dev, pps: d.pps, mbps: d.mbps, pktsSoFar: d.pktsSoFar, errors: d.errors, done: d.done, running: d.running })),
  };
}

module.exports = { isAvailable, isRunning, start, stop, status };
