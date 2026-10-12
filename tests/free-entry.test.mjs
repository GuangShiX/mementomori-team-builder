import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { createFreeCatalog } from '../src/free-catalog.mjs';
import { createTeam, calculateTeam, validateTeam, createExport, parseImport, cloneTeam } from '../src/domain.mjs';
import { placeRosterCharacter } from '../src/team-interactions.mjs';
import { applyEquipmentPreset, changeMemberRarity } from '../src/equipment-presets.mjs';
import { calculateCharacterStats } from '../src/character-stats.mjs';

const load = async name => JSON.parse(await readFile(new URL('../public/data/' + name + '.json', import.meta.url)));
const [baseCatalog, arcana, equipmentBonuses, characterStats, freeLevels, freeEquipment, policy, cupPolicy] = await Promise.all(
  ['catalog', 'arcana-catalog', 'equipment-bonuses', 'character-stats', 'free-levels', 'free-equipment', 'free-pricing-policy', 'pricing-policy'].map(load));
const catalog = createFreeCatalog(baseCatalog, { arcana, equipmentBonuses, characterStats, freeLevels, freeEquipment });
const actors = catalog.characters.filter(character => character.baseRarity === 8).slice(0, 5);
const teamAt = (level = 450, playerLevel = 560) => actors.reduce((team, character, index) =>
  placeRosterCharacter(team, character, index, { catalog, policy }).team, createTeam({ level, playerLevel }));

test('free catalog merges real growth and equipment tables without altering cup data, and resolves root assets from /free/', () => {
  assert.equal(baseCatalog.mode, undefined);
  assert.equal(catalog.mode, 'free');
  assert.equal(catalog.limits.reinforcementLevel, 1000);
  assert.equal(catalog.equipmentCosts.sacredExperience[40], baseCatalog.equipmentCosts.sacredExperience[40]);
  assert.equal(catalog.characterStats.rank560.bonuses.AttackPower, characterStats.rank560.bonuses.AttackPower);
  const oldKey = Object.keys(characterStats.equipment).find(key => key.endsWith(':450'));
  assert.ok(oldKey);
  assert.deepEqual(catalog.characterStats.equipment[oldKey], characterStats.equipment[oldKey]);
  const assets = value => Array.isArray(value) ? value.flatMap(assets) : value && typeof value === 'object'
    ? Object.values(value).flatMap(assets) : typeof value === 'string' && value.includes('/assets/') ? [value] : [];
  const urls = assets(catalog);
  assert.ok(urls.length > 200);
  assert.ok(urls.every(url => url.startsWith('../assets/')));
  assert.ok(baseCatalog.characters[0].portrait.startsWith('./assets/'));
  assert.ok(catalog.arcana.supportCharacters[0].portrait.startsWith('../assets/'));
});

test('shipped free policy charges all paid resources and neither carries cup credits nor inflates unlimited resources', () => {
  assert.equal(policy.unitPrices.characterCopy, 17000);
  assert.equal(policy.unitPrices.unidentifiedRune7, 256);
  assert.deepEqual(policy.blessings, []);
  assert.ok(Object.values(policy.allowances).every(value => value === 0));
  assert.equal(policy.runes.fixedStock, undefined);
  assert.equal(policy.baseline.curse, undefined);
  assert.equal(policy.weaponSync.mode, 'none');
  assert.ok(policy.freeResources.includes('魔装'));
  const cost = calculateTeam(teamAt(), catalog, policy);
  assert.equal(cost.characterDiamonds, 5 * 17000);
  assert.equal(cost.teamDiamondAllowance, 0);
  assert.ok(cost.resources.exclusiveFragments.consumed > 0);
  assert.ok(cost.resources.exclusiveFragments.diamonds > 0);
  assert.equal(cost.resources.lifeTreeDew.consumed, 0, 'default own SSR exclusive has no leaves');
  assert.equal(cost.totalDiamonds, Math.round(cost.paidDiamonds * 100) / 100);
  assert.equal(cost.arcanaState.ledger.length, 5);
});

test('720 link and 800 player level round-trip with real equipment, reprice and static stats', () => {
  const team = teamAt(720, 800);
  team.members = team.members.map(member => applyEquipmentPreset(changeMemberRarity(member, 'LR5', catalog), 'lr6', catalog, { ...policy, characterLevel: team.level }));
  const validation = validateTeam(team, catalog, policy, { requireFullTeam: true });
  assert.deepEqual(validation.errors, []);
  const stats = calculateCharacterStats(team.members[0], catalog, { ...policy, characterLevel: 720, baseline: { ...policy.baseline, playerLevel: 800, levelLink: { level: 720, subLevel: 0 } } }, []);
  assert.ok(stats.rows.length > 15);
  const exported = createExport(team, catalog, policy);
  assert.equal(exported.team.level, 720);
  assert.equal(exported.team.playerLevel, 800);
  assert.equal(exported.policySnapshot.baseline.playerLevel, 800);
  exported.costBreakdown = { totalDiamonds: 0 };
  exported.policySnapshot = { ...cupPolicy, unitPrices: { characterCopy: 0 } };
  const imported = parseImport(JSON.stringify(exported), catalog, policy);
  assert.deepEqual(imported.team, team);
  assert.ok(imported.costBreakdown.totalDiamonds > 17000 * 5);
  assert.equal(imported.costBreakdown.totalDiamonds, calculateTeam(team, catalog, policy).totalDiamonds);
});

test('free UI restores independent level drafts, hides cup mechanisms and reports current consumed equivalents', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  const originalStorage = globalThis.localStorage;
  try {
    const { default: App } = await server.ssrLoadModule('/src/App.jsx');
    const cupDraft = { ...cloneTeam(teamAt()), name: '原简易杯草稿' };
    const freeDraft = { ...cloneTeam(teamAt(720, 800)), name: '独立自由草稿' };
    const reads = [];
    globalThis.localStorage = { getItem: key => {
      reads.push(key);
      return JSON.stringify({ schemaVersion: 1, catalogVersion: catalog.version, team: key.includes(':free:') ? freeDraft : cupDraft });
    }};
    const markup = renderToStaticMarkup(React.createElement(App, { catalog, policy }));
    assert.deepEqual(reads, ['mementomori-team-builder:free:draft:v1']);
    assert.match(markup, /aria-label="玩家等级"[^>]*value="800"/);
    assert.match(markup, /aria-label="等级链接"[^>]*value="720"/);
    assert.match(markup, /value="独立自由草稿"/);
    assert.match(markup, /href="\.\.\/"[^>]*>简易杯/);
    assert.match(markup, /Lv\.720/);
    assert.match(markup, /17,000/);
    assert.doesNotMatch(markup, /诅咒|恩泽|免费库|自动同步|10万钻通用/);
    assert.equal(/NaN|undefined|已恢复可识别/.test(markup), false, 'canonical free draft restores without corrupt output or a repair notice');
  } finally {
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
    await server.close();
  }
});
