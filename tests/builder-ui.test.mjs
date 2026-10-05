import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTeam, createMember, cloneTeam, calculateTeam, migrateLegacyWeaponConfiguration, selectEquipmentRarity, getArcanaState, setArcanaPurchased, getResourceAllowance } from '../src/domain.mjs';
import { placeRosterCharacter } from '../src/team-interactions.mjs';

const [baseCatalog, policy, freeLibrary, nameAliases, arcana] = await Promise.all(['catalog', 'pricing-policy', 'free-library', 'name-aliases', 'arcana-catalog'].map(async name => JSON.parse(await readFile(new URL(`../public/data/${name}.json`, import.meta.url)))));
const catalog = { ...baseCatalog, arcana };
const amount = value => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);

async function renderDraft(team, displayedCatalog = catalog, displayedPolicy = policy) {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  const original = globalThis.localStorage;
  const raw = JSON.stringify({ schemaVersion: 1, catalogVersion: catalog.version, team });
  try {
    globalThis.localStorage = { getItem: () => raw };
    const { default: App } = await server.ssrLoadModule('/src/App.jsx');
    return renderToStaticMarkup(React.createElement(App, { catalog: displayedCatalog, policy: displayedPolicy, freeLibrary, nameAliases }));
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
    await server.close();
  }
}

async function renderArcana(team) {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  try {
    const { ArcanaEditor } = await server.ssrLoadModule('/src/App.jsx');
    return renderToStaticMarkup(React.createElement(ArcanaEditor, { state: getArcanaState(team, catalog, policy, freeLibrary), catalog, onPurchase() {} }));
  } finally { await server.close(); }
}

const arcanaCard = (markup, group) => markup.split(`aria-label="${group.name}"`)[1]?.split('</section>')[0];

function assertAutomaticControls(markup) {
  assert.doesNotMatch(markup, /aria-label="武器同步配置"|aria-label="武器同步位"|aria-label="队外基准费用"|添加队外基准|将队外专武装备给队员|基准武器等级/);
  assert.doesNotMatch(markup, /NaN|undefined/);
}

test('builder displays a nameless framed team to the right of the selected character in the central header', async () => {
  const displayedCatalog = {
    ...catalog,
    elementIcons: Object.fromEntries(Object.keys(catalog.elementIcons).map(key => [key, `./custom-elements/${key}.png`])),
    teamFrame: './custom-elements/team-frame.png',
    iconArt: { ...catalog.iconArt, frames: Object.fromEntries(Object.keys(catalog.iconArt.frames).map(key => [key, `./custom-elements/frame-${key}.png`])) },
    characters: catalog.characters.map(character => character.id === 124 ? { ...character, name: '【SP】特殊标识角色', subtitle: '固定一行副标题' } : character.id === 85 ? { ...character, subtitle: '' } : character),
  };
  const team = createTeam();
  team.members[0] = createMember(124);
  team.members[0].rarity = 'LR5';
  team.members[1] = createMember(85);
  Object.assign(team.members[0].equipment[0], { rarity: 'SSR', seriesId: 12, weaponKind: 'exclusive', level: 240 });
  team.members[0].equipment[0].runes[0] = { categoryId: 1, level: 11 };
  const markup = await renderDraft(cloneTeam(team), displayedCatalog);
  const selection = markup.match(/<aside class="panel catalog-panel left-column" aria-label="选择角色">([\s\S]*?)<\/aside>/)?.[1];
  const lineup = markup.match(/<section class="team-panel" aria-label="当前五人配队">([\s\S]*?)<\/section>/)?.[1];
  assert.ok(selection && lineup);
  assert.doesNotMatch(selection, /team-panel|我的配队/);
  assert.ok(markup.indexOf('aria-label="当前角色装备配置"') < markup.indexOf('aria-label="当前五人配队"'));
  assert.ok(markup.indexOf('class="selected-character-header"') < markup.indexOf('aria-label="当前五人配队"'));
  assert.ok(markup.indexOf('aria-label="当前五人配队"') < markup.indexOf('class="equip-grid"'));
  assert.doesNotMatch(selection, /class="panel team-panel"|class="member-actions"|title="前移"|title="后移"|title="移除角色"/);
  assert.match(selection, /将队员拖回此目录可移出配队/);
  assert.doesNotMatch(selection, /双击|单击加入/);
  assert.equal((lineup.match(/class="team-slot(?: |")/g) ?? []).length, 5);
  assert.equal((lineup.match(/class="member-rarity"/g) ?? []).length, 2);
  assert.equal((lineup.match(/class="member-level">Lv\.450/g) ?? []).length, 2);
  assert.equal((lineup.match(/class="member-equipment-item/g) ?? []).length, 12);
  assert.match(lineup, /class="member-matchless"[^>]*>魔装 0<\/span>/);
  assert.match(lineup, /class="member-matchless"[^>]*>未装备<\/span>/);
  assert.doesNotMatch(lineup, /class="member-name"|class="member-subtitle"/);
  assert.doesNotMatch(lineup.replace(/<[^>]*>/g, ''), /【SP】特殊标识角色|固定一行副标题/);
  assert.match(lineup, /aria-label="配置【SP】特殊标识角色 · 固定一行副标题，位置1" aria-pressed="true"/);
  assert.match(lineup, /--team-frame-image:url\(&quot;\.\/custom-elements\/team-frame\.png&quot;\)/);
  assert.equal((lineup.match(/background-image:url\(&quot;(?:data:image\/svg\+xml,|[^&]*team-seat\.svg)/g) ?? []).length, 5);
  assert.equal((selection.match(/class="tile-subtitle"/g) ?? []).length, catalog.characters.length);
  assert.equal((selection.match(/class="tile-free-cap"/g) ?? []).length, catalog.characters.length);
  for (const key of Object.keys(catalog.elementIcons)) {
    assert.ok(markup.includes(`class="element-badge" src="./custom-elements/${key}.png"`));
  }
  assert.equal((markup.match(/class="element-badge"/g) ?? []).length, catalog.characters.length + 3, 'roster, both occupied seats and selected portrait must use the catalog icons');
  assert.match(lineup, /class="game-icon-frame" data-rarity="LR5" data-frame="lr"/);
  assert.equal((markup.match(/class="rarity-stars"/g) ?? []).length, 2, 'the team and selected portrait use current LR5, while catalog portraits remain SR');
  assert.match(selection, /class="game-icon-frame" data-rarity="SR" data-frame="common"/);
  assert.match(markup, /border-image-source:url\(&quot;\.\/custom-elements\/frame-lr\.png&quot;\)/);
  assert.match(markup, /border-image-slice:26 25 25 25/);
  assert.doesNotMatch(markup, /class="equipment-art-fallback"/);
  assert.doesNotMatch(markup, /--element-color|<span class="element-badge"/);
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.tile-name\{height:14px;line-height:14px\}/);
  assert.match(css, /\.tile-subtitle\{height:11px;line-height:11px\}/);
  assert.match(css, /\.portrait-frame \.portrait-image\{[^}]*object-fit:cover/);
  assert.match(css, /\.portrait-frame \.element-badge\{[^}]*width:19px;[^}]*height:19px;object-fit:contain/);
  assert.match(css, /\.team-slot\{[^}]*aspect-ratio:100\/104/);
  assert.match(css, /\.portrait-frame\.has-rarity-frame\{overflow:visible/);
  assert.match(css, /\.rune-holes\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(css, /\.rune-holes\{[^}]*grid-template-columns:1fr|\.rune-holes\{[^}]*repeat\(2/);
  assert.match(markup, /class="rune-number">第 1 孔<\/span>/);
  assert.equal((markup.match(/class="rune-level-label">等级/g) ?? []).length, 4);
  assert.equal((markup.match(/class="equipment-tier-button/g) ?? []).length, 18);
  assert.match(markup, /aria-label="武器切换LR" aria-pressed="false"/);
  assert.doesNotMatch(css, /\.portrait-frame img\{|--element-color|@media\([^{}]+\)\{\}/);
  assert.ok(markup.indexOf('aria-label="角色目录"') < markup.indexOf('aria-label="当前角色装备配置"'));
  assert.match(markup, /draggable="true"/);
  assert.match(markup, /<option value="11" selected="">Lv\.11<\/option>/);
  assert.match(markup, /<option value="10">Lv\.10<\/option>/);
  assert.match(markup, /Lv\.11 × 3、Lv\.10 × 3/);
  assert.match(markup, /aria-label="专武造价"/);
  assert.match(markup, /紫水晶等价 82\.5 个/);
  assert.match(markup, /免费库抵扣/);
  assert.doesNotMatch(markup, /已恢复可识别的草稿配置/, 'a current canonical draft must not repeatedly create migration backups');
  assertAutomaticControls(markup);
});

test('automatic third-weapon fabrication discount leaves all actual levels and reinforcement at 450', async () => {
  const team = createTeam();
  team.members = [85, 124, 96, 86, 100].map(characterId => {
    const member = createMember(characterId);
    member.rarity = 'LR5';
    Object.assign(member.equipment[0], { rarity: 'LR', seriesId: 14, weaponKind: 'exclusive', level: 450, reinforcementLevel: 420 });
    return member;
  });
  Object.assign(team.members[0].equipment[4], { rarity: 'LR', seriesId: 14, level: 450 });
  const cost = calculateTeam(team, catalog, policy, freeLibrary);
  const markup = await renderDraft(cloneTeam(team));
  assert.equal((markup.match(/class="automatic-weapon-credit"/g) ?? []).length, 1);
  assert.match(markup, /自动同步 · 制作材料按 Lv\.300 计算；强化与叶子按实际配置计费/);
  assert.match(markup, /aria-label="武器装备等级"[\s\S]*?<option value="450" selected="">Lv\. 450<\/option>/);
  assert.match(markup, /aria-label="武器强化等级"[^>]*max="450"[^>]*value="420"/);
  assert.match(markup, /aria-label="叶子造价"/);
  assert.match(markup, /铠甲 LR/);
  assert.match(markup, /20,000 钻/);
  assert.ok(markup.includes(`<strong>${amount(cost.totalDiamonds)}</strong>`));
  assertAutomaticControls(markup);
});

test('a new dragged member displays default magic level 40 and preserves zero or mixed levels from existing gear', async () => {
  const character = catalog.characters.find(item => item.id === 124);
  const team = placeRosterCharacter(createTeam(), character, 0, { catalog, freeLibrary }).team;
  const defaults = await renderDraft(cloneTeam(team));
  assert.match(defaults, /class="member-matchless"[^>]*>魔装 40<\/span>/);
  assert.match(defaults, /aria-label="武器魔装等级"[^>]*value="40"/);
  assert.match(defaults, /aria-label="武器切换LR，需要LR5角色" aria-pressed="false" disabled=""/);
  assert.match(defaults, /新装备默认魔装 40，可按实际配置调整/);
  team.members[0].equipment[1] = { ...selectEquipmentRarity(team.members[0].equipment[1], 'SSR'), matchlessSacredTreasureLevel: 0 };
  team.members[0].equipment[3] = { ...selectEquipmentRarity(team.members[0].equipment[3], 'SSR'), matchlessSacredTreasureLevel: 17 };
  const previous = JSON.stringify(team);
  const mixed = await renderDraft(cloneTeam(team));
  assert.match(mixed, /class="member-matchless"[^>]*>魔装 0–40<\/span>/);
  assert.match(mixed, /aria-label="饰品 SSR 魔装0"/);
  assert.match(mixed, /aria-label="头盔 SSR 魔装17"/);
  assert.match(mixed, /aria-label="饰品魔装等级"[^>]*value="0"/);
  assert.match(mixed, /aria-label="头盔魔装等级"[^>]*value="17"/);
  assert.equal(JSON.stringify(team), previous, 'existing zero and mixed magic values are never overwritten on rendering');
  assertAutomaticControls(mixed);
});

test('legacy synchronized draft preserves the effective weapon level and removes outside source charges', async () => {
  const team = createTeam();
  team.members[0] = createMember(85);
  team.members[0].rarity = 'LR5';
  Object.assign(team.members[0].equipment[0], { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', level: 300, syncSlot: 1, reinforcementLevel: 420 });
  team.weaponSources = [8, 27].map(characterId => ({ characterId, characterRarity: 'LR5', rarity: 'UR', level: 450 }));
  const migrated = migrateLegacyWeaponConfiguration(team, catalog, policy, freeLibrary);
  const cost = calculateTeam(migrated.team, catalog, policy, freeLibrary);
  const original = JSON.stringify(team);
  const markup = await renderDraft(team);
  assert.match(markup, /已按当前规则恢复旧版武器等级，原草稿会另存备份/);
  assert.match(markup, /队外同步配置已移除，全部费用按当前配队重新计算/);
  assert.match(markup, /aria-label="武器强化等级"[^>]*max="450"[^>]*value="420"/);
  assert.ok(markup.includes(`<strong>${amount(cost.totalDiamonds)}</strong>`));
  assert.equal(cost.characterCosts.length, 1);
  assert.equal(cost.exclusiveWeaponCosts.length, 1);
  assert.equal(JSON.stringify(team), original, 'migration must not mutate the original backup contents');
  assertAutomaticControls(markup);
});

test('unsafe legacy synchronization does not become a hidden uneditable charge', async () => {
  const team = createTeam();
  team.members[0] = createMember(85);
  Object.assign(team.members[0].equipment[0], { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', level: 300, syncSlot: 2 });
  team.weaponSources = [];
  const markup = await renderDraft(team);
  assert.match(markup, /原草稿无法完整恢复，已保留原始内容并尝试另存备份/);
  assert.match(markup, /从一名角色开始/);
  assertAutomaticControls(markup);
});

test('borrowed free UR weapon keeps its ownership warning without manual synchronization controls', async () => {
  const team = createTeam();
  team.members[0] = createMember(153);
  Object.assign(team.members[0].equipment[0], { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', weaponOwnerCharacterId: 27, level: 300 });
  const markup = await renderDraft(cloneTeam(team));
  assert.match(markup, /aria-label="专武所属角色"/);
  assert.match(markup, /<option value="27" selected="">科迪 · 免费 UR Lv\.300<\/option>/);
  assert.match(markup, /同职业借用/);
  assert.match(markup, /不提供当前角色的专武技能/);
  assert.doesNotMatch(markup, /aria-label="武器类型"/);
  const owner = catalog.characters.find(item => item.id === 27);
  assert.ok(markup.includes(`class="equipment-art-image" src="${owner.exclusiveWeaponIcon}"`), 'borrowed equipment icons show the weapon owner');
  assertAutomaticControls(markup);
});

test('equipment composition displays the verified normal, holy, dark and combined plates below the original foreground and frame', async () => {
  const team = createTeam();
  team.members[0] = createMember(124);
  for (const gear of team.members[0].equipment.slice(1, 5)) Object.assign(gear, { rarity: 'SSR', seriesId: 12, level: 450 });
  team.members[0].equipment[2].legendSacredTreasureLevel = 1;
  team.members[0].equipment[3].matchlessSacredTreasureLevel = 17;
  Object.assign(team.members[0].equipment[4], { legendSacredTreasureLevel: 1, matchlessSacredTreasureLevel: 40 });
  const before = JSON.stringify(team);
  const markup = await renderDraft(cloneTeam(team));
  for (const kind of ['normal', 'holy', 'dark', 'both']) {
    assert.match(markup, new RegExp(`class="equipment-art-plate" data-plate="${kind}"`));
    assert.ok(markup.includes(catalog.iconArt.equipmentComposition.plate.palettes[kind].colors[0]));
  }
  assert.match(markup, /left:4\.6875%;top:4\.6875%;width:90\.625%;height:90\.625%/);
  assert.match(markup, /class="equipment-art-image"[^>]*style="left:7\.8125%;top:7\.8125%;width:84\.375%;height:84\.375%;object-fit:contain;filter:url\(#equipment-shadow-/);
  assert.match(markup, /<feDropShadow[^>]*flood-opacity="0\.5"/);
  assert.match(markup, /<feMergeNode in="SourceGraphic"/);
  const character = catalog.characters.find(item => item.id === 124);
  for (const slot of [2, 3, 4, 5]) assert.ok(markup.includes(`src="${catalog.iconArt.equipmentIcons[character.job].SSR[slot]}"`));
  assert.equal(JSON.stringify(team), before, 'visual treasure backgrounds never change the configured magic or holy levels');
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.equipment-art-plate\{position:absolute;z-index:0/);
  assert.match(css, /\.equipment-art-image\{position:absolute;z-index:1/);
  assert.match(css, /\.game-icon-frame\{[^}]*z-index:3/);
});

test('arcana shows actual owned LR5 bonuses, free R portraits and disabled unpublished groups without adding R to the team roster', async () => {
  const team = createTeam();
  const state = getArcanaState(team, catalog, policy, freeLibrary);
  const markup = await renderArcana(team);
  const lr5 = state.groups.find(group => group.unlocked && group.bonusTierLabel === 'LR5');
  assert.ok(lr5);
  const activeCard = arcanaCard(markup, lr5);
  assert.match(activeCard, /常驻已解锁 · LR5/);
  assert.match(activeCard, /LR5 档加成 · 已生效/);
  for (const bonus of lr5.bonuses) assert.ok(activeCard.includes(bonus.displayValue));
  assert.match(markup, /只读持有表/);
  assert.match(markup, /5830 中的战斗属性接入将在后续完成/);
  assert.match(markup, /卡片价格是当前补齐差额，不能直接相加/);
  assert.doesNotMatch(markup, /赠最高档|全阶赠送|购买 LR5|购买 SSR|NaN|undefined/);
  for (const support of catalog.arcana.supportCharacters) assert.ok(markup.includes(`src="${support.portrait}"`), `R support ${support.id} retains its verified portrait`);
  const unpublished = state.groups.find(group => group.published === false);
  const unpublishedCard = arcanaCard(markup, unpublished);
  assert.match(unpublishedCard, /class="arcana-unpublished-placeholder">未开放/);
  assert.match(unpublishedCard, /disabled=""[^>]*>暂不可购买/);
  assert.doesNotMatch(unpublishedCard, /取消购买|补齐 .* 钻/);
  const app = await renderDraft(cloneTeam(team));
  const roster = app.match(/<aside class="panel catalog-panel left-column" aria-label="选择角色">([\s\S]*?)<\/aside>/)[1];
  assert.equal((roster.match(/class="tile-name"/g) ?? []).length, catalog.characters.length);
  for (const support of catalog.arcana.supportCharacters) assert.ok(!roster.includes(`src="${support.portrait}"`), 'R holdings stay outside the selectable SR team catalog');
});

test('arcana purchases render marginal LR prices, one shared character fee and cancellation that preserves the configured team', async () => {
  const team = createTeam();
  team.members[0] = createMember(54);
  const first = 12;
  const second = 98;
  const before = getArcanaState(team, catalog, policy, freeLibrary);
  const beforeMarkup = await renderArcana(team);
  const firstGroup = before.groups.find(group => group.id === first);
  assert.match(arcanaCard(beforeMarkup, firstGroup), /LR 档加成 · 补齐后生效/);
  assert.ok(arcanaCard(beforeMarkup, firstGroup).includes(`补齐 ${amount(firstGroup.currentPurchaseDiamonds)} 钻`));
  let purchased = setArcanaPurchased(team, first, true, catalog, policy, freeLibrary);
  const next = getArcanaState(purchased, catalog, policy, freeLibrary);
  const nextGroup = next.groups.find(group => group.id === second);
  assert.ok(nextGroup.currentPurchaseDiamonds < before.groups.find(group => group.id === second).currentPurchaseDiamonds);
  const nextMarkup = await renderArcana(purchased);
  assert.ok(arcanaCard(nextMarkup, nextGroup).includes(`补齐 ${amount(nextGroup.currentPurchaseDiamonds)} 钻`));
  assert.match(arcanaCard(nextMarkup, next.groups.find(group => group.id === first)), /aria-label="取消购买大犬座的长啸"/);
  purchased = setArcanaPurchased(purchased, second, true, catalog, policy, freeLibrary);
  const cost = calculateTeam(purchased, catalog, policy, freeLibrary);
  assert.equal(cost.characterCosts.filter(item => item.characterId === 54).length, 1);
  const app = await renderDraft(cloneTeam(purchased));
  assert.ok(app.includes(`<strong>${amount(cost.totalDiamonds)}</strong>`));
  assert.match(app, /配队与秘仪按角色最高持有稀有度合并，同一角色只计一次本体费用/);
  assert.match(app, /小白 · LR · 8 本体（免费至 SR） · 秘仪持有/);
  assert.match(app, /aria-label="角色稀有度"[\s\S]*?<option value="LR" selected="">LR<\/option>/);
  assert.match(app, /aria-label="角色稀有度"[^>]*><option value="SR" disabled="">SR<\/option>/);
  assert.match(app, /已购秘仪至少需 LR/);
  assert.doesNotMatch(app, /已恢复可识别的草稿配置|NaN|undefined/);
  const canceled = setArcanaPurchased(purchased, first, false, catalog, policy, freeLibrary);
  assert.equal(canceled.members[0].rarity, 'LR');
  const canceledState = getArcanaState(canceled, catalog, policy, freeLibrary);
  const canceledMarkup = await renderArcana(canceled);
  assert.doesNotMatch(arcanaCard(canceledMarkup, canceledState.groups.find(group => group.id === first)), /取消购买/);
  assert.match(canceledMarkup, /取消购买不会降低已配置队员的稀有度/);
});

test('draft purchases recover associated SR to LR while malformed IDs trigger a recoverable original backup', async () => {
  const team = cloneTeam(createTeam());
  team.members[0] = createMember(54);
  team.purchasedArcanaIds = [12];
  const raw = JSON.stringify(team);
  const repaired = await renderDraft(team);
  assert.match(repaired, /已恢复可识别的草稿配置，原始草稿会另存备份/);
  assert.match(repaired, /aria-label="角色稀有度"[\s\S]*?<option value="LR" selected="">LR<\/option>/);
  assert.doesNotMatch(repaired, /已购买 LR 秘仪的队内角色必须至少为 LR|待修正|NaN/);
  assert.equal(JSON.stringify(team), raw, 'recovery retains the original SR draft for backup');
  const canonical = setArcanaPurchased(team, 12, true, catalog, policy, freeLibrary);
  const markup = await renderDraft(cloneTeam(canonical));
  assert.doesNotMatch(markup, /已恢复可识别的草稿配置/);
  canonical.members[0].rarity = 'LR5';
  const higher = await renderDraft(cloneTeam(canonical));
  assert.match(higher, /aria-label="角色稀有度"[\s\S]*?<option value="LR5" selected="">LR5<\/option>/);
  assert.doesNotMatch(higher, /已恢复可识别的草稿配置/);
  const malformed = { ...canonical, purchasedArcanaIds: [12, 12, 101, '98', 999999] };
  const sanitized = await renderDraft(malformed);
  assert.match(sanitized, /已恢复可识别的草稿配置，原始草稿会另存备份/);
  assert.doesNotMatch(sanitized, /秘仪编号未知、重复|原草稿无法完整恢复/);
  const expected = calculateTeam(canonical, catalog, policy, freeLibrary);
  assert.ok(sanitized.includes(`<strong>${amount(expected.totalDiamonds)}</strong>`));
});

test('the blessing header and resource budget consume dynamic base plus blessing allowances', async () => {
  const markup = await renderDraft(cloneTeam(createTeam()));
  assert.match(markup, /aria-label="赐福机制"[\s\S]*?赐福·绯红恩泽/);
  assert.match(markup, /额外免费 40,000 红水/);
  assert.match(markup, /基础免费 60,000 · 合计免费 100,000/);
  assert.match(markup, /class="resource-blessing-breakdown">基础 60,000 ＋ 赐福 40,000 ＝ 100,000/);
  const configuredPolicy = { ...policy, allowances: { ...policy.allowances, reinforcementMedicine: 62000 }, blessings: policy.blessings.map(blessing => ({ ...blessing, name: '赐福·自定义额度', amount: 41000 })) };
  const configured = await renderDraft(cloneTeam(createTeam()), catalog, configuredPolicy);
  assert.equal(getResourceAllowance(configuredPolicy, 'reinforcementMedicine'), 103000);
  assert.match(configured, /赐福·自定义额度/);
  assert.match(configured, /额外免费 41,000 红水/);
  assert.match(configured, /基础免费 62,000 · 合计免费 103,000/);
  assert.match(configured, /class="resource-blessing-breakdown">基础 62,000 ＋ 赐福 41,000 ＝ 103,000/);
});
