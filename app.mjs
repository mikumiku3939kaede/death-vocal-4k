import { KEYS, COLORS, makeSession, hit, miss, rhythmScore, pitchDifference, detectPitch, projectTrack, validateChart, voiceNoteAt, registerVoiceMatch, pitchName } from './engine.mjs';

const $ = id => document.getElementById(id);
const pads = [...document.querySelectorAll('[data-lane]')];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const pitchCanvas = $('pitch-canvas'), keyCanvas = $('rhythm-canvas');
const pitchCtx = pitchCanvas.getContext('2d'), keyCtx = keyCanvas.getContext('2d');
let pitchSize = {}, keySize = {};
let customChart = null;
try { const saved = localStorage.getItem('death-vocal-chart'); if (saved) customChart = validateChart(JSON.parse(saved)); } catch {}
if (customChart) selectChartTempo(customChart.bpm);
let session = makeSession(Number($('tempo').value), customChart), phase = 'idle', time = 0, token = 0;
let audio = null, master = null, microphone = null, analyser = null, samples = null, voiceActive = false;
let scheduled = [], startTime = 0, lastAnalysis = 0, lastHud = 0;
let voiceTrace = [], particles = [], flashes = [0, 0, 0, 0], pressed = [false, false, false, false];
let stats = freshStats(), muted = false, feedbackAt = -100;

let scrollSpeed = 1;
try {
  const savedSpeed = Number(localStorage.getItem('death-vocal-scroll-speed'));
  if (savedSpeed >= .5 && savedSpeed <= 3) scrollSpeed = Math.round(savedSpeed * 4) / 4;
} catch {}
$('scroll-speed').value = String(scrollSpeed);
$('scroll-speed-value').textContent = `${scrollSpeed.toFixed(2)}×`;
$('scroll-speed').addEventListener('input', () => {
  scrollSpeed = Number($('scroll-speed').value);
  $('scroll-speed-value').textContent = `${scrollSpeed.toFixed(2)}×`;
  try { localStorage.setItem('death-vocal-scroll-speed', String(scrollSpeed)); } catch {}
});

let inputDelay = 80;
try { const saved = localStorage.getItem('death-vocal-input-delay'); if (saved !== null && Number(saved) >= 0 && Number(saved) <= 300) inputDelay = Math.round(Number(saved) / 10) * 10; } catch {}
$('input-delay').value = String(inputDelay); $('input-delay-value').textContent = `${inputDelay} ms`;
$('input-delay').addEventListener('input', () => {
  inputDelay = Number($('input-delay').value); $('input-delay-value').textContent = `${inputDelay} ms`;
  try { localStorage.setItem('death-vocal-input-delay', String(inputDelay)); } catch {}
});

function selectChartTempo(bpm) {
  if (![...$('tempo').options].some(o => Number(o.value) === bpm)) $('tempo').add(new Option(`${bpm} BPM（譜面）`, String(bpm)));
  $('tempo').value = String(bpm);
}
function applyChart(data) {
  if (phase === 'playing' || phase === 'starting') throw new Error('演奏を終了してから読み込んでください。');
  customChart = data ? validateChart(data) : null;
  selectChartTempo(customChart?.bpm ?? 120);
  $('chart-name').textContent = customChart?.title ?? '標準譜面'; $('clear-chart').hidden = !customChart;
  let saved = true;
  try { if (customChart) localStorage.setItem('death-vocal-chart', JSON.stringify(customChart)); else localStorage.removeItem('death-vocal-chart'); } catch { saved = false; }
  resetPreview();
  return saved ? customChart ? '譜面を読み込みました。' : '標準譜面に戻しました。' : '今回は読み込みました。このブラウザーでは保存できないため、再読み込みすると元に戻ります。';
}
$('chart-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try { if (file.size > 1024 * 1024) throw new Error('譜面ファイルは1 MBまでです。'); $('chart-status').textContent = applyChart(JSON.parse(await file.text())); }
  catch (error) { $('chart-status').textContent = error.message; }
  event.target.value = '';
});
$('clear-chart').addEventListener('click', () => { $('chart-status').textContent = applyChart(null); });

function freshStats() { return { combo: 0, maxCombo: 0, voiceTotal: 0, voiceGood: 0, pitch: null, voiceHit: null }; }
function setPhase(next) { phase = next; document.body.dataset.phase = next; }
function setText(id, value) { const el = $(id); if (el.textContent !== String(value)) el.textContent = value; }
function roundRect(ctx, x, y, w, h, radius, fill) { ctx.beginPath(); ctx.roundRect(x, y, w, h, radius); ctx.fillStyle = fill; ctx.fill(); }
function voicePercent() { return voiceActive && stats.voiceTotal > 0 ? Math.round(stats.voiceGood / stats.voiceTotal * 100) : null; }

function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  for (const [canvas, ctx, key] of [[pitchCanvas, pitchCtx, 'pitch'], [keyCanvas, keyCtx, 'keys']]) {
    const { width: w, height: h } = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(w * dpr)); canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (key === 'pitch') pitchSize = { w, h }; else keySize = { w, h };
  }
  const first = projectTrack(0, 0, keySize.w, keySize.h);
  const last = projectTrack(4, 0, keySize.w, keySize.h);
  const pads = document.querySelector('.key-pads');
  Object.assign(pads.style, { left: `${first.x}px`, width: `${last.x - first.x}px`, top: `${first.y + 8}px`, height: `${Math.max(20, Math.min(48, keySize.h - first.y - 12))}px` });

}
new ResizeObserver(resize).observe(document.querySelector('.game'));
window.addEventListener('resize', resize);

function tone(frequency, at, length = .22, volume = .09, type = 'triangle') {
  const oscillator = audio.createOscillator(), envelope = audio.createGain();
  oscillator.type = type; oscillator.frequency.value = frequency;
  envelope.gain.setValueAtTime(0, at);
  envelope.gain.linearRampToValueAtTime(volume, at + .012);
  envelope.gain.exponentialRampToValueAtTime(.001, at + length);
  oscillator.connect(envelope); envelope.connect(master);
  oscillator.start(at); oscillator.stop(at + length + .015); scheduled.push(oscillator);
}

function disposeAudio() {
  microphone?.getTracks().forEach(track => track.stop()); microphone = null;
  scheduled.forEach(node => { try { node.stop(); } catch {} }); scheduled = [];
  analyser = null; samples = null;
  const context = audio; audio = null; master = null;
  if (context && context.state !== 'closed') void context.close().catch(() => {});
}

let noticeTimer;
function setNotice(message = '') {
  clearTimeout(noticeTimer); setText('notice', message);
  if (message) noticeTimer = setTimeout(() => setText('notice', ''), 4500);
}

function updateHud() {
  setText('score', String(rhythmScore(session.notes)).padStart(7, '0'));
  setText('combo', stats.combo);
  const r = time < session.lead ? 0 : Math.min(session.rounds - 1, Math.floor((time - session.lead) / (8 * session.beat)));
  setText('round-label', `${r + 1} / ${session.rounds}`);
  setText('voice-matched', `音程一致 ${session.voice.filter(n => n.matched).length} / ${session.voice.length}音`);
  const target = voiceNoteAt(session, time - inputDelay / 1000);
  setText('pitch-feedback', !voiceActive ? phase === 'playing' ? 'マイクOFF' : '' : stats.pitch === null ? '声を待っています' : stats.voiceHit ? '音程一致' : target && pitchDifference(stats.pitch, target.midi) > 0 ? '少し低く' : '少し高く');
  $('pitch-feedback').dataset.match = String(stats.voiceHit === true);
  setText('voice-score', voicePercent() === null ? '—' : `${voicePercent()}%`);
  setText('mic-status', phase === 'playing' ? voiceActive ? '● MIC LIVE' : 'MIC OFF' : 'MIC STANDBY');
  if (phase === 'playing') {
    const before = time < session.lead - .17;
    $('countdown').hidden = !before;
    if (before) setText('countdown', Math.max(1, Math.ceil((session.lead - Math.max(0, time)) / session.beat)));
    if (time - feedbackAt > .55) $('judgement').style.opacity = '0';
  }
}

function showGrade(grade) {
  feedbackAt = time;
  const el = $('judgement'); el.dataset.grade = grade;
  el.querySelector('strong').textContent = grade;
  el.style.opacity = '1'; el.classList.remove('pop');
  if (!reducedMotion) { void el.offsetWidth; el.classList.add('pop'); }
}

function strike(lane) {
  if (phase !== 'playing' || !audio) return;
  time = audio.currentTime - startTime;
  if (miss(session.notes, time)) stats.combo = 0;
  const note = hit(session.notes, lane, time);
  flashes[lane] = .16;
  if (!note) return;
  stats.combo++; stats.maxCombo = Math.max(stats.maxCombo, stats.combo); showGrade(note.grade);
  const at = audio.currentTime;
  tone(850 + lane * 110, at, .055, .018, 'sine');
  const { w, h } = keySize;
  const point = projectTrack(lane + .5, 0, w, h);
  for (let i = 0; i < (reducedMotion ? 0 : 12); i++) particles.push({ x: point.x, y: point.y, vx: (Math.random() - .5) * 130, vy: -50 - Math.random() * 120, life: .35, color: COLORS[lane] });
  updateHud();
}

function setPressed(lane, down) {
  if (down && pressed[lane]) return;
  pressed[lane] = down; pads[lane].classList.toggle('pressed', down);
  if (down) strike(lane);
}
function clearPressed() { pressed.fill(false); pads.forEach(pad => pad.classList.remove('pressed')); }

function showGame() {
  $('title-screen').hidden = true; $('game').hidden = false;
  document.body.dataset.screen = 'game'; resize(); $('game').focus({ preventScroll: true });
}

function returnToTitle() {
  ++token; disposeAudio(); clearPressed();
  setPhase('idle');
  if ($('results').open) $('results').close();
  if ($('settings').open) $('settings').close();
  $('settings-button').disabled = false; $('start').disabled = false; $('tempo').disabled = false; $('mic').disabled = false;
  $('stop').hidden = true; $('countdown').hidden = true; $('judgement').style.opacity = '0';
  flashes.fill(0); particles = []; setText('start-label', 'スタート'); setNotice(); resetPreview();
  $('game').hidden = true; $('title-screen').hidden = false; document.body.dataset.screen = 'title';
  $('title-start').focus({ preventScroll: true });
}

async function begin() {
  if (phase === 'starting') return;
  if ($('game').hidden) showGame();
  const request = ++token;
  disposeAudio(); clearPressed();
  if ($('results').open) $('results').close();
  if ($('settings').open) $('settings').close();
  session = makeSession(Number($('tempo').value), customChart); stats = freshStats(); voiceTrace = []; particles = []; time = 0; voiceActive = false;
  setPhase('starting'); $('settings-button').disabled = true; $('start').disabled = true; $('tempo').disabled = true; $('mic').disabled = true;
  $('stop').hidden = false; setText('start-label', '準備中…'); setNotice();
  try {
    const context = new AudioContext(); audio = context;
    master = context.createGain(); master.gain.value = muted ? 0 : .8; master.connect(context.destination);
    await context.resume();
    if (request !== token) return;
    if ($('mic').checked) {
      setText('start-label', 'マイクの許可待ち…');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false } });
        if (request !== token) { stream.getTracks().forEach(track => track.stop()); return; }
        microphone = stream; analyser = context.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0;
        context.createMediaStreamSource(stream).connect(analyser); samples = new Float32Array(analyser.fftSize); voiceActive = true;
        stream.getTracks().forEach(track => track.addEventListener('ended', () => {
          if (request === token && phase === 'playing') { voiceActive = false; analyser = null; setNotice('マイクが切断されました。4K練習は続けられます。'); }
        }, { once: true }));
      } catch {
        if (request !== token) return;
        setNotice('マイクを使えないため、4K練習でスタートします。');
      }
    }
    if (request !== token) return;
    startTime = context.currentTime + .16;
    const countIn = Math.round(session.lead / session.beat);
    for (let i = 0; i < countIn; i++) tone(i === countIn - 1 ? 1200 : 850, startTime + i * session.beat, .055, .045, 'sine');
    session.voice.forEach(note => tone(440 * 2 ** ((note.midi - 69) / 12), startTime + note.time, (note.end - note.time) * .82, .1));
    if (voiceActive || !$('mic').checked) setNotice();
    lastAnalysis = -10; lastHud = -10; feedbackAt = -100;
    setPhase('playing'); $('start').disabled = false; setText('start-label', 'リトライ');
    $('judgement').style.opacity = '0'; updateHud();
  } catch {
    if (request !== token) return;
    disposeAudio(); setPhase('idle'); $('settings-button').disabled = false; $('start').disabled = false; $('tempo').disabled = false; $('mic').disabled = false; $('stop').hidden = true;
    setText('start-label', 'スタート'); setNotice('音を開始できませんでした。もう一度スタートしてください。');
  }
}

function finish(complete) {
  if (phase !== 'playing' && phase !== 'starting') return;
  const wasPlaying = phase === 'playing';
  const vocalResult = voicePercent();
  ++token;
  if (complete) miss(session.notes, session.end + 1);
  const score = rhythmScore(session.notes);
  disposeAudio(); clearPressed();
  setPhase(wasPlaying ? 'results' : 'idle');
  $('settings-button').disabled = false; $('countdown').hidden = true; $('stop').hidden = true; $('start').disabled = false; $('tempo').disabled = false; $('mic').disabled = false;
  setText('start-label', 'スタート');
  if (!wasPlaying) { setNotice(); return; }
  setText('result-kicker', complete ? `SESSION CLEAR / ${session.rounds} SETS` : 'SESSION STOPPED');
  setText('result-title', complete ? customChart ? '演奏クリア' : '3周クリア' : '中断');
  setText('result-rank', complete ? score >= 950000 ? 'S' : score >= 800000 ? 'A' : score >= 600000 ? 'B' : 'C' : '—');
  setText('result-score', score.toLocaleString('ja-JP')); setText('result-combo', stats.maxCombo);
  setText('result-voice', vocalResult === null ? '—' : `${vocalResult}%`);
  setText('result-perfect', session.notes.filter(note => note.grade === 'PERFECT').length);
  setText('result-note', vocalResult === null ? '今回は4Kスコアのみ。マイクをONにすると声のヒット率も記録できます。' : '4Kスコアと声のヒット率を、それぞれ表示しています。');
  setNotice();
  $('results').showModal();
}

function resetPreview() {
  if (phase === 'playing' || phase === 'starting') return;
  session = makeSession(Number($('tempo').value), customChart); stats = freshStats(); time = 0; voiceActive = false; voiceTrace = [];
  setPhase('idle'); updateHud();
}

function drawPitch() {
  const ctx = pitchCtx, { w, h } = pitchSize; if (!w || !h) return;
  ctx.clearRect(0, 0, w, h);
  const left = w < 600 ? 28 : 36, right = w - 20, top = 27, bottom = h - 25;
  const low = Math.min(60, ...session.voice.map(n => n.midi)) - 1;
  const high = Math.max(72, ...session.voice.map(n => n.midi)) + 1;
  const viewTime = phase === 'idle' || phase === 'starting' ? session.lead : Math.max(session.lead, time);
  const cursor = left + (right - left) * .42;
  const beatWidth = (right - left) / (w < 500 ? 6 : 9);
  const x = t => cursor + (t - viewTime) / session.beat * beatWidth;
  const y = midi => bottom - (Math.max(low, Math.min(high, midi)) - low) / (high - low) * (bottom - top);
  const barHeight = h < 130 ? 9 : 13;
  ctx.textAlign = 'right'; ctx.font = '9px sans-serif';
  for (let midi = low; midi <= high; midi++) {
    if (high - low > 24 && midi % 2) continue;
    ctx.strokeStyle = midi % 12 === 0 ? '#b6d8f437' : '#b6d8f413'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, y(midi)); ctx.lineTo(right, y(midi)); ctx.stroke();
    if ([60, 72].includes(midi)) { ctx.fillStyle = '#8096ae'; ctx.fillText(pitchName(midi), left - 7, y(midi) + 3); }
  }
  ctx.save(); ctx.beginPath(); ctx.rect(left, 0, right - left, h); ctx.clip();
  ctx.fillStyle = '#c4edff08'; ctx.fillRect(cursor - 7, 0, 14, h);
  for (const note of session.voice) {
    const nx = x(note.time), end = x(note.end);
    if (end < left || nx > right) continue;
    const active = phase === 'playing' && time >= note.time && time < note.end;
    const passed = note.end < viewTime;
    const width = Math.max(4, end - nx - 4);
    ctx.beginPath(); ctx.roundRect(nx, y(note.midi) - barHeight / 2, width, barHeight, barHeight / 2);
    if (note.matched) { ctx.fillStyle = '#f2d66d'; ctx.fill(); }
    ctx.strokeStyle = note.matched ? '#fff2b0' : active ? '#e6f5ff' : passed ? '#536378' : '#96acc3';
    ctx.lineWidth = active ? 2 : 1.3; ctx.stroke();
    ctx.font = `${w < 600 ? 10 : 12}px sans-serif`; ctx.textAlign = 'center';
    ctx.fillStyle = note.matched ? '#f3dc8d' : active ? '#edf6ff' : '#8fa6bd';
    ctx.fillText(note.name, nx + width / 2, y(note.midi) + barHeight / 2 + 15);
  }
  let prev = null;
  for (const point of voiceTrace) {
    if (point.midi === null || x(point.time) < left) { prev = null; continue; }
    if (prev && point.time - prev.time < .18) {
      ctx.strokeStyle = point.good ? '#ffffff' : '#ff8ca6'; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x(prev.time), y(prev.midi)); ctx.lineTo(x(point.time), y(point.midi)); ctx.stroke();
    }
    prev = point;
  }
  ctx.fillStyle = '#c9ebffcc'; ctx.fillRect(cursor - 1, 7, 2, h - 14);
  ctx.beginPath(); ctx.moveTo(cursor - 4, 7); ctx.lineTo(cursor + 4, 7); ctx.lineTo(cursor, 12); ctx.fill();
  const latest = voiceTrace.at(-1);
  if (phase === 'playing' && latest?.midi != null) {
    ctx.fillStyle = latest.good ? '#fff' : '#ff8ca6'; ctx.beginPath(); ctx.arc(x(latest.time), y(latest.midi), 5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function drawKeys(dt) {
  const ctx = keyCtx, { w, h } = keySize; if (!w || !h) return;
  ctx.clearRect(0, 0, w, h);
  const point = (lane, ahead) => projectTrack(lane, ahead, w, h);
  const travel = 2.8, displayTime = phase === 'idle' || phase === 'starting' ? session.lead - .9 : time;
  const polygon = (points, fill, stroke) => {
    ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
  };
  const glow = ctx.createRadialGradient(w / 2, h * .08, 0, w / 2, h * .16, Math.max(w * .55, h));
  glow.addColorStop(0, '#5174b52b'); glow.addColorStop(.36, '#20375417'); glow.addColorStop(1, '#080d1900');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h);
  // Sparse side beams give the track depth without cluttering the note field.
  for (const direction of [-1, 1]) {
    polygon([{x:w*.5+direction*w*.1,y:h*.04},{x:w*.5+direction*w*.31,y:h},{x:w*.5+direction*w*.47,y:h}], '#6ac5ff04');
    ctx.strokeStyle = '#93c7ff10'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(w*.5+direction*w*.14,h*.03); ctx.lineTo(w*.5+direction*w*.49,h); ctx.stroke();
  }
  const floor = ctx.createLinearGradient(0, 0, 0, h); floor.addColorStop(0, '#0b152366'); floor.addColorStop(.6, '#172844b3'); floor.addColorStop(1, '#111d36');
  polygon([point(0,travel),point(4,travel),point(4,-.09),point(0,-.09)], floor);
  for (let lane = 0; lane < 4; lane++) {
    polygon([point(lane,travel),point(lane+1,travel),point(lane+1,-.09),point(lane,-.09)], lane % 2 ? '#8a80cc06' : '#70d9ff08');
    flashes[lane] = Math.max(0, flashes[lane] - dt);
    if (flashes[lane] > 0) {
      ctx.globalAlpha = flashes[lane] / .16 * .23;
      polygon([point(lane,travel*.45),point(lane+1,travel*.45),point(lane+1,-.09),point(lane,-.09)], COLORS[lane]); ctx.globalAlpha = 1;
    }
  }
  for (let i = 0; i <= 4; i++) {
    const a = point(i,travel), b = point(i,-.09);
    ctx.lineWidth = i === 0 || i === 4 ? 2 : 1;
    ctx.strokeStyle = i === 0 || i === 4 ? '#b3cfff70' : '#a6bde840';
    ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
  }
  for (let i = 0; i < session.beats + 6; i++) {
    const ahead = (session.lead + i * session.beat - displayTime) * scrollSpeed;
    if (ahead < -.06 || ahead > travel) continue;
    const a = point(0,ahead), b = point(4,ahead);
    ctx.strokeStyle = i % 4 === 0 ? '#aed4ff30' : '#aed4ff14'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
  }
  // Draw far notes first; their projected surfaces become wider near the player.
  for (let index = session.notes.length - 1; index >= 0; index--) {
    const note = session.notes[index], ahead = (note.time - displayTime) * scrollSpeed;
    if (note.grade || ahead < -.16 || ahead > travel) continue;
    const a = point(note.lane+.07,ahead+.035), b = point(note.lane+.93,ahead+.035);
    const c = point(note.lane+.93,ahead-.035), d = point(note.lane+.07,ahead-.035);
    const depth = 3 * c.scale;
    polygon([d,c,{x:c.x,y:c.y+depth},{x:d.x,y:d.y+depth}], '#3b72a7');
    ctx.shadowColor = COLORS[note.lane]; ctx.shadowBlur = reducedMotion ? 0 : 12 * c.scale;
    polygon([a,b,c,d], COLORS[note.lane], '#e4faff'); ctx.shadowBlur = 0;
    const midA = {x:a.x*.4+d.x*.6,y:a.y*.4+d.y*.6}, midB = {x:b.x*.4+c.x*.6,y:b.y*.4+c.y*.6};
    ctx.strokeStyle = '#f8fcff'; ctx.lineWidth = Math.max(1, 3*c.scale); ctx.beginPath(); ctx.moveTo(midA.x,midA.y); ctx.lineTo(midB.x,midB.y); ctx.stroke();
  }
  const a = point(0,0), b = point(4,0);
  ctx.shadowColor = '#d7bbff'; ctx.shadowBlur = reducedMotion ? 0 : 15;
  polygon([point(0,.013),point(4,.013),point(4,-.025),point(0,-.025)], '#d5a5ff22', '#dfbbff');
  ctx.strokeStyle = '#f6eaff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke(); ctx.shadowBlur = 0;
  particles = particles.filter(p => p.life > 0);
  for (const p of particles) { p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 280 * dt; ctx.globalAlpha = Math.max(0,p.life/.35); ctx.fillStyle = p.color; ctx.fillRect(p.x,p.y,3,3); } ctx.globalAlpha = 1;
}

let previousFrame = performance.now();
function frame(now) {
  if ($('game').hidden) { previousFrame = now; requestAnimationFrame(frame); return; }
  const dt = Math.min(.05, (now - previousFrame) / 1000); previousFrame = now;
  if (phase === 'playing' && audio) {
    time = audio.currentTime - startTime;
    if (miss(session.notes, time)) { stats.combo = 0; showGrade('MISS'); }
    if (time - lastAnalysis >= .045) {
      const elapsed = Math.max(0, Math.min(.08, time - lastAnalysis)); lastAnalysis = time;
      if (voiceActive && analyser) {
        const sampleTime = time - inputDelay / 1000, target = voiceNoteAt(session, sampleTime);
        if (target) {
          analyser.getFloatTimeDomainData(samples); const midi = detectPitch(samples, audio.sampleRate);
          const duration = Math.min(elapsed, Math.max(0, sampleTime - target.time));
          stats.pitch = midi; stats.voiceHit = registerVoiceMatch(target, midi, duration);
          stats.voiceTotal += duration; if (stats.voiceHit) stats.voiceGood += duration;
          voiceTrace.push({ time: sampleTime, midi: midi === null ? null : target.midi + pitchDifference(midi, target.midi), good: stats.voiceHit });
        } else { stats.pitch = null; stats.voiceHit = null; voiceTrace.push({ time: sampleTime, midi: null, good: false }); }
        voiceTrace = voiceTrace.filter(p => p.time > sampleTime - 8);
      }
    }
    if (time - lastHud > .045) { lastHud = time; updateHud(); }
    if (time >= session.end) finish(true);
  }
  drawPitch(); drawKeys(dt); requestAnimationFrame(frame);
}

pads.forEach((pad, lane) => {
  pad.addEventListener('pointerdown', event => { if (event.button !== 0) return; event.preventDefault(); pad.setPointerCapture(event.pointerId); setPressed(lane, true); });
  pad.addEventListener('click', event => { if (event.detail === 0) strike(lane); });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) pad.addEventListener(name, () => setPressed(lane, false));
});
document.addEventListener('keydown', event => {
  if (event.repeat || $('results').open || $('settings').open || event.target.matches('input, select, textarea')) return;
  const lane = KEYS.indexOf(event.code);
  if (lane >= 0 && phase === 'playing') { event.preventDefault(); setPressed(lane, true); }
  if ((event.code === 'Space' || event.code === 'Enter' && $('game').hidden) && phase === 'idle' && !event.target.closest('button')) { event.preventDefault(); void begin(); }
  if (event.code === 'Escape' && (phase === 'playing' || phase === 'starting')) { event.preventDefault(); finish(false); }
});
document.addEventListener('keyup', event => { const lane = KEYS.indexOf(event.code); if (lane >= 0) setPressed(lane, false); });
window.addEventListener('blur', clearPressed);
document.addEventListener('visibilitychange', () => { if (document.hidden && (phase === 'playing' || phase === 'starting')) finish(false); });
window.addEventListener('pagehide', () => { ++token; disposeAudio(); });
$('title-start').addEventListener('click', () => void begin());
$('home').addEventListener('click', returnToTitle); $('results-home').addEventListener('click', returnToTitle);
$('title-settings').addEventListener('click', () => $('settings').showModal());
$('start').addEventListener('click', () => void begin()); $('retry').addEventListener('click', () => void begin());
$('stop').addEventListener('click', () => finish(false)); $('tempo').addEventListener('change', resetPreview);
$('close-results').addEventListener('click', () => $('results').close());
$('results').addEventListener('close', () => { if (phase === 'results') resetPreview(); });
$('settings-button').addEventListener('click', () => $('settings').showModal());
$('close-settings').addEventListener('click', () => $('settings').close());
$('sound').addEventListener('click', () => { muted = !muted; $('sound').setAttribute('aria-pressed', String(!muted)); $('sound').setAttribute('aria-label', muted ? 'ガイド音をオンにする' : 'ガイド音をミュート'); $('sound').querySelector('span').textContent = `ガイド音 ${muted ? 'OFF' : 'ON'}`; if (master && audio) master.gain.setTargetAtTime(muted ? 0 : .8, audio.currentTime, .02); });
$('chart-name').textContent = customChart?.title ?? '標準譜面'; $('clear-chart').hidden = !customChart;
resize(); resetPreview(); requestAnimationFrame(frame); document.body.dataset.ready = 'true';
