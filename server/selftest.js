// Headless simulation: runs bot-only matches of every mode at accelerated
// speed and checks that combat, captures and vehicles work without errors.
import { Match } from './match.js';
import { MODES } from '../shared/modes.js';
import { MAPS } from '../shared/maps.js';

const seconds = +(process.argv[2] || 120);
let failed = false;
const modes = process.argv[3] ? [process.argv[3]] : Object.keys(MODES);
for (const modeId of modes) {
  const mapId = Math.floor(Math.random() * MAPS.length);
  const m = new Match(modeId, mapId, { headless: true });
  m.fillBots();
  m.start();
  const t0 = Date.now();
  let ticks = 0;
  try {
    const dur = (modeId === 'conquest' ? Math.max(seconds, 300) : seconds) * 1000; // big maps need time for armies to meet
    while (m.time < dur && !m.ended) { m.tick(); m.flush(); ticks++; }
  } catch (e) { console.error(modeId, e); failed = true; continue; }
  const ms = Date.now() - t0;
  const kills = [...m.players.values()].reduce((a, p) => a + p.kills, 0);
  const vehUsed = m.vehicles.filter((v) => v.driver >= 0).length;
  const caps = m.objectives.map((o) => `${o.id}:${o.owner}`).join(' ');
  console.log(`${modeId.padEnd(13)} ${m.map.name.padEnd(18)} ${m.players.size}p  sim ${Math.round(m.time / 1000)}s in ${ms}ms (${(ms / ticks).toFixed(2)}ms/tick)  kills=${kills} vehiclesDriven=${vehUsed} tickets=${m.tickets.map(Math.round)} flags=[${caps}] ended=${m.ended}`);
  if (kills === 0) { console.error('  !! no kills happened'); failed = true; }
}
process.exit(failed ? 1 : 0);
