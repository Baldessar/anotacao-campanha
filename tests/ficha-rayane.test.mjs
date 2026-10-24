import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Run with: node tests/ficha-rayane.test.mjs
// CHROME_BIN can override the local Chrome executable.
const chrome = spawn(process.env.CHROME_BIN || '/usr/bin/google-chrome', [
  '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', '--remote-debugging-pipe',
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let sequence = 0;
let buffer = '';
const pending = new Map();
let diagnostics = '';
chrome.stderr.on('data', chunk => { diagnostics += chunk; });
chrome.stdio[4].on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\0')) >= 0) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      clearTimeout(request.timeout);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    }
  }
});
chrome.on('error', error => {
  for (const request of pending.values()) request.reject(error);
});
function command(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout: ${method}\n${diagnostics}`));
    }, 15000);
    pending.set(id, { resolve, reject, timeout });
    chrome.stdio[3].write(JSON.stringify({id, method, params, sessionId}) + '\0');
  });
}
let session;
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  }, session);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function waitForReady() {
  for (let i = 0; i < 100; i++) {
    if (await evaluate('document.readyState === "complete" && document.querySelectorAll("#spell-list tr").length === 12')) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Sheet did not load.');
}
function check(expression, expected, label) {
  return evaluate(expression).then(value => { assert.deepEqual(value, expected, label); console.log('PASS', label); });
}
async function typeAttribute(key, value) {
  const point = await evaluate(`(() => {
    const input = document.getElementById(${JSON.stringify(key)});
    input.scrollIntoView({block:'center'});
    const rect = input.getBoundingClientRect();
    const x = rect.x + rect.width / 3, y = rect.y + rect.height / 2;
    return {x,y,uncovered:document.elementFromPoint(x,y) === input};
  })()`);
  assert.equal(point.uncovered, true, `${key} can receive a real click`);
  await command('Input.dispatchMouseEvent', {type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1}, session);
  await command('Input.dispatchMouseEvent', {type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1}, session);
  await check('document.activeElement.id', key, `Click focuses ${key}`);
  await command('Input.dispatchKeyEvent', {type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2}, session);
  await command('Input.dispatchKeyEvent', {type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2}, session);
  await command('Input.insertText', {text:String(value)}, session);
  await check(`state[${JSON.stringify(key)}]`, value, `Keyboard editing saves ${key}`);
}
try {
  const { targetId } = await command('Target.createTarget', {url:'about:blank'});
  const attached = await command('Target.attachToTarget', {targetId, flatten:true});
  session = attached.sessionId;
  const url = pathToFileURL(fileURLToPath(new URL('../ficha-rayane.html', import.meta.url))).href;
  await command('Page.enable', {}, session);
  await command('Page.navigate', {url}, session);
  await waitForReady();
  await evaluate('localStorage.removeItem("rayane-character-sheet-v1")');
  await command('Page.reload', {}, session);
  await waitForReady();
  await check('[state.hp,state.gp,state.sp,state.slots1,state.slots2,state.sorcery,state.hitDiceSpent,state.session5]', [27,89,8,3,0,0,null,''], 'Preserved initial values and unknown hit dice');
  await check('spells.map(s => s[0])', ['Thaumaturgy','Guidance','Sorcerous Burst','Thunderclap','Minor Illusion','True Strike','Healing Word','Shield','Magic Missile','Detect Magic','Invisibility','Misty Step'], 'Exact spell list');
  await check('document.querySelectorAll("#spells th").length', 6, 'Saved browser HTML does not duplicate spell history header');
  await check('state.equipment.includes("40 virotes") && state.equipment.includes("5 rações") && state.equipment.includes("Pinha")', true, 'Purchases and campaign inventory preserved');
  await check('Object.values(state.spellHistory)', Array(6).fill('unknown'), 'All level 1+ spell histories initially unknown');
  await check('document.querySelectorAll("[data-spell-history]").length === 6 && [...document.querySelectorAll("#spell-list tr")].slice(0,6).every(row => !row.querySelector("select"))', true, 'History controls exclude all cantrips');
  await check('(() => {try {validate({...state,spellHistory:{Shield:"invalid"}});return false} catch {return true}})()', true, 'Invalid history rejected');
  await evaluate('const legacy = {...state,notes:"Legacy notes"}; delete legacy.spellHistory; for (const key of attributeKeys) delete legacy[key]; localStorage.setItem(STORAGE_KEY,JSON.stringify(legacy))');
  await command('Page.reload', {}, session);
  await waitForReady();
  await check('[state.notes,Object.values(state.spellHistory).every(value => value === "unknown")]', ['Legacy notes',true], 'Existing local save migrates without losing notes');
  await check('attributeKeys.map(key => state[key])', [8,8,14,16,8,10,17], 'Legacy saves receive original attributes and current Strength');
  await evaluate(`const historySelect = document.querySelector('[data-spell-history="Misty Step"]'); historySelect.value = 'never'; historySelect.dispatchEvent(new Event('change'));`);
  await check('document.querySelector(\'[data-spell-history="Misty Step"]\').closest("td").textContent.includes("Surto garantido")', true, 'Never-cast spell shows automatic surge reminder');
  await check('[state.hp,state.slots1,state.slots2,state.sorcery,state.tides]', [27,3,0,0,'unknown'], 'History edits do not spend resources or change Tides');
  await evaluate('document.getElementById("tempHp").value = "3"; document.getElementById("tempHp").dispatchEvent(new Event("input")); document.getElementById("hp-amount").value = "5"; document.getElementById("damage").click()');
  await check('[state.hp,state.tempHp]', [25,0], 'Temporary HP absorbs damage');
  await evaluate('document.getElementById("hp-amount").value = "999"; document.getElementById("heal").click()');
  await check('state.hp', 29, 'Healing capped at corrected maximum HP');
  await evaluate('document.getElementById("damage").click()');
  await check('state.hp', 0, 'HP never negative');
  await evaluate('document.getElementById("hp").value = "-1"; document.getElementById("hp").dispatchEvent(new Event("input"))');
  await check('state.hp', 0, 'Invalid numeric edit rejected');
  await evaluate('document.getElementById("hp").dispatchEvent(new Event("blur"))');
  await check('document.getElementById("hp").value', '0', 'Invalid visible edit restored on blur');
  await evaluate('render(); document.querySelector("#slots2-pips input").click()');
  await check('state.slots2', 1, 'Spell slot spending');
  await evaluate('document.getElementById("session5").value = "Sessão 5: teste <script>não executar</script>"; document.getElementById("session5").dispatchEvent(new Event("input"))');
  await command('Page.reload', {}, session);
  await waitForReady();
  await check('document.getElementById("session5").value', 'Sessão 5: teste <script>não executar</script>', 'Notes survive reload and remain plain text');
  await check('document.querySelector(\'[data-spell-history="Misty Step"]\').value', 'never', 'Spell history survives reload');
  await evaluate('document.getElementById("spell-level").value = "2"; document.getElementById("spell-level").dispatchEvent(new Event("change"))');
  await check('document.querySelectorAll("#spell-list tr").length', 2, 'Spell level filter');
  await evaluate('window.dispatchEvent(new Event("beforeprint"))');
  await check('document.querySelectorAll("#spell-list tr").length', 12, 'Printing includes all spells');
  await evaluate('window.dispatchEvent(new Event("afterprint"))');
  await check('document.querySelectorAll("#spell-list tr").length', 2, 'Filter restored after printing');
  await check('JSON.stringify(validate(JSON.parse(JSON.stringify(state)))) === JSON.stringify(state)', true, 'JSON backup round trip');
  await check('(() => {try {validate({...state,hp:999});return false} catch {return true}})()', true, 'Malformed backup rejected');
  await evaluate(`window.confirm = () => true;
    const transfer = new DataTransfer();
    transfer.items.add(new File([JSON.stringify({...state,gp:42,session5:'Importado'})], 'test.json', {type:'application/json'}));
    document.getElementById('import').files = transfer.files;
    document.getElementById('import').dispatchEvent(new Event('change'));
  `);
  for (let i = 0; i < 50 && !(await evaluate('state.gp === 42')); i++) await new Promise(resolve => setTimeout(resolve, 20));
  await check('[state.gp,state.session5]', [42,'Importado'], 'File import updates validated data');
  await evaluate(`URL.createObjectURL = blob => { window.exportedBlob = blob; return 'blob:test'; };
    HTMLAnchorElement.prototype.click = function () {};
    document.getElementById('export').click();`);
  await check('exportedBlob.text().then(text => JSON.parse(text).session5)', 'Importado', 'Export button includes session notes in JSON');
  await check('exportedBlob.text().then(text => JSON.parse(text).spellHistory["Misty Step"])', 'never', 'Exported backup preserves spell history');
  await evaluate('window.confirm = () => false; document.getElementById("restore").click()');
  await check('state.hp', 0, 'Cancelled rest leaves state untouched');
  await evaluate('window.confirm = () => true; document.getElementById("restore").click()');
  await check('[state.hp,state.slots1,state.slots2,state.sorcery,state.hitDiceSpent,state.inspiration]', [29,0,0,0,null,'yes'], 'Confirmed rest restores only declared resources');
  await check('state.spellHistory["Misty Step"]', 'never', 'Long rest never resets spell history');
  await evaluate(`document.getElementById('spell-level').value = 'all'; renderSpells(); const castSelect = document.querySelector('[data-spell-history="Misty Step"]'); castSelect.value = 'cast'; castSelect.dispatchEvent(new Event('change'));`);
  await check('document.querySelector(\'[data-spell-history="Misty Step"]\').closest("td").textContent.includes("Primeiro uso já realizado")', true, 'Already-cast spell no longer promises first-use surge');
  await check('[...document.querySelectorAll("nav a")].every(link => link.getAttribute("href").startsWith("#"))', true, 'Navigation uses portable relative anchors');
  for (const width of [320,390,760,900,1280]) {
    await command('Emulation.setDeviceMetricsOverride', {width,height:900,deviceScaleFactor:1,mobile:width < 700}, session);
    await check('document.documentElement.scrollWidth <= innerWidth', true, `No horizontal page overflow at ${width}px`);
    await check('getComputedStyle(document.querySelector("#spell-list tr")).display', width <= 760 ? 'grid' : 'table-row', `Spell cards or table at ${width}px`);
    if (width <= 760) {
      await check('[...document.querySelectorAll("#spell-list tr")].every(row => row.scrollWidth <= row.clientWidth)', true, `Spell card content fits at ${width}px`);
    }
  }
  await check('document.querySelector("#spell-list td:nth-child(4)").dataset.label', 'Conjuração / alcance', 'Mobile spell details have labels');
  await check('[...document.querySelectorAll(".pips label")].every(label => label.getBoundingClientRect().height >= 44)', true, 'Resource controls have touch-sized targets');
  await command('Emulation.setEmulatedMedia', {media:'print'}, session);
  await check('getComputedStyle(document.querySelector("#spell-list tr")).display', 'table-row', 'Printing retains table layout');
  await command('Emulation.setEmulatedMedia', {media:''}, session);
  await evaluate(`window.editAttribute = (key,value) => {const input = document.getElementById(key); input.value = String(value); input.dispatchEvent(new Event('input'));};
    editAttribute('strCurrent',5);`);
  await check('[state.strBase,state.strCurrent,document.querySelector(\'[data-derived="strMod"]\').textContent]', [8,5,'−3'], 'Reduced Strength uses floor-rounded current modifier');
  await check('document.getElementById("strength-status").textContent.includes("redução 3")', true, 'Strength reduction visible');
  await check('document.getElementById("skills").textContent.includes("Atletismo−3") && document.getElementById("weapon-attacks").textContent.includes("Cajado comum−1")', true, 'Current Strength updates Athletics and staff attacks');
  await evaluate('editAttribute("strBase",12)');
  await check('state.strCurrent', 5, 'Editing base Strength does not restore current Strength');
  await evaluate('editAttribute("dex",18); editAttribute("cha",20); editAttribute("wis",14); editAttribute("int",12); editAttribute("con",18)');
  await check('[document.querySelector(\'[data-derived="armor"]\').textContent,document.querySelector(\'[data-derived="initiative"]\').textContent,document.querySelector(\'[data-derived="passive"]\').textContent]', ['14','+4','14'], 'Dexterity and Wisdom update combat summary');
  await check('[document.querySelector(\'[data-derived="spellAttack"]\').textContent,document.querySelector(\'[data-derived="spellDC"]\').textContent,document.querySelector(\'[data-derived="innateDC"]\').textContent]', ['+7','15','16'], 'Charisma updates spells and Innate Sorcery');
  await check('document.getElementById("spell-list").textContent.includes("Ataque de magia +7") && document.getElementById("spell-list").textContent.includes("CD 15")', true, 'Spell descriptions stay in sync');
  await check('[document.querySelector(\'[data-derived="conSave"]\').textContent,document.querySelector(\'[data-derived="intSave"]\').textContent,state.hp,document.querySelector(\'[aria-label="Vida máxima"]\').value]', ['+6','+1',29,'29'], 'Saving throws update while Constitution preserves HP');
  await check('document.getElementById("weapon-attacks").textContent.includes("Besta leve+6")', true, 'Weapon attacks follow Dexterity');
  await evaluate('editAttribute("strCurrent",0)');
  await check('[document.getElementById("strength-alert").hidden,state.hp]', [false,29], 'Zero Strength shows warning without changing HP');
  await evaluate('document.getElementById("restore").click()');
  await check('state.strCurrent', 0, 'Long rest does not automatically restore Strength');
  await evaluate('editAttribute("strCurrent",5); editAttribute("dex",31)');
  await check('state.dex', 18, 'Out-of-range attribute edit rejected');
  await evaluate('document.getElementById("dex").dispatchEvent(new Event("blur"))');
  await check('(() => {try {validate({...state,strBase:0});return false} catch {return true}})()', true, 'Invalid attribute backup rejected');
  await check('JSON.stringify(validate(JSON.parse(JSON.stringify(state)))) === JSON.stringify(state)', true, 'Attributes round-trip through JSON validation');
  await command('Page.reload', {}, session);
  await waitForReady();
  await check('[state.strBase,state.strCurrent,state.dex,state.con,state.int,state.wis,state.cha]', [12,5,18,18,12,14,20], 'Edited attributes survive reload');
  for (const width of [390,1280]) {
    await command('Emulation.setDeviceMetricsOverride', {width,height:900,deviceScaleFactor:1,mobile:width < 700}, session);
    for (const [key,value] of [['strBase',10],['strCurrent',6],['dex',16],['con',14],['int',13],['wis',12],['cha',18]]) {
      await typeAttribute(key,value);
    }
  }
  await command('Page.reload', {}, session);
  await waitForReady();
  await check('[state.strBase,state.strCurrent,state.dex,state.con,state.int,state.wis,state.cha]', [10,6,16,14,13,12,18], 'Real keyboard edits survive reload');
  await evaluate('storageAvailable = false; save()');
  await check('document.getElementById("storage-status").textContent.includes("Exporte backup")', true, 'Blocked storage shows backup warning');
  if (process.env.SNAPSHOT_DIR) {
    await evaluate('state = structuredClone(defaults); render(); document.getElementById("spell-level").value = "all"; renderSpells()');
    for (const width of [390,1280]) {
      await command('Emulation.setDeviceMetricsOverride', {width,height:1000,deviceScaleFactor:1,mobile:width < 700}, session);
      const screenshot = await command('Page.captureScreenshot', {captureBeyondViewport:true}, session);
      await writeFile(join(process.env.SNAPSHOT_DIR, `rayane-html-${width}.png`), Buffer.from(screenshot.data,'base64'));
    }
    const printed = await command('Page.printToPDF', {printBackground:true,preferCSSPageSize:true}, session);
    await writeFile(join(process.env.SNAPSHOT_DIR,'rayane-html-print.pdf'), Buffer.from(printed.data,'base64'));
  }
  console.log('All browser checks passed.');
} finally {
  for (const request of pending.values()) clearTimeout(request.timeout);
  chrome.kill();
}
