export const SCALE = [
  { name: 'ド', midi: 60 }, { name: 'レ', midi: 62 }, { name: 'ミ', midi: 64 },
  { name: 'ファ', midi: 65 }, { name: 'ソ', midi: 67 }, { name: 'ラ', midi: 69 },
  { name: 'シ', midi: 71 }, { name: 'ド', midi: 72 },
];
export const KEYS = ['KeyD', 'KeyF', 'KeyJ', 'KeyK'];
export const COLORS = ['#8be8ff', '#e6b0ff', '#e6b0ff', '#8be8ff'];
export const WINDOWS = { PERFECT: .07, GREAT: .12, GOOD: .17 };
export const WEIGHTS = { PERFECT: 1, GREAT: .7, GOOD: .4, MISS: 0 };

export function makeSession(bpm = 120, chart = null) {
  if (chart) {
    const data = validateChart(chart);
    bpm = Number.isFinite(bpm) ? Math.max(40, Math.min(240, bpm)) : data.bpm;
    const beat = 60 / bpm, lead = data.countIn * beat;
    return { bpm, beat, lead, beats: data.beats, rounds: Math.ceil(data.beats / 8), title: data.title,
      voice: data.voice.map((n, i) => ({ ...n, id: `v${i}`, name: pitchName(n.midi), time: lead + beatValue(n.beat) * beat, end: lead + (beatValue(n.beat) + beatValue(n.length)) * beat, matched: false, matchSeconds: 0 })),
      notes: data.notes.map((n, i) => ({ id: `n${i}`, lane: n.lane, time: lead + beatValue(n.beat) * beat, round: Math.floor(beatValue(n.beat) / 8), grade: null })),
      end: lead + data.beats * beat + .75 };
  }
  bpm = Number.isFinite(bpm) ? Math.max(80, Math.min(180, bpm)) : 120;
  const beat = 60 / bpm;
  const lead = beat * 4;
  const voice = Array.from({ length: 24 }, (_, i) => ({ ...SCALE[i % 8], index: i % 8, round: Math.floor(i / 8), time: lead + i * beat, end: lead + (i + 1) * beat, matched: false, matchSeconds: 0 }));
  const notes = [];
  const pattern = [0, 1, 2, 3, 2, 1, 0, 3];
  for (let i = 0; i < 24; i++) {
    const round = Math.floor(i / 8);
    const lane = (pattern[i % 8] + round) % 4;
    const time = lead + i * beat;
    notes.push({ id: `n${i}`, lane, time, round, grade: null });
    if (round === 1 && i % 2 === 1) notes.push({ id: `off${i}`, lane: (lane + 1) % 4, time: time + beat / 2, round, grade: null });
    if (round === 2) notes.push({ id: `extra${i}`, lane: (lane + 2) % 4, time: time + (i % 2 === 0 ? beat / 2 : 0), round, grade: null });
  }
  notes.sort((a, b) => a.time - b.time || a.lane - b.lane);
  return { bpm, beat, lead, voice, notes, beats: 24, rounds: 3, title: 'ドレミファソラシド', end: lead + 24 * beat + .75 };
}

export function gradeAt(delta) {
  const distance = Math.abs(delta);
  return distance <= WINDOWS.PERFECT ? 'PERFECT' : distance <= WINDOWS.GREAT ? 'GREAT' : distance <= WINDOWS.GOOD ? 'GOOD' : null;
}

export function hit(notes, lane, time) {
  if (!Number.isInteger(lane) || lane < 0 || lane > 3) return null;
  const note = notes.filter(n => n.lane === lane && !n.grade && Math.abs(n.time - time) <= WINDOWS.GOOD)
    .sort((a, b) => Math.abs(a.time - time) - Math.abs(b.time - time))[0];
  if (!note) return null;
  note.grade = gradeAt(time - note.time);
  return note;
}

export function miss(notes, time) {
  const missed = notes.filter(n => !n.grade && time - n.time > WINDOWS.GOOD);
  missed.forEach(n => { n.grade = 'MISS'; });
  return missed.length;
}

export function rhythmScore(notes) {
  if (!notes.length) return 0;
  return Math.round(notes.reduce((sum, n) => sum + (WEIGHTS[n.grade] || 0), 0) / notes.length * 1000000);
}

export function pitchDifference(midi, target) {
  const delta = midi - target;
  return delta - Math.round(delta / 12) * 12;
}

// The same local YIN pitch detector used in the FOUR//FALL test version.
export function detectPitch(samples, sampleRate) {
  const stride = sampleRate > 26000 ? 2 : 1;
  const rate = sampleRate / stride;
  const length = Math.floor(samples.length / stride);
  let energy = 0;
  for (let i = 0; i < length; i++) energy += samples[i * stride] ** 2;
  if (Math.sqrt(energy / length) < .008) return null;
  const min = Math.max(2, Math.floor(rate / 1100));
  const max = Math.min(Math.floor(rate / 65), Math.floor(length / 2));
  const comparison = length - max;
  const diff = new Float32Array(max + 1);
  for (let tau = 1; tau <= max; tau++) {
    let sum = 0;
    for (let i = 0; i < comparison; i++) sum += (samples[i * stride] - samples[(i + tau) * stride]) ** 2;
    diff[tau] = sum;
  }
  let total = 0;
  diff[0] = 1;
  for (let tau = 1; tau <= max; tau++) { total += diff[tau]; diff[tau] = total ? diff[tau] * tau / total : 1; }
  let tau = -1;
  for (let i = min; i < max; i++) if (diff[i] < .14 && diff[i] <= diff[i + 1]) { tau = i; break; }
  if (tau < 0) return null;
  const denominator = 2 * (2 * diff[tau] - diff[tau + 1] - diff[tau - 1]);
  const refined = denominator ? tau + (diff[tau + 1] - diff[tau - 1]) / denominator : tau;
  const hz = rate / refined;
  if (!Number.isFinite(hz) || hz < 65 || hz > 1100) return null;
  return 69 + 12 * Math.log2(hz / 440);
}

// A pinhole projection: notes grow and accelerate as they approach the hit line.
export function projectTrack(lane, ahead, width, height, travel = 2.8) {
  const depth = Math.max(-.08, Math.min(1, ahead / travel));
  const scale = 1 / (1 + 3.6 * depth);
  const farScale = 1 / 4.6;
  const top = height * .045, judge = height * .875;
  const trackWidth = Math.min(width * .94, height * 1.9);
  return { x: width / 2 + (lane / 4 - .5) * trackWidth * scale,
    y: top + (judge - top) * (scale - farScale) / (1 - farScale), scale };
}

export function pitchName(midi) {
  return ['ド', 'ド♯', 'レ', 'レ♯', 'ミ', 'ファ', 'ファ♯', 'ソ', 'ソ♯', 'ラ', 'ラ♯', 'シ'][((midi % 12) + 12) % 12];
}

export function voiceNoteAt(session, time) {
  return session.voice.find(note => time >= note.time && time < note.end) || null;
}

export function registerVoiceMatch(note, midi, elapsed) {
  if (!note) return false;
  const good = midi !== null && Number.isFinite(midi) && Math.abs(pitchDifference(midi, note.midi)) <= .65;
  if (good) note.matchSeconds += Math.max(0, Math.min(.08, elapsed));
  if (note.matchSeconds >= Math.min(.1, (note.end - note.time) * .3)) note.matched = true;
  return good;
}

export function defaultChart() {
  const session = makeSession();
  return { format: 'death-vocal-chart', version: 1, title: 'ドレミファソラシド', bpm: 120, beats: 24, countIn: 4,
    voice: session.voice.map((n, i) => ({ beat: i, length: 1, midi: n.midi })),
    notes: session.notes.map(n => ({ beat: (n.time - session.lead) / session.beat, lane: n.lane })) };
}

export function validateChart(input) {
  const fail = message => { throw new Error(message); };
  if (!input || typeof input !== 'object' || input.format !== 'death-vocal-chart' || input.version !== 1) fail('対応形式は death-vocal-chart / version 1 です。');
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 100) fail('譜面名は1〜100文字で指定してください。');
  if (!Number.isFinite(input.bpm) || input.bpm < 40 || input.bpm > 240) fail('BPMは40〜240で指定してください。');
  if (!Number.isInteger(input.beats) || input.beats < 1 || input.beats > 256) fail('長さは1〜256拍で指定してください。');
  if (!Number.isInteger(input.countIn) || input.countIn < 0 || input.countIn > 8) fail('カウントは0〜8拍で指定してください。');
  if (!Array.isArray(input.voice) || input.voice.length > 1024 || !Array.isArray(input.notes) || input.notes.length > 4096) fail('音程は1024個、4Kノーツは4096個までです。');
  const voice = input.voice.map(n => {
    if (!n) fail('音程データが不正です。');
    const beat = canonicalBeat(n.beat), length = canonicalBeat(n.length), at = beatValue(beat), duration = beatValue(length);
    if (at < 0 || duration < 1 / 1024 || at + duration > input.beats + 1e-9 || !Number.isInteger(n.midi) || n.midi < 48 || n.midi > 84) fail('音程を曲の範囲内、C3〜C6で指定してください。長さは1/1024拍以上です。');
    const value = n.value === undefined ? null : validateNoteValue(n.value);
    if (value && canonicalBeat(noteValueLength(value)) !== length) fail('音価と音程ノーツの長さが一致していません。');
    return { beat, length, midi: n.midi, ...(value ? { value } : {}) };
  }).sort((a, b) => beatValue(a.beat) - beatValue(b.beat));
  for (let i = 1; i < voice.length; i++) if (beatValue(voice[i - 1].beat) + beatValue(voice[i - 1].length) > beatValue(voice[i].beat) + 1e-9) fail('音程が重なっています。位置か長さを調整してください。');
  const seen = new Set();
  const notes = input.notes.map(n => {
    if (!n) fail('4Kデータが不正です。');
    const beat = canonicalBeat(n.beat), at = beatValue(beat);
    if (at < 0 || at >= input.beats || !Number.isInteger(n.lane) || n.lane < 0 || n.lane > 3) fail('4Kノーツをレーン0〜3、曲の長さの範囲内に置いてください。');
    const key = `${beat}:${n.lane}`; if (seen.has(key)) fail('同じ位置に4Kノーツが重複しています。'); seen.add(key);
    return { beat, lane: n.lane, ...(n.value === undefined ? {} : { value: validateNoteValue(n.value) }) };
  }).sort((a, b) => beatValue(a.beat) - beatValue(b.beat) || a.lane - b.lane);
  return { format: 'death-vocal-chart', version: 1, title: input.title.trim(), bpm: input.bpm, beats: input.beats, countIn: input.countIn, voice, notes };
}

function beatParts(value) {
  let source = typeof value === 'number' && Number.isFinite(value) ? (String(value).includes('e') ? value.toFixed(9) : String(value)) : typeof value === 'string' ? value.replace(/\s/g, '') : '';
  const japanese = source.match(/^(\d{1,10})分の(\d{1,12})$/); if (japanese) source = `${japanese[2]}/${japanese[1]}`;
  let n, d;
  const mixed = source.match(/^(\d{1,3})\+(\d{1,12})\/(\d{1,10})$/);
  const ratio = source.match(/^(\d{1,12})(?:\/(\d{1,10}))?$/);
  const decimal = source.match(/^(\d{1,3})\.(\d{1,9})$/);
  if (mixed) { d = BigInt(mixed[3]); n = BigInt(mixed[1]) * d + BigInt(mixed[2]); }
  else if (ratio) { n = BigInt(ratio[1]); d = BigInt(ratio[2] || 1); }
  else if (decimal) { d = 10n ** BigInt(decimal[2].length); n = BigInt(decimal[1]) * d + BigInt(decimal[2]); }
  else throw new Error('拍は 16/13、13/16、1+3/13、0.5 のように入力してください。');
  if (d === 0n) throw new Error('分母は1以上で指定してください。');
  return [n, d];
}
function reducedBeat(n, d) {
  if (n < 0n) throw new Error('拍は0以上で指定してください。');
  let a = n, b = d; while (b) [a, b] = [b, a % b];
  n /= a; d /= a;
  if (d > 1000000000n || n > 256n * d) throw new Error('拍は256以内、分母は10億以内で指定してください。');
  return d === 1n ? Number(n) : `${n}/${d}`;
}
export function canonicalBeat(value) { const [n, d] = beatParts(value); return reducedBeat(n, d); }
export function beatValue(value) { const [n, d] = beatParts(value); return Number(n) / Number(d); }
export function addBeats(a, b) { const [an, ad] = beatParts(a), [bn, bd] = beatParts(b); return reducedBeat(an * bd + bn * ad, ad * bd); }
export function subtractBeats(a, b) { const [an, ad] = beatParts(a), [bn, bd] = beatParts(b); return reducedBeat(an * bd - bn * ad, ad * bd); }
export function multiplyBeats(value, count) {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('音符の個数は0以上の整数で指定してください。');
  const [n, d] = beatParts(value); return reducedBeat(n * BigInt(count), d);
}

export function validateNoteValue(value) {
  const { denominator, dots = 0, tupletCount = 1, tupletIn = 1 } = value || {};
  if (!Number.isInteger(denominator) || denominator < 1 || denominator > 4096 || !Number.isInteger(dots) || dots < 0 || dots > 2 || !Number.isInteger(tupletCount) || tupletCount < 1 || tupletCount > 1024 || !Number.isInteger(tupletIn) || tupletIn < 1 || tupletIn > 1024) throw new Error('音価は1〜4096分音符、付点0〜2個、連符比1〜1024で指定してください。');
  return { denominator, dots, tupletCount, tupletIn };
}
export function noteValueLength(input) {
  const v = validateNoteValue(input);
  return canonicalBeat(`${4 * (2 ** (v.dots + 1) - 1) * v.tupletIn}/${v.denominator * 2 ** v.dots * v.tupletCount}`);
}
export function noteValueLabel(input) {
  const v = validateNoteValue(input), name = v.denominator === 1 ? '全音符' : `${v.denominator}分音符`;
  return `${['', '付点', '複付点'][v.dots]}${name}${v.tupletCount === 1 && v.tupletIn === 1 ? '' : `・${v.tupletCount}連符（${v.tupletIn}個分）`}`;
}
export function inferNoteValue(length) {
  const target = canonicalBeat(length);
  for (const ratio of [[1,1],[3,2]]) for (const denominator of [1,2,4,8,16,32,64,128,256,512,1024,2048,4096]) for (const dots of [0,1,2]) {
    const value = { denominator, dots, tupletCount: ratio[0], tupletIn: ratio[1] };
    if (noteValueLength(value) === target) return value;
  }
  return null;
}
