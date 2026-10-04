# Keel: transcribe one voice message with OpenAI Whisper.
# usage: transcribe.py <audio> <model> <languages, comma-separated or empty> <vocabulary>
import json
import sys
import warnings

warnings.filterwarnings("ignore")

import torch
import whisper

audio_path, model_name, wanted, vocabulary = sys.argv[1:5]
languages = [code.strip() for code in wanted.split(",") if code.strip()]

model = whisper.load_model(model_name)
audio = whisper.load_audio(audio_path)
seconds = len(audio) / whisper.audio.SAMPLE_RATE
mel = whisper.log_mel_spectrogram(
    whisper.pad_or_trim(audio), n_mels=model.dims.n_mels
).to(model.device)
_, probs = model.detect_language(mel)
pool = {code: probs.get(code, 0.0) for code in languages if code in probs}


def transcribe(language):
    return model.transcribe(
        audio,
        language=language,
        fp16=torch.cuda.is_available(),
        condition_on_previous_text=False,
        # Names Whisper would otherwise hear as ordinary words.
        initial_prompt=vocabulary or None,
    )


def confidence(result):
    segments = result.get("segments") or []
    total = sum(max(s["end"] - s["start"], 0.01) for s in segments)
    if not total:
        return float("-inf")
    return sum(s["avg_logprob"] * max(s["end"] - s["start"], 0.01) for s in segments) / total


ranked = sorted(pool, key=pool.get, reverse=True)
unsure = len(ranked) > 1 and (seconds < 8 or pool[ranked[0]] < 2 * pool[ranked[1]])
if unsure:
    # A second or two of audio is not enough to tell languages apart, so
    # transcribe in each one the user speaks and keep the most confident.
    tries = {code: transcribe(code) for code in ranked}
    language = max(tries, key=lambda code: confidence(tries[code]))
    result = tries[language]
else:
    language = ranked[0] if ranked else max(probs, key=probs.get)
    result = transcribe(language)

print(
    "KEEL-TRANSCRIPT "
    + json.dumps(
        {"language": language, "seconds": round(seconds, 1), "text": result["text"].strip()},
        ensure_ascii=False,
    )
)
