from __future__ import annotations

import os
import sys
from pathlib import Path

from faster_whisper import WhisperModel

DEFAULT_MODEL = "large-v3-turbo"
DEFAULT_DEVICE = "cuda"


def load_model(
    model_name: str,
    model_dir: Path,
    device: str,
    compute_type: str = "",
) -> WhisperModel:
    compute_type = compute_type or os.environ.get("WHISPER_COMPUTE_TYPE", "").strip()
    if not compute_type:
        compute_type = "float16" if device == "cuda" else "int8" if device == "cpu" else "auto"
    return WhisperModel(
        model_name,
        device=device,
        compute_type=compute_type,
        download_root=str(model_dir),
    )


def transcribe_audio(
    audio_path: Path,
    model_name: str,
    model_dir: Path,
    device: str,
    compute_type: str = "",
) -> str:
    model = load_model(model_name, model_dir, device, compute_type)
    segments, _ = model.transcribe(
        str(audio_path),
        language="ru",
        vad_filter=True,
        beam_size=5,
    )
    return " ".join(segment.text.strip() for segment in segments if segment.text.strip())


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: transcribe.py <audio-file>|--download", file=sys.stderr)
        return 2

    agent_hub_root = Path(__file__).resolve().parent
    model_name = os.environ.get("WHISPER_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL
    device = os.environ.get("WHISPER_DEVICE", DEFAULT_DEVICE).strip().lower() or DEFAULT_DEVICE
    if device not in {"auto", "cpu", "cuda"}:
        print("WHISPER_DEVICE must be auto, cpu or cuda", file=sys.stderr)
        return 2
    model_dir = Path(os.environ.get("WHISPER_MODEL_DIR", agent_hub_root / ".whisper-models"))
    model_dir.mkdir(parents=True, exist_ok=True)

    if sys.argv[1] == "--download":
        try:
            load_model(model_name, model_dir, device)
            active_device = device
        except (OSError, RuntimeError) as error:
            if device != "cuda":
                raise
            print(f"CUDA is unavailable, falling back to CPU: {error}", file=sys.stderr)
            load_model(model_name, model_dir, "cpu", "int8")
            active_device = "cpu"
        print(f"Model {model_name} is ready on {active_device}")
        return 0

    audio_path = Path(sys.argv[1]).resolve()
    if not audio_path.is_file():
        print(f"Audio file not found: {audio_path}", file=sys.stderr)
        return 2

    try:
        transcript = transcribe_audio(audio_path, model_name, model_dir, device)
    except (OSError, RuntimeError) as error:
        if device != "cuda":
            raise
        print(f"CUDA transcription failed, retrying on CPU: {error}", file=sys.stderr)
        transcript = transcribe_audio(audio_path, model_name, model_dir, "cpu", "int8")
    print(transcript)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
