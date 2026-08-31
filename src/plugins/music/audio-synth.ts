// 多采样库 WAV 合成引擎

export type SynthHap = {
  begin: number;
  end: number;
  vel: number;
  s: string;        // 乐器名（strudel sample name）
  n?: number | string | null; // MIDI 音符号或待展开模式串
  note?: string;     // 音符名
  freq?: number;     // 频率
};

export type NoteEvent = {
  note: string;
  duration: number;
  velocity?: number;
};

export type TrackSpec = {
  instrument: string;
  notes: NoteEvent[];
  gain?: number;     // 0-1
  pan?: number;      // -1..1
};

export type MusicSpec = {
  library?: string;
  bpm: number;
  tracks: TrackSpec[];
  title?: string;
};

export type PatternToken = string | number | null | string[];

// ── 采样库定义 ──────────────────────────────────────────────

type Envelope = { a: number; d: number; s: number; r: number };
type SynthDef = {
  label: string;
  wave: "sine" | "square" | "saw" | "tri";
  env: Envelope;
  harmonics: number[];   // 倍振幅 [基频, 2倍, 3倍…]
  cutoff?: number;       // 低通截止频率 0-1
  vibSpeed?: number;     // 颤音速度 Hz
  vibDepth?: number;     // 颤音深度 半音
  fixedFreq?: number;    // 固定频率（打击乐等不跟随音高）
};

type SampleLibrary = {
  name: string;
  desc: string;
  label: string;
  instruments: Record<string, SynthDef>;
};

function def(
  wave: SynthDef["wave"], env: Envelope,
  harmonics: number[],
  extra?: Partial<SynthDef>,
): SynthDef {
  return { label: wave, wave, env, harmonics, ...extra };
}

const LIBRARIES: Record<string, SampleLibrary> = {
  official: {
    name: "official",
    desc: "官方默认音色库，偏现代/柔和",
    label: "官方",
    instruments: {
      piano:   def("sine", { a: 0.004, d: 0.22, s: 0.28, r: 0.55 }, [1, 0.9, 0.62, 0.34, 0.18, 0.08], { cutoff: 0.22 }),
      bass:    def("tri",  { a: 0.01,  d: 0.12, s: 0.42, r: 0.28 }, [1, 0.42, 0.18, 0.06], { cutoff: 0.18 }),
      pad:     def("sine", { a: 0.16,  d: 0.3,  s: 0.72, r: 0.85 }, [1, 0.45, 0.24, 0.1], { cutoff: 0.16, vibSpeed: 3, vibDepth: 0.03 }),
      lead:    def("tri",  { a: 0.008, d: 0.16, s: 0.44, r: 0.32 }, [1, 0.35, 0.12], { cutoff: 0.28, vibSpeed: 4, vibDepth: 0.015 }),
      pluck:   def("sine", { a: 0.001, d: 0.09, s: 0.02, r: 0.14 }, [1, 0.45, 0.12], { cutoff: 0.2 }),
      kick:    def("sine", { a: 0.001, d: 0.15, s: 0,   r: 0.05 }, [1, 0.8, 0.4], { cutoff: 0.15, fixedFreq: 58 }),
      snare:   def("tri",  { a: 0.001, d: 0.09, s: 0,   r: 0.1  }, [1, 0.42, 0.22], { cutoff: 0.46, fixedFreq: 240 }),
      hihat:   def("square",{a: 0.001, d: 0.03, s: 0,   r: 0.018}, [1, 0.35, 0.14], { cutoff: 0.78, fixedFreq: 3200 }),
      bell:    def("sine", { a: 0.003, d: 0.18, s: 0.2, r: 0.85 }, [1, 0.72, 0.4, 0.14, 0.05], { cutoff: 0.26, vibSpeed: 2.5, vibDepth: 0.02 }),
      organ:   def("sine", { a: 0.01,  d: 0.08, s: 0.82, r: 0.38 }, [1, 0.65, 0.46, 0.22, 0.08], { cutoff: 0.24 }),
    },
  },

  retro: {
    name: "retro",
    desc: "红白机/8bit 复古风格",
    label: "复古",
    instruments: {
      piano:   def("square",{a: 0.001, d: 0.05, s: 0.5, r: 0.15}, [1]),
      bass:    def("square",{a: 0.002, d: 0.02, s: 0.4, r: 0.1},  [1, 0.2]),
      pad:     def("tri",  { a: 0.05,  d: 0.1,  s: 0.6, r: 0.4 }, [1, 0.3],     { cutoff: 0.3, vibSpeed: 5, vibDepth: 0.02 }),
      lead:    def("square",{a: 0.001, d: 0.02, s: 0.7, r: 0.1},  [1, 0.15]),
      pluck:   def("square",{a: 0.001, d: 0.02, s: 0,   r: 0.06}, [1]),
      kick:    def("square",{a: 0.001, d: 0.12, s: 0,   r: 0.04}, [1, 0.6, 0.3], { cutoff: 0.12, fixedFreq: 62 }),
      snare:   def("square",{a: 0.001, d: 0.05, s: 0,   r: 0.08}, [1, 0.4, 0.2], { cutoff: 0.5, fixedFreq: 260 }),
      hihat:   def("square",{a: 0.001, d: 0.02, s: 0,   r: 0.01}, [1, 0.5],     { cutoff: 0.9, fixedFreq: 3600 }),
      bell:    def("square",{a: 0.001, d: 0.05, s: 0.2, r: 0.4},  [1, 0.5, 0.2],{ vibSpeed: 4, vibDepth: 0.02 }),
      organ:   def("square",{a: 0.002, d: 0.03, s: 0.7, r: 0.2},  [1, 0.4, 0.3, 0.15]),
    },
  },

  ambient: {
    name: "ambient",
    desc: "空灵/氛围音乐",
    label: "氛围",
    instruments: {
      piano:   def("sine", { a: 0.02,  d: 0.15, s: 0.5, r: 0.6 }, [1],        { vibSpeed: 3, vibDepth: 0.04 }),
      bass:    def("sine", { a: 0.03,  d: 0.1,  s: 0.6, r: 0.5 }, [1, 0.15],  { cutoff: 0.3, vibSpeed: 2, vibDepth: 0.03 }),
      pad:     def("sine", { a: 0.2,   d: 0.3,  s: 0.7, r: 1.0 }, [1, 0.3, 0.15], { cutoff: 0.25, vibSpeed: 3, vibDepth: 0.05 }),
      lead:    def("tri",  { a: 0.01,  d: 0.2,  s: 0.5, r: 0.5 }, [1, 0.2],  { cutoff: 0.45, vibSpeed: 4, vibDepth: 0.03 }),
      pluck:   def("sine", { a: 0.001, d: 0.04, s: 0,   r: 0.2 }, [1]),
      kick:    def("sine", { a: 0.002, d: 0.2,  s: 0,   r: 0.08 }, [1, 0.7, 0.3], { cutoff: 0.12, fixedFreq: 54 }),
      snare:   def("tri",  { a: 0.002, d: 0.1,  s: 0,   r: 0.15 }, [1, 0.4, 0.2], { cutoff: 0.45, fixedFreq: 220 }),
      hihat:   def("tri",  { a: 0.001, d: 0.06, s: 0,   r: 0.03 }, [1, 0.6],     { cutoff: 0.75, fixedFreq: 2800 }),
      bell:    def("sine", { a: 0.01,  d: 0.15, s: 0.3, r: 0.8 }, [1, 0.5, 0.25, 0.1, 0.05], { vibSpeed: 3, vibDepth: 0.03 }),
      organ:   def("sine", { a: 0.02,  d: 0.1,  s: 0.7, r: 0.5 }, [1, 0.4, 0.5, 0.2, 0.1]),
    },
  },

  orchestral: {
    name: "orchestral",
    desc: "管弦乐风格",
    label: "管弦",
    instruments: {
      piano:   def("tri",  { a: 0.008, d: 0.08, s: 0.6, r: 0.3 }, [1, 0.5, 0.3, 0.15, 0.08]),
      bass:    def("saw",  { a: 0.01,  d: 0.05, s: 0.5, r: 0.3 }, [1, 0.25],   { cutoff: 0.25 }),
      pad:     def("tri",  { a: 0.15,  d: 0.2,  s: 0.7, r: 0.6 }, [1, 0.3, 0.1, 0.05], { cutoff: 0.3, vibSpeed: 3, vibDepth: 0.03 }),
      lead:    def("saw",  { a: 0.005, d: 0.08, s: 0.5, r: 0.35}, [1, 0.15],   { cutoff: 0.55, vibSpeed: 3, vibDepth: 0.02 }),
      pluck:   def("tri",  { a: 0.001, d: 0.02, s: 0,   r: 0.08 }, [1, 0.3]),
      kick:    def("sine", { a: 0.001, d: 0.18, s: 0,   r: 0.06 }, [1, 0.9, 0.5, 0.2], { cutoff: 0.1, fixedFreq: 56 }),
      snare:   def("saw",  { a: 0.001, d: 0.1,  s: 0,   r: 0.12 }, [1, 0.5, 0.3], { cutoff: 0.45, fixedFreq: 230 }),
      hihat:   def("square",{a: 0.001, d: 0.05, s: 0,   r: 0.03 }, [1, 0.7, 0.4], { cutoff: 0.8, fixedFreq: 3000 }),
      bell:    def("sine", { a: 0.005, d: 0.12, s: 0.3, r: 0.7 }, [1, 0.55, 0.3, 0.12, 0.06], { vibSpeed: 3, vibDepth: 0.02 }),
      organ:   def("sine", { a: 0.01,  d: 0.05, s: 0.8, r: 0.35}, [1, 0.5, 0.6, 0.25, 0.12]),
    },
  },
};

export function listLibraries(): { name: string; label: string; desc: string }[] {
  return Object.values(LIBRARIES).map(l => ({ name: l.name, label: l.label, desc: l.desc }));
}

export function getLibrary(name?: string): SampleLibrary {
  return LIBRARIES[name && LIBRARIES[name] ? name : "official"];
}

// ── 合成函数 ────────────────────────────────────────────────

export function synthWav(spec: MusicSpec): Buffer {
  const library = getLibrary(spec.library);
  const sampleRate = 44100;
  const spb = 60 / spec.bpm;

  const totalBeats = Math.max(1, ...spec.tracks.map(t =>
    t.notes.reduce((s, n) => s + n.duration, 0)
  ));
  const totalSamples = Math.ceil(totalBeats * spb * sampleRate) + sampleRate / 5;
  const mixed = new Float32Array(totalSamples);
  let maxWritten = 0;

  for (const track of spec.tracks) {
    const sd = library.instruments[track.instrument] ?? library.instruments.piano!;
    const buffer = renderSynthTrack(track, sd, sampleRate, spb);
    const gain = track.gain ?? 0.5;
    const pan = track.pan ?? 0;
    const leftG = gain * Math.min(1, 1 - Math.max(0, pan));
    const rightG = gain * Math.min(1, 1 + Math.max(-0, pan));

    for (let i = 0; i < buffer.length && i < mixed.length; i++) {
      mixed[i] += buffer[i] * Math.max(leftG, rightG);
      maxWritten = Math.max(maxWritten, i);
    }
  }

  let peak = 0;
  for (let i = 0; i <= Math.max(0, maxWritten); i++) peak = Math.max(peak, Math.abs(mixed[i]));
  if (peak > 0.001) {
    const scale = 0.95 / peak;
    for (let i = 0; i <= maxWritten; i++) mixed[i] *= scale;
  }

  return float32ToWav(mixed, sampleRate, maxWritten + 1);
}

// ── strudel hap 渲染 ─────────────────────────────────────────

export function synthHaps(
  haps: SynthHap[],
  library: SampleLibrary,
  opts: { bpm: number; duration: number; secondsPerCycle?: number },
): Buffer {
  const sampleRate = 44100;
  const secondsPerCycle = opts.secondsPerCycle ?? 3;
  const totalSamples = Math.ceil(opts.duration * secondsPerCycle * sampleRate) + sampleRate / 5;
  const mixed = new Float32Array(totalSamples);
  let maxWritten = 0;

  for (const hap of expandSynthHap(haps)) {
    const sd = library.instruments[hap.s] ?? library.instruments.piano!;
    const freq = sd.fixedFreq ?? hap.freq ?? (hap.n !== undefined ? midiToFreq(hap.n) : noteToFreq(hap.note ?? "C4"));
    const beginSamples = Math.round(hap.begin * secondsPerCycle * sampleRate);
    const durSamples = Math.round((hap.end - hap.begin) * secondsPerCycle * sampleRate);
    const vel = hap.vel ?? 0.8;

    const env = sd.env;
    const atk = Math.round(env.a * sampleRate);
    const dec = Math.round(env.d * sampleRate);
    const rel = Math.round(env.r * sampleRate);
    const susLevel = env.s;
    const lpAlpha = getLowPassAlpha(sd.cutoff, sampleRate);
    let filtered = 0;

    for (let i = 0; i < durSamples && beginSamples + i < mixed.length; i++) {
      const t = (beginSamples + i) / sampleRate;
      let f = freq;
      if (sd.vibSpeed && sd.vibDepth) {
        f += Math.sin(t * 2 * Math.PI * sd.vibSpeed) * sd.vibDepth * freq / 100;
      }
      let envVal = 1;
      if (i < atk) {
        envVal = i / atk;
      } else if (i < atk + dec) {
        envVal = 1 - (1 - susLevel) * (i - atk) / dec;
      } else if (i >= durSamples - rel) {
        envVal = susLevel * (durSamples - i) / rel;
      } else {
        envVal = susLevel;
      }

      const phase = (f * t * 2 * Math.PI) % (2 * Math.PI);
      let sample = 0;
      for (let h = 0; h < sd.harmonics.length; h++) {
        const hPhase = (phase * (h + 1)) % (2 * Math.PI);
        const hWave = baseWave(hPhase, sd.wave);
        sample += hWave * (sd.harmonics[h] ?? 0) / (h + 1);
      }
      if (lpAlpha !== null) {
        filtered += lpAlpha * (sample - filtered);
        sample = filtered;
      }

      mixed[beginSamples + i] += sample * envVal * vel;
      maxWritten = Math.max(maxWritten, beginSamples + i);
    }
  }

  let peak = 0;
  for (let i = 0; i <= Math.max(0, maxWritten); i++) peak = Math.max(peak, Math.abs(mixed[i]));
  if (peak > 0.001) {
    const scale = 0.95 / peak;
    for (let i = 0; i <= maxWritten; i++) mixed[i] *= scale;
  }

  return float32ToWav(mixed, sampleRate, maxWritten + 1);
}

export function extractPatternTokens(value: string | number | undefined | null): PatternToken[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "number") return [value];

  const normalized = value.replace(/[(),]/g, " ").trim();
  if (!normalized) return [];

  const rawTokens = normalized.match(/\[[^\]]+\]|[^\s]+/g) ?? [];
  return rawTokens.flatMap((token) => expandPatternToken(token));
}

function expandSynthHap(haps: SynthHap[]): SynthHap[] {
  const expanded: SynthHap[] = [];
  for (const hap of haps) {
    const noteTokens = extractPatternTokens(hap.note);
    const midiTokens = extractPatternTokens(hap.n);

    if (noteTokens.length > 1) {
      expanded.push(...distributePatternTokens(hap, noteTokens, "note"));
      continue;
    }
    if (midiTokens.length > 1) {
      expanded.push(...distributePatternTokens(hap, midiTokens, "n"));
      continue;
    }
    if (noteTokens.length === 1) {
      const token = noteTokens[0];
      if (Array.isArray(token)) {
        for (const chordNote of token) {
          expanded.push({ ...hap, note: chordNote, n: undefined });
        }
        continue;
      }
      if (typeof token === "string") {
        expanded.push({ ...hap, note: token, n: undefined });
        continue;
      }
      expanded.push(hap);
      continue;
    }
    if (midiTokens.length === 1) {
      const token = midiTokens[0];
      const midi = typeof token === "number" ? token : Number(token);
      expanded.push({ ...hap, n: Number.isFinite(midi) ? midi : undefined, note: undefined });
      continue;
    }

    expanded.push(hap);
  }
  return expanded;
}

function distributePatternTokens(
  hap: SynthHap,
  tokens: PatternToken[],
  field: "note" | "n",
): SynthHap[] {
  const playable = tokens.filter((token) => token !== null);
  if (playable.length === 0) return [];

  const segmentCount = Math.max(tokens.length, playable.length);
  const segmentDuration = (hap.end - hap.begin) / segmentCount;
  const result: SynthHap[] = [];
  let cursor = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const begin = hap.begin + segmentDuration * cursor;
    const end = hap.begin + segmentDuration * (cursor + 1);
    cursor++;
    if (token === null) continue;
    if (field === "note") {
      if (Array.isArray(token)) {
        for (const chordNote of token) {
          result.push({
            ...hap,
            begin,
            end,
            note: chordNote,
            n: undefined,
            freq: undefined,
          });
        }
        continue;
      }
      result.push({
        ...hap,
        begin,
        end,
        note: String(token),
        n: undefined,
        freq: undefined,
      });
    } else {
      const midi = typeof token === "number" ? token : Number(token);
      if (!Number.isFinite(midi)) continue;
      result.push({
        ...hap,
        begin,
        end,
        n: midi,
        note: undefined,
        freq: undefined,
      });
    }
  }

  return result;
}

function renderSynthTrack(
  track: TrackSpec, sd: SynthDef,
  sampleRate: number, spb: number,
): Float32Array {
  const totalSamples = Math.ceil(
    track.notes.reduce((s, n) => s + n.duration, 0) * spb * sampleRate
  ) + sampleRate / 5;
  const buf = new Float32Array(totalSamples);

  let samplePos = 0;
  for (const evt of track.notes) {
    const freq = noteToFreq(evt.note);
    const durSamples = Math.round(evt.duration * spb * sampleRate);
    const vel = evt.velocity ?? 0.8;
    const env = sd.env;
    const atk = Math.round(env.a * sampleRate);
    const dec = Math.round(env.d * sampleRate);
    const rel = Math.round(env.r * sampleRate);
    const lpAlpha = getLowPassAlpha(sd.cutoff, sampleRate);
    let filtered = 0;

    for (let i = 0; i < durSamples && samplePos + i < buf.length; i++) {
      const t = (samplePos + i) / sampleRate;
      let f = freq;
      if (sd.vibSpeed && sd.vibDepth) {
        f += Math.sin(t * 2 * Math.PI * sd.vibSpeed) * sd.vibDepth * freq / 100;
      }
      let envVal = 1;
      if (i < atk) {
        envVal = i / atk;
      } else if (i < atk + dec) {
        envVal = 1 - (1 - env.s) * (i - atk) / dec;
      } else if (i >= durSamples - rel) {
        envVal = env.s * (durSamples - i) / rel;
      } else {
        envVal = env.s;
      }

      const phase = (f * t * 2 * Math.PI) % (2 * Math.PI);
      let sample = 0;
      for (let h = 0; h < sd.harmonics.length; h++) {
        const hPhase = (phase * (h + 1)) % (2 * Math.PI);
        const hWave = baseWave(hPhase, sd.wave);
        sample += hWave * sd.harmonics[h]! / (h + 1);
      }
      if (lpAlpha !== null) {
        filtered += lpAlpha * (sample - filtered);
        sample = filtered;
      }

      buf[samplePos + i] += sample * envVal * vel;
    }
    samplePos += durSamples;
  }

  return buf;
}

function getLowPassAlpha(cutoff: number | undefined, sampleRate: number): number | null {
  if (cutoff === undefined) return null;
  const normalized = Math.max(0.02, Math.min(0.98, cutoff));
  const cutoffHz = 250 + normalized * 4500;
  return 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
}

function baseWave(phase: number, wave: SynthDef["wave"]): number {
  switch (wave) {
    case "sine":   return Math.sin(phase);
    case "square": return Math.sin(phase) > 0 ? 1 : -1;
    case "saw":    return (phase % (2 * Math.PI)) / Math.PI - 1;
    case "tri":    return Math.abs(((phase % (2 * Math.PI)) / Math.PI) - 1) * 2 - 1;
  }
}

function float32ToWav(samples: Float32Array, sampleRate: number, length: number): Buffer {
  const numChannels = 1;
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const dataLength = length * numChannels * bytesPerSample;
  const headerLength = 44;
  const totalLength = headerLength + dataLength;
  const buf = Buffer.alloc(totalLength);

  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(totalLength - 8, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28);
  buf.writeUInt16LE(numChannels * bytesPerSample, 32);
  buf.writeUInt16LE(bitDepth, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataLength, 40);

  let offset = headerLength;
  for (let i = 0; i < length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    const val = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
    buf.writeInt16LE(Math.round(val), offset);
    offset += 2;
  }
  return buf;
}

const A4 = 440;
const NOTE_BASE: Record<string, number> = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 };

function noteToFreq(note: string): number {
  const normalized = note.trim();
  const match = /^([A-G])([#b]?)(-?\d+)?$/i.exec(normalized);
  if (!match) return A4;
  const [, name, accidental, octave] = match;
  let s = NOTE_BASE[name.toUpperCase()] ?? 0;
  if (accidental === "#") s += 1;
  if (accidental === "b") s -= 1;
  const octaveNum = octave === undefined ? 4 : Number(octave);
  return A4 * Math.pow(2, (s + (octaveNum - 4) * 12) / 12);
}

function midiToFreq(n: number | string | null): number {
  const midi = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(midi)) return A4;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function expandPatternToken(token: string): PatternToken[] {
  const cleaned = token.trim();
  if (!cleaned) return [];
  if (cleaned === "~") return [null];

  const repeatMatch = /^(.+)\*(\d+)$/.exec(cleaned);
  if (repeatMatch) {
    const [, base, countText] = repeatMatch;
    const count = Number(countText);
    if (!Number.isFinite(count) || count <= 0) return [];
    const expandedBase = expandPatternToken(base);
    return Array.from({ length: count }, () => expandedBase).flat();
  }

  if (cleaned.startsWith("~") && cleaned.length > 1) {
    return [null, ...expandPatternToken(cleaned.slice(1))];
  }
  if (cleaned.endsWith("~") && cleaned.length > 1) {
    return [...expandPatternToken(cleaned.slice(0, -1)), null];
  }

  if (cleaned.startsWith("[") && cleaned.endsWith("]")) {
    const chordNotes = (cleaned.slice(1, -1).match(/[^\s]+/g) ?? [])
      .map((part) => sanitizePitchToken(part))
      .filter((part): part is string => Boolean(part));
    return chordNotes.length > 0 ? [chordNotes] : [null];
  }

  if (cleaned.includes(":")) {
    const parts = cleaned.split(":").filter(Boolean);
    if (parts.length > 1) {
      return parts.flatMap((part) => expandPatternToken(part));
    }
  }

  const sanitized = sanitizePitchToken(cleaned);
  if (!sanitized) return [null];
  return [sanitized];
}

function sanitizePitchToken(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed || trimmed === "~") return null;
  return trimmed.replace(/[.,;:!?]+$/g, "") || null;
}
