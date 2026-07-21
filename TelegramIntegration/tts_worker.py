from __future__ import annotations

import argparse
import json
import os
import queue
import re
import sys
import threading
import wave
from pathlib import Path


def read_requests(target: queue.Queue[dict | None]) -> None:
    for line in sys.stdin:
        try:
            target.put(json.loads(line))
        except json.JSONDecodeError:
            continue
    target.put(None)


def clean_text(value: str, max_chars: int) -> str:
    text = re.sub(r"```.*?```", " Фрагмент кода опущен. ", value, flags=re.DOTALL)
    text = re.sub(r"\[([^\]]+)]\([^)]+\)", r"\1", text)
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"https?://\S+", " ссылка ", text)
    text = re.sub(r"[*#_>|]", " ", text)
    replacements = {
        "Codex": "Кодекс",
        "Claude": "Клод",
        "Telegram": "Телеграм",
        "Whisper": "Уиспер",
        "Silero": "Силеро",
        "app-server": "апп сервер",
        "AGENTS": "эйджентс",
        "API": "эй пи ай",
        "TTS": "ти ти эс",
        "JSON": "джейсон",
        "Python": "Пайтон",
    }
    for source, replacement in replacements.items():
        text = re.sub(rf"\b{re.escape(source)}\b", replacement, text, flags=re.IGNORECASE)
    text = re.sub(r"[A-Za-z]+", " ", text)
    text = re.sub(r"[^0-9А-Яа-яЁё.,!?;:()\-–—\s]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:max_chars].strip()


def split_text(text: str, max_chunk: int = 400) -> list[str]:
    sentences = re.split(r"(?<=[.!?…])\s+", text)
    chunks: list[str] = []
    current = ""
    for sentence in sentences:
        words = sentence.split()
        for word in words:
            candidate = f"{current} {word}".strip()
            if current and len(candidate) > max_chunk:
                chunks.append(current)
                current = word
            else:
                current = candidate
    if current:
        chunks.append(current)
    return chunks


def save_wav(audio, output_path: Path, sample_rate: int) -> None:
    samples = audio.detach().cpu().clamp(-1, 1).numpy()
    pcm = (samples * 32767).astype("int16").tobytes()
    with wave.open(str(output_path), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(sample_rate)
        target.writeframes(pcm)


def wav_to_ogg_opus(wav_path: Path, output_path: Path, sample_rate: int) -> None:
    import av

    with av.open(str(wav_path)) as source, av.open(str(output_path), "w", format="ogg") as target:
        stream = target.add_stream("libopus", rate=sample_rate)
        stream.layout = "mono"
        resampler = av.AudioResampler(format="fltp", layout="mono", rate=sample_rate)
        for frame in source.decode(audio=0):
            for converted in resampler.resample(frame):
                for packet in stream.encode(converted):
                    target.mux(packet)
        for converted in resampler.resample(None):
            for packet in stream.encode(converted):
                target.mux(packet)
        for packet in stream.encode(None):
            target.mux(packet)


class Synthesizer:
    def __init__(self, model_id: str, speaker: str, cache_dir: Path) -> None:
        os.environ["TORCH_HOME"] = str(cache_dir)
        cache_dir.mkdir(parents=True, exist_ok=True)
        import torch

        torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
        self.torch = torch
        model_path = cache_dir / f"{model_id}.pt"
        if not model_path.is_file():
            torch.hub.download_url_to_file(
                f"https://models.silero.ai/models/tts/ru/{model_id}.pt",
                str(model_path),
                progress=True,
            )
        importer = torch.package.PackageImporter(str(model_path))
        self.model = importer.load_pickle("tts_models", "model")
        self.model.to(torch.device("cpu"))
        self.speaker = speaker
        self.sample_rate = 48000

    def synthesize(self, text: str, output_path: Path, max_chars: int, progress=None) -> None:
        cleaned = clean_text(text, max_chars)
        if not cleaned:
            raise ValueError("После очистки в ответе не осталось текста для озвучивания")
        pieces = []
        silence = self.torch.zeros(int(self.sample_rate * 0.2))
        chunks = split_text(cleaned)
        for index, chunk in enumerate(chunks):
            if progress is not None:
                progress("chunk", index, len(chunks))
            if index:
                pieces.append(silence)
            pieces.append(self.model.apply_tts(
                text=chunk,
                speaker=self.speaker,
                sample_rate=self.sample_rate,
                put_accent=True,
                put_yo=True,
            ))
            if progress is not None:
                progress("chunk-complete", index + 1, len(chunks))
        audio = self.torch.cat(pieces)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        wav_path = output_path.with_suffix(".wav")
        try:
            if progress is not None:
                progress("encoding", len(chunks), len(chunks))
            save_wav(audio, wav_path, self.sample_rate)
            wav_to_ogg_opus(wav_path, output_path, self.sample_rate)
        finally:
            wav_path.unlink(missing_ok=True)


def respond(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--idle-timeout", type=int, default=900)
    parser.add_argument("--model", default="v5_5_ru")
    parser.add_argument("--speaker", default="xenia")
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--max-chars", type=int, default=20000)
    parser.add_argument("--download", action="store_true")
    args = parser.parse_args()

    if args.download:
        Synthesizer(args.model, args.speaker, args.cache_dir.resolve())
        print(f"Model {args.model} is ready", flush=True)
        return 0

    requests: queue.Queue[dict | None] = queue.Queue()
    threading.Thread(target=read_requests, args=(requests,), daemon=True).start()
    synthesizer: Synthesizer | None = None

    while True:
        try:
            request = requests.get(timeout=max(1, args.idle_timeout))
        except queue.Empty:
            return 0
        if request is None:
            return 0
        request_id = request.get("id")
        try:
            respond({"id": request_id, "progress": True, "phase": "accepted"})
            if synthesizer is None:
                respond({"id": request_id, "progress": True, "phase": "loading-model"})
                synthesizer = Synthesizer(args.model, args.speaker, args.cache_dir.resolve())
                respond({"id": request_id, "progress": True, "phase": "model-ready"})
            output_path = Path(request["outputPath"]).resolve()
            synthesizer.synthesize(
                str(request.get("text", "")),
                output_path,
                args.max_chars,
                lambda phase, completed, total: respond({
                    "id": request_id,
                    "progress": True,
                    "phase": phase,
                    "completed": completed,
                    "total": total,
                }),
            )
            respond({"id": request_id, "ok": True, "outputPath": str(output_path)})
        except Exception as error:
            respond({"id": request_id, "ok": False, "error": str(error)})


if __name__ == "__main__":
    raise SystemExit(main())
