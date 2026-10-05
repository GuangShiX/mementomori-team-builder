import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const bonuses=JSON.parse(await readFile(new URL('../public/data/equipment-bonuses.json',import.meta.url)));

test('treasure preview is a minimal six-slot display projection with explicit units and source hashes',()=>{
  assert.equal(bonuses.schemaVersion,1);
  assert.equal(bonuses.scope,'treasureTermsOnly');
  assert.deepEqual(bonuses.supportedJobs,[1,2,4]);
  assert.equal(bonuses.minimumLevel,0);
  assert.equal(bonuses.maximumLevel,40);
  assert.equal(bonuses.dependencies.jobIndependent,true);
  assert.equal(bonuses.dependencies.equipmentRarityIndependent,true);
  assert.equal(bonuses.dependencies.equipmentLevelIndependent,true);
  assert.equal(bonuses.dependencies.weaponOwnerIndependent,true);
  assert.equal(bonuses.dependencies.includesTotalCharacterStats,false);
  assert.equal(bonuses.dependencies.includesCombatPower,false);
  assert.deepEqual(bonuses.sources.map(({table,sha256})=>({table,sha256})),[
    {table:'EquipmentLegendSacredTreasureMB',sha256:'b46f9008cd4b4a2c7eb2f15c4eec1fe46f9b772128488bf60d6ac61e26741d74'},
    {table:'EquipmentMatchlessSacredTreasureMB',sha256:'0d71386bad6b1eea16cc6c8cde570a9bacadf803c1a91ee3f4921766a8099ef2'},
  ]);
  for (const [kind,group] of Object.entries(bonuses.kinds)) {
    assert.deepEqual(Object.keys(group.slots),['1','2','3','4','5','6']);
    assert.deepEqual(Object.values(group.slots).map(term=>term.slotLabel),['武器','项链','手套','头盔','衣服','脚']);
    for (const [slot,term] of Object.entries(group.slots)) {
      assert.equal(term.slot,Number(slot));
      assert.equal(term.values.length,41);
      assert.equal(term.values[0],0);
      assert.equal(term.unit,kind==='legend'?'percent':'flat');
      assert.equal(term.sourceToDisplayDivisor,kind==='legend'?100:1);
      assert.ok(term.values.every(value=>Number.isFinite(value)&&value>=0));
      assert.ok(!Object.hasOwn(term,'RequiredTotalExp'));
      assert.ok(!Object.hasOwn(term,'Memo'));
    }
  }
});

test('holy percent increases and additive rate points retain distinct parameter operations',()=>{
  const slots=bonuses.kinds.legend.slots;
  assert.deepEqual(Object.values(slots).map(term=>term.parameterType),[
    'AttackPower','Hit','CriticalDamageEnhance','PhysicalCriticalDamageRelax','MagicCriticalDamageRelax','HpDrain',
  ]);
  assert.deepEqual(Object.values(slots).map(term=>term.changeParameterTypeId),[2,2,1,1,1,1]);
  assert.deepEqual(Object.values(slots).map(term=>term.operation),['percentIncrease','percentIncrease','addRate','addRate','addRate','addRate']);
  assert.deepEqual(Object.values(slots).map(term=>term.values[1]),[1.5,0.75,1.5,1.5,1.5,0.5]);
  assert.deepEqual(Object.values(slots).map(term=>term.values[40]),[60,30,60,60,60,20]);
  assert.equal(bonuses.dependencies.percentIncreaseNeedsCharacterBaselineForFinalPoints,true);
});

test('dark bonuses are exact nonlinear fixed-value level lookups rather than level multipliers',()=>{
  const slots=bonuses.kinds.matchless.slots;
  assert.deepEqual(Object.values(slots).map(term=>term.parameterType),[
    'AttackPower','PhysicalDamageRelax','MagicDamageRelax','Critical','DefensePenetration','Hp',
  ]);
  assert.ok(Object.values(slots).every(term=>term.operation==='addValue'&&term.changeParameterTypeId===1));
  assert.deepEqual(Object.values(slots).map(term=>term.values[1]),[590,130,130,60,20,3920]);
  assert.deepEqual(Object.values(slots).map(term=>term.values[10]),[10200,2260,2260,1130,480,67900]);
  assert.deepEqual(Object.values(slots).map(term=>term.values[20]),[32400,7130,7130,3560,1520,214000]);
  assert.deepEqual(Object.values(slots).map(term=>term.values[40]),[105000,23100,23100,11500,4950,693000]);
  assert.notEqual(slots[1].values[40],slots[1].values[1]*40);
  assert.ok(Object.values(slots).every(term=>term.values.every(Number.isSafeInteger)));
});
