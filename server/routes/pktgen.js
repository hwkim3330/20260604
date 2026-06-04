'use strict';
// pktgen — kernel line-rate generator control (10G load testing)
const { Router } = require('express');
const pktgen = require('../services/pktgenBackend');
const router = Router();

function err(res, e) { res.status(503).json({ ok: false, error: e.message }); }

// GET /api/pktgen/available
router.get('/pktgen/available', (_req, res) => {
  res.json({ ok: true, available: pktgen.isAvailable(), running: pktgen.isRunning() });
});

// POST /api/pktgen/start  { iface, pktSize, count, cloneSkb, delayNs, threads, dstMac, dstIp, ... }
router.post('/pktgen/start', (req, res) => {
  try { res.json(pktgen.start(req.body || {})); }
  catch (e) { err(res, e); }
});

// POST /api/pktgen/stop
router.post('/pktgen/stop', (_req, res) => {
  try { res.json(pktgen.stop()); }
  catch (e) { err(res, e); }
});

// GET /api/pktgen/status
router.get('/pktgen/status', (_req, res) => {
  try { res.json(pktgen.status()); }
  catch (e) { err(res, e); }
});

module.exports = router;
