import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTeam, getArcanaState, calculateTeam } from '../src/domain.mjs';

const readData = async name => JSON.parse(await readFile(new URL(`../public/data/${name}.json`, import.meta.url)));
const [roster, arcana, policy, freeLibrary] = await Promise.all(['catalog', 'arcana-catalog', 'pricing-policy', 'free-library'].map(readData));
const catalog = { ...roster, arcana };

test('public arcana projection contains only supported display fields and canonical character identities', () => {
  assert.equal(arcana.format, 'mementomori-lr-arcana-catalog');
  assert.equal(arcana.schemaVersion, 1);
  assert.equal(arcana.purchaseRarity, 'LR');
  assert.equal(arcana.groups.length, 100);
  assert.equal(new Set(arcana.groups.map(group => group.id)).size, 100);
  assert.deepEqual(Object.keys(arcana.source.sha256).sort(), ['CharacterCollectionLevelMB', 'CharacterCollectionMB', 'CharacterMB', 'TextResourceZhCnMB']);
  for (const hash of Object.values(arcana.source.sha256)) assert.match(hash, /^[a-f0-9]{64}$/);
  const allIds = new Set([...roster.characters, ...arcana.supportCharacters].map(character => character.id));
  const allowedFields = ['id', 'name', 'characterIds', 'published', 'lrBonuses', 'lr5Bonuses', 'lr5RarityBonus', 'unavailableReason'].sort();
  for (const group of arcana.groups) {
    assert.deepEqual(Object.keys(group).sort(), allowedFields);
    for (const id of group.characterIds) assert.ok(allIds.has(id) || (id === 0 && !group.published));
    for (const bonus of [...group.lrBonuses, ...(group.lr5Bonuses ?? [])]) {
      assert.equal(bonus.scope, 'allCharacters');
      assert.ok(Number.isSafeInteger(bonus.value) && bonus.value > 0);
      assert.ok(['flat', 'percent', 'perLevel'].includes(bonus.unit));
    }
  }
  assert.equal(arcana.groups.filter(group => !group.published).length, 1);
  assert.deepEqual(arcana.groups.find(group => !group.published).characterIds, [154, 0]);
  assert.equal(JSON.stringify(arcana).includes('D:/'), false);
});

test('real LR percent and flat effects retain distinct units while LR5 does not stack the same lower tier', () => {
  const state = getArcanaState(createTeam(), catalog, policy, freeLibrary);
  assert.deepEqual(state.errors, []);
  const defense = state.groups.find(group => group.id === 1);
  assert.equal(defense.bonusTierLabel, 'LR5');
  assert.deepEqual(defense.bonuses.map(bonus => [bonus.type, bonus.effectiveValue]), [[3, 3000], [4, 3000]]);
  const critical = state.groups.find(group => group.id === 2);
  assert.deepEqual(critical.bonuses.map(bonus => [bonus.type, bonus.unit, bonus.displayValue]), [[10, 'percent', '+15%'], [8, 'flat', '+1,500']]);
});

test('actual free roster naturally unlocks eligible arcana without buying extra characters or LR5 for R supports', () => {
  const cost = calculateTeam(createTeam(), catalog, policy, freeLibrary);
  const state = cost.arcanaState;
  assert.equal(cost.totalDiamonds, 0);
  assert.equal(state.groups.filter(group => group.unlocked).length, 10);
  assert.equal(state.groups.filter(group => group.lr5Unlocked).length, 5);
  assert.equal(arcana.supportCharacters.length, 12);
  for (const character of arcana.supportCharacters) {
    assert.equal(character.freeRarity, 'LR');
    assert.equal(roster.characters.some(member => member.id === character.id), false);
    assert.equal(state.ledger.find(member => member.characterId === character.id).rarity, 'LR');
  }
  for (const id of [58, 71, 88]) {
    const group = state.groups.find(group => group.id === id);
    assert.equal(group.unlocked, true);
    assert.equal(group.bonusTierLabel, 'LR');
  }
  assert.equal(state.groups.find(group => group.id === 101).unlocked, false);
});
