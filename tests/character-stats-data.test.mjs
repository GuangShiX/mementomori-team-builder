import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMember } from '../src/domain.mjs';
import { calculateCharacterStats } from '../src/character-stats.mjs';

const read = async name => JSON.parse(await readFile(new URL(`../public/data/${name}.json`, import.meta.url)));
const [data, catalog, bonuses, policy] = await Promise.all(['character-stats', 'catalog', 'equipment-bonuses', 'pricing-policy'].map(read));
const baseKeys = ['Muscle', 'Energy', 'Intelligence', 'Health'];
const battleKeys = ['Hp', 'AttackPower', 'PhysicalDamageRelax', 'MagicDamageRelax', 'Hit', 'Avoidance', 'Critical', 'CriticalResist', 'CriticalDamageEnhance', 'PhysicalCriticalDamageRelax', 'MagicCriticalDamageRelax', 'DefensePenetration', 'Defense', 'DamageEnhance', 'DebuffHit', 'DebuffResist', 'DamageReflect', 'HpDrain', 'Speed'];
const validEffect = effect => {
  assert.deepEqual(Object.keys(effect), ['group', 'type', 'changeType', 'value']);
  assert.ok(['base', 'battle'].includes(effect.group));
  assert.ok(Number.isSafeInteger(effect.type) && effect.type >= 1 && effect.type <= (effect.group === 'base' ? 4 : 19));
  assert.ok([1, 2, 3].includes(effect.changeType));
  assert.ok(Number.isFinite(effect.value));
};

test('static stats project only the selected roster, with explicit scope and traceable master hashes', () => {
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.scope, 'selectedRosterStaticStats');
  assert.equal(data.characterLevel, 450);
  assert.equal(data.characterSubLevel, 0);
  assert.deepEqual(Object.keys(data.characters).map(Number).sort((a, b) => a - b), catalog.characters.map(character => character.id).sort((a, b) => a - b));
  assert.equal(Object.keys(data.characters).length, 119);
  for (const character of Object.values(data.characters)) {
    assert.deepEqual(Object.keys(character), ['job', 'baseByRarity', 'initialBattle']);
    assert.ok([1, 2, 4].includes(character.job));
    assert.deepEqual(Object.keys(character.baseByRarity), ['SR', 'LR', 'LR5']);
    for (const base of Object.values(character.baseByRarity)) {
      assert.deepEqual(Object.keys(base), baseKeys);
      assert.ok(Object.values(base).every(value => Number.isSafeInteger(value) && value > 0));
    }
    assert.deepEqual(Object.keys(character.initialBattle), battleKeys);
    assert.ok(Object.values(character.initialBattle).every(Number.isSafeInteger));
  }
  assert.deepEqual(data.sources, [
    { table: 'CharacterMB', sha256: '93ccc0cd175a340ebad0f63f5988371baad54dbf51e212c08d90114c957f3076' },
    { table: 'CharacterPotentialMB', sha256: '0599ed8ab5a6bcac2a71ca6d4ccc255069417cb950570786f88832bda8eb6de9' },
    { table: 'CharacterPotentialCoefficientMB', sha256: '5fe30e091483d9c84b1e7f7b4affcf3e972672d1e19aa972b93d0426906414cb' },
    { table: 'EquipmentMB', sha256: '2d198e4f97502ebc1c437cb5c9dcea04c5c62c094067caacbad3a4bb0d95b72b' },
    { table: 'EquipmentReinforcementParameterMB', sha256: 'c5da53c2f03b618626a1729da940e1c166f96db3123c6265450561882af83000' },
    { table: 'EquipmentExclusiveEffectMB', sha256: 'cf8a3ccffea3c2daf72e32b9cab9595e09463513f83c5900b40bd941811b2f32' },
    { table: 'EquipmentSetMB', sha256: '80f7debd83ea19cc1467d1d37ec82d3ec8f8701d707216a9fd3e26bc0d42ca36' },
    { table: 'SphereMB', sha256: '8db20af61f994492fcbe9420eb2481ecd23bcea75f690e7dd6914ccb42c64f35' },
    { table: 'PlayerRankMB', sha256: '3c6d276be9b483a817c8613e394e02918c74d84ea9b474e75ca33d80e425067b' },
  ]);
  assert.equal(data.dependencies.includesBattleSkillEffects, false);
  assert.equal(data.dependencies.includesTemporaryBattleEffects, false);
  assert.equal(data.dependencies.includesAccountPotentialExtras, false);
  assert.equal(data.dependencies.percentEffectUnit, 'basisPoints');
  assert.ok(!JSON.stringify(data).match(/(?:[A-Z]:[\\/]|https?:|ActiveSkillIds|PassiveSkillIds|RequiredTotalExp|StartTimeFixJST|NameKey|Memo)/));
});

test('fixed 450 growth retains exact rarity-dependent values and initial constants', () => {
  assert.deepEqual(data.characters[8].baseByRarity, {
    SR: { Muscle: 1737109, Energy: 1491457, Intelligence: 1491457, Health: 1210712 },
    LR: { Muscle: 3475483, Energy: 2984001, Intelligence: 2984001, Health: 2422306 },
    LR5: { Muscle: 3993678, Energy: 3428916, Intelligence: 3428916, Health: 2783473 },
  });
  assert.equal(data.characters[8].initialBattle.Hp, -3);
  assert.equal(data.characters[27].initialBattle.Defense, 7);
  assert.equal(data.characters[26].initialBattle.Speed, 2888);
});

test('every supported gear level has one shared template, real set IDs and grade-specific own-weapon effects', () => {
  assert.equal(Object.keys(data.equipment).length, 418);
  assert.equal(Object.keys(data.exclusiveEffects).length, 714);
  for (const [rarity, allLevels] of Object.entries(catalog.equipmentCosts.allowedLevels)) {
    for (const kind of ['normal', 'exclusive']) {
      const levels = kind === 'exclusive' && rarity === 'SSR' ? [180, 200, 220, 240] : allLevels;
      const slots = kind === 'exclusive' ? [1] : rarity === 'SSR' ? [1, 2, 3, 4, 5, 6] : [2, 3, 4, 5, 6];
      for (const level of levels) for (const slot of slots) {
        const template = data.equipment[`${kind}:${slot}:${rarity}:${level}`];
        assert.ok(template);
        assert.deepEqual(Object.keys(template), ['battleChange', 'setId', 'polishTotal']);
        assert.ok(Number.isSafeInteger(template.polishTotal) && template.polishTotal > 0);
        assert.ok(data.sets[template.setId]);
        if (template.battleChange) validEffect(template.battleChange);
      }
      if (kind === 'exclusive') for (const character of catalog.characters) for (const level of levels) {
        const key = rarity === 'SSR' ? `${character.id}:SSR:${level}` : `${character.id}:${rarity}`;
        const own = data.exclusiveEffects[key];
        assert.ok(own);
        assert.deepEqual(Object.keys(own), ['baseChanges', 'battleChanges']);
        [...own.baseChanges, ...own.battleChanges].forEach(validEffect);
      }
    }
  }
  assert.ok(!data.equipment['normal:1:UR:450']);
  assert.ok(!data.equipment['normal:1:LR:450']);
  assert.ok(!data.equipment['exclusive:1:SSR:450']);
  assert.deepEqual([180, 200, 220, 240].map(level => data.equipment[`normal:2:SSR:${level}`].setId), [3, 6, 9, 12]);
  assert.deepEqual(data.equipment['exclusive:1:UR:450'], { battleChange: { group: 'battle', type: 2, changeType: 1, value: 427170 }, setId: 13, polishTotal: 535149 });
  assert.deepEqual(data.equipment['exclusive:1:LR:450'], { battleChange: { group: 'battle', type: 2, changeType: 1, value: 512604 }, setId: 14, polishTotal: 642179 });
  assert.deepEqual([180, 200, 220, 240].map(level => data.exclusiveEffects[`5:SSR:${level}`].battleChanges[0].value), [1200, 1300, 1400, 1500]);
});

test('runes and cumulative set thresholds preserve canonical parameter IDs and basis-point values', () => {
  assert.equal(Object.keys(data.runes).length, 240);
  for (const category of catalog.runeCategories) for (let level = 1; level <= 15; level++) {
    const effects = data.runes[`${category.id}:${level}`];
    assert.ok(Array.isArray(effects) && effects.length > 0);
    effects.forEach(validEffect);
  }
  assert.deepEqual(data.runes['1:11'], [{ group: 'base', type: 1, changeType: 1, value: 23100 }]);
  assert.deepEqual(data.runes['5:15'], [{ group: 'battle', type: 14, changeType: 1, value: 26900 }]);
  assert.deepEqual(data.runes['9:15'], [{ group: 'battle', type: 19, changeType: 1, value: 660 }]);
  assert.deepEqual(Object.keys(data.sets), ['3', '6', '9', '12', '13', '14']);
  for (const thresholds of Object.values(data.sets)) {
    assert.deepEqual(thresholds.map(value => value.requiredCount), [2, 4, 6]);
    thresholds.flatMap(value => value.effects).forEach(validEffect);
  }
  assert.deepEqual(data.sets[14][1], { requiredCount: 4, effects: [{ group: 'base', type: 4, changeType: 2, value: 3000 }] });
});

test('rank 560 and reinforcement are exact independent baselines, while polish states its allocation convention', () => {
  assert.deepEqual(data.rank560, { rank: 560, bonuses: {
    AttackPowerBonus: 478713, AttackPowerPercentBonus: 0, HpBonus: 4272977, HpPercentBonus: 6000,
    DefensePenetrationBonus: 0, DamageEnhanceBonus: 0, CriticalBonus: 0, HitBonus: 30000,
    AvoidanceBonus: 0, DebuffHitBonus: 0, SpeedBonus: 0, CriticalDamageEnhanceBonus: 0,
    DamageReflectBonus: 0, HpDrainBonus: 0, HitDirectPercentBonus: 0,
  } });
  assert.equal(data.reinforcementCoefficients.length, 451);
  assert.equal(data.reinforcementCoefficients[0], 1);
  assert.equal(data.reinforcementCoefficients[1], 1.0141);
  assert.equal(data.reinforcementCoefficients[60], 1.9);
  assert.equal(data.reinforcementCoefficients[240], 5.9342);
  assert.equal(data.reinforcementCoefficients[450], 12.7567);
  assert.ok(data.reinforcementCoefficients.every(value => Number.isFinite(value) && value >= 1));
  assert.deepEqual(data.polish, { selectedPercent: 60, remainingDistribution: 'equal', noneDistribution: 'equal', order: [1, 2, 3, 4] });
});

// Calibrated against a separate local offline calculator with synthetic equipment,
// never an account snapshot: Lv450/sub0/LR5, player560, own LR450 weapon and five
// LR450 armor pieces, reinforcement450, both treasures40, main60, no rune/arcana.
const golden = [
  { id: 27, base: { Muscle: 4088521, Energy: 6094576, Intelligence: 3644779, Health: 4213783 }, battle: {
    HP: 75366088, AttackPower: 25701368, PhysicalDamageRelax: 6954719, MagicDamageRelax: 6510977,
    Hit: 2903967, Avoidance: 3047288, Critical: 3058788, CriticalResist: 2106891,
    CriticalDamageEnhance: 9500, PhysicalCriticalDamageRelax: 6000, MagicCriticalDamageRelax: 6000,
    DefensePenetration: 11950, Defense: 5686203, DamageEnhance: 0, DebuffHit: 1822389,
    DebuffResist: 2843098, DamageReflect: 0, HpDrain: 2000, Speed: 3562,
  } },
  { id: 8, base: { Muscle: 6054235, Energy: 3886820, Intelligence: 3886820, Health: 4213783 }, battle: {
    HP: 75366086, AttackPower: 25621491, PhysicalDamageRelax: 8920433, MagicDamageRelax: 6753018,
    Hit: 3974252, Avoidance: 1943410, Critical: 2150398, CriticalResist: 2106891,
    CriticalDamageEnhance: 6000, PhysicalCriticalDamageRelax: 6000, MagicCriticalDamageRelax: 6000,
    DefensePenetration: 11950, Defense: 5686206, DamageEnhance: 7002, DebuffHit: 1943410,
    DebuffResist: 2843098, DamageReflect: 0, HpDrain: 2000, Speed: 3022,
  } },
  { id: 26, base: { Muscle: 3638075, Energy: 3638075, Intelligence: 5598497, Health: 5452980 }, battle: {
    HP: 95193244, AttackPower: 24719116, PhysicalDamageRelax: 6504273, MagicDamageRelax: 8464699,
    Hit: 2588652, Avoidance: 1819038, Critical: 1830537, CriticalResist: 2726490,
    CriticalDamageEnhance: 6000, PhysicalCriticalDamageRelax: 6000, MagicCriticalDamageRelax: 6000,
    DefensePenetration: 11950, Defense: 5970515, DamageEnhance: 0, DebuffHit: 2799248,
    DebuffResist: 2843098, DamageReflect: 0, HpDrain: 2000, Speed: 2888,
  } },
];
test('three occupations match independently calibrated complete static panels without accounts or combat skills', () => {
  const configured = { ...catalog, characterStats: data, equipmentBonuses: bonuses };
  for (const expected of golden) {
    const member = createMember(expected.id);
    member.rarity = 'LR5';
    for (const gear of member.equipment) {
      Object.assign(gear, { rarity: 'LR', level: 450, reinforcementLevel: 450, legendSacredTreasureLevel: 40, matchlessSacredTreasureLevel: 40, polishAttribute: 'main' });
      if (gear.slot === 1) Object.assign(gear, { weaponKind: 'exclusive', weaponOwnerCharacterId: member.characterId });
    }
    const result = calculateCharacterStats(member, configured, policy);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.deepEqual(result.base, expected.base);
    assert.deepEqual(result.battle, expected.battle);
  }
});
