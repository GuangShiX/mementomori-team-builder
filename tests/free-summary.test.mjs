import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let server;
let FreeCostSummary;
before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  ({ default: FreeCostSummary } = await server.ssrLoadModule('/src/FreeCostSummary.jsx'));
});
after(async () => { await server?.close(); });

const policy = { mode: 'free', version: 1, holySteelPerExperience: 1000,
  unitPrices: { characterCopy: 17000, exclusiveFragments: 15.355893, urLrFragments: 211.42105263 },
  conversions: { exclusiveFragmentsPerExchange: 10, magicCrystalsPerExclusiveExchange: 3, urLrFragmentsPerExchange: 50, relicMaterialsPerExchange: 2 } };
const catalog = { characters: [
  { id: 1, name: '测试角色', baseRarity: 8, exclusiveWeaponName: '真实专武名称' },
  { id: 2, name: '测试R角色', baseRarity: 2 },
  { id: 3, name: '测试N角色', baseRarity: 1 },
  { id: 4, name: '秘仪角色', baseRarity: 8 },
] };
const props = { policy, catalog, cost: null, errors: [], memberCount: 0, canExport: false, onExport() {}, priceHelp: React.createElement('button', { 'aria-label': '查看资源等价钻石价格' }, '价格') };
const render = additions => renderToStaticMarkup(React.createElement(FreeCostSummary, { ...props, ...additions }));
const body = (id, name, position, rarity = 'SR') => ({ characterId: id, characterName: name, sourceKind: 'team', position, rarity, copies: 1, unitPrice: id === 1 ? 17000 : 0, diamonds: id === 1 ? 17000 : 0, arcanaIds: [] });

function fixture() {
  const characterCosts = [body(1, '测试角色', 1), body(2, '测试R角色', 2, 'LR5'), body(3, '测试N角色', 3, 'N'),
    { characterId: 4, characterName: '秘仪角色', sourceKind: 'arcana', rarity: 'LR', copies: 8, unitPrice: 17000, diamonds: 136000, arcanaIds: [1] }];
  return {
    totalDiamonds: 187419.48, resourceDiamonds: 34419.48, offTeamCharacterDiamonds: 136000,
    characterCosts, offTeamCharacterCosts: characterCosts.slice(3),
    memberCosts: [
      { position: 1, characterId: 1, characterName: '测试角色', characterDiamonds: 17000, equipmentDiamonds: 34419.48, totalDiamonds: 51419.48 },
      { position: 2, characterId: 2, characterName: '测试R角色', characterDiamonds: 0, equipmentDiamonds: 0, totalDiamonds: 0 },
      { position: 3, characterId: 3, characterName: '测试N角色', characterDiamonds: 0, equipmentDiamonds: 0, totalDiamonds: 0 },
    ],
    resources: {
      exclusiveFragments: { consumed: 275, unitPrice: 15.355893, diamonds: 4222.87 },
      urLrFragments: { consumed: 100, unitPrice: 211.42105263, diamonds: 21142.11 },
      holySteel: { consumed: 1000, unitPrice: 0.1, diamonds: 100 },
      lifeTreeDew: { consumed: 15, unitPrice: 400, diamonds: 6000 },
      unidentifiedRune7: { consumed: 8, unitPrice: 256, diamonds: 2048 },
      runeTickets: { consumed: 4, unitPrice: 10, diamonds: 40 },
      reinforcementMedicine: { consumed: 86.65, unitPrice: 10, diamonds: 866.5 },
    },
    equipmentCosts: [
      { position: 1, sourceKind: 'team', characterId: 1, slot: 1, weaponKind: 'exclusive', weaponOwnerCharacterId: 1, rarity: 'UR', level: 240,
        resources: { exclusiveFragments: 275, lifeTreeDew: 15, holySteel: 1000 },
        chargedResourceDiamonds: { exclusiveFragments: 4222.87, lifeTreeDew: 6000, holySteel: 100 }, matchlessExperience: 781, diamonds: 10322.87 },
      { position: 1, sourceKind: 'team', characterId: 1, slot: 2, weaponKind: 'normal', rarity: 'LR', seriesName: '圣遗物', level: 240,
        resources: { urLrFragments: 100 }, chargedResourceDiamonds: { urLrFragments: 21142.11 }, equivalentArtifactMaterials: 4, diamonds: 21142.11 },
    ],
    exclusiveWeaponCosts: [{ position: 1, sourceKind: 'team', characterId: 1, weaponOwnerCharacterId: 1, magicCrystals: 82.5 }],
  };
}

test('free budget uses supplied prices and authoritative totals without applying another allowance or pricing algorithm', () => {
  const cost = fixture();
  // The component must display the domain result even when a test value differs from quantity × price.
  cost.resources.exclusiveFragments.diamonds = 1234.56;
  const markup = render({ cost, memberCount: 3 });
  assert.match(markup, /<strong>187,419\.48<\/strong>/);
  assert.match(markup, /data-resource="exclusiveFragments"[\s\S]*?<strong>1,234\.56 钻<\/strong>/);
  assert.match(markup, /使用 275 片/);
  assert.match(markup, /153\.56 钻 \/ 10片/);
  assert.match(markup, /10,571\.05 钻 \/ 50片/);
  assert.match(markup, /使用 1 份/);
  assert.match(markup, /100 钻 \/ 份/);
  assert.match(markup, /紫水晶等价 82\.5 个/);
  assert.match(markup, /圣遗物材料等价 4 个/);
  assert.match(markup, /50 片圣遗物装备碎片 = 2 个圣遗物材料/);
  assert.match(markup, /真实专武名称/);
  assert.match(markup, /项链 · 圣遗物 · LR Lv\.240/);
  assert.match(markup, /aria-label="查看资源等价钻石价格"/);
  assert.doesNotMatch(markup, /恩泽|诅咒|抵扣|免费额度|NaN|undefined/);
});

test('free budget separates team bodies, equipment and off-team arcana holdings and labels unpriced R/N bodies', () => {
  const markup = render({ cost: fixture(), memberCount: 3 });
  assert.match(markup, /<dt>配队角色本体<\/dt><dd>17,000 钻<\/dd>/);
  assert.match(markup, /<dt>装备与养成<\/dt><dd>34,419\.48 钻<\/dd>/);
  assert.match(markup, /<dt>秘仪补齐本体<\/dt><dd>136,000 钻<\/dd>/);
  assert.match(markup, /R 卡本体不计价/);
  assert.match(markup, /N 卡本体不计价/);
  assert.match(markup, /魔装、绿水与金币免费/);
  assert.match(markup, /等级提升资源不计价/);
  assert.match(markup, /秘仪补齐明细/);
  assert.doesNotMatch(markup, /<details[^>]*\sopen(?:=|\s|>)/);
  assert.doesNotMatch(markup, /叶子造价|专武造价|LR 装备造价/);
});

test('empty and invalid free budgets keep export unavailable and never show an inaccurate zero total', () => {
  const empty = render();
  assert.match(empty, /<strong>—<\/strong>/);
  assert.match(empty, /尚未投入装备养成材料/);
  assert.match(empty, /选择角色后显示投入明细/);
  assert.match(empty, /<button[^>]*disabled=""/);
  const invalid = render({ cost: fixture(), memberCount: 5, errors: [{ path: 'team.level', message: '等级链接超过允许上限。' }] });
  assert.match(invalid, /role="alert"/);
  assert.match(invalid, /等级链接超过允许上限。/);
  assert.match(invalid, /请修正配置后查看准确费用/);
  assert.match(invalid, /<strong>—<\/strong>/);
});

test('export stays connected to the supplied action once the complete configuration is valid', () => {
  let calls = 0;
  const tree = FreeCostSummary({ ...props, cost: fixture(), memberCount: 5, canExport: true, onExport: () => calls++ });
  const button = React.Children.toArray(tree.props.children).find(node => React.isValidElement(node) && node.type === 'button');
  assert.equal(button.props.disabled, false);
  button.props.onClick();
  assert.equal(calls, 1);
  assert.match(renderToStaticMarkup(tree), /下载 JSON 文件，发送给站主用于构建/);
});
