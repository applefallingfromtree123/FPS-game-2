// 40 WARFIELD battlefields. Terrain, towns, trees and objectives are generated
// deterministically from each map's seed (see world.js).
import { hashString } from './rng.js';

export const BIOMES = {
  forest:    { grass: [0.22, 0.36, 0.12], dirt: [0.33, 0.27, 0.18], rock: [0.42, 0.41, 0.38], sand: [0.6, 0.55, 0.4],  grassDensity: 1.0, grassHeight: 0.55, treeDensity: 1.0, trees: ['pine', 'oak'],  relief: 55, fog: [0.62, 0.7, 0.78], foliage: [0.16, 0.3, 0.1] },
  autumn:    { grass: [0.42, 0.38, 0.14], dirt: [0.35, 0.26, 0.16], rock: [0.45, 0.42, 0.38], sand: [0.6, 0.55, 0.4],  grassDensity: 0.9, grassHeight: 0.5, treeDensity: 0.9, trees: ['oak', 'birch', 'pine'], relief: 50, fog: [0.75, 0.68, 0.58], foliage: [0.7, 0.33, 0.08] },
  desert:    { grass: [0.62, 0.52, 0.32], dirt: [0.72, 0.6, 0.42], rock: [0.6, 0.45, 0.32], sand: [0.82, 0.7, 0.48],  grassDensity: 0.18, grassHeight: 0.35, treeDensity: 0.06, trees: ['palm'], relief: 40, fog: [0.86, 0.78, 0.64], foliage: [0.36, 0.42, 0.18], dunes: true },
  snow:      { grass: [0.86, 0.89, 0.93], dirt: [0.62, 0.62, 0.64], rock: [0.4, 0.41, 0.44], sand: [0.8, 0.82, 0.85], grassDensity: 0.0, grassHeight: 0.3, treeDensity: 0.7, trees: ['snowpine'], relief: 70, fog: [0.82, 0.86, 0.92], foliage: [0.12, 0.22, 0.14], snow: true },
  jungle:    { grass: [0.18, 0.36, 0.08], dirt: [0.3, 0.22, 0.12], rock: [0.35, 0.36, 0.3], sand: [0.66, 0.6, 0.44],  grassDensity: 1.3, grassHeight: 0.85, treeDensity: 1.6, trees: ['palm', 'jungle', 'oak'], relief: 45, fog: [0.6, 0.7, 0.62], foliage: [0.12, 0.34, 0.06] },
  plains:    { grass: [0.36, 0.44, 0.16], dirt: [0.4, 0.32, 0.2], rock: [0.45, 0.43, 0.4], sand: [0.6, 0.55, 0.4],    grassDensity: 1.25, grassHeight: 0.7, treeDensity: 0.25, trees: ['oak', 'birch'], relief: 25, fog: [0.7, 0.76, 0.82], foliage: [0.25, 0.38, 0.12] },
  mountains: { grass: [0.28, 0.36, 0.18], dirt: [0.36, 0.31, 0.24], rock: [0.46, 0.45, 0.43], sand: [0.6, 0.55, 0.4], grassDensity: 0.7, grassHeight: 0.4, treeDensity: 0.6, trees: ['pine'], relief: 150, fog: [0.7, 0.75, 0.82], foliage: [0.13, 0.25, 0.1] },
  urban:     { grass: [0.3, 0.38, 0.18], dirt: [0.38, 0.36, 0.33], rock: [0.45, 0.45, 0.45], sand: [0.55, 0.53, 0.48], grassDensity: 0.55, grassHeight: 0.4, treeDensity: 0.3, trees: ['oak', 'birch'], relief: 20, fog: [0.68, 0.7, 0.74], foliage: [0.2, 0.32, 0.12], city: true },
  wasteland: { grass: [0.42, 0.38, 0.26], dirt: [0.36, 0.3, 0.24], rock: [0.3, 0.28, 0.27], sand: [0.55, 0.48, 0.36], grassDensity: 0.3, grassHeight: 0.35, treeDensity: 0.12, trees: ['dead'], relief: 60, fog: [0.62, 0.56, 0.5], foliage: [0.3, 0.28, 0.2] },
  savanna:   { grass: [0.58, 0.5, 0.22], dirt: [0.55, 0.4, 0.25], rock: [0.5, 0.42, 0.34], sand: [0.72, 0.62, 0.42], grassDensity: 1.1, grassHeight: 0.8, treeDensity: 0.12, trees: ['acacia'], relief: 30, fog: [0.82, 0.76, 0.62], foliage: [0.3, 0.38, 0.12] },
};

export const TIMES = {
  morning:  { sunElev: 18, sunAz: 110, turbidity: 6, rayleigh: 1.6, exposure: 0.55, fogDensity: 0.0011, sunColor: [1.0, 0.9, 0.78], sunIntensity: 3.0, hemi: 0.9 },
  noon:     { sunElev: 62, sunAz: 160, turbidity: 3, rayleigh: 1.0, exposure: 0.5, fogDensity: 0.0008, sunColor: [1.0, 0.97, 0.92], sunIntensity: 3.6, hemi: 1.0 },
  afternoon:{ sunElev: 38, sunAz: 220, turbidity: 4, rayleigh: 1.2, exposure: 0.5, fogDensity: 0.0009, sunColor: [1.0, 0.94, 0.84], sunIntensity: 3.4, hemi: 0.95 },
  dusk:     { sunElev: 6,  sunAz: 260, turbidity: 9, rayleigh: 2.6, exposure: 0.62, fogDensity: 0.0013, sunColor: [1.0, 0.66, 0.4], sunIntensity: 2.4, hemi: 0.7 },
  overcast: { sunElev: 45, sunAz: 180, turbidity: 18, rayleigh: 3.0, exposure: 0.45, fogDensity: 0.0018, sunColor: [0.85, 0.87, 0.9], sunIntensity: 1.3, hemi: 1.3, clouds: 0.85 },
  storm:    { sunElev: 30, sunAz: 200, turbidity: 20, rayleigh: 3.5, exposure: 0.4, fogDensity: 0.0026, sunColor: [0.7, 0.74, 0.8], sunIntensity: 0.9, hemi: 1.2, clouds: 1.0, rain: true },
  dawn:     { sunElev: 4,  sunAz: 95,  turbidity: 8, rayleigh: 2.2, exposure: 0.62, fogDensity: 0.0016, sunColor: [1.0, 0.72, 0.5], sunIntensity: 2.2, hemi: 0.75 },
};

const DEFS = [
  ['Iron Valley', 'forest', 'morning', 2000],
  ['Red Dunes', 'desert', 'noon', 2200],
  ['Frozen Pass', 'snow', 'overcast', 1900],
  ['Harbor Siege', 'urban', 'afternoon', 1800, { coast: true }],
  ['Jungle Delta', 'jungle', 'morning', 2000, { lakes: true }],
  ['Highland Rift', 'mountains', 'noon', 2400],
  ['Golden Fields', 'plains', 'afternoon', 2200],
  ['Steel City', 'urban', 'noon', 1600, { dense: true }],
  ['Ashen Wastes', 'wasteland', 'dusk', 2000],
  ['Autumn Ridge', 'autumn', 'morning', 2000],
  ['Coral Atoll', 'jungle', 'noon', 2000, { island: true }],
  ['Glacier Point', 'snow', 'noon', 2200],
  ['Canyon Run', 'desert', 'afternoon', 2400, { canyon: true }],
  ['Silent Pines', 'forest', 'overcast', 1900],
  ['Monsoon River', 'jungle', 'storm', 2000, { lakes: true }],
  ['Northern Front', 'snow', 'dawn', 2100],
  ['Oasis Strike', 'desert', 'morning', 2000, { lakes: true }],
  ['Metro Outskirts', 'urban', 'overcast', 1800, { dense: true }],
  ['Thunder Plains', 'plains', 'storm', 2400],
  ['Black Forest', 'forest', 'dusk', 2000],
  ['Volcanic Isle', 'wasteland', 'afternoon', 2000, { island: true }],
  ['Tundra Line', 'snow', 'afternoon', 2400],
  ['Sunset Bay', 'urban', 'dusk', 2000, { coast: true }],
  ['Verdant Hills', 'plains', 'morning', 2200],
  ['Dust Bowl', 'desert', 'overcast', 2000],
  ['Crimson Valley', 'autumn', 'dusk', 2100],
  ['Lakeside Assault', 'forest', 'noon', 2000, { lakes: true }],
  ['Ruined Capital', 'wasteland', 'overcast', 1800, { dense: true, city: true }],
  ['Mangrove Swamp', 'jungle', 'overcast', 1900, { lakes: true }],
  ['Alpine Fortress', 'mountains', 'morning', 2300],
  ['Savanna Hunt', 'savanna', 'afternoon', 2400],
  ['Shipyard Zero', 'urban', 'storm', 1800, { coast: true }],
  ['Granite Quarry', 'mountains', 'afternoon', 2000, { canyon: true }],
  ['Rainforest Ops', 'jungle', 'afternoon', 2000],
  ['Wheatland Crossing', 'plains', 'noon', 2200, { lakes: true }],
  ['Polar Station', 'snow', 'storm', 1900],
  ['Mesa Verde', 'desert', 'dusk', 2300, { canyon: true }],
  ['Riverside Town', 'autumn', 'afternoon', 2000, { lakes: true, city: true }],
  ['Storm Coast', 'forest', 'storm', 2100, { coast: true }],
  ['Last Bastion', 'mountains', 'dusk', 2200],
];

export const MAPS = DEFS.map(([name, biome, time, size, opts = {}], id) => ({
  id, name, biome, time, size, seed: hashString(name), ...opts,
}));
