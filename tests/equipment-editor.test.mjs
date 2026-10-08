import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTeam, createMember, validateTeam } from '../src/domain.mjs';
import { applyEquipmentPreset } from '../src/equipment-presets.mjs';

const [baseCatalog, policy, freeLibrary, equipmentBonuses, characterStats] = await Promise.all(
  ['catalog', 'pricing-policy', 'free-library', 'equipment-bonuses', 'character-stats'].map(async name => JSON.parse(await readFile(new URL(`../public/data/${name}.json`, import.meta.url))))
);
const catalog = { ...baseCatalog, equipmentBonuses, characterStats };

async function withEditor(run) {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  try {
    const { EquipmentEditor } = await server.ssrLoadModule('/src/App.jsx');
    await run(EquipmentEditor);
  } finally { await server.close(); }
}

function findControl(node, label) {
  if (!React.isValidElement(node)) return null;
  if (node.props['aria-label'] === label) return node;
  for (const child of React.Children.toArray(node.props.children)) {
    const found = findControl(child, label);
    if (found) return found;
  }
  return null;
}

function fixture(EquipmentEditor) {
  const team = createTeam();
  team.members[0] = applyEquipmentPreset({ ...createMember(54), rarity: 'LR5' }, 'ur2-ssr4', catalog, policy);
  Object.assign(team.members[0].equipment[0], { level: 450, reinforcementLevel: 420, legendSacredTreasureLevel: 7, matchlessSacredTreasureLevel: 17 });
  team.members[0].equipment[0].runes[0] = { categoryId: 9, level: 11 };
  function editor(part) {
    const member = team.members[0];
    return EquipmentEditor({
      ...(part === undefined ? {} : { part }),
      gear: member.equipment[0], index: 0, member, memberIndex: 0, catalog, policy, freeLibrary,
      errors: validateTeam(team, catalog, policy, { freeLibrary }).errors,
      inventory: [], borrowableWeapons: [], ownWeaponClaimed: false,
      onChange(gear) { team.members[0] = { ...member, equipment: member.equipment.map((current, index) => index === 0 ? gear : current) }; },
    });
  }
  function control(label, part) {
    const found = findControl(editor(part), label);
    assert.ok(found, `control exists: ${label}`);
    return found;
  }
  return { team, editor, control };
}

test('equipment A and B share the current equipment preview and rarity controls while exposing their own fields', async () => {
  await withEditor(EquipmentEditor => {
    const { team, editor } = fixture(EquipmentEditor);
    Object.assign(team.members[0].equipment[0], { rarity: 'SSR', seriesId: 12, level: 240, reinforcementLevel: 200 });
    const defaultA = renderToStaticMarkup(editor());
    const explicitA = renderToStaticMarkup(editor('A'));
    const partB = renderToStaticMarkup(editor('B'));
    for (const markup of [defaultA, explicitA, partB]) {
      assert.match(markup, /class="equipment-card-header"/);
      assert.match(markup, /aria-label="武器稀有度"/);
      assert.match(markup, /aria-label="武器切换SSR" aria-pressed="true"/);
      assert.match(markup, /aria-label="武器切换UR"/);
      assert.match(markup, /aria-label="武器切换LR"/);
      assert.equal((markup.match(/class="equipment-art is-detailed"/g) ?? []).length, 1);
      assert.match(markup, /class="equipment-art-level"[^>]*>Lv\.240<\/text>/);
      assert.match(markup, /class="equipment-art-reinforcement"[^>]*>\+200<\/text>/);
      assert.match(markup, /class="equipment-art-holy"[^>]*>\+7<\/text>/);
      assert.match(markup, /class="equipment-art-runes" aria-label="已装符石"/);
      assert.equal((markup.match(/class="equipment-art-rune"/g) ?? []).length, 1);
      assert.match(markup, /aria-label="第1孔：速度 Lv\.11"/);
      assert.ok(markup.includes(`src="${catalog.characters.find(character => character.id === 54).exclusiveWeaponIcon}"`));
    }
    for (const markup of [defaultA, explicitA]) {
      for (const label of ['武器装备等级', '武器强化等级', '武器圣装等级', '武器魔装等级', '专武所属角色', '武器类型']) assert.ok(markup.includes(`aria-label="${label}"`));
      assert.doesNotMatch(markup, /aria-label="武器满打磨属性"|aria-label="武器第1孔符石类别"|class="rune-section"/);
    }
    assert.match(partB, /aria-label="武器满打磨属性"/);
    assert.match(partB, /aria-label="武器第1孔符石类别"/);
    assert.doesNotMatch(partB, /aria-label="武器(?:装备|强化|圣装|魔装)等级"|aria-label="专武所属角色"|aria-label="武器类型"/);
  });
});

test('typing equipment level 4 then 45 then 450 preserves reinforcement until a legal lower level is chosen', async () => {
  await withEditor(EquipmentEditor => {
    const { team, editor, control } = fixture(EquipmentEditor);
    const input = control('武器装备等级');
    assert.equal(input.type, 'input');
    assert.equal(input.props.type, 'number');
    assert.equal(Number(input.props.min), 240);
    assert.equal(Number(input.props.max), 450);
    assert.equal(Number(input.props.step), 1);
    for (const value of ['4', '45', '450']) {
      control('武器装备等级').props.onChange({ target: { value } });
      assert.equal(control('武器装备等级').props.value, Number(value));
      assert.equal(team.members[0].equipment[0].reinforcementLevel, 420);
      const issues = validateTeam(team, catalog, policy, { freeLibrary }).errors.filter(issue => issue.path === 'members[0].equipment[0].level');
      if (value === '450') assert.deepEqual(issues, []);
      else assert.ok(issues.some(issue => issue.code === 'UNAVAILABLE_GEAR_LEVEL'));
    }
    assert.equal(validateTeam(team, catalog, policy, { freeLibrary }).valid, true);
    control('武器装备等级').props.onChange({ target: { value: '240' } });
    assert.equal(team.members[0].equipment[0].level, 240);
    assert.equal(team.members[0].equipment[0].reinforcementLevel, 240);
    assert.equal(control('武器强化等级').props.max, 240);
    assert.match(renderToStaticMarkup(editor()), /class="equipment-art-reinforcement"[^>]*>\+240<\/text>/);
    assert.equal(validateTeam(team, catalog, policy, { freeLibrary }).valid, true);
  });
});

test('unavailable, fractional, out-of-range and empty equipment levels remain visible with existing validation errors', async () => {
  await withEditor(EquipmentEditor => {
    const { team, editor, control } = fixture(EquipmentEditor);
    for (const value of ['241', '240.5', '451', '0', '']) {
      control('武器装备等级').props.onChange({ target: { value } });
      assert.equal(control('武器装备等级').props.value, value === '' ? '' : Number(value));
      assert.equal(team.members[0].equipment[0].reinforcementLevel, 420, 'unfinished or invalid input must not consume existing reinforcement');
      const validation = validateTeam(team, catalog, policy, { freeLibrary });
      const levelIssues = validation.errors.filter(issue => issue.path === 'members[0].equipment[0].level');
      assert.equal(validation.valid, false);
      assert.ok(levelIssues.some(issue => issue.code === (value === '241' ? 'UNAVAILABLE_GEAR_LEVEL' : 'INVALID_GEAR_LEVEL')));
      const markup = renderToStaticMarkup(editor());
      assert.ok(markup.includes(levelIssues[0].message), 'the field displays its first existing validation error');
      assert.match(markup, /role="alert"/);
    }
  });
});

test('equipment previews show sacred upgrades only for valid positive sacred levels', async () => {
  await withEditor(EquipmentEditor => {
    const { team, editor } = fixture(EquipmentEditor);
    for (const part of ['A', 'B']) {
      for (const level of [0, '', 7.5, 41]) {
        team.members[0].equipment[0].legendSacredTreasureLevel = level;
        assert.doesNotMatch(renderToStaticMarkup(editor(part)), /class="equipment-art-holy"/);
      }
      for (const level of [1, 40]) {
        team.members[0].equipment[0].legendSacredTreasureLevel = level;
        assert.match(renderToStaticMarkup(editor(part)), new RegExp(`class="equipment-art-holy"[^>]*>\\+${level}<\\/text>`));
      }
    }
  });
});

test('equipment frames use eight SVG slices with an empty center and sockets retain their game layout inside the canvas', async () => {
  await withEditor(EquipmentEditor => {
    const { team, editor } = fixture(EquipmentEditor);
    for (let index = 0; index < 4; index++) team.members[0].equipment[0].runes[index] = { categoryId: index + 1, level: 10 };
    const markup = renderToStaticMarkup(editor());
    assert.equal((markup.match(/class="game-icon-frame equipment-nine-slice"/g) ?? []).length, 4);
    assert.equal((markup.match(/preserveAspectRatio="none" overflow="hidden"/g) ?? []).length, 32);
    assert.match(markup, /x="20" y="0" width="88" height="20" viewBox="20 0 22 20"/);
    assert.doesNotMatch(markup, /x="20" y="20" width="88" height="88"/);
    assert.match(markup, /class="equipment-art-details" viewBox="0 0 128 128"/);
    const socketImages = [...markup.matchAll(/<image class="equipment-art-rune"[^>]*x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)];
    assert.equal(socketImages.length, 4);
    for (const [index, match] of socketImages.entries()) {
      const [, x, y, width, height] = match.map(Number);
      assert.equal(width, 15.08);
      assert.equal(height, 15.08);
      assert.ok(x >= 0 && x + width <= 128 && y >= 0 && y + height <= 128);
      assert.ok(Math.abs(y - (40.69 + index * 21.13)) < .001);
    }
    assert.doesNotMatch(markup, /equipment-art-rune is-filled|<small>|border-image-slice:20/);
    team.members[0].equipment[0].runes = team.members[0].equipment[0].runes.map(() => ({ categoryId: null, level: 0 }));
    assert.doesNotMatch(renderToStaticMarkup(editor()), /class="equipment-art-rune"/);
  });
});
