import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'vite';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createTeam,createMember} from '../src/domain.mjs';
const catalog={...JSON.parse(await readFile(new URL('../public/data/catalog.json',import.meta.url))),arcana:JSON.parse(await readFile(new URL('../public/data/arcana-catalog.json',import.meta.url))),equipmentBonuses:JSON.parse(await readFile(new URL('../public/data/equipment-bonuses.json',import.meta.url)))};
const policy=JSON.parse(await readFile(new URL('../public/data/pricing-policy.json',import.meta.url)));
const fiveMemberCost=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(policy.unitPrices.characterCopy*5);

test('production UI renders the shipped empty and restored five-member draft without a browser',async()=>{
  const server=await createServer({server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'});
  const original=globalThis.localStorage;
  try{
    const {default:App}=await server.ssrLoadModule('/src/App.jsx');
    const empty=renderToStaticMarkup(React.createElement(App,{catalog,policy}));
    assert.match(empty,/我的配队/);
    assert.ok(empty.indexOf('aria-label="当前角色装备配置"')<empty.indexOf('aria-label="当前五人配队"'),'the empty lineup stays in the central equipment header');
    assert.equal((empty.match(/class="team-slot empty"/g)??[]).length,5);
    assert.match(empty,/搜索角色/);
    assert.match(empty,/导出/);
    assert.match(empty,/诅咒·时之枷锁/);
    assert.match(empty,/等级固定为450级/);
    assert.match(empty,/秘仪加成随角色实际持有汇总/);
    assert.match(empty,/aria-label="构筑页面"/);
    assert.match(empty,/id="arcana-tab" role="tab"/);
    assert.doesNotMatch(empty,/统一链接模拟基准/);
    assert.doesNotMatch(empty,/NaN/);
    const configuredPolicy={...policy,baseline:{...policy.baseline,curse:{...policy.baseline?.curse,name:'诅咒·自定义展示'}},unitPrices:{...policy.unitPrices,characterCopy:12345}};
    const configured=renderToStaticMarkup(React.createElement(App,{catalog,policy:configuredPolicy}));
    assert.match(configured,/诅咒·自定义展示/);
    assert.match(configured,/角色本体：12,345 钻 \/ 个。/);
    assert.doesNotMatch(configured,/诅咒·时之枷锁/,'the curse label must follow the current owner policy');
    const team=createTeam();team.members=catalog.characters.slice(0,5).map(createMember);
    globalThis.localStorage={getItem:()=>JSON.stringify({schemaVersion:1,catalogVersion:catalog.version,team})};
    const restored=renderToStaticMarkup(React.createElement(App,{catalog,policy}));
    assert.ok(restored.includes(fiveMemberCost));
    assert.ok(restored.includes(`角色本体：${new Intl.NumberFormat('zh-CN').format(policy.unitPrices.characterCopy)} 钻 / 个。`));
    assert.match(restored,/索尔缇娜/);
    assert.match(restored,/100,000/);
    assert.doesNotMatch(restored,/NaN/);
    globalThis.localStorage={getItem:()=>JSON.stringify({schemaVersion:1,catalogVersion:'previous-public-catalog',team})};
    const migrated=renderToStaticMarkup(React.createElement(App,{catalog,policy}));
    assert.ok(migrated.includes(fiveMemberCost),'a catalog update must not discard a valid draft');
  }finally{
    if(original===undefined) delete globalThis.localStorage;else globalThis.localStorage=original;
    await server.close();
  }
});
