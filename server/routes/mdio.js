'use strict';
const { Router } = require('express');
const router = Router();

function wErr(res, e) { res.status(e.workerError ? 502 : 503).json({ ok: false, error: e.message }); }

// MDIO register map (relative to BaseAddress = 0x44A00000)
// Block base = 0x0080 + port * 0x0040
// Offsets within block:
//   0x0000: MDIO_SETUP
//   0x0004: MDIO_TIME
//   0x0010: MDIO_ACC_DATA
const MDIO_BASE   = 0x0080;
const MDIO_STRIDE = 0x0040;
const OFF_SETUP   = 0x0000;
const OFF_TIME    = 0x0004;
const OFF_ACC     = 0x0010;

// PHY addresses per port (matches MdioService.PhyAddrs)
const PHY_ADDRS = [0x00, 0x04, 0x05, 0x08, 0x0A, 0x0C];

function blockBase(port) {
  return MDIO_BASE + port * MDIO_STRIDE;
}

function toHexOffset(num) {
  return '0x' + num.toString(16).toUpperCase().padStart(8, '0');
}

function parseHex(str) {
  if (str === null || str === undefined) return NaN;
  return parseInt(String(str).replace(/^0x/i, ''), 16);
}

async function regRead(req, offset) {
  const d = await req.app.locals.localCmd('registerread', { offset: toHexOffset(offset) }, 5000);
  // value field is "0xHEXHEX" string
  return parseHex(d.value);
}

async function regWrite(req, offset, value) {
  await req.app.locals.localCmd('registerwrite', {
    offset: toHexOffset(offset),
    value:  '0x' + (value >>> 0).toString(16).toUpperCase().padStart(8, '0')
  }, 5000);
}

// One MDIO transaction on a port's ACC register: write cmd, poll EN(bit31) clear.
// Returns the final raw ACC value (read data in [15:0] for read transactions).
async function mdioXact(req, acc, cmd, timeoutMs = 2000) {
  await regWrite(req, acc, cmd);
  const deadline = Date.now() + timeoutMs;
  let raw = cmd; // seed with EN=1 so loop runs at least once
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 50));
    raw = await regRead(req, acc);
    if ((raw & 0x80000000) === 0) return raw;
  }
  throw new Error('MDIO transaction timeout');
}

function accCmd(write, phyAddr, regAddr, data = 0) {
  return (0x80000000 | (write ? (1 << 26) : 0) |
          ((phyAddr & 0x1F) << 21) | ((regAddr & 0x1F) << 16) | (data & 0xFFFF)) >>> 0;
}

// ── Clause 22 Annex 22D indirect MMD access ───────────────────────────────────
// Direct access only covers PHY registers 0x00-0x1F (ACC reg field is 5 bits).
// Registers beyond 0x1F live in MMD register space (e.g. MMD1F) and are reached
// through Reg 0x0D (MMD Access Control) + Reg 0x0E (MMD Address/Data):
//   1. Reg 0x0D ← fn=00(Address) | DEVAD      2. Reg 0x0E ← target reg addr
//   3. Reg 0x0D ← fn=01(Data)    | DEVAD      4. Reg 0x0E → read / ← write data
const MMD_CTRL = 0x0D;
const MMD_DATA = 0x0E;
const FN_DATA  = 0x4000; // function=01 (data, no post-increment)

async function mmdSetAddr(req, acc, phyAddr, devad, regAddr) {
  await mdioXact(req, acc, accCmd(true, phyAddr, MMD_CTRL, devad & 0x1F));           // fn=Address
  await mdioXact(req, acc, accCmd(true, phyAddr, MMD_DATA, regAddr & 0xFFFF));       // target addr
  await mdioXact(req, acc, accCmd(true, phyAddr, MMD_CTRL, FN_DATA | (devad & 0x1F))); // fn=Data
}

async function mmdRead(req, acc, phyAddr, devad, regAddr) {
  await mmdSetAddr(req, acc, phyAddr, devad, regAddr);
  const raw = await mdioXact(req, acc, accCmd(false, phyAddr, MMD_DATA));
  return raw & 0xFFFF;
}

async function mmdWrite(req, acc, phyAddr, devad, regAddr, data) {
  await mmdSetAddr(req, acc, phyAddr, devad, regAddr);
  await mdioXact(req, acc, accCmd(true, phyAddr, MMD_DATA, data & 0xFFFF));
}

// ── POST /api/mdio/read ───────────────────────────────────────────────────────
// body: { port, phyAddr, regAddr, devad? }
// regAddr 0x00-0x1F → direct ACC read.
// regAddr > 0x1F (or devad given) → indirect MMD access (devad defaults to 0x1F).
router.post('/mdio/read', async (req, res) => {
  try {
    const port    = Number(req.body.port ?? 0);
    const phyAddr = parseHex(req.body.phyAddr ?? '0x00');
    const regAddr = parseHex(req.body.regAddr ?? '0x01');
    const devad   = req.body.devad != null ? parseHex(req.body.devad) : 0x1F;
    const indirect = regAddr > 0x1F || req.body.devad != null;

    if (port < 0 || port > 5) throw new Error('port must be 0-5');
    const acc = blockBase(port) + OFF_ACC;

    const value = indirect
      ? await mmdRead(req, acc, phyAddr, devad, regAddr)
      : (await mdioXact(req, acc, accCmd(false, phyAddr, regAddr))) & 0xFFFF;

    res.json({ ok: true, value: '0x' + value.toString(16).toUpperCase().padStart(4, '0'), raw: value,
               access: indirect ? 'mmd-indirect' : 'direct', devad: indirect ? devad : undefined });
  } catch (e) { wErr(res, e); }
});

// ── POST /api/mdio/write ──────────────────────────────────────────────────────
// body: { port, phyAddr, regAddr, value, devad? }
// Same direct/indirect auto-branch as /mdio/read.
router.post('/mdio/write', async (req, res) => {
  try {
    const port    = Number(req.body.port ?? 0);
    const phyAddr = parseHex(req.body.phyAddr ?? '0x00');
    const regAddr = parseHex(req.body.regAddr ?? '0x01');
    const data    = parseHex(req.body.value   ?? '0x0000') & 0xFFFF;
    const devad   = req.body.devad != null ? parseHex(req.body.devad) : 0x1F;
    const indirect = regAddr > 0x1F || req.body.devad != null;

    if (port < 0 || port > 5) throw new Error('port must be 0-5');
    const acc = blockBase(port) + OFF_ACC;

    if (indirect) await mmdWrite(req, acc, phyAddr, devad, regAddr, data);
    else          await mdioXact(req, acc, accCmd(true, phyAddr, regAddr, data));

    res.json({ ok: true, access: indirect ? 'mmd-indirect' : 'direct', devad: indirect ? devad : undefined });
  } catch (e) { wErr(res, e); }
});

// ── GET /api/mdio/link-status ─────────────────────────────────────────────────
// Reads BMSR (reg 0x01) bit2 for all 6 ports.
// BMSR bit2 is a latch-low bit per IEEE 802.3 — must be read twice:
// first read clears the latch, second read reflects the actual current state.
router.get('/mdio/link-status', async (req, res) => {
  try {
    const ports = [];

    async function readBmsr(acc, cmd) {
      await regWrite(req, acc, cmd);
      const deadline = Date.now() + 1000;
      let raw = cmd;
      let timedOut = true;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 50));
        raw = await regRead(req, acc);
        if ((raw & 0x80000000) === 0) { timedOut = false; break; }
      }
      return timedOut ? null : (raw & 0xFFFF);
    }

    for (let port = 0; port < 6; port++) {
      const phyAddr = PHY_ADDRS[port];
      const acc     = blockBase(port) + OFF_ACC;
      const cmd     = 0x80000000 | ((phyAddr & 0x1F) << 21) | ((0x01) << 16);

      // Read SETUP and TIME registers first — these are plain AHB reads,
      // independent of MDIO enable state, so they must run before readBmsr
      // which may timeout (and continue) for disabled/inactive ports.
      let setup = null;
      try {
        const setupOff = blockBase(port) + OFF_SETUP;
        const timeOff  = blockBase(port) + OFF_TIME;
        const setupVal = await regRead(req, setupOff);
        const timeVal  = await regRead(req, timeOff);

        const enable     = Boolean(setupVal & 0x00010000);
        const preDisable = Boolean(setupVal & 0x01000000);
        const intrEnable = Boolean(setupVal & 0x80000000);
        const clk        = timeVal & 0xFF;
        const ms         = (timeVal >>> 8) & 0xFFF;
        const unit       = (timeVal >>> 20) & 0xFFF;
        const targetMhz  = ms > 0 ? parseFloat((ms / 1000).toFixed(3)) : 2.5;
        setup = { enable, preDisable, intrEnable, clk, ms, unit, targetMhz };
      } catch (e) { console.warn(`[mdio] setup read port ${port}: ${e.message}`); }

      // First BMSR read — clears latch
      const first = await readBmsr(acc, cmd);
      if (first === null) { ports.push({ port, linkUp: null, setup }); continue; }

      // Second BMSR read — actual current link state
      const second = await readBmsr(acc, cmd);
      if (second === null) { ports.push({ port, linkUp: null, setup }); continue; }

      // 0xFFFF: no PHY responded (bus pulled high) → no link
      const linkUp = second === 0xFFFF ? false : Boolean(second & 0x0004);
      ports.push({ port, linkUp, setup });
    }
    res.json({ ok: true, ports });
  } catch (e) { wErr(res, e); }
});

// ── POST /api/mdio/setup ──────────────────────────────────────────────────────
// body: { port, enable, preDisable, interruptEnable, targetMhz }
// Matches C# MdioViewModel.ApplyAsync logic
router.post('/mdio/setup', async (req, res) => {
  try {
    const port       = Number(req.body.port ?? 0);
    const enable     = Boolean(req.body.enable);
    const preDisable = Boolean(req.body.preDisable);
    const intrEnable = Boolean(req.body.interruptEnable);
    const targetMhz  = Number(req.body.targetMhz ?? 2.5);

    if (port < 0 || port > 5) throw new Error('port must be 0-5');

    const setupOff = blockBase(port) + OFF_SETUP;
    const timeOff  = blockBase(port) + OFF_TIME;

    // 1. Disable first
    let setupDis = 0x00600000; // TA=b10, SOF=b01 base
    if (preDisable) setupDis |= 0x01000000;
    if (intrEnable) setupDis |= 0x80000000;
    await regWrite(req, setupOff, setupDis);
    await new Promise(r => setTimeout(r, 10));

    // 2. Compute clock dividers (AHB = 100 MHz)
    const ahbMhz = 100.0;
    const clk = Math.max(1, Math.min(255, Math.round(ahbMhz / (2.0 * targetMhz))));
    const ms  = Math.max(1, Math.min(4095, Math.round(targetMhz * 1000.0)));
    const unit = 100;
    const timeReg = ((unit & 0xFFF) << 20) | ((ms & 0xFFF) << 8) | (clk & 0xFF);
    await regWrite(req, timeOff, timeReg);

    // 3. Apply SETUP with requested enable state
    let setupFin = 0x00600000;
    if (enable)     setupFin |= 0x00010000;
    if (preDisable) setupFin |= 0x01000000;
    if (intrEnable) setupFin |= 0x80000000;
    await regWrite(req, setupOff, setupFin);

    res.json({ ok: true, setup: '0x' + setupFin.toString(16).toUpperCase().padStart(8, '0'), time: '0x' + timeReg.toString(16).toUpperCase().padStart(8, '0'), clk, ms });
  } catch (e) { wErr(res, e); }
});

module.exports = router;
