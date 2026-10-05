import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  createTeam, createMember, createEquipment, calculateTeam, validateTeam,
  createExport, parseImport, cloneTeam, EQUIPMENT_SLOTS, RESOURCE_KEYS,
} from './domain.mjs';

const DRAFT_KEY = 'mementomori-team-builder:draft:v1';
const ELEMENTS = {
  blue: { name: '蓝', color: '#6595b6', symbol: '水' },
  red: { name: '红', color: '#b97470', symbol: '火' },
  green: { name: '绿', color: '#729782', symbol: '风' },
  yellow: { name: '黄', color: '#ba9d57', symbol: '土' },
  light: { name: '光', color: '#b9ac7f', symbol: '光' },
  dark: { name: '暗', color: '#88829d', symbol: '暗' },
};
const SLOT_NAMES = { 1: '武器', 2: '饰品', 3: '护手', 4: '头盔', 5: '铠甲', 6: '鞋子' };
const RESOURCE_NAMES = {
  runeTickets: '饼干 · 符石兑换券', reinforcementMedicine: '红水 · 强化秘药',
  unidentifiedRune7: '7 级未鉴定符石', holySteel: '圣装经验等价',
  ssrFragments: 'SSR 装备碎片（禁忌）', forbiddenFragments: '禁忌武具碎片',
  urLrFragments: 'UR / LR 圣遗物碎片', exclusiveFragments: '专属武器碎片',
  lifeTreeDew: '叶子 · 生命树之露',
};
const RARITY_SERIES = { SSR: 12, UR: 13, LR: 14 };
const characterLabel = character => character?.subtitle ? `${character.name} · ${character.subtitle}` : character?.name ?? '';
const FORMATTER = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const amount = value => Number.isFinite(value) ? FORMATTER.format(value) : '—';
const numeric = value => value === '' ? '' : Number(value);
const runeSlots = category => category.slots ?? category.allowedSlots ?? category.equipmentSlots ?? [];

function restoreDraft(catalog, policy) {
  const empty = { ...createTeam(), level: policy.characterLevel };
  let originalRaw;
  try {
    originalRaw = localStorage.getItem(DRAFT_KEY);
    if (!originalRaw) return { team: empty, originalRaw: null, needsBackup: false, notice: null };
    const stored = JSON.parse(originalRaw);
    if (stored?.schemaVersion !== 1 || !stored?.team || !Array.isArray(stored.team.members)) throw new Error('草稿格式无法识别');
    const previous = stored.team;
    const knownCharacters = new Map(catalog.characters.map(character => [character.id, character]));
    const seen = new Set();
    let repaired = previous.members.length !== 5 || previous.level !== policy.characterLevel;
    const readableNumber = (value, fallback) => typeof value === 'number' || value === '' ? value : fallback;
    const recovered = {
      ...empty,
      name: typeof previous.name === 'string' ? previous.name : empty.name,
      author: typeof previous.author === 'string' ? previous.author : '',
      notes: typeof previous.notes === 'string' ? previous.notes : '',
      members: empty.members.map((_, index) => {
        const source = previous.members[index];
        if (!source) return null;
        const character = knownCharacters.get(source.characterId);
        if (!character || seen.has(source.characterId)) { repaired = true; return null; }
        seen.add(source.characterId);
        const member = createMember(character);
        if (['SR', 'LR', 'LR5'].includes(source.rarity)) member.rarity = source.rarity;
        else repaired = true;
        if (!Array.isArray(source.equipment)) { repaired = true; return member; }
        member.equipment = member.equipment.map((emptyGear, gearIndex) => {
          const saved = source.equipment.find(gear => gear?.slot === emptyGear.slot) ?? source.equipment[gearIndex];
          if (!saved || !['NONE', 'SSR', 'UR', 'LR'].includes(saved.rarity)) { repaired = true; return emptyGear; }
          if (saved.rarity === 'NONE') return emptyGear;
          if (!Array.isArray(saved.runes) || saved.runes.length !== 4) repaired = true;
          return {
            ...emptyGear, rarity: saved.rarity, seriesId: saved.seriesId ?? RARITY_SERIES[saved.rarity],
            weaponKind: ['normal', 'exclusive'].includes(saved.weaponKind) ? saved.weaponKind : 'normal',
            level: readableNumber(saved.level, policy.characterLevel),
            reinforcementLevel: readableNumber(saved.reinforcementLevel, 0),
            legendSacredTreasureLevel: readableNumber(saved.legendSacredTreasureLevel, 0),
            matchlessSacredTreasureLevel: readableNumber(saved.matchlessSacredTreasureLevel, 0),
            runes: emptyGear.runes.map((emptyRune, runeIndex) => {
              const rune = saved.runes?.[runeIndex];
              if (!rune || !catalog.runeCategories.some(category => category.id === rune.categoryId)) { repaired = true; return emptyRune; }
              return { categoryId: rune.categoryId, level: readableNumber(rune.level, 0) };
            }),
          };
        });
        return member;
      }),
    };
    const versionChanged = stored.catalogVersion !== catalog.version;
    const needsBackup = repaired || versionChanged || JSON.stringify(recovered) !== JSON.stringify(previous);
    const notice = needsBackup ? {
      kind: 'info',
      text: versionChanged
        ? '角色目录已更新，已迁移仍可用的角色和装备。原草稿会另存备份，请检查当前规则下的配置提示。'
        : '已恢复可识别的草稿配置，原始草稿会另存备份。请检查未恢复或需要调整的项目。',
    } : null;
    return { team: recovered, originalRaw, needsBackup, notice };
  } catch {
    return {
      team: empty, originalRaw, needsBackup: Boolean(originalRaw),
      notice: originalRaw ? { kind: 'error', text: '原草稿无法完整恢复，已保留原始内容并尝试另存备份。你可以新建方案；备份失败时会暂停自动保存。' } : null,
    };
  }
}

function fixedRuneInventory(team, catalog, policy, calculated) {
  if (Array.isArray(calculated?.fixedRuneInventory)) return calculated.fixedRuneInventory;
  const stock = policy.runes?.fixedStock;
  if (!stock) return [];
  const categories = catalog.runeCategories.filter(category => !stock.excludedCategoryIds.includes(category.id));
  const used = new Map(categories.map(category => [category.id, 0]));
  for (const member of team.members) {
    if (!member) continue;
    for (const gear of member.equipment) {
      if (gear.rarity === 'NONE') continue;
      for (const rune of gear.runes) {
        if (rune.level > 0 && used.has(rune.categoryId)) used.set(rune.categoryId, used.get(rune.categoryId) + 1);
      }
    }
  }
  return categories.map(category => ({ categoryId: category.id, name: category.name, level: stock.level, used: used.get(category.id), available: stock.perCategory, remaining: stock.perCategory - used.get(category.id) }));
}

function Icon({ name, size = 16, ...props }) {
  const paths = {
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
    download: <><path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4" /></>,
    upload: <><path d="M12 16V4m-4 4 4-4 4 4M4 17v4h16v-4" /></>,
    left: <path d="m14 6-6 6 6 6" />,
    right: <path d="m10 6 6 6-6 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    gear: <><path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z" /><circle cx="12" cy="12" r="3" /></>,
    sword: <><path d="m5 19 13-13 2-3-3 2L4 18m1-5 6 6m-7-2-2 2 3 3 2-2" /></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" /><path d="M12 7v10" /></>,
    sparkle: <><path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z" /></>,
    check: <path d="m5 12 4 4L19 6" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name] ?? paths.gear}</svg>;
}

function Portrait({ character, badge = true }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [character?.id, character?.portrait]);
  const element = ELEMENTS[character?.element];
  return <div className="portrait-frame">
    {character?.portrait && !failed
      ? <img src={character.portrait} alt="" loading="lazy" onError={() => setFailed(true)} />
      : <span className="portrait-fallback" aria-hidden="true">{character?.name?.slice(0, 1) ?? '✧'}</span>}
    {badge && element && <span className="element-badge" style={{ '--element-color': element.color }} title={`${element.name}属性`}>{element.symbol}</span>}
  </div>;
}

function Field({ label, path, errors, children, full = false }) {
  const issue = errors?.find(item => item.path === path);
  return <label className={`field${full ? ' full' : ''}`}>
    <span className="field-label">{label}</span>
    {children}
    {issue && <span className="input-error" role="alert">{issue.message}</span>}
  </label>;
}

function equipmentLevels(catalog, rarity, weaponKind) {
  if (rarity === 'NONE') return [];
  const tableKey = weaponKind === 'exclusive' ? `exclusive${rarity}` : rarity;
  const table = catalog.equipmentCosts?.fragments?.[tableKey];
  if (table) return Object.keys(table).map(Number).filter(Number.isSafeInteger).sort((a, b) => a - b);
  return catalog.equipmentCosts?.allowedLevels?.[rarity] ?? [];
}

function EquipmentEditor({ gear, index, member, catalog, policy, onChange, errors, memberIndex, inventory }) {
  const prefix = `members[${memberIndex}].equipment[${index}]`;
  const availableRunes = catalog.runeCategories.filter(category => runeSlots(category).includes(gear.slot));
  const levels = equipmentLevels(catalog, gear.rarity, gear.weaponKind).filter(level => level <= policy.characterLevel);
  const series = (catalog.equipmentSeries ?? catalog.series ?? []).find(item => item.id === gear.seriesId);
  const maximumSacred = catalog.limits?.sacredTreasureLevel ?? policy.limits?.sacredTreasureLevel ?? 40;
  const maximumRune = catalog.limits?.runeLevel ?? policy.limits?.runeLevel ?? 15;
  const fixedStock = policy.runes?.fixedStock;
  const isFixedCategory = categoryId => fixedStock && !fixedStock.excludedCategoryIds.includes(categoryId);
  function selectRarity(rarity) {
    if (rarity === 'NONE') { onChange(createEquipment(gear.slot)); return; }
    const updated = {
      ...gear, rarity, seriesId: RARITY_SERIES[rarity],
      runes: gear.runes.map((rune, index) => rune.level === 0
        ? { ...rune, categoryId: availableRunes[index]?.id ?? availableRunes[0]?.id ?? rune.categoryId }
        : rune),
    };
    const allowed = equipmentLevels(catalog, rarity, updated.weaponKind).filter(level => level <= policy.characterLevel);
    if (!allowed.includes(updated.level)) updated.level = allowed.at(-1) ?? policy.characterLevel;
    if (Number.isFinite(updated.reinforcementLevel)) updated.reinforcementLevel = Math.min(updated.reinforcementLevel, updated.level);
    onChange(updated);
  }
  function setWeaponKind(weaponKind) {
    const updated = { ...gear, weaponKind };
    const allowed = equipmentLevels(catalog, gear.rarity, weaponKind).filter(level => level <= policy.characterLevel);
    if (!allowed.includes(updated.level)) updated.level = allowed.at(-1) ?? policy.characterLevel;
    if (Number.isFinite(updated.reinforcementLevel)) updated.reinforcementLevel = Math.min(updated.reinforcementLevel, updated.level);
    onChange(updated);
  }
  function setRune(runeIndex, updates) {
    onChange({ ...gear, runes: gear.runes.map((rune, i) => i === runeIndex ? { ...rune, ...updates } : rune) });
  }
  return <section className={`equipment-card${gear.rarity === 'NONE' ? ' empty-equipment' : ''}`} aria-label={SLOT_NAMES[gear.slot]}>
    <div className="equipment-card-header">
      <h3 className="equipment-name"><Icon name={gear.slot <= 3 ? 'sword' : 'shield'} size={15} />{SLOT_NAMES[gear.slot]}</h3>
      <select className="equipment-rarity" aria-label={`${SLOT_NAMES[gear.slot]}稀有度`} value={gear.rarity} onChange={event => selectRarity(event.target.value)}>
        <option value="NONE">未装备</option><option value="SSR">SSR</option><option value="UR">UR</option>
        <option value="LR" disabled={member.rarity !== 'LR5'}>LR{member.rarity !== 'LR5' ? ' · 需 LR5' : ''}</option>
      </select>
    </div>
    {gear.rarity === 'NONE' ? <p className="empty-equipment-note">选择装备后设置养成与符石</p> : <>
      <div className="fixed-series">{gear.weaponKind === 'exclusive' ? '角色专属武器' : series?.name ?? gear.rarity}{gear.rarity === 'LR' ? ' · 需 LR5 角色' : ''}</div>
      <div className="equipment-fields">
        {gear.slot === 1 && <Field label="武器类型" path={`${prefix}.weaponKind`} errors={errors} full>
          <select aria-label="武器类型" value={gear.weaponKind} onChange={event => setWeaponKind(event.target.value)}><option value="normal">通用武器</option><option value="exclusive">专属武器</option></select>
        </Field>}
        <Field label="装备等级" path={`${prefix}.level`} errors={errors}>
          <select aria-label={`${SLOT_NAMES[gear.slot]}装备等级`} value={gear.level} onChange={event => onChange({ ...gear, level: Number(event.target.value), reinforcementLevel: Math.min(Number(gear.reinforcementLevel) || 0, Number(event.target.value)) })}>
            {!levels.includes(gear.level) && <option value={gear.level}>{gear.level} · 不可用</option>}
            {levels.map(level => <option key={level} value={level}>Lv. {level}</option>)}
          </select>
        </Field>
        <Field label="强化等级" path={`${prefix}.reinforcementLevel`} errors={errors}>
          <input aria-label={`${SLOT_NAMES[gear.slot]}强化等级`} type="number" min="0" max={gear.level} step="1" value={gear.reinforcementLevel} onChange={event => onChange({ ...gear, reinforcementLevel: numeric(event.target.value) })} />
        </Field>
        <Field label="圣装等级" path={`${prefix}.legendSacredTreasureLevel`} errors={errors}>
          <input aria-label={`${SLOT_NAMES[gear.slot]}圣装等级`} type="number" min="0" max={maximumSacred} step="1" value={gear.legendSacredTreasureLevel} onChange={event => onChange({ ...gear, legendSacredTreasureLevel: numeric(event.target.value) })} />
        </Field>
        <Field label="魔装等级" path={`${prefix}.matchlessSacredTreasureLevel`} errors={errors}>
          <input aria-label={`${SLOT_NAMES[gear.slot]}魔装等级`} type="number" min="0" max={maximumSacred} step="1" value={gear.matchlessSacredTreasureLevel} onChange={event => onChange({ ...gear, matchlessSacredTreasureLevel: numeric(event.target.value) })} />
        </Field>
      </div>
      <div className="rune-section">
        <div className="rune-heading"><span>符石孔</span><span>{gear.slot <= 3 ? '攻击类' : '防御类'} · 同类不可重复</span></div>
        <div className="rune-holes">{gear.runes.map((rune, runeIndex) => {
          const active = rune.level !== 0;
          const fixedLevel = active && isFixedCategory(rune.categoryId);
          const issue = errors.find(item => item.path.startsWith(`${prefix}.runes[${runeIndex}]`));
          return <div key={runeIndex}>
            <div className="rune-row">
              <span className="rune-number">{runeIndex + 1}</span>
              <select aria-label={`${SLOT_NAMES[gear.slot]}第${runeIndex + 1}孔符石类别`} value={active ? rune.categoryId : ''} onChange={event => {
                if (event.target.value === '') { setRune(runeIndex, { level: 0 }); return; }
                const categoryId = Number(event.target.value);
                setRune(runeIndex, { categoryId, level: isFixedCategory(categoryId) ? fixedStock.level : rune.level > 0 ? rune.level : 1 });
              }}>
                <option value="">空孔</option>
                {availableRunes.map(category => {
                  const stock = inventory.find(item => item.categoryId === category.id);
                  const alreadyHere = active && rune.categoryId === category.id;
                  const unavailable = stock && stock.remaining <= 0 && !alreadyHere;
                  return <option key={category.id} value={category.id} disabled={unavailable || gear.runes.some((other, i) => i !== runeIndex && other.level > 0 && other.categoryId === category.id)}>{category.name.replace(/符石$/, '')}{stock ? ` · 余${Math.max(0, stock.remaining)}` : ''}</option>;
                })}
              </select>
              {fixedLevel
                ? <input aria-label={`${SLOT_NAMES[gear.slot]}第${runeIndex + 1}孔固定符石等级`} className="fixed-rune-level" type="text" readOnly value={`Lv.${rune.level}`} title={`普通符石固定 Lv.${fixedStock.level}，使用整队共享库存`} />
                : <input aria-label={`${SLOT_NAMES[gear.slot]}第${runeIndex + 1}孔符石等级`} type="number" min="0" max={maximumRune} step="1" disabled={!active} value={active ? rune.level : ''} placeholder="—" onChange={event => setRune(runeIndex, { level: numeric(event.target.value) })} />}
            </div>
            {fixedLevel && rune.level !== fixedStock.level && <button className="rune-repair" onClick={() => setRune(runeIndex, { level: fixedStock.level })}>调整为 Lv.{fixedStock.level}</button>}
            {issue && <p className="input-error" role="alert">{issue.message}</p>}
          </div>;
        })}</div>
      </div>
    </>}
  </section>;
}

function CostSummary({ cost, errors, policy, canExport, onExport, memberCount, inventory }) {
  const displayedResources = ['runeTickets', 'reinforcementMedicine', 'holySteel'];
  const steelRatio = policy.holySteelPerExperience || 1;
  const captionByResource = {
    runeTickets: '穿透、速度符石折算', reinforcementMedicine: '含武器与其余五件装备',
    holySteel: '按各部位累计经验合计',
  };
  const resourceLabel = key => RESOURCE_NAMES[key] ?? key;
  const scaled = (key, value) => key === 'holySteel' ? value / steelRatio : value;
  return <aside className="panel summary-panel" aria-label="资源与费用摘要">
    <div className="panel-header"><div className="panel-heading"><span className="section-index">03</span><h2>资源预算</h2></div><Icon name="sparkle" size={16} /></div>
    <p className="summary-top-note">全队统一额度 · 即时计算等价钻石</p>
    <div className="total-block">
      <div className="total-label">当前配队等价费用</div>
      <div className="total-value"><strong>{amount(cost?.totalDiamonds)}</strong><span>钻石</span></div>
      <p className="total-caption">{errors.length ? '请修正配置后查看准确费用' : `${memberCount} / 5 名角色 · 包含本体与超额材料`}</p>
    </div>
    <div className="resource-section-title"><span>已投入等价量</span><span>免费额度</span></div>
    <div className="resource-list">{displayedResources.map(key => {
      const resource = cost?.resources?.[key];
      const consumed = resource ? scaled(key, resource.consumed) : null;
      const free = scaled(key, resource?.freeAllowance ?? policy.allowances?.[key] ?? 0);
      const charged = resource ? scaled(key, resource.charged) : null;
      const ratio = consumed == null ? 0 : free > 0 ? Math.min(1, consumed / free) : consumed > 0 ? 1 : 0;
      return <div className="resource-item" key={key}>
        <div className="resource-item-top"><span>{resourceLabel(key)}</span><strong>{amount(consumed)}</strong></div>
        <div className="resource-caption"><span>{captionByResource[key]}</span><span>{amount(free)} 免费</span></div>
        <div className={`resource-bar${charged > 0 ? ' exceeded' : ''}`}><span style={{ width: `${ratio * 100}%` }} /></div>
        {charged > 0 && <p className="resource-extra">超出 {amount(charged)} · +{amount(resource.diamonds)} 钻</p>}
      </div>;
    })}</div>
    {inventory.length > 0 && <details className="inventory-details" open={inventory.some(item => item.remaining < 0)}>
      <summary>普通符石库存 <span>Lv.{policy.runes.fixedStock.level} × {policy.runes.fixedStock.perCategory} / 类</span></summary>
      <p className="inventory-caption">每类整队共享，等级固定。超出库存须移除对应符石。</p>
      <div className="inventory-list">{inventory.map(item => <div key={item.categoryId} className={`inventory-row${item.remaining < 0 ? ' exceeded' : ''}`}>
        <span>{item.name.replace(/符石$/, '')}</span><span>已用 {item.used} / {item.available}</span><strong>{item.remaining < 0 ? `超出 ${-item.remaining}` : `余 ${item.remaining}`}</strong>
      </div>)}</div>
    </details>}
    <div className="summary-divider" />
    <div className="price-breakdown">
      <div className="price-line"><span>角色本体</span><strong>{amount(cost?.characterDiamonds)} 钻</strong></div>
      <div className="price-line"><span>超额材料</span><strong>{amount(cost?.resourceDiamonds)} 钻</strong></div>
    </div>
    <details className="price-details"><summary>查看费用细目与规则</summary><div className="cost-detail-content">
      <dl>{cost?.characterCosts?.map(item => <React.Fragment key={item.position}><dt>{item.characterName} · {item.rarity} · {item.copies} 本体</dt><dd>{amount(item.diamonds)} 钻</dd></React.Fragment>)}
        {RESOURCE_KEYS.filter(key => key !== 'unidentifiedRune7').map(key => {
          const resource = cost?.resources?.[key];
          if (!resource || resource.consumed === 0) return null;
          return <React.Fragment key={key}><dt>{RESOURCE_NAMES[key] ?? key} · {amount(resource.consumed)}</dt><dd>{amount(resource.diamonds)} 钻</dd></React.Fragment>;
        })}
      </dl>
      <p>符石兑换券超额单价 {amount(policy.unitPrices?.runeTickets)} 钻 / 张；强化秘药 {amount(policy.unitPrices?.reinforcementMedicine)} 钻 / 个；圣装经验 {amount((policy.unitPrices?.holySteel ?? 0) * steelRatio)} 钻 / 点。</p>
      <p>魔装累计经验 {amount(cost?.matchlessExperience)}。各类碎片独立计价；材料表示当前配置的累计投入，降级会减少预算。</p>
      <p>导出包含完整计价规则与费用细目。接收方会按当前规则重新计算。</p>
    </div></details>
    <button className="button primary summary-export" disabled={!canExport} onClick={onExport}><Icon name="download" />导出配队文件</button>
    <p className="summary-export-note">{memberCount < 5 ? '选齐 5 名角色即可导出' : errors.length ? '修正无效配置后即可导出' : '下载 JSON 文件，发送给站主用于构建'}</p>
    <p className="policy-footnote">规则版本：{policy.version ?? policy.revision ?? '当前规则'}<br />费用为构筑预算，不代表战力或战斗结果。</p>
  </aside>;
}

export default function App({ catalog, policy }) {
  const [restoredDraft] = useState(() => restoreDraft(catalog, policy));
  const [team, setTeam] = useState(restoredDraft.team);
  const [selectedIndex, setSelectedIndex] = useState(() => team.members.findIndex(Boolean));
  const [search, setSearch] = useState('');
  const [element, setElement] = useState('all');
  const [notice, setNotice] = useState(restoredDraft.notice);
  const [draftStatus, setDraftStatus] = useState('已保存在此浏览器');
  const importInput = useRef(null);
  const editorRef = useRef(null);
  const draftBackupDone = useRef(!restoredDraft.needsBackup);
  const characters = useMemo(() => new Map(catalog.characters.map(character => [character.id, character])), [catalog]);
  const selectedMember = team.members[selectedIndex];
  const selectedCharacter = selectedMember ? characters.get(selectedMember.characterId) : null;
  const memberCount = team.members.filter(Boolean).length;
  const valuation = useMemo(() => {
    const validation = validateTeam(team, catalog, policy);
    if (!validation.valid) return { cost: null, errors: validation.errors };
    try { return { cost: calculateTeam(team, catalog, policy), errors: [] }; }
    catch (error) { return { cost: null, errors: error.errors ?? [{ message: error.message }] }; }
  }, [team, catalog, policy]);
  const canExport = memberCount === 5 && valuation.errors.length === 0;
  const inventory = useMemo(() => fixedRuneInventory(team, catalog, policy, valuation.cost), [team, catalog, policy, valuation.cost]);
  const filtered = catalog.characters.filter(character =>
    (character.baseRarity == null || character.baseRarity === 8)
    && (element === 'all' || character.element === element)
    && `${character.name} ${character.subtitle ?? ''} ${character.variant ?? ''} ${character.aliases?.join?.(' ') ?? ''} ${character.id}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  useEffect(() => {
    try {
      if (!draftBackupDone.current && restoredDraft.originalRaw) {
        const backupKey = `${DRAFT_KEY}:backup:${Date.now()}`;
        localStorage.setItem(backupKey, restoredDraft.originalRaw);
        draftBackupDone.current = true;
      }
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ schemaVersion: 1, catalogVersion: catalog.version, team: cloneTeam(team) }));
      setDraftStatus('已保存在此浏览器');
    } catch {
      setDraftStatus(draftBackupDone.current ? '浏览器无法保存草稿，请及时导出' : '原草稿无法备份，已暂停自动保存');
    }
  }, [team, catalog.version, restoredDraft]);
  function changeTeam(update) { setNotice(null); setTeam(current => typeof update === 'function' ? update(current) : update); }
  function addCharacter(character) {
    if (team.members.some(member => member?.characterId === character.id)) {
      setSelectedIndex(team.members.findIndex(member => member?.characterId === character.id));
      return;
    }
    const emptyIndex = team.members.findIndex(member => member === null);
    if (emptyIndex === -1) { setNotice({ kind: 'info', text: '配队已满。移除一名角色后可添加其他角色。' }); return; }
    changeTeam(current => ({ ...current, members: current.members.map((member, index) => index === emptyIndex ? createMember(character) : member) }));
    setSelectedIndex(emptyIndex);
  }
  function updateMember(update) {
    changeTeam(current => ({ ...current, members: current.members.map((member, index) => index === selectedIndex ? { ...member, ...update } : member) }));
  }
  function updateEquipment(index, equipment) {
    changeTeam(current => ({ ...current, members: current.members.map((member, i) => i === selectedIndex ? { ...member, equipment: member.equipment.map((gear, j) => j === index ? equipment : gear) } : member) }));
  }
  function removeMember(index) {
    changeTeam(current => ({ ...current, members: current.members.map((member, i) => i === index ? null : member) }));
    if (selectedIndex === index) setSelectedIndex(team.members.findIndex((member, i) => member && i !== index));
  }
  function moveMember(index, offset) {
    const target = index + offset;
    if (target < 0 || target >= 5) return;
    changeTeam(current => {
      const members = [...current.members];
      [members[index], members[target]] = [members[target], members[index]];
      return { ...current, members };
    });
    if (selectedIndex === index) setSelectedIndex(target);
    else if (selectedIndex === target) setSelectedIndex(index);
  }
  function exportTeam() {
    try {
      const exported = createExport(team, catalog, policy);
      const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${(team.name.trim() || '我的配队').replace(/[\\/:*?"<>|]/g, '_')}.mmtm-team.json`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice({ kind: 'success', text: '配队文件已下载。将 JSON 文件发送给站主，即可按此方案构建。' });
    } catch (error) { setNotice({ kind: 'error', text: error.message }); }
  }
  async function importTeam(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error('配队文件超过 1 MB，请选择本站导出的 JSON 文件。');
      const imported = parseImport(await file.text(), catalog, policy);
      setTeam(imported.team); setSelectedIndex(imported.team.members.findIndex(Boolean));
      setNotice({ kind: 'success', text: `配队已导入。${imported.warnings.join(' ')}` });
    } catch (error) { setNotice({ kind: 'error', text: `导入失败：${error.message}` }); }
  }
  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">M</span><div><div className="brand-title">配队工坊</div><div className="brand-subtitle">MEMENTO MORI · TEAM BUILDER</div></div></div>
      <div className="topbar-right"><span className="local-note"><span className="status-dot" />{draftStatus}</span><button className="button" onClick={() => importInput.current?.click()}><Icon name="upload" size={14} />导入方案</button><button className="button primary" disabled={!canExport} onClick={exportTeam}><Icon name="download" size={14} />导出方案</button></div>
      <input ref={importInput} type="file" accept="application/json,.json" aria-label="导入配队 JSON 文件" onChange={importTeam} />
    </header>
    <div className="intro"><div><div className="eyebrow">BUILD YOUR OWN STORY</div><h1>让每一份构想，成为配队。</h1><p>挑选角色，调整装备，掌握资源预算。完成后导出你的专属方案。</p></div><div className="intro-note"><strong>{policy.characterLevel}</strong><span>级统一链接模拟基准<br />SR、LR 与 LR5 共用此等级</span></div></div>
    {notice && <div className={`notice ${notice.kind}`} role="status" style={{ marginBottom: 16 }}>{notice.text}</div>}
    <main className="workspace">
      <aside className="panel catalog-panel" aria-label="角色目录">
        <div className="panel-header"><div className="panel-heading"><span className="section-index">01</span><h2>选择角色</h2></div><span className="count">{filtered.length} 位</span></div>
        <div className="search"><Icon name="search" size={14} /><input aria-label="搜索角色" placeholder="搜索角色名称" value={search} onChange={event => setSearch(event.target.value)} /></div>
        <div className="filter-row" role="group" aria-label="元素筛选"><button className={`filter-button${element === 'all' ? ' active' : ''}`} aria-pressed={element === 'all'} onClick={() => setElement('all')}>全部</button>{Object.entries(ELEMENTS).map(([key, item]) => <button key={key} className={`filter-button${element === key ? ' active' : ''}`} aria-pressed={element === key} onClick={() => setElement(key)}>{item.name}</button>)}</div>
        <div className="catalog-grid">{filtered.map(character => {
          const inTeam = team.members.some(member => member?.characterId === character.id);
          return <button className={`character-tile${inTeam ? ' in-team' : ''}`} key={character.id} title={`${characterLabel(character)} · ${inTeam ? '查看当前配置' : '添加到配队'}`} aria-label={`${inTeam ? '选择' : '添加'}${characterLabel(character)}`} onClick={() => addCharacter(character)}>
            <div style={{ position: 'relative' }}><Portrait character={character} />{inTeam && <span className="selected-check"><Icon name="check" size={10} /></span>}</div><span className="tile-name">{character.name}</span>{character.subtitle && <span className="tile-subtitle">{character.subtitle}</span>}
          </button>;
        })}{filtered.length === 0 && <p className="no-results">没有找到符合条件的角色</p>}</div>
        <p className="catalog-help">点击头像加入配队 · 已加入角色会标记<br />目录为可用的初始 SR 角色，角色数据随版本更新。</p>
      </aside>
      <div className="center-column">
        <section className="panel team-panel" aria-label="当前五人配队">
          <div className="panel-header"><div className="panel-heading"><span className="section-index">02</span><h2>我的配队 <span className="count">{memberCount} / 5</span></h2></div><div className="team-header-controls"><button className="quiet-button reset-button" onClick={() => { changeTeam({ ...createTeam(), level: policy.characterLevel }); setSelectedIndex(-1); }}>新建方案</button></div></div>
          <div className="team-slots">{team.members.map((member, index) => {
            const character = member ? characters.get(member.characterId) : null;
            return <div key={index} className={`team-slot${member ? '' : ' empty'}${member && index === selectedIndex ? ' selected' : ''}`}>
              <span className="slot-position">0{index + 1}</span>
              {member ? <><button className="member-select" title={characterLabel(character)} aria-label={`配置${characterLabel(character)}，位置${index + 1}`} aria-pressed={index === selectedIndex} onClick={() => setSelectedIndex(index)}><Portrait character={character} /><span className="member-name">{character?.name}</span>{character?.subtitle && <span className="member-subtitle">{character.subtitle}</span>}<span className="rarity-pill">{member.rarity} · Lv.{team.level}</span></button><div className="member-actions"><button className="icon-button" aria-label={`${characterLabel(character)}前移`} title="前移" disabled={index === 0} onClick={() => moveMember(index, -1)}><Icon name="left" size={12} /></button><button className="icon-button" aria-label={`${characterLabel(character)}后移`} title="后移" disabled={index === 4} onClick={() => moveMember(index, 1)}><Icon name="right" size={12} /></button><button className="icon-button danger" aria-label={`移除${characterLabel(character)}`} title="移除角色" onClick={() => removeMember(index)}><Icon name="close" size={12} /></button></div></> : <div className="empty-slot-content"><div className="empty-slot-plus">＋</div><span>待选择</span></div>}
            </div>;
          })}</div>
          <p className="team-note">位置决定导出顺序。点击队伍头像编辑角色，使用箭头调整站位。</p>
        </section>
        <section className="panel details-panel" ref={editorRef} aria-label="当前角色装备配置">
          {selectedMember && selectedCharacter ? <>
            <div className="selected-character-header"><div className="selected-character-identity"><Portrait character={selectedCharacter} /><div><h2>{selectedCharacter.name}</h2>{selectedCharacter.subtitle && <p className="selected-subtitle">{selectedCharacter.subtitle}</p>}<p className="character-meta">{ELEMENTS[selectedCharacter.element]?.name}属性 · 第 {selectedIndex + 1} 位 · Lv.{policy.characterLevel}</p></div></div><label className="rarity-control"><span className="field-label">角色稀有度</span><select aria-label="角色稀有度" value={selectedMember.rarity} onChange={event => updateMember({ rarity: event.target.value })}><option value="SR">SR</option><option value="LR">LR</option><option value="LR5">LR5</option></select></label></div>
            {valuation.errors.length > 0 && <div className="notice error validation-notice" role="alert"><strong>当前配置需要修正</strong><ul>{valuation.errors.slice(0, 6).map((issue, i) => <li key={`${issue.path}-${i}`}>{issue.message}</li>)}</ul>{valuation.errors.length > 6 && <p>另有 {valuation.errors.length - 6} 项，请逐项检查。</p>}</div>}
            <div className="equip-intro"><span>六部位装备</span><span>未装备部位不消耗材料</span></div>
            {policy.runes?.fixedStock && <p className="fixed-stock-note">普通符石：每类 Lv.{policy.runes.fixedStock.level} × {policy.runes.fixedStock.perCategory}，整队共享。穿透与速度可自由调整等级。</p>}
            <div className="equip-grid">{EQUIPMENT_SLOTS.map((slot, index) => <EquipmentEditor key={`${selectedMember.characterId}-${slot}`} gear={selectedMember.equipment[index]} index={index} member={selectedMember} memberIndex={selectedIndex} catalog={catalog} policy={policy} errors={valuation.errors} inventory={inventory} onChange={gear => updateEquipment(index, gear)} />)}</div>
          </> : <div className="empty-detail"><div className="empty-detail-mark"><Icon name="gear" size={23} /></div><h2>从一名角色开始</h2><p>在角色目录中选择头像，设定稀有度与六部位装备。<br />全队使用 Lv.{policy.characterLevel} 统一链接基准。</p></div>}
        </section>
        <section className="panel plan-panel" aria-label="方案信息"><div className="panel-header"><h2>为方案留下一些说明</h2><span className="count">自动保存草稿</span></div><div className="plan-fields"><Field label="配队名称" path="name" errors={valuation.errors}><input aria-label="配队名称" maxLength={120} value={team.name} onChange={event => changeTeam(current => ({ ...current, name: event.target.value }))} /></Field><Field label="作者 / 昵称（可选）" path="author" errors={valuation.errors}><input aria-label="作者昵称" maxLength={120} placeholder="你的昵称" value={team.author} onChange={event => changeTeam(current => ({ ...current, author: event.target.value }))} /></Field><Field label="备注（可选）" path="notes" errors={valuation.errors} full><textarea aria-label="方案备注" rows={3} maxLength={4000} placeholder="例如：配队思路、主力角色或希望测试的对手……" value={team.notes} onChange={event => changeTeam(current => ({ ...current, notes: event.target.value }))} /></Field></div></section>
      </div>
      <CostSummary cost={valuation.cost} errors={valuation.errors} policy={policy} memberCount={memberCount} inventory={inventory} canExport={canExport} onExport={exportTeam} />
    </main>
    <footer className="footer"><span>配队与草稿保存在你的浏览器中 · 不自动上传 · {draftStatus}</span><span>资源价值参考 <a href="https://hitazuki.github.io/mementomori-calculator/#packCompare" target="_blank" rel="noopener noreferrer">MementoMori Calculator</a> · 最终按站主规则复核</span></footer>
  </div>;
}
