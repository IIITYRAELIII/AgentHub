from __future__ import annotations

import os
import sys
from pathlib import Path

from faster_whisper import WhisperModel


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: transcribe.py <audio-file>|--download", file=sys.stderr)
        return 2

    agent_hub_root = Path(__file__).resolve().parent
    model_name = os.environ.get("WHISPER_MODEL", "small")
    model_dir = Path(os.environ.get("WHISPER_MODEL_DIR", agent_hub_root / ".whisper-models"))
    model_dir.mkdir(parents=True, exist_ok=True)

    model = WhisperModel(
        model_name,
        device="cpu",
        compute_type="int8",
        download_root=str(model_dir),
    )
    if sys.argv[1] == "--download":
        print(f"Model {model_name} is ready")
        return 0

    audio_path = Path(sys.argv[1]).resolve()
    if not audio_path.is_file():
        print(f"Audio file not found: {audio_path}", file=sys.stderr)
        return 2

    segments, _ = model.transcribe(
        str(audio_path),
        language="ru",
        vad_filter=True,
        beam_size=5,
    )
    transcript = " ".join(segment.text.strip() for segment in segments if segment.text.strip())
    print(transcript)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
