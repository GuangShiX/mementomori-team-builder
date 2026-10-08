import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMember, createTeam, getArcanaState } from '../src/domain.mjs';
import { allocatePolish, calculateCharacterStats } from '../src/character-stats.mjs';
import { applyEquipmentPreset, changeMemberRarity } from '../src/equipment-presets.mjs';

function fixture() {
  const initialBattle = Object.fromEntries(['Hp', 'AttackPower', 'PhysicalDamageRelax', 'MagicDamageRelax', 'Hit', 'Avoidance', 'Critical', 'CriticalResist', 'CriticalDamageEnhance', 'PhysicalCriticalDamageRelax', 'MagicCriticalDamageRelax', 'DefensePenetration', 'Defense', 'DamageEnhance', 'DebuffHit', 'DebuffResist', 'DamageReflect', 'HpDrain', 'Speed'].map(key => [key, 0]));
  initialBattle.Defense = 10; initialBattle.Speed = 3000;
  const stats = {
    schemaVersion: 1, characterLevel: 450, polish: { selectedPercent: 60 },
    characters: { 1: { job: 1, baseByRarity: { SR: { Muscle: 100, Energy: 200, Intelligence: 300, Health: 400 } }, initialBattle } },
    rank560: { rank: 560, bonuses: { AttackPowerBonus: 5, AttackPowerPercentBonus: 0, HpBonus: 100, HpPercentBonus: 2000, HitBonus: 30 } },
    equipment: { 'normal:1:SSR:180': { battleChange: { group: 'battle', type: 2, changeType: 1, value: 10 }, setId: 0, polishTotal: 100 } },
    reinforcementCoefficients: Array(451).fill(2), runes: {}, sets: {}, exclusiveEffects: {},
  };
  return { catalog: { characterStats: stats, equipmentBonuses: { kinds: {} } }, policy: { characterLevel: 450, baseline: { playerLevel: 560, levelLink: { subLevel: 0 } } }, stats };
}
const effect = (group, type, changeType, value) => ({ group, type, changeType, value });
const install = (member, slot, options = {}) => Object.assign(member.equipment[slot - 1], { rarity: 'SSR', weaponKind: 'normal', level: 180, reinforcementLevel: 180, ...options });

test('integer full polish respects the real sixty percent cap, conserves totals and resolves main attributes for all jobs', () => {
  const settings = { selectedPercent: 60 };
  assert.deepEqual(allocatePolish(100, 'main', 1, settings), { Muscle: 60, Energy: 14, Intelligence: 13, Health: 13 });
  assert.deepEqual(allocatePolish(7, 'none', 1, settings), { Muscle: 2, Energy: 2, Intelligence: 2, Health: 1 });
  for (const [job, key] of [[1, 'Muscle'], [2, 'Energy'], [4, 'Intelligence']]) {
    const distribution = allocatePolish(535149, 'main', job, settings);
    assert.equal(Object.values(distribution).reduce((sum, value) => sum + value, 0), 535149);
    assert.equal(distribution[key], 321090);
  }
  assert.throws(() => allocatePolish(100, 'unknown', 1, settings));
});

test('rank HP is inside its percentage, rank attack is outside, and four dimensional conversion uses the polished values', () => {
  const { catalog, policy } = fixture();
  const member = createMember(1); install(member, 1);
  const result = calculateCharacterStats(member, catalog, policy);
  assert.equal(result.valid, true);
  assert.deepEqual(result.base, { Muscle: 160, Energy: 214, Intelligence: 313, Health: 413 });
  assert.equal(result.battle.AttackPower, 185);
  assert.equal(result.battle.HP, 5076);
  assert.equal(result.battle.Hit, 110);
  assert.equal(result.battle.Defense, 10);
  assert.equal(result.battle.Speed, 3000);
  const natural = calculateCharacterStats(createMember(1), catalog, policy);
  assert.equal(natural.battle.AttackPower, 105);
  assert.equal(natural.battle.HP, 4920);
  assert.ok(result.notes.some(note => note.includes('560')));
  assert.equal(member.equipment[0].polishAttribute, 'main');
});

test('base rune, own exclusive, set and arcana changes use their correct order and a borrowed weapon does not grant owner effects', () => {
  const { catalog, policy, stats } = fixture();
  const template = { battleChange: null, setId: 13, polishTotal: 100 };
  stats.equipment['exclusive:1:UR:240'] = template;
  stats.equipment['normal:2:UR:240'] = template;
  stats.exclusiveEffects['1:UR'] = { baseChanges: [effect('base', 1, 2, 2000)], battleChanges: [effect('battle', 19, 1, 10)] };
  stats.runes['1:11'] = [effect('base', 1, 1, 20)];
  stats.sets[13] = [{ requiredCount: 2, effects: [effect('base', 1, 2, 1000)] }, { requiredCount: 4, effects: [effect('battle', 19, 1, 100)] }];
  const member = createMember(1);
  install(member, 1, { rarity: 'UR', weaponKind: 'exclusive', level: 240 });
  install(member, 2, { rarity: 'UR', level: 240 });
  member.equipment[0].runes[0] = { categoryId: 1, level: 11 };
  const arcana = { bonusRows: [
    { kind: 'base', type: 1, changeType: 1, value: 10 },
    { kind: 'base', type: 1, changeType: 3, value: 2 },
    { kind: 'base', type: 1, changeType: 2, value: 1000 },
  ] };
  const own = calculateCharacterStats(member, catalog, policy, arcana);
  assert.equal(own.valid, true);
  assert.equal(own.base.Muscle, 1348);
  assert.equal(own.battle.Speed, 3010);
  member.equipment[0].weaponOwnerCharacterId = 2;
  const borrowed = calculateCharacterStats(member, catalog, policy, arcana);
  assert.equal(borrowed.valid, true);
  assert.equal(borrowed.base.Muscle, 1291);
  assert.equal(borrowed.battle.Speed, 3000);
});

test('holy and dark terms keep their separate percent and flat units with fractional conversion truncated only at the final stage', () => {
  const { catalog, policy } = fixture();
  catalog.equipmentBonuses.kinds = {
    legend: { slots: { 1: { parameterTypeId: 2, changeParameterTypeId: 2, unit: 'percent', values: [0, 60] } } },
    matchless: { slots: { 1: { parameterTypeId: 2, changeParameterTypeId: 1, unit: 'flat', values: [0, 100] } } },
  };
  const member = createMember(1);
  install(member, 1, { legendSacredTreasureLevel: 1, matchlessSacredTreasureLevel: 1 });
  const result = calculateCharacterStats(member, catalog, policy);
  assert.equal(result.valid, true);
  assert.equal(result.battle.AttackPower, 453);
  assert.equal(result.rows.find(row => row.key === 'AttackPower').parts.find(part => part.label === '圣装比例').displayValue, '60%');
  assert.equal(result.rows.length, 23);
});

test('unsupported level, illegal gear, missing curves and forged effect types produce an explicit error rather than plausible stats', () => {
  const cases = [
    ({ policy }) => { policy.baseline.playerLevel = 561; },
    ({ policy }) => { policy.characterLevel = 449; },
    ({ member }) => { install(member, 1, { rarity: 'LR' }); },
    ({ member }) => { install(member, 1, { level: 999 }); },
    ({ member }) => { install(member, 1, { matchlessSacredTreasureLevel: 41 }); },
    ({ member }) => { install(member, 1); member.equipment[0].runes[0] = { categoryId: 99, level: 11 }; },
    ({ stats, member }) => { install(member, 1); stats.equipment['normal:1:SSR:180'].battleChange.type = 999; },
  ];
  for (const change of cases) {
    const inputs = { ...fixture(), member: createMember(1) }; change(inputs);
    const result = calculateCharacterStats(inputs.member, inputs.catalog, inputs.policy);
    assert.equal(result.valid, false);
    assert.equal(result.rows.length, 0);
    assert.ok(result.errors[0].message);
  }
});

test('actual public data calculates every selectable character and rarity while current free arcana affects the static panel', async () => {
  const names = ['catalog', 'pricing-policy', 'free-library', 'arcana-catalog', 'equipment-bonuses', 'character-stats'];
  const [catalog, policy, library, arcana, equipmentBonuses, characterStats] = await Promise.all(names.map(async name => JSON.parse(await readFile(new URL(`../public/data/${name}.json`, import.meta.url)))));
  Object.assign(catalog, { arcana, equipmentBonuses, characterStats });
  for (const character of catalog.characters) for (const rarity of character.allowedRarities ?? ['SR', 'LR', 'LR5']) {
    const team = createTeam(); team.members[0] = { ...createMember(character.id), rarity };
    const state = getArcanaState(team, catalog, policy, library);
    const result = calculateCharacterStats(team.members[0], catalog, policy, state);
    assert.equal(result.valid, true, `${character.id}/${rarity}: ${JSON.stringify(result.errors)}`);
    assert.ok(result.battle.HP > 0 && result.battle.AttackPower > 0 && result.battle.Speed > 0);
  }
  const member = applyEquipmentPreset({ ...createMember(8), rarity: 'LR5' }, 'lr6', catalog, policy);
  const withGear = calculateCharacterStats(member, catalog, policy);
  const after = calculateCharacterStats(changeMemberRarity(member, 'LR', catalog), catalog, policy);
  assert.equal(withGear.valid, true);
  assert.equal(after.valid, true);
  assert.ok(withGear.battle.AttackPower > after.battle.AttackPower);
});

test('R LR5 and natural N panels support real borrowed UR weapons without inventing their own exclusive effects', async () => {
  const [catalog, policy, characterStats, equipmentBonuses] = await Promise.all(['catalog', 'pricing-policy', 'character-stats', 'equipment-bonuses'].map(async name => JSON.parse(await readFile(new URL(`../public/data/${name}.json`, import.meta.url)))));
  Object.assign(catalog, { characterStats, equipmentBonuses });
  for (const [id, rarity, owner, speed, naturalAttack, borrowedAttack] of [
    [1, 'N', 27, 2600, 1450379, 1721509],
    [2, 'LR5', 8, 2733, 3997737, 4268867],
    [32, 'LR5', 46, 2590, 3997732, 4268862],
  ]) {
    const member = { ...createMember(id), rarity };
    const natural = calculateCharacterStats(member, catalog, policy);
    assert.equal(natural.valid, true);
    assert.equal(natural.battle.AttackPower, naturalAttack);
    assert.equal(natural.battle.Speed, speed);
    Object.assign(member.equipment[0], { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', weaponOwnerCharacterId: owner,
      level: 240, reinforcementLevel: 0, legendSacredTreasureLevel: 0, matchlessSacredTreasureLevel: 0 });
    const borrowed = calculateCharacterStats(member, catalog, policy);
    assert.equal(borrowed.valid, true, JSON.stringify(borrowed.errors));
    assert.equal(borrowed.battle.AttackPower, borrowedAttack);
    assert.equal(borrowed.battle.Speed, speed);
    assert.ok(borrowed.battle.AttackPower > natural.battle.AttackPower);
  }
});

test('three real full builds retain their independently calibrated rank560 panels', async () => {
  const [catalog, policy, characterStats, equipmentBonuses] = await Promise.all(['catalog', 'pricing-policy', 'character-stats', 'equipment-bonuses'].map(async name => JSON.parse(await readFile(new URL(`../public/data/${name}.json`, import.meta.url)))));
  Object.assign(catalog, { characterStats, equipmentBonuses });
  // Independent offline reference evaluated these synthetic builds without any
  // account snapshot: 6LR450, reinforce450, sacred40, magic40, no rune or arcana.
  for (const [id, attack, hp] of [[27, 25701368, 75366088], [8, 25621491, 75366086], [26, 24719116, 95193244]]) {
    const member = applyEquipmentPreset({ ...createMember(id), rarity: 'LR5' }, 'lr6', catalog, policy);
    for (const gear of member.equipment) Object.assign(gear, { level: 450, reinforcementLevel: 450, legendSacredTreasureLevel: 40, matchlessSacredTreasureLevel: 40 });
    const result = calculateCharacterStats(member, catalog, policy);
    assert.equal(result.valid, true);
    assert.equal(result.battle.AttackPower, attack);
    assert.equal(result.battle.HP, hp);
  }
});
