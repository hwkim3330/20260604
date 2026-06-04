'use strict';
const { Router } = require('express');
const os = require('os');
const router = Router();

// Version info resolved once at startup — lets two nodes be compared at a glance
// (노드 A/B 코드·Node.js 버전 일치 확인용)
const VERSION = (() => {
  let commit = null;
  try {
    commit = require('child_process')
      .execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch { /* not a git checkout (e.g. copied folder) */ }
  let pkg = '0.0.0';
  try { pkg = require('../package.json').version; } catch {}
  return { app: pkg, commit, node: process.version };
})();

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    server: { name: 'packet-lab-manager', port: Number(process.env.PORT || 8080) },
    version: VERSION,
    time: new Date().toISOString()
  });
});

router.get('/backend/status', async (req, res) => {
  const { packetBackend, serialBridge } = req.app.locals;

  let serialPorts = [];
  if (serialBridge?.isAvailable?.()) {
    try { serialPorts = await serialBridge.list(); } catch {}
  }

  const interfaces = packetBackend.listInterfaces();
  const nodeNative = {
    packetSend: Boolean(packetBackend.isAvailable?.()),
    packetCapture: Boolean(packetBackend.isAvailable?.() || packetBackend.isTcpdumpAvailable?.()),
    cap: Boolean(packetBackend.isAvailable?.()),
    tcpdump: Boolean(packetBackend.isTcpdumpAvailable?.()),
    serial: Boolean(serialBridge?.isAvailable?.()),
    serialOpen: Boolean(serialBridge?.getStatus?.().open),
    serialPorts: serialPorts.map((p) => p.path || p.name).filter(Boolean),
    interfaces: interfaces.map((i) => ({
      name: i.name,
      state: i.state,
      mac: i.mac,
      ipv4: i.ipv4 || []
    }))
  };

  const features = {
    send: nodeNative.packetSend,
    capture: nodeNative.packetCapture,
    serial: nodeNative.serial,
    register: nodeNative.serialOpen,
    fdb: nodeNative.serialOpen,
    mdio: nodeNative.serialOpen,
    reports: true
  };

  res.json({
    ok: true,
    mode: 'node-native',
    platform: { type: os.type(), platform: os.platform(), arch: os.arch(), node: process.version },
    nodeNative,
    features,
    notes: {
      packetSend: nodeNative.packetSend ? 'Node cap is available for raw Ethernet send.' : 'Raw Ethernet send needs cap optional dependency.',
      packetCapture: nodeNative.packetCapture ? 'Capture backend is available.' : 'Capture needs cap or tcpdump.',
      register: features.register ? 'Register/MDIO/FDB can run through open serial bridge.' : 'Open serial bridge for switch registers.'
    },
    time: new Date().toISOString()
  });
});

module.exports = router;
