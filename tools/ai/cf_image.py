"""Free AI pictures through the CRM's Cloudflare Workers AI (FLUX.1 schnell), for posts and carousel slides.

  python3 tools/ai/cf_image.py content/images/jobs.json

jobs.json: [{"prompt": "...", "out": "content/carousels/K-05/src/02.jpg", "w": 1024, "h": 960}, ...]
Existing outputs are skipped, so a re-run only makes what is missing. Each picture is cropped to w x h (default
1024x960, the carousel photo size). Needs CRM_API_KEY (+ crm/url.txt). The Claude sandbox cannot reach workers.dev,
so this runs in GitHub Actions (.github/workflows/images.yml), which commits the pictures to the working branch.
Owner rule: no AI-drawn product - our steamer comes only from real footage.
"""
import json, os, subprocess, sys, tempfile, urllib.error, urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
sys.path.insert(0, os.path.abspath(ROOT))
from tools.crm.client import crm_url  # noqa: E402


def generate(prompt, out, w=1024, h=960, seed=None):
    body = {"prompt": prompt}
    if seed is not None:
        body["seed"] = seed
    req = urllib.request.Request(crm_url() + "/api/hooks/image", data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "X-Api-Key": os.environ["CRM_API_KEY"],
                                          "User-Agent": "bikas-images/1"})
    with urllib.request.urlopen(req, timeout=120) as r, tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
        f.write(r.read())
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    # cover-crop the square FLUX picture to the slide size
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", f.name, "-vf",
                    f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}", "-q:v", "2", out], check=True)
    os.unlink(f.name)


def main(jobs_file):
    jobs = json.load(open(jobs_file))
    made, failed = 0, []
    for j in jobs:
        out = os.path.join(ROOT, j["out"])
        if os.path.exists(out):
            continue
        try:
            generate(j["prompt"], out, j.get("w", 1024), j.get("h", 960), j.get("seed"))
            made += 1
            print("made", j["out"])
        except (urllib.error.URLError, subprocess.CalledProcessError, OSError) as e:
            failed.append(j["out"])
            print("failed", j["out"], type(e).__name__, getattr(e, "code", ""))
    print(f"{made} made, {len(failed)} failed")
    if failed and not made:
        sys.exit(1)


if __name__ == "__main__":
    main(sys.argv[1])
