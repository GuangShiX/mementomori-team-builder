import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMember, createTeam, validateTeam, DomainValidationError } from '../src/domain.mjs';
import { EQUIPMENT_PRESETS, applyEquipmentPreset, getEquipmentPresetOptions, changeMemberRarity } from '../src/equipment-presets.mjs';

const [catalog, policy, freeLibrary] = await Promise.all(['catalog', 'pricing-policy', 'free-library'].map(async name => JSON.parse(await readFile(new URL(`../public/data/${name}.json`, import.meta.url)))));

test('quick sets keep the established high-tier slot groups and reinforcement values', () => {
  const member = createMember(8);
  const cases = [
    ['ur2-ssr4', ['UR', 'UR', 'SSR', 'SSR', 'SSR', 'SSR']],
    ['adaptive4', ['UR', 'UR', 'SSR', 'UR', 'UR', 'SSR']],
    ['lr6', ['UR', 'UR', 'UR', 'UR', 'UR', 'UR']],
  ];
  for (const [id, rarities] of cases) {
    const result = applyEquipmentPreset(member, id, catalog, policy);
    assert.deepEqual(result.equipment.map(gear => gear.rarity), rarities);
    assert.deepEqual(result.equipment.map(gear => gear.reinforcementLevel), [450, 60, 450, 240, 240, 450]);
    assert.equal(result.equipment[0].weaponKind, 'exclusive');
    assert.equal(result.equipment[0].weaponOwnerCharacterId, member.characterId);
    assert.ok(result.equipment.every(gear => gear.matchlessSacredTreasureLevel === 40));
    const team = createTeam(); team.members[0] = result;
    assert.equal(validateTeam(team, catalog, policy, { freeLibrary }).valid, true);
  }
  assert.ok(member.equipment.every(gear => gear.rarity === 'NONE'));
  assert.equal(EQUIPMENT_PRESETS.length, 3);
  assert.deepEqual(EQUIPMENT_PRESETS.map(preset => preset.id), ['ur2-ssr4', 'adaptive4', 'lr6']);
});

test('adaptive sets equip LR only for LR5 without silently upgrading the character and always keep game-legal levels', () => {
  const member = createMember(8);
  const lower = applyEquipmentPreset(member, 'lr6', catalog, policy);
  assert.ok(lower.equipment.every(gear => gear.rarity === 'UR'));
  assert.equal(lower.rarity, 'SR');
  member.rarity = 'LR5';
  const partial = applyEquipmentPreset(member, 'ur2-ssr4', catalog, policy);
  assert.deepEqual(partial.equipment.map(gear => gear.rarity), ['LR', 'LR', 'SSR', 'SSR', 'SSR', 'SSR']);
  const all = applyEquipmentPreset(member, 'lr6', catalog, policy);
  assert.deepEqual(all.equipment.map(gear => gear.level), [450, 240, 450, 240, 240, 450]);
  assert.deepEqual(all.equipment.map(gear => gear.reinforcementLevel), [450, 60, 450, 240, 240, 450]);
  const team = createTeam(); team.members[0] = all;
  assert.equal(validateTeam(team, catalog, policy, { freeLibrary }).valid, true);
  assert.equal(all.rarity, 'LR5');
});

test('presets preserve installed holy, magic, runes and borrowed weapon identity without mutating the original build', () => {
  const member = createMember(153);
  Object.assign(member.equipment[0], { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', weaponOwnerCharacterId: 27, level: 300, legendSacredTreasureLevel: 17, matchlessSacredTreasureLevel: 0 });
  member.equipment[0].runes[0] = { categoryId: 5, level: 14 };
  const before = structuredClone(member);
  const result = applyEquipmentPreset(member, 'adaptive4', catalog, policy);
  assert.equal(result.equipment[0].weaponOwnerCharacterId, 27);
  assert.equal(result.equipment[0].legendSacredTreasureLevel, 17);
  assert.equal(result.equipment[0].matchlessSacredTreasureLevel, 0);
  assert.deepEqual(result.equipment[0].runes, before.equipment[0].runes);
  assert.deepEqual(member, before);
  result.equipment[0].runes[0].level = 1;
  assert.equal(member.equipment[0].runes[0].level, 14);
});

test('unsupported presets and unavailable legal tiers fail without producing a partial equipment change', () => {
  const member = createMember(8);
  assert.throws(() => applyEquipmentPreset(member, 'ur6', catalog, policy), DomainValidationError);
  assert.throws(() => applyEquipmentPreset(member, 'lr2-ssr4', catalog, policy), DomainValidationError);
  const unsupported = structuredClone(catalog);
  delete unsupported.equipmentCosts.fragments.UR;
  assert.throws(() => applyEquipmentPreset(member, 'adaptive4', unsupported, policy), DomainValidationError);
  assert.ok(member.equipment.every(gear => gear.rarity === 'NONE'));
});

test('all three adaptive compositions resolve complete button labels and choose UR at SR or LR and LR at LR5', () => {
  for (const [rarity, gearRarity] of [['SR', 'UR'], ['LR', 'UR'], ['LR5', 'LR']]) {
    const member = createMember(8); member.rarity = rarity;
    const options = getEquipmentPresetOptions(member);
    assert.deepEqual(options.map(option => option.label), [`2${gearRarity} + 4SSR`, `4${gearRarity} + 2SSR`, `6${gearRarity}`]);
    for (const option of options) {
      assert.equal(option.label, option.composition);
      const result = applyEquipmentPreset(member, option.id, catalog, policy);
      assert.deepEqual(result.equipment.map(gear => gear.rarity), [1, 2, 3, 4, 5, 6].map(slot => option.highSlots.includes(slot) ? gearRarity : 'SSR'));
      assert.equal(result.rarity, rarity);
      assert.deepEqual(result.equipment.map(gear => gear.reinforcementLevel), [450, 60, 450, 240, 240, 450]);
      const team = createTeam(); team.members[0] = result;
      assert.equal(validateTeam(team, catalog, policy, { freeLibrary }).valid, true);
    }
  }
});

test('lowering LR5 to LR converts all LR equipment to UR while retaining levels, cultivation, runes and weapon ownership', () => {
  const member = createMember(153); member.rarity = 'LR5';
  let equipped = applyEquipmentPreset(member, 'lr6', catalog, policy);
  Object.assign(equipped.equipment[0], { weaponOwnerCharacterId: 27, legendSacredTreasureLevel: 13, matchlessSacredTreasureLevel: 17 });
  equipped.equipment[0].runes[0] = { categoryId: 5, level: 14 };
  const before = structuredClone(equipped);
  const result = changeMemberRarity(equipped, 'LR', catalog);
  assert.equal(result.rarity, 'LR');
  assert.ok(result.equipment.every(gear => gear.rarity === 'UR' && gear.seriesId === 13));
  for (const [index, gear] of result.equipment.entries()) {
    for (const key of ['level', 'reinforcementLevel', 'legendSacredTreasureLevel', 'matchlessSacredTreasureLevel', 'weaponOwnerCharacterId', 'runes']) assert.deepEqual(gear[key], before.equipment[index][key]);
  }
  const team = createTeam(); team.members[0] = result;
  assert.equal(validateTeam(team, catalog, policy, { freeLibrary }).valid, true);
  assert.deepEqual(equipped, before);
  assert.deepEqual(changeMemberRarity(result, 'LR5', catalog), before);
});

test('raising LR to LR5 upgrades only equipped UR tiers while preserving the build and borrowed weapon ownership', () => {
  const member = { ...createMember(153), rarity: 'LR' };
  const equipped = applyEquipmentPreset(member, 'adaptive4', catalog, policy);
  equipped.equipment[5] = createMember(153).equipment[5];
  Object.assign(equipped.equipment[0], { weaponOwnerCharacterId: 27, legendSacredTreasureLevel: 13, matchlessSacredTreasureLevel: 17, polishAttribute: 'intelligence' });
  equipped.equipment[0].runes[0] = { categoryId: 5, level: 14 };
  const before = structuredClone(equipped);
  const result = changeMemberRarity(equipped, 'LR5', catalog);
  assert.equal(result.rarity, 'LR5');
  assert.deepEqual(result.equipment.map(gear => gear.rarity), ['LR', 'LR', 'SSR', 'LR', 'LR', 'NONE']);
  assert.deepEqual(result.equipment.map(gear => gear.seriesId), [14, 14, 12, 14, 14, null]);
  for (const [index, gear] of result.equipment.entries()) {
    const { rarity, seriesId, ...upgrades } = gear;
    const { rarity: originalRarity, seriesId: originalSeries, ...originalUpgrades } = before.equipment[index];
    assert.deepEqual(upgrades, originalUpgrades);
  }
  const team = createTeam(); team.members[0] = result;
  assert.equal(validateTeam(team, catalog, policy, { freeLibrary }).valid, true);
  assert.deepEqual(equipped, before);
  result.equipment[0].runes[0].level = 1;
  assert.equal(equipped.equipment[0].runes[0].level, 14);
});

test('reselecting LR5 or changing SR rarity does not implicitly upgrade UR equipment', () => {
  for (const rarity of ['SR', 'LR5']) {
    const equipped = applyEquipmentPreset({ ...createMember(8), rarity: 'LR' }, 'lr6', catalog, policy);
    equipped.rarity = rarity;
    assert.ok(changeMemberRarity(equipped, 'LR5', catalog).equipment.every(gear => gear.rarity === 'UR'));
  }
});
