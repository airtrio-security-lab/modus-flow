#!/usr/bin/env python3
"""MODUS FLOW · local speech-to-text server on faster-whisper (owner decision 2026-11-11, ADR-0015).

Free, offline, on the same computer: the recording never leaves the machine. Speaks the small
subset of the OpenAI-compatible API that MODUS FLOW uses:
    GET  /v1/models
    POST /v1/audio/transcriptions   (multipart: file, model, language, response_format=verbose_json)

    pip install faster-whisper            # once; the model is downloaded on first start
    python scripts/whisper-server.py --model small --port 8000
    # then start MODUS FLOW with:
    MODUS_TRANSCRIBE_PROVIDER=openai-compatible-local MODUS_TRANSCRIBE_URL=http://127.0.0.1:8000 MODUS_TRANSCRIBE_MODEL=small

Needs ffmpeg. Listens on 127.0.0.1 only. Does not store audio: the upload is decoded in memory and dropped.
faster-whisper does not tell who is speaking: segments carry time and text only.
Quality on Russian speech: see docs/audit/asr/ (scripts/asr-eval.py).
"""
import argparse, json, subprocess, sys, time

import numpy as np
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from faster_whisper import WhisperModel

MAX_BYTES = 26 * 1024 * 1024


def parse_multipart(content_type: str, body: bytes) -> dict:
    """multipart/form-data → {field: bytes} with the standard library (cgi was removed in Python 3.13)."""
    msg = BytesParser(policy=email_policy).parsebytes(b'Content-Type: ' + content_type.encode('latin-1') + b'\r\nMIME-Version: 1.0\r\n\r\n' + body)
    out = {}
    for part in msg.iter_parts():
        name = part.get_param('name', header='content-disposition')
        if name:
            out[name] = part.get_payload(decode=True) or b''
    return out


def make_handler(model, model_name):
    class H(BaseHTTPRequestHandler):
        server_version = 'modus-whisper/1'

        def _json(self, code, body):
            data = json.dumps(body, ensure_ascii=False).encode('utf-8')
            self.send_response(code)
            self.send_header('content-type', 'application/json; charset=utf-8')
            self.send_header('content-length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, fmt, *args):
            sys.stderr.write('[whisper] ' + (fmt % args) + '\n')

        def do_GET(self):
            if self.path.rstrip('/') == '/v1/models':
                return self._json(200, {'object': 'list', 'data': [{'id': model_name, 'object': 'model'}]})
            self._json(404, {'error': 'not found'})

        def do_POST(self):
            if self.path.rstrip('/') != '/v1/audio/transcriptions':
                return self._json(404, {'error': 'not found'})
            length = int(self.headers.get('content-length') or 0)
            if length <= 0 or length > MAX_BYTES:
                return self._json(413, {'error': 'file is empty or larger than 25 MB'})
            form = parse_multipart(self.headers.get('content-type', ''), self.rfile.read(length))
            if not form.get('file'):
                return self._json(400, {'error': 'file is required'})
            raw = form['file']
            language = (form.get('language') or b'ru').decode('utf-8', 'replace').strip() or 'ru'
            # Decoded by ffmpeg in memory (not PyAV: its newest releases broke faster-whisper's decoder).
            p = subprocess.run(['ffmpeg', '-v', 'error', '-i', 'pipe:0', '-f', 'f32le', '-ac', '1', '-ar', '16000', 'pipe:1'], input=raw, capture_output=True)
            if p.returncode != 0 or not p.stdout:
                return self._json(400, {'error': 'cannot decode audio'})
            audio = np.frombuffer(p.stdout, dtype=np.float32).copy()
            t0 = time.time()
            segments, info = model.transcribe(audio, language=language, vad_filter=True, beam_size=5)
            segs = [{'id': i, 'start': round(s.start, 2), 'end': round(s.end, 2), 'text': s.text.strip()} for i, s in enumerate(segments)]
            self._json(200, {
                'text': ' '.join(s['text'] for s in segs),
                'language': info.language,
                'duration': round(info.duration, 2),
                'segments': segs,
                'processing_seconds': round(time.time() - t0, 2),
            })

    return H


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default='small', help='tiny | base | small | medium | large-v3 | large-v3-turbo')
    ap.add_argument('--port', type=int, default=8000)
    ap.add_argument('--device', default='cpu')
    ap.add_argument('--compute-type', default='int8')
    ap.add_argument('--download-root')
    a = ap.parse_args()
    model = WhisperModel(a.model, device=a.device, compute_type=a.compute_type, download_root=a.download_root)
    srv = ThreadingHTTPServer(('127.0.0.1', a.port), make_handler(model, a.model))
    print(f'faster-whisper {a.model} on http://127.0.0.1:{a.port} (local only)', flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
