"""Free AI inserts for reels via Hugging Face Spaces (owner decision 2026-10-11: 20-30 % AI story scenes,
product in action always real footage). Needs env HF_TOKEN (read token) and network access to
huggingface.co, *.huggingface.co, *.hf.space. Free ZeroGPU quota is a few GPU-minutes a day.

  python3 tools/ai/gen.py image "prompt" out.jpg            FLUX.1-schnell (Apache 2.0), 704x1216
  python3 tools/ai/gen.py video "image prompt" "motion prompt" out.mp4 [seconds]
                                                             FLUX still -> LTX-Video image-to-video, 704x1216

AI text and clock faces come out garbled: put times and words on plates (HyperFrames), not in prompts.
"""
import os, shutil, subprocess, sys
from gradio_client import Client, handle_file

TOKEN = os.environ["HF_TOKEN"]
W, H = 704, 1216
NEG = "worst quality, inconsistent motion, blurry, jittery, distorted, text, watermark, logo, faces"


def image(prompt, out, seed=7):
    r = Client("black-forest-labs/FLUX.1-schnell", token=TOKEN, verbose=False).predict(
        prompt=prompt, seed=seed, randomize_seed=False, width=W, height=H, num_inference_steps=4, api_name="/infer")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", r[0], out], check=True)
    return out


def video(img_prompt, motion, out, seconds=3, seed=5):
    still = out.rsplit(".", 1)[0] + "_still.jpg"
    image(img_prompt, still, seed)
    r = Client("Lightricks/ltx-video-distilled", token=TOKEN, verbose=False).predict(
        prompt=motion, negative_prompt=NEG, input_image_filepath=handle_file(still), input_video_filepath=None,
        height_ui=H, width_ui=W, mode="image-to-video", duration_ui=seconds, ui_frames_to_use=9, seed_ui=seed,
        randomize_seed=False, ui_guidance_scale=1, improve_texture_flag=True, api_name="/image_to_video")
    shutil.copy(r[0]["video"] if isinstance(r[0], dict) else r[0], out)
    return out


if __name__ == "__main__":
    kind, *args = sys.argv[1:]
    if kind == "image":
        print(image(*args))
    else:
        print(video(args[0], args[1], args[2], float(args[3]) if len(args) > 3 else 3))
