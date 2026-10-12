import React from 'react';

const SLOT_NAMES = { 1: '武器', 2: '项链', 3: '手套', 4: '头盔', 5: '衣服', 6: '脚' };
const RESOURCE_ITEMS = [
  ['exclusiveFragments', '专武碎片', '片', 10],
  ['urLrFragments', 'UR / LR 圣遗物装备碎片', '片', 50],
  ['ssrFragments', '普通 SSR 装备碎片', '片', 1],
  ['lifeTreeDew', '叶子 · 生命树之露', '个', 1],
  ['runeTickets', '饼干 · 符石兑换券', '张', 1],
  ['unidentifiedRune7', '普通符石 · 7级等价', '颗', 1],
  ['reinforcementMedicine', '红水 · 强化秘药', '个', 1],
  ['holySteel', '圣装经验等价', '份', 1],
];
const number = (value, precision = 2) => Number.isFinite(value)
  ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: precision }).format(value) : '—';
const add = (rows, field) => rows.reduce((sum, row) => sum + (row[field] ?? 0), 0);
const itemKey = item => `${item.sourceKind ?? 'team'}:${item.position ?? item.sourceIndex ?? ''}:${item.characterId}:${item.slot ?? 'body'}`;

function Foldout({ title, diamonds, caption, children, className = '' }) {
  return <details className={`free-cost-foldout ${className}`}>
    <summary><span>{title}</span><strong>{number(diamonds)} 钻</strong>{caption && <small>{caption}</small>}</summary>
    <div className="free-cost-content">{children}</div>
  </details>;
}

function ResourceLine({ definition, quantity, unitPrice, diamonds, policy, caption }) {
  const [key, label, unit, defaultBatch] = definition;
  const steelRatio = key === 'holySteel' ? (policy.holySteelPerExperience || 1) : 1;
  const batch = key === 'exclusiveFragments' ? (policy.conversions?.exclusiveFragmentsPerExchange ?? defaultBatch)
    : key === 'urLrFragments' ? (policy.conversions?.urLrFragmentsPerExchange ?? defaultBatch) : defaultBatch;
  return <div className="free-resource-row" data-resource={key}>
    <div><span>{label}</span><strong>{number(diamonds)} 钻</strong></div>
    <p><span>使用 {number(quantity / steelRatio)} {unit}</span><span>{number(unitPrice * steelRatio * batch)} 钻 / {batch === 1 ? '' : number(batch)}{unit}</span></p>
    {caption && <small>{caption}</small>}
  </div>;
}

function BodyLine({ item, catalog }) {
  const character = catalog.characters?.find(entry => entry.id === item.characterId);
  const unpriced = [1, 2].includes(character?.baseRarity);
  return <div className="free-body-row">
    <div><span>{item.characterName} · {item.rarity}</span><strong>{number(item.diamonds)} 钻</strong></div>
    <p>{unpriced ? `${character.baseRarity === 2 ? 'R' : 'N'} 卡本体不计价` : `${number(item.copies)} 本体 × ${number(item.unitPrice)} 钻`}</p>
    {item.arcanaIds?.length > 0 && <small>配队与秘仪按最高持有稀有度合并计价</small>}
  </div>;
}

function EquipmentCost({ item, cost, catalog, policy }) {
  const owner = catalog.characters?.find(entry => entry.id === item.weaponOwnerCharacterId);
  const weapon = item.weaponKind === 'exclusive'
    ? cost.exclusiveWeaponCosts?.find(entry => itemKey(entry) === itemKey({ ...item, slot: undefined })) : null;
  const equipmentName = item.weaponKind === 'exclusive' ? owner?.exclusiveWeaponName : null;
  return <Foldout title={`${SLOT_NAMES[item.slot] ?? item.slot} · ${equipmentName || item.seriesName || item.rarity} · ${item.rarity} Lv.${item.level}`} diamonds={item.diamonds} className="free-equipment-cost">
    {item.borrowed && <p className="free-cost-caption">借用 {item.weaponOwnerCharacterName} 的专武；不提供当前角色的专武技能。</p>}
    {RESOURCE_ITEMS.filter(([key]) => (item.resources?.[key] ?? 0) > 0).map(definition => {
      const key = definition[0];
      const caption = key === 'exclusiveFragments' && weapon ? `紫水晶等价 ${number(weapon.magicCrystals)} 个`
        : key === 'urLrFragments' && Number.isFinite(item.equivalentArtifactMaterials) ? `圣遗物材料等价 ${number(item.equivalentArtifactMaterials)} 个` : null;
      return <ResourceLine key={key} definition={definition} quantity={item.resources[key]} unitPrice={cost.resources?.[key]?.unitPrice ?? policy.unitPrices?.[key] ?? 0} diamonds={item.chargedResourceDiamonds?.[key] ?? 0} policy={policy} caption={caption} />;
    })}
    {item.matchlessExperience > 0 && <p className="free-cost-caption">魔装经验等价 {number(item.matchlessExperience)} · 免费</p>}
  </Foldout>;
}

export default function FreeCostSummary({ cost, errors = [], policy, catalog, memberCount = 0, canExport, onExport, priceHelp }) {
  const members = cost?.memberCosts ?? [];
  const offTeam = cost?.offTeamCharacterCosts ?? [];
  const bodies = cost?.characterCosts ?? [];
  const materials = RESOURCE_ITEMS.filter(([key]) => (cost?.resources?.[key]?.consumed ?? 0) > 0);
  const invalid = errors.length > 0;
  return <aside className="panel summary-panel free-cost-summary" aria-label="自由配队资源与费用摘要">
    <div className="panel-header"><div className="panel-heading"><span className="section-index">03</span><h2>资源预算</h2></div>{priceHelp}</div>
    <p className="summary-top-note">按实际消耗折算等价钻石</p>
    <div className="total-block">
      <div className="total-label">当前配队等价费用</div>
      <div className="total-value"><strong>{number(invalid ? null : cost?.totalDiamonds)}</strong><span>钻石</span></div>
      <p className="total-caption">{invalid ? '请修正配置后查看准确费用' : `${memberCount} / 5 名角色 · 包含秘仪补齐投入`}</p>
    </div>
    {invalid && <div className="free-cost-errors" role="alert"><p>当前配置需要调整</p><ul>{errors.slice(0, 4).map((error, index) => <li key={`${error.path ?? ''}:${index}`}>{error.message}</li>)}</ul>{errors.length > 4 && <small>另有 {errors.length - 4} 项，请查看对应设置。</small>}</div>}
    <dl className="free-cost-totals">
      <div><dt>配队角色本体</dt><dd>{number(cost ? add(members, 'characterDiamonds') : null)} 钻</dd></div>
      <div><dt>装备与养成</dt><dd>{number(cost?.resourceDiamonds)} 钻</dd></div>
      <div><dt>秘仪补齐本体</dt><dd>{number(cost?.offTeamCharacterDiamonds)} 钻</dd></div>
    </dl>
    <Foldout title="资源消耗明细" diamonds={cost?.resourceDiamonds} caption="数量、参考单价与等价钻石">
      {materials.length ? materials.map(definition => {
        const resource = cost.resources[definition[0]];
        return <ResourceLine key={definition[0]} definition={definition} quantity={resource.consumed} unitPrice={resource.unitPrice} diamonds={resource.diamonds} policy={policy} />;
      }) : <p className="free-cost-caption">尚未投入装备养成材料。</p>}
      {materials.some(([key]) => key === 'urLrFragments') && <p className="free-cost-caption">{number(policy.conversions?.urLrFragmentsPerExchange ?? 50)} 片圣遗物装备碎片 = {number(policy.conversions?.relicMaterialsPerExchange ?? 2)} 个圣遗物材料。</p>}
      {materials.some(([key]) => key === 'exclusiveFragments') && <p className="free-cost-caption">{number(policy.conversions?.exclusiveFragmentsPerExchange ?? 10)} 片专武碎片 = {number(policy.conversions?.magicCrystalsPerExclusiveExchange ?? 3)} 个紫水晶。</p>}
    </Foldout>
    <Foldout title="队员投入明细" diamonds={cost ? add(members, 'totalDiamonds') : null} caption="展开查看各角色、专武与六部位装备">
      {members.length ? members.map(member => {
        const body = bodies.find(item => item.sourceKind === 'team' && item.position === member.position);
        const equipment = cost.equipmentCosts.filter(item => item.sourceKind === 'team' && item.position === member.position);
        return <Foldout key={member.characterId} title={`${member.position}. ${member.characterName}`} diamonds={member.totalDiamonds} className="free-member-cost">
          {body && <BodyLine item={body} catalog={catalog} />}
          {equipment.length ? equipment.map(item => <EquipmentCost key={itemKey(item)} item={item} cost={cost} catalog={catalog} policy={policy} />) : <p className="free-cost-caption">尚未装备。</p>}
        </Foldout>;
      }) : <p className="free-cost-caption">选择角色后显示投入明细。</p>}
    </Foldout>
    {offTeam.length > 0 && <Foldout title="秘仪补齐明细" diamonds={cost.offTeamCharacterDiamonds} caption="队外持有角色；与配队共用本体记录">
      {offTeam.map(item => <BodyLine key={itemKey(item)} item={item} catalog={catalog} />)}
    </Foldout>}
    <p className="free-cost-exemptions">魔装、绿水与金币免费。R / N 本体、等级提升资源不计价；等级设置仅决定属性。</p>
    <button className="button primary summary-export" disabled={!canExport || invalid} onClick={onExport}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5" /></svg>
      导出配队文件
    </button>
    <p className="summary-export-note">{memberCount < 5 ? '选齐 5 名角色即可导出' : invalid ? '修正无效配置后即可导出' : '下载 JSON 文件，发送给站主用于构建'}</p>
    <p className="policy-footnote">自由版规则：{policy.version ?? '当前规则'} · 各项明细已计入总额。</p>
  </aside>;
}
