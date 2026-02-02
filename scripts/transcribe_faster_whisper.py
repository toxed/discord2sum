#!/usr/bin/env python3
import argparse
import sys
from faster_whisper import WhisperModel


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="small", help="Model size/name (tiny|base|small|medium|large-v3 or HF repo)")
    ap.add_argument("--device", default="cpu", choices=["cpu", "cuda", "auto"], help="device")
    ap.add_argument("--compute_type", default="int8", help="int8|int8_float16|float16|float32")
    ap.add_argument("--language", default=None, help="e.g. ru/en. None = auto")
    ap.add_argument("--beam_size", type=int, default=1)
    ap.add_argument("--vad_filter", action="store_true", default=True)

    # Anti-hallucination knobs (helpful for noisy calls)
    ap.add_argument("--no_speech_threshold", type=float, default=0.6)
    ap.add_argument("--log_prob_threshold", type=float, default=-1.0)
    ap.add_argument("--compression_ratio_threshold", type=float, default=2.4)

    # Optional prompt to bias toward certain vocab (e.g. deploy/endpoint/webhook)
    ap.add_argument("--prompt", default=None)

    ap.add_argument("file", help="Path to audio file")
    args = ap.parse_args()

    device = args.device
    if device == "auto":
        device = "cuda"  # will fail if no cuda; keep simple

    model = WhisperModel(args.model, device=device, compute_type=args.compute_type)

    segments, _info = model.transcribe(
        args.file,
        language=args.language,
        beam_size=args.beam_size,
        vad_filter=args.vad_filter,
        no_speech_threshold=args.no_speech_threshold,
        log_prob_threshold=args.log_prob_threshold,
        compression_ratio_threshold=args.compression_ratio_threshold,
        initial_prompt=args.prompt,
    )

    out = []
    for seg in segments:
        text = (seg.text or "").strip()
        if text:
            out.append(text)

    sys.stdout.write(" ".join(out).strip())


if __name__ == "__main__":
    main()
