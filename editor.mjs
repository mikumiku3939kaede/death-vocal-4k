import { defaultChart, validateChart, pitchName, canonicalBeat, beatValue, addBeats, subtractBeats, multiplyBeats, validateNoteValue, noteValueLength, noteValueLabel, inferNoteValue } from './engine.mjs';
const $ = id => document.getElementById(id);
const LEFT = 64, H = 480, VOICE_Y = 39, ROW = 19, KEY_Y = 324, KEY_ROW = 34;
const canvas = $('editor-canvas'), ctx = canvas.getContext('2d'), dpr = Math.min(devicePixelRatio || 1, 2);
let chart = validateChart(defaultChart()), history = [], future = [], page = 0, selected = null;
let cursor = { row: 13, beat: 0 }, drag = null, preview = null, ppb = 110, W = 960;
const clone = value => structuredClone(value);
const base = () => Number($('octave').value);
let inputValue = { denominator: 16, dots: 0, tupletCount: 1, tupletIn: 1 };
const gridStep = () => noteValueLength(inputValue);
const snap = () => 1 / beatValue(gridStep());
const gridBeat = index => multiplyBeats(gridStep(), index);
const right = () => LEFT + 8 * ppb;
const xAt = beat => LEFT + (beatValue(beat) - page * 8) * ppb;
const labelPitch = midi => `${pitchName(midi)} / ${['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'][midi % 12]}${Math.floor(midi / 12) - 1}`;
function status(message, error = false) { $('editor-status').textContent = message; $('editor-status').dataset.error = String(error); }
try { const saved = localStorage.getItem('death-vocal-editor-draft'); if (saved) chart = validateChart(JSON.parse(saved)); }
catch { status('前の下書きを開けなかったため、標準譜面を表示しています。', true); }
for (let midi = 84; midi >= 48; midi--) { const option = document.createElement('option'); option.value = midi; option.textContent = labelPitch(midi); $('note-midi').append(option); }
for (const prefix of ['input', 'note']) {
  for (const denominator of [1,2,4,8,16,32,64,128,256,512,1024,2048,4096]) {
    const option = document.createElement('option'); option.value = denominator; option.textContent = denominator === 1 ? '全音符' : `${denominator}分音符`; $(`${prefix}-value`).append(option);
  }
}
const customOption = document.createElement('option'); customOption.value = 'custom'; customOption.textContent = '任意の長さ（旧譜面など）'; $('note-value').append(customOption);
function setValueControls(prefix, value) {
  if (value && ![...$(`${prefix}-value`).options].some(option => Number(option.value) === value.denominator)) {
    const option = document.createElement('option'); option.value = value.denominator; option.textContent = `${value.denominator}分音符`; $(`${prefix}-value`).append(option);
  }
  $(`${prefix}-value`).value = value ? value.denominator : 'custom';
  $(`${prefix}-dots`).value = value?.dots || 0;
  $(`${prefix}-tuplet`).checked = Boolean(value && (value.tupletCount !== 1 || value.tupletIn !== 1));
  $(`${prefix}-tuplet-count`).value = value && (value.tupletCount !== 1 || value.tupletIn !== 1) ? value.tupletCount : 3;
  $(`${prefix}-tuplet-in`).value = value && (value.tupletCount !== 1 || value.tupletIn !== 1) ? value.tupletIn : 2;
  $(`${prefix}-tuplet-fields`).hidden = !$(`${prefix}-tuplet`).checked;
}
function readValueControls(prefix) {
  if ($(`${prefix}-value`).value === 'custom') return null;
  return validateNoteValue({ denominator: Number($(`${prefix}-value`).value), dots: Number($(`${prefix}-dots`).value),
    tupletCount: $(`${prefix}-tuplet`).checked ? Number($(`${prefix}-tuplet-count`).value) : 1,
    tupletIn: $(`${prefix}-tuplet`).checked ? Number($(`${prefix}-tuplet-in`).value) : 1 });
}
function describeControls(prefix) {
  $(`${prefix}-tuplet-fields`).hidden = !$(`${prefix}-tuplet`).checked;
  const value = readValueControls(prefix);
  $(`${prefix}-value-description`).textContent = value ? `${noteValueLabel(value)} = ${noteValueLength(value)}拍` : '任意の長さを保持しています';
  return value;
}
function updateInputValue({ preview = false } = {}) {
  try {
    const value = describeControls('input'), duration = beatValue(noteValueLength(value));
    if (duration < 1/1024 || duration > 256) throw new Error('入力音価は1/1024〜256拍の範囲で指定してください。');
    inputValue = value;
    document.querySelectorAll('[data-value]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.value) === value.denominator)));
    draw();
  } catch (error) { if (!preview) { status(error.message, true); setValueControls('input', inputValue); describeControls('input'); } }
}
for (const id of ['value','dots','tuplet','tuplet-count','tuplet-in']) {
  $(`input-${id}`).addEventListener('change', updateInputValue);
  $(`note-${id}`).addEventListener('change', () => { try { describeControls('note'); } catch (error) { status(error.message, true); } });
}
for (const id of ['tuplet-count','tuplet-in']) {
  $(`input-${id}`).addEventListener('input', () => updateInputValue({ preview: true }));
  $(`note-${id}`).addEventListener('input', () => { try { describeControls('note'); } catch {} });
}
document.querySelectorAll('[data-value]').forEach(button => button.addEventListener('click', () => { $('input-value').value = button.dataset.value; updateInputValue(); }));
$('note-length').addEventListener('input', () => { $('note-value').value = 'custom'; describeControls('note'); });
setValueControls('input', inputValue);
function persist() {
  try { localStorage.setItem('death-vocal-editor-draft', JSON.stringify(chart)); }
  catch { status('下書きを保存できません。JSONを書き出して保存してください。', true); }
}
function identity(kind, note) { return { kind, beat: canonicalBeat(note.beat), ...(kind === 'voice' ? { midi: note.midi } : { lane: note.lane }) }; }
function findSelection(data, id) { return id ? data[id.kind].find(n => canonicalBeat(n.beat) === id.beat && (id.kind === 'voice' ? n.midi === id.midi : n.lane === id.lane)) : null; }
function snapshot() { return { chart, id: selected && identity(selected.kind, selected.note) }; }
function restore(entry) { chart = entry.chart; const note = findSelection(chart, entry.id); selected = note ? { kind: entry.id.kind, note } : null; persist(); sync(); }
function commit(next, message = '下書きを保存しました。', focus = selected) {
  try {
    const valid = validateChart(next), id = focus && identity(focus.kind, focus.note);
    history.push(snapshot()); if (history.length > 80) history.shift(); future = []; chart = valid;
    const note = findSelection(chart, id); selected = note ? { kind: id.kind, note } : null;
    status(message); persist(); sync(); return true;
  } catch (error) { status(error.message, true); sync(); return false; }
}
function syncInspector() {
  $('note-form').hidden = !selected; $('inspector-empty').hidden = Boolean(selected);
  $('selected-kind').textContent = selected ? selected.kind === 'voice' ? '音程ノーツ' : '4Kノーツ' : 'ノーツを選択';
  $('selected-pitch').textContent = selected ? selected.kind === 'voice' ? labelPitch(selected.note.midi) : ['D','F','J','K'][selected.note.lane] : '—';
  if (!selected) return;
  const voice = selected.kind === 'voice', n = selected.note;
  $('note-beat').value = n.beat; $('note-length').value = voice ? n.length : '';
  const value = n.value || (voice ? inferNoteValue(n.length) : inputValue);
  setValueControls('note', value); describeControls('note');
  $('note-custom-length').hidden = !voice; $('note-custom-length').open = voice && !value;
  $('note-length-field').hidden = !voice; $('note-midi-field').hidden = !voice; $('note-lane-field').hidden = voice;
  $('note-midi').value = voice ? n.midi : 60; $('note-lane').value = voice ? 0 : n.lane;
}
function sync() {
  $('chart-title').value = chart.title; $('chart-bpm').value = chart.bpm; $('chart-beats').value = chart.beats; $('chart-count').value = chart.countIn;
  page = Math.max(0, Math.min(Math.ceil(chart.beats / 8) - 1, page));
  $('page-label').textContent = `${page * 8}〜${Math.min(chart.beats, page * 8 + 8)}拍 / ${chart.beats}`;
  $('previous').disabled = page === 0; $('next').disabled = (page + 1) * 8 >= chart.beats;
  $('undo').disabled = !history.length; $('redo').disabled = !future.length;
  $('editor-counts').textContent = `音程 ${chart.voice.length} / 4K ${chart.notes.length}`;
  syncInspector(); draw();
}
function resize() {
  ppb = Number($('zoom').value); W = LEFT + 8 * ppb + 16;
  canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); $('zoom-value').value = `${ppb} px/拍`; draw();
}
function draw() {
  const data = preview || chart;
  ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#0e192b'; ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'right'; ctx.font = '10px sans-serif';
  for (let row = 0; row < 13; row++) {
    const midi = base() + 12 - row, y = VOICE_Y + row * ROW;
    ctx.fillStyle = [1,3,6,8,10].includes(midi % 12) ? '#101b2b' : '#162438'; ctx.fillRect(0, y, right(), ROW);
    ctx.fillStyle = '#9ab4cc'; ctx.fillText(`${pitchName(midi)} ${Math.floor(midi / 12) - 1}`, LEFT - 9, y + 13);
    ctx.strokeStyle = '#8db0d519'; ctx.beginPath(); ctx.moveTo(LEFT, y); ctx.lineTo(right(), y); ctx.stroke();
  }
  for (let lane = 0; lane < 4; lane++) {
    const y = KEY_Y + lane * KEY_ROW; ctx.fillStyle = lane % 2 ? '#182139' : '#132439'; ctx.fillRect(0, y, right(), KEY_ROW - 1);
    ctx.textAlign = 'right'; ctx.fillStyle = lane === 0 || lane === 3 ? '#8be8ff' : '#e6b0ff'; ctx.font = '13px monospace'; ctx.fillText(['D','F','J','K'][lane], LEFT - 17, y + 22);
  }
  ctx.textAlign = 'left'; ctx.font = '10px monospace'; ctx.fillStyle = '#a8c8df'; ctx.fillText('VOICE', 10, 23); ctx.fillText('4KEYS', 10, 311);
  const divisions = snap(), step = beatValue(gridStep());
  if (ppb * step >= 6) for (let i = Math.ceil(page * 8 / step - 1e-9); i * step <= Math.min(chart.beats, (page + 1) * 8) + 1e-9; i++) {
    const x = LEFT + (i * step - page * 8) * ppb;
    ctx.lineWidth = 1; ctx.strokeStyle = '#98c8ef20'; ctx.beginPath(); ctx.moveTo(x, VOICE_Y); ctx.lineTo(x, VOICE_Y + 13 * ROW); ctx.moveTo(x, KEY_Y); ctx.lineTo(x, KEY_Y + 4 * KEY_ROW); ctx.stroke();
  }
  for (let i = 0; i <= 8; i++) {
    const x = LEFT + i * ppb, at = page * 8 + i;
    ctx.lineWidth = at % 4 === 0 ? 1.5 : 1; ctx.strokeStyle = at % 4 === 0 ? '#b5d9f088' : '#98c8ef50';
    ctx.beginPath(); ctx.moveTo(x, VOICE_Y); ctx.lineTo(x, VOICE_Y + 13 * ROW); ctx.moveTo(x, KEY_Y); ctx.lineTo(x, KEY_Y + 4 * KEY_ROW); ctx.stroke();
    if (i < 8) { ctx.fillStyle = '#a2bcd2'; ctx.font = '11px monospace'; ctx.fillText(`${Math.floor(at / 4) + 1}:${at % 4 + 1}`, x + 5, 24); }
  }
  if (chart.beats < (page + 1) * 8) { ctx.fillStyle = '#050b16ad'; ctx.fillRect(xAt(chart.beats), VOICE_Y, right() - xAt(chart.beats), KEY_Y + 4 * KEY_ROW - VOICE_Y); }
  ctx.save(); ctx.beginPath(); ctx.rect(LEFT, VOICE_Y, right() - LEFT, KEY_Y + KEY_ROW * 4 - VOICE_Y); ctx.clip();
  for (const [kind, list] of [['voice', data.voice], ['notes', data.notes]]) for (let index = 0; index < list.length; index++) {
    const n = list[index], at = beatValue(n.beat), duration = kind === 'voice' ? beatValue(n.length) : 0;
    const row = kind === 'voice' ? base() + 12 - n.midi : n.lane;
    if (at + duration < page * 8 || at >= (page + 1) * 8 || row < 0 || (kind === 'voice' && row > 12)) continue;
    const active = drag ? drag.kind === kind && drag.index === index : selected?.kind === kind && selected.note === n;
    const x = xAt(n.beat), y = kind === 'voice' ? VOICE_Y + row * ROW + 3 : KEY_Y + row * KEY_ROW + 7;
    const width = kind === 'voice' ? Math.max(3, duration * ppb - 2) : Math.max(4, Math.min(20, ppb / divisions * .8));
    const height = kind === 'voice' ? ROW - 6 : KEY_ROW - 14;
    ctx.fillStyle = kind === 'voice' ? '#e6d791' : n.lane === 0 || n.lane === 3 ? '#8be8ff' : '#e6b0ff';
    ctx.beginPath(); ctx.roundRect(kind === 'voice' ? x + 1 : x - width / 2, y, width, height, 2); ctx.fill();
    if (active) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(kind === 'voice' ? x : x - width / 2 - 1, y - 2, width + 2, height + 4);
      if (kind === 'voice') { ctx.fillStyle = '#fff'; ctx.fillRect(x + width - 3, y + 1, 3, height - 2); }
    }
  }
  if (!selected && !drag) {
    const sy = cursor.row < 13 ? VOICE_Y + cursor.row * ROW : KEY_Y + (cursor.row - 13) * KEY_ROW;
    ctx.strokeStyle = '#ffffff80'; ctx.lineWidth = 1; ctx.strokeRect(xAt(cursor.beat), sy + 1, Math.max(3, ppb / divisions), (cursor.row < 13 ? ROW : KEY_ROW) - 2);
  }
  ctx.restore();
  $('selection-description').textContent = selected ? `${selected.kind === 'voice' ? labelPitch(selected.note.midi) : ['D','F','J','K'][selected.note.lane]}、開始 ${selected.note.beat}拍。方向キーで移動、Deleteで削除。` : `開始 ${cursor.beat}拍。方向キーで移動、Enterで配置。`;
}
function point(event) { const r = canvas.getBoundingClientRect(); return { x: (event.clientX - r.left) * W / r.width, y: (event.clientY - r.top) * H / r.height }; }
function rowAt(y) { return y >= VOICE_Y && y < VOICE_Y + 13 * ROW ? Math.floor((y - VOICE_Y) / ROW) : y >= KEY_Y && y < KEY_Y + 4 * KEY_ROW ? 13 + Math.floor((y - KEY_Y) / KEY_ROW) : -1; }
function snapped(x) { const index = Math.max(0, Math.min(Math.ceil(chart.beats * snap()) - 1, Math.round(((x - LEFT) / ppb + page * 8) * snap()))); return gridBeat(index); }
function noteAt(x, row) {
  const kind = row < 13 ? 'voice' : 'notes', list = chart[kind];
  const index = list.findIndex(n => kind === 'voice' ? n.midi === base() + 12 - row && x >= xAt(n.beat) - 3 && x <= xAt(addBeats(n.beat, n.length)) + 3 : n.lane === row - 13 && Math.abs(x - xAt(n.beat)) <= Math.max(5, Math.min(13, ppb / snap() / 2)));
  return index < 0 ? null : { kind, index, note: list[index] };
}
function removeSelected() { if (!selected) return; const next = clone(chart); next[selected.kind].splice(chart[selected.kind].indexOf(selected.note), 1); commit(next, 'ノーツを削除しました。', null); }
function createNote(row, beat, length = gridStep()) {
  try {
    const next = clone(chart), kind = row < 13 ? 'voice' : 'notes';
    const note = kind === 'voice' ? { beat, length: canonicalBeat(length), midi: base() + 12 - row } : { beat, lane: row - 13 };
    const value = kind === 'notes' || canonicalBeat(length) === gridStep() ? inputValue : inferNoteValue(length);
    if (value) note.value = value;
    next[kind].push(note); return commit(next, 'ノーツを配置しました。', { kind, note });
  } catch (error) { status(error.message, true); return false; }
}
canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 || $('tool').value === 'pan') return;
  const p = point(event), row = rowAt(p.y); if (row < 0 || p.x < LEFT || p.x >= right()) return;
  canvas.focus({ preventScroll: true }); const found = noteAt(p.x, row); cursor = { row, beat: snapped(p.x) };
  if ($('tool').value === 'erase') { if (found) { selected = found; removeSelected(); } return; }
  selected = found; syncInspector(); draw();
  drag = { kind: found?.kind, index: found?.index, original: found ? clone(found.note) : null, row, start: p, beat: snapped(p.x), changed: false,
    resize: found?.kind === 'voice' && Math.abs(p.x - xAt(addBeats(found.note.beat, found.note.length))) <= 9 };
  canvas.setPointerCapture(event.pointerId); event.preventDefault();
});
canvas.addEventListener('pointermove', event => {
  const p = point(event);
  if (!drag) { const row = rowAt(p.y), found = row >= 0 ? noteAt(p.x, row) : null; canvas.style.cursor = found ? found.kind === 'voice' && Math.abs(p.x - xAt(addBeats(found.note.beat, found.note.length))) <= 9 ? 'ew-resize' : 'grab' : 'crosshair'; return; }
  if (!drag.changed && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) < 4) return;
  drag.changed = true; canvas.style.cursor = drag.resize ? 'ew-resize' : 'grabbing'; preview = clone(chart);
  if (!drag.original) {
    try {
      const end = snapped(p.x), kind = drag.row < 13 ? 'voice' : 'notes';
      const length = beatValue(end) > beatValue(drag.beat) ? subtractBeats(end, drag.beat) : gridStep();
      drag.kind = kind; drag.index = preview[kind].length;
      preview[kind].push(kind === 'voice' ? { beat: drag.beat, length, midi: base() + 12 - drag.row } : { beat: drag.beat, lane: drag.row - 13 });
    } catch { preview = null; }
    draw(); return;
  }
  try {
    const n = preview[drag.kind][drag.index];
    if (drag.resize) {
      const endIndex = Math.max(Math.floor(beatValue(n.beat) * snap()) + 1, Math.min(Math.floor(chart.beats * snap()), Math.round(((p.x - LEFT) / ppb + page * 8) * snap())));
      n.length = subtractBeats(gridBeat(endIndex), n.beat);
      delete n.value; const value = inferNoteValue(n.length); if (value) n.value = value;
    } else {
      const steps = Math.round((p.x - drag.start.x) / ppb * snap()), amount = gridBeat(Math.abs(steps));
      n.beat = steps < 0 ? subtractBeats(drag.original.beat, amount) : addBeats(drag.original.beat, amount);
      const row = rowAt(p.y);
      if (drag.kind === 'voice' && row >= 0 && row < 13) n.midi = base() + 12 - row;
      if (drag.kind === 'notes' && row >= 13) n.lane = row - 13;
    }
  } catch { preview = null; }
  draw();
});
function finishDrag(event, cancel = false) {
  if (!drag) return; const gesture = drag, next = preview; drag = null; preview = null; canvas.style.cursor = 'crosshair';
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  if (cancel) { draw(); return; }
  if (gesture.original) {
    if (gesture.changed && next) commit(next, gesture.resize ? '音の長さを変更しました。' : 'ノーツを移動しました。', { kind: gesture.kind, note: next[gesture.kind][gesture.index] });
    else draw();
  } else {
    let length = gridStep();
    if (gesture.row < 13 && gesture.changed) { const end = snapped(point(event).x); if (beatValue(end) > beatValue(gesture.beat)) length = subtractBeats(end, gesture.beat); }
    createNote(gesture.row, gesture.beat, length);
  }
}
canvas.addEventListener('pointerup', event => finishDrag(event)); canvas.addEventListener('pointercancel', event => finishDrag(event, true));
$('note-form').addEventListener('submit', event => {
  event.preventDefault(); if (!selected) return;
  try { const next = clone(chart), n = next[selected.kind][chart[selected.kind].indexOf(selected.note)]; n.beat = canonicalBeat($('note-beat').value);
    const value = readValueControls('note'); delete n.value; if (value) n.value = value;
    if (selected.kind === 'voice') { n.length = value ? noteValueLength(value) : canonicalBeat($('note-length').value); n.midi = Number($('note-midi').value); } else n.lane = Number($('note-lane').value);
    commit(next, '選択ノーツを変更しました。', { kind: selected.kind, note: n });
  } catch (error) { status(error.message, true); }
});
$('delete-note').addEventListener('click', removeSelected);
function undo() { if (history.length) { future.push(snapshot()); restore(history.pop()); status('取り消しました。'); } }
function redo() { if (future.length) { history.push(snapshot()); restore(future.pop()); status('やり直しました。'); } }
$('undo').addEventListener('click', undo); $('redo').addEventListener('click', redo);
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.target.matches('input,select,textarea')) { event.preventDefault(); event.shiftKey ? redo() : undo(); }
});
canvas.addEventListener('keydown', event => {
  if (event.key === 'Escape') { selected = null; syncInspector(); draw(); return; }
  if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeSelected(); return; }
  const moves = { ArrowLeft: [0,-1], ArrowRight: [0,1], ArrowUp: [-1,0], ArrowDown: [1,0] }, move = moves[event.key];
  if (move) {
    event.preventDefault();
    try {
      if (selected) {
        const next = clone(chart), n = next[selected.kind][chart[selected.kind].indexOf(selected.note)];
        if (move[1]) n.beat = move[1] < 0 ? subtractBeats(n.beat, gridStep()) : addBeats(n.beat, gridStep());
        if (move[0]) { if (selected.kind === 'voice') n.midi -= move[0]; else n.lane += move[0]; }
        commit(next, 'ノーツを1目盛移動しました。', { kind: selected.kind, note: n });
      } else { cursor.row = Math.max(0, Math.min(16, cursor.row + move[0])); cursor.beat = gridBeat(Math.max(Math.ceil(page * 8 * snap()), Math.min(Math.ceil(Math.min(chart.beats, (page + 1) * 8) * snap()) - 1, Math.round(beatValue(cursor.beat) * snap()) + move[1]))); draw(); }
    } catch (error) { status(error.message, true); }
  }
  if (event.key === 'Enter' && !selected) { event.preventDefault(); createNote(cursor.row, cursor.beat); }
});
for (const id of ['chart-title','chart-bpm','chart-beats','chart-count']) $(id).addEventListener('change', () => {
  const next = clone(chart); next.title = $('chart-title').value.trim() || '無題の譜面'; next.bpm = Number($('chart-bpm').value); next.beats = Number($('chart-beats').value); next.countIn = Number($('chart-count').value);
  commit(next, '譜面の情報を変更しました。');
});
$('zoom').addEventListener('input', resize); $('octave').addEventListener('change', draw);
$('tool').addEventListener('change', () => { canvas.style.touchAction = $('tool').value === 'pan' ? 'pan-x pan-y' : 'none'; });
$('previous').addEventListener('click', () => { page--; cursor.beat = page * 8; sync(); }); $('next').addEventListener('click', () => { page++; cursor.beat = page * 8; sync(); });
$('default').addEventListener('click', () => commit(defaultChart(), '標準譜面を開きました。取り消すと前の内容に戻ります。', null));
$('empty').addEventListener('click', () => commit({ ...clone(chart), title: '新しい譜面', voice: [], notes: [] }, '空の譜面を作りました。取り消すと前の内容に戻ります。', null));
$('import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try { if (file.size > 1024 * 1024) throw new Error('譜面ファイルは1 MBまでです。'); commit(validateChart(JSON.parse(await file.text())), 'JSONを読み込みました。', null); }
  catch (error) { status(error.message, true); } event.target.value = '';
});
$('export').addEventListener('click', () => {
  try {
    const data = validateChart(chart), blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }), url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = `${data.title.replace(/[\\/:*?"<>|]/g, '-').slice(0, 80)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); status('譜面のJSONを書き出しました。');
  } catch (error) { status(error.message, true); }
});
$('apply').addEventListener('click', () => {
  try { localStorage.setItem('death-vocal-chart', JSON.stringify(validateChart(chart))); location.href = './'; }
  catch { status('ゲームへの反映に失敗しました。JSONを書き出し、ゲームの設定から読み込んでください。', true); }
});
resize(); sync(); updateInputValue(); if (!$('editor-status').textContent) status('下書きは自動保存。保管・受け渡しにはJSONを書き出してください。'); document.body.dataset.ready = 'true';
