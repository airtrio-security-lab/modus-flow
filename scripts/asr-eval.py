#!/usr/bin/env python3
"""MODUS FLOW · quality check of local faster-whisper on Russian speech (owner decision 2026-11-11).

Two modes:
  1. FLEURS (Google, CC-BY 4.0; real read Russian speech, many speakers, reference texts):
       python scripts/asr-eval.py fleurs --fleurs /path/to/fleurs_ru --models small medium --out docs/audit/asr
     Builds "meetings" of 8 utterances from different speakers (alternating voices) and
     transcribes them in four conditions: clean; babble noise at 10 dB SNR; babble + mains
     hum + broadband noise at 5 dB SNR; speakers overlapping by 0.8 s plus babble at 10 dB.
  2. Your own recordings (for the pilot, recorded with consent):
       python scripts/asr-eval.py pairs --dir /path/to/pairs --models small
     where every audio file x.wav|ogg|mp3|m4a|webm has a reference x.txt.

Reports WER (word error rate) after a plain normalization (lower case, ё→е, no punctuation) and
the real-time factor (processing time / audio time) on this CPU. faster-whisper does not tell who
is speaking: speaker separation is NOT evaluated and NOT provided.
Needs: pip install faster-whisper jiwer soundfile numpy (and ffmpeg for non-WAV inputs).
"""
import argparse, csv, json, os, random, re, subprocess, sys, tempfile, time

import numpy as np
import soundfile as sf
import jiwer
from faster_whisper import WhisperModel

SR = 16000


def norm(t: str) -> str:
    t = t.lower().replace('ё', 'е')
    t = re.sub(r"[^\w\s]", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def load(path: str) -> np.ndarray:
    if path.endswith('.wav'):
        x, sr = sf.read(path, dtype='float32', always_2d=False)
    else:
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '1', '-ar', str(SR), '-'], capture_output=True, check=True).stdout
        return np.frombuffer(raw, dtype=np.float32).copy()
    if x.ndim > 1:
        x = x.mean(axis=1)
    if sr != SR:
        raise SystemExit(f'{path}: expected {SR} Hz, got {sr}')
    return x


def rms(x):
    return float(np.sqrt(np.mean(x ** 2)) + 1e-9)


def mix(speech, noise, snr_db):
    noise = np.resize(noise, speech.shape)
    gain = rms(speech) / (rms(noise) * 10 ** (snr_db / 20))
    out = speech + gain * noise
    return (out / max(1.0, float(np.max(np.abs(out))))).astype(np.float32)


def build_meetings(fleurs_dir, n_meetings=3, per_meeting=8, seed=7):
    rows = list(csv.reader(open(os.path.join(fleurs_dir, 'test.tsv'), encoding='utf-8'), delimiter='\t'))
    by_sentence = {}
    for r in rows:
        by_sentence.setdefault(r[0], []).append(r)
    rnd = random.Random(seed)
    sentences = sorted(by_sentence)
    rnd.shuffle(sentences)
    meetings, used = [], 0
    for _ in range(n_meetings):
        utts = []
        for k in range(per_meeting):
            want = 'FEMALE' if k % 2 == 0 else 'MALE'
            while True:
                cands = by_sentence[sentences[used]]
                used += 1
                pick = [c for c in cands if c[6] == want] or cands
                r = rnd.choice(pick)
                wav = os.path.join(fleurs_dir, 'test', r[1])
                if os.path.exists(wav):
                    utts.append((load(wav), r[2], r[6]))
                    break
        meetings.append(utts)
    # Babble: four utterances not used in any meeting, summed.
    pool = []
    for s in sentences[used:used + 4]:
        pool.append(load(os.path.join(fleurs_dir, 'test', by_sentence[s][0][1])))
    L = max(len(p) for p in pool)
    babble = sum(np.pad(p, (0, L - len(p))) for p in pool)
    return meetings, babble


def render(utts, overlap_s=0.0, gap_s=0.6):
    parts, refs = [], []
    total = 0
    for i, (x, ref, _) in enumerate(utts):
        refs.append(ref)
        if i == 0:
            parts.append((0, x))
            total = len(x)
            continue
        start = total + int(gap_s * SR) if overlap_s == 0 else max(0, total - int(overlap_s * SR))
        parts.append((start, x))
        total = max(total, start + len(x))
    out = np.zeros(total + SR // 2, dtype=np.float32)
    for s, x in parts:
        out[s:s + len(x)] += x
    return out / max(1.0, float(np.max(np.abs(out)))), ' '.join(refs)


def conditions(utts, babble):
    rng = np.random.default_rng(1)
    clean, ref = render(utts)
    t = np.arange(len(clean)) / SR
    hum = 0.5 * np.sin(2 * np.pi * 50 * t) + 0.25 * np.sin(2 * np.pi * 100 * t)
    broadband = np.cumsum(rng.standard_normal(len(clean))).astype(np.float32)
    broadband = broadband - np.convolve(broadband, np.ones(400) / 400, mode='same')
    over, ref_o = render(utts, overlap_s=0.8)
    return [
        ('clean', 'чистая запись', clean, ref),
        ('babble10', 'фоновый гомон, SNR 10 дБ', mix(clean, babble, 10), ref),
        ('noise5', 'гомон + гул 50 Гц + шум, SNR 5 дБ', mix(clean, np.resize(babble, clean.shape) + hum + broadband / rms(broadband) * rms(babble), 5), ref),
        ('overlap', 'перебивают друг друга (0,8 с) + гомон 10 дБ', mix(over, babble, 10), ref_o),
    ]


def transcribe(model, audio):
    t0 = time.time()
    segs, info = model.transcribe(np.ascontiguousarray(audio, dtype=np.float32), language='ru', vad_filter=True, beam_size=5)
    text = ' '.join(s.text for s in segs)
    return text, time.time() - t0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('mode', choices=['fleurs', 'pairs'])
    ap.add_argument('--fleurs')
    ap.add_argument('--dir')
    ap.add_argument('--models', nargs='+', default=['small'])
    ap.add_argument('--out', default='docs/audit/asr')
    ap.add_argument('--download-root', default=os.environ.get('MODUS_ASR_MODELS'))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    cases = []
    if a.mode == 'fleurs':
        meetings, babble = build_meetings(a.fleurs)
        for mi, utts in enumerate(meetings, 1):
            for key, label, audio, ref in conditions(utts, babble):
                cases.append((f'm{mi}-{key}', key, label, audio, ref))
    else:
        for f in sorted(os.listdir(a.dir)):
            base, ext = os.path.splitext(f)
            if ext.lower() in ('.wav', '.ogg', '.mp3', '.m4a', '.webm') and os.path.exists(os.path.join(a.dir, base + '.txt')):
                cases.append((base, 'own', 'собственная запись', load(os.path.join(a.dir, f)), open(os.path.join(a.dir, base + '.txt'), encoding='utf-8').read()))
    results = []
    for m in a.models:
        model = WhisperModel(m, device='cpu', compute_type='int8', download_root=a.download_root)
        for cid, key, label, audio, ref in cases:
            hyp, secs = transcribe(model, audio)
            w = jiwer.wer(norm(ref), norm(hyp))
            dur = len(audio) / SR
            results.append({'model': m, 'case': cid, 'condition': key, 'label': label, 'seconds': round(dur, 1), 'wer': round(w, 4), 'rtf': round(secs / dur, 3), 'reference': ref, 'hypothesis': hyp.strip()})
            print(f'{m:8s} {cid:14s} WER {w:6.1%}  RTF {secs / dur:5.2f}', flush=True)
    json.dump({'cpu': os.cpu_count(), 'results': results}, open(os.path.join(a.out, 'results.json'), 'w'), ensure_ascii=False, indent=1)
    # Summary per model and condition (WER over all words of the condition).
    lines = ['| Модель | Условие | WER | Скорость (RTF) |', '|---|---|---|---|']
    for m in a.models:
        for key in dict.fromkeys(r['condition'] for r in results):
            rs = [r for r in results if r['model'] == m and r['condition'] == key]
            w = jiwer.wer([norm(r['reference']) for r in rs], [norm(r['hypothesis']) for r in rs])
            rtf = sum(r['rtf'] * r['seconds'] for r in rs) / sum(r['seconds'] for r in rs)
            lines.append(f"| {m} | {rs[0]['label']} | {w:.1%} | {rtf:.2f} |")
    open(os.path.join(a.out, 'summary.md'), 'w').write('\n'.join(lines) + '\n')
    print('\n'.join(lines))


if __name__ == '__main__':
    main()
