import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMember } from '../src/domain.mjs';
import { calculateCharacterStats } from '../src/character-stats.mjs';

const names = ['catalog', 'pricing-policy', 'character-stats', 'equipment-bonuses', 'free-levels', 'free-equipment'];
const [catalog, policy, stats, bonuses, levels, extension] = await Promise.all(names.map(async name => JSON.parse(await readFile(new URL(`../public/data/${name}.json`, import.meta.url)))));
const fixedCatalog = { ...catalog, characterStats: stats, equipmentBonuses: bonuses };
const freeCatalog = {
  ...fixedCatalog, freeLevels: levels, limits: { ...catalog.limits, ...extension.limits },
  equipmentCosts: { ...catalog.equipmentCosts, ...extension.equipmentCosts },
  characterStats: { ...stats, equipment: { ...stats.equipment, ...extension.characterStats.equipment }, reinforcementCoefficients: extension.characterStats.reinforcementCoefficients },
};
const freePolicy = (level = 450, playerLevel = 560) => ({ ...policy, mode: 'free', characterLevel: level, baseline: { ...policy.baseline, playerLevel, levelLink: { level, subLevel: 0 } } });

test('free levels expose only selected identities, contiguous real ranges and compact display curves', () => {
  assert.equal(levels.schemaVersion, 1);
  assert.equal(levels.scope, 'selectedRosterVariableLevels');
  assert.deepEqual(levels.limits, { characterLevel: { min: 1, max: 1000 }, playerLevel: { min: 1, max: 1100 } });
  assert.equal(levels.characterSubLevel, 0);
  assert.equal(levels.characterLevelPotential.length, 1001);
  assert.equal(levels.playerRankBonuses.length, 1101);
  assert.equal(levels.characterLevelPotential[0], null);
  assert.equal(levels.playerRankBonuses[0], null);
  assert.deepEqual([1, 240, 450, 1000].map(level => levels.characterLevelPotential[level]), [2450, 894911, 4492210, 13640668]);
  assert.deepEqual(Object.keys(levels.characters).map(Number).sort((a, b) => a - b), catalog.characters.map(row => row.id).sort((a, b) => a - b));
  for (const source of catalog.characters) {
    const projected = levels.characters[source.id];
    assert.equal(projected.originRarity, source.baseRarity ?? 8);
    assert.ok(Number.isSafeInteger(projected.weightTotal) && projected.weightTotal > 0);
    assert.ok(projected.weights.every(value => Number.isSafeInteger(value) && value > 0));
    assert.deepEqual(Object.keys(projected).sort(), ['originRarity', 'weightTotal', 'weights']);
  }
  for (const row of levels.playerRankBonuses.slice(1)) assert.equal(row.length, levels.playerRankFields.length);
  assert.deepEqual(levels.sources, stats.sources);
  const serialized = JSON.stringify({ levels, extension });
  assert.doesNotMatch(serialized, /IsIgnore|RequiredTotalExp|SkillId|CharacterMB.*(?:D:\\|C:\\)|master_record|WorldId|Token/i);
  for (const source of extension.sources) assert.match(source.sha256, /^[a-f0-9]{64}$/);
});

test('variable 450 and player560 retain every existing character and rarity panel exactly', () => {
  for (const character of catalog.characters) for (const rarity of character.allowedRarities ?? ['SR', 'LR', 'LR5']) {
    const member = { ...createMember(character.id), rarity };
    const fixed = calculateCharacterStats(member, fixedCatalog, policy);
    const free = calculateCharacterStats(member, freeCatalog, freePolicy());
    assert.equal(free.valid, true, `${character.id}/${rarity}: ${JSON.stringify(free.errors)}`);
    assert.deepEqual(free, fixed, `${character.id}/${rarity}`);
  }
});

test('independent low/high level anchors change growth and actual rank bonuses without clamping to450/560', () => {
  const member = { ...createMember(8), rarity: 'LR5' };
  const minimum = calculateCharacterStats(member, freeCatalog, freePolicy(1, 1));
  assert.equal(minimum.valid, true);
  assert.deepEqual(minimum.base, { Muscle: 7198, Energy: 6180, Intelligence: 6180, Health: 5017 });
  assert.equal(minimum.battle.AttackPower, 7201);
  assert.equal(minimum.battle.HP, 50167);
  assert.equal(minimum.battle.Speed, 3022);
  const maximum = calculateCharacterStats(member, freeCatalog, freePolicy(1000, 1100));
  assert.equal(maximum.valid, true);
  assert.deepEqual(maximum.base, { Muscle: 12116640, Energy: 10403175, Intelligence: 10403175, Health: 8444931 });
  assert.equal(maximum.battle.AttackPower, 13650261);
  assert.equal(maximum.battle.HP, 182942455);
  assert.ok(maximum.notes[0].includes('1000') && maximum.notes[0].includes('1100'));
  assert.ok(maximum.rows.find(row => row.key === 'AttackPower').parts.some(part => part.label.includes('玩家1100级')));
  assert.ok(maximum.battle.AttackPower > calculateCharacterStats(member, freeCatalog, freePolicy(1000, 1)).battle.AttackPower);
  assert.ok(calculateCharacterStats(member, freeCatalog, freePolicy(451, 560)).base.Muscle > calculateCharacterStats(member, freeCatalog, freePolicy()).base.Muscle);
});

test('out-of-table, fractional, missing or unsupported sublevels fail explicitly and fixed mode remains fixed', () => {
  const member = createMember(8);
  for (const [level, rank] of [[0, 1], [1001, 1], [450.5, 560], [450, 0], [450, 1101], [450, 560.5]]) {
    const result = calculateCharacterStats(member, freeCatalog, freePolicy(level, rank));
    assert.equal(result.valid, false, `${level}/${rank}`);
    assert.equal(result.rows.length, 0);
  }
  const subLevel = freePolicy(); subLevel.baseline.levelLink.subLevel = 1;
  assert.equal(calculateCharacterStats(member, freeCatalog, subLevel).valid, false);
  assert.equal(calculateCharacterStats(member, { ...freeCatalog, freeLevels: null }, freePolicy()).valid, false);
  assert.equal(calculateCharacterStats(member, freeCatalog, { ...freePolicy(451), mode: undefined }).valid, false);
  assert.equal(calculateCharacterStats(member, freeCatalog, { ...freePolicy(450, 561), mode: undefined }).valid, false);
});

test('free gear extension retains every old cumulative amount and adds real higher-level equipment and reinforcement', () => {
  assert.deepEqual(extension.limits, { equipmentLevel: 1000, reinforcementLevel: 1000 });
  for (const [kind, oldCurve] of Object.entries(catalog.equipmentCosts.fragments)) {
    for (const [level, value] of Object.entries(oldCurve)) assert.equal(extension.equipmentCosts.fragments[kind][level], value, `${kind}/${level}`);
  }
  for (const kind of ['weapon', 'other']) assert.deepEqual(extension.equipmentCosts.reinforcement[kind].slice(0, 451), catalog.equipmentCosts.reinforcement[kind]);
  assert.deepEqual(extension.characterStats.reinforcementCoefficients.slice(0, 451), stats.reinforcementCoefficients);
  assert.equal(extension.characterStats.reinforcementCoefficients[1000], 40.903);
  assert.equal(extension.equipmentCosts.reinforcement.weapon[1000], 35698);
  assert.equal(extension.equipmentCosts.reinforcement.other[1000], 17849);
  assert.deepEqual(['SSR', 'UR', 'LR', 'exclusiveUR', 'exclusiveLR'].map(kind => extension.equipmentCosts.fragments[kind][1000]), [2785, 2780, 2780, 3150, 3150]);
  assert.deepEqual(extension.equipmentCosts.allowedLevels.exclusiveSSR, [180, 200, 220, 240]);
  assert.ok(Object.keys(extension.characterStats.equipment).every(key => Number(key.split(':').at(-1)) > 450));
  const member = { ...createMember(8), rarity: 'LR5' };
  for (const gear of member.equipment) Object.assign(gear, { rarity: 'LR', level: 1000, reinforcementLevel: 1000, weaponKind: gear.slot === 1 ? 'exclusive' : 'normal', legendSacredTreasureLevel: 40, matchlessSacredTreasureLevel: 40 });
  const result = calculateCharacterStats(member, freeCatalog, freePolicy(1000, 1100));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.ok(result.battle.AttackPower > 13650261);
  assert.equal(calculateCharacterStats(member, { ...freeCatalog, characterStats: stats }, freePolicy(1000, 1100)).valid, false);
  member.equipment[0].reinforcementLevel = 1001;
  assert.equal(calculateCharacterStats(member, freeCatalog, freePolicy(1000, 1100)).valid, false);
});
