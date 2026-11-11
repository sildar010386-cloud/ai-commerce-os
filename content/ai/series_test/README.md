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

## Episode 01 (owner said «начинай» for a full ~25 s episode, 2026-11-11 evening) — in progress

Owner feedback on the trial: likes the approach and variant A (model's own speech, more emotion; STT via ElevenLabs
`/v1/speech-to-text` scribe_v1 confirmed the Russian is word-for-word correct in A and B). Fix: blouse must be
SNOW-WHITE office blouse, heavily wrinkled, a full character (not a face decal).

Script (title on screen for the whole video: «Почему блузка боится утюга?»):
1. Blouse, wrinkled, panicking: «Почему я боюсь утюга? Смотрите сами. Я мятая, а нам выходить через пять минут!»
2. Iron villain: «Ну что, красавица… Доска разложена. Иди сюда, прижгу, как в прошлый раз!»
3. Blouse: «Только не он! Хозяйка, спаси!»
4. REAL footage of our steamer on a white shirt (product is never AI), voice owner2: «Спокойно. Я нагреваюсь за девять секунд. Без доски, прямо на вешалке.»
5. Blouse, smooth and happy: «Ой… я как новая! Хотите такого же спасателя? Пишите «ПАР» в комментариях!»
6. Iron: «Я ещё вернусь…»

State
- HF free ZeroGPU ran out after 2 videos + 1 failed call + 5 FLUX stills ("exceeded your free ZeroGPU quota (90s requested vs. 0s left)").
  The quota is charged per requested window, not wall time: realistically ~3 video calls a day, so one episode = 2 days on the free plan.
  Resets 24 h after first use (first use 2026-11-11 ~15:52 UTC). `Lightricks/LTX-2-3`: max 10 s per call, no audio input.
- `ep01/B1.jpg`, `ep01/B2.jpg`: first HF stills (B1 usable direction, creases weak, reddish eyes).
- 10 character stills are queued in `content/images/jobs.json` (`ep01/cfB1-4` wrinkled blouse, `cfS1-3` smooth blouse,
  `cfI1-3` iron). Actions → Images failed on 2026-11-11 16:09 UTC: Workers AI daily 10,000 neurons already used up
  (also at 04:41 UTC the same day, so something drains it early). Re-run Images after 00:00 UTC.
- Real footage for scene 4: raw-05 clip 16 (white shirt steamed on the bed) or clip 3; check unused windows in
  `content/raw-05/specs.json` and look at the frames before use.
- Paid option offered to the owner, not approved: Hugging Face PRO, 9 USD a month, 40 GPU-minutes a day.
