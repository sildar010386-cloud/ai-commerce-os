# Series test 2026-11-11: talking-object scene on free Hugging Face Spaces

Trial for the owner (command «начинай», 2026-11-11): can free tools make a "talking object" AI series episode.
Not published anywhere. Built by a Sonnet helper, reviewed by the conductor on contact sheets.

Line (Russian, voice Larisa, eleven_multilingual_v2, 7.38 s):
«Почему я опять вот такая мятая? Хозяйка, нам выходить через пять минут! Только не утюг, умоляю!»

| File | How |
|---|---|
| `shirt_still.jpg` | `black-forest-labs/FLUX.1-schnell` `/infer`, 704x1216, 4 steps, seed 21 |
| `shirt_test_B.mp4` | `linoyts/LTX-2-3-sync` `/generate_video`: still + ElevenLabs audio (lip sync), duration 7.5, conditioning_strength 0.85, 512x896, seed 42; upscaled to 1080x1920, loudnorm -16 LUFS |
| `shirt_test_A.mp4` | `Lightricks/LTX-2-3` `/generate_video`: still + prompt with the line, model's own audio, duration 8, 512x896, seed 42 |
| `*_sheet.jpg` | contact sheets, one frame per 0.5 s |

Notes
- `LTX-2-3-sync` returned nothing for MP3 input; the same audio as WAV (44.1 kHz stereo) worked.
- GPU wall time: B 25 s for 7.7 s of video, A 58 s for 8 s; FLUX stills are fast. No quota error on a free account
  (ZeroGPU about 5 GPU-minutes a day), so roughly one 20-30 s episode a day is realistic with B. Extrapolation, not measured.
- B drifts into a slow push-in although the prompt asked for a static camera. Fabric is only moderately creased: ask FLUX for heavier wrinkles.
- Audio of variant A (model-generated Russian speech) was not listened to by anyone yet.
