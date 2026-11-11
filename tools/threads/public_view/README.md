# Public Threads pages without login (analysis of other accounts)

The official Threads API token has no permission to read other profiles (profile_lookup / keyword_search return code 10).
Public pages do open anonymously in the pre-installed Playwright Chromium with DEFAULT settings
(hosts `www.threads.com`, `threads.com` were added to the Default environment on 2026-11-11 with the owner's approval).

- `collect.js HANDLE [replies]` — latest ~10-16 top-level posts of a profile (then a login wall): exact datetime, permalink,
  text, like/reply/repost counters, media, author's own continuation posts. The Replies tab gives 8-22 items.
- `postview.js /@handle/post/CODE` — a post's permalink page: VIEW count ("39.6K views") and the visible comment thread.
- `analyze.py` — per-account stats from the collected JSON.

Rules: default browser settings only (no user-agent spoofing, no stealth, no login, no captcha solving), one page per ~8 s,
stop on a login wall or block. Views are visible only on permalink pages; counters equal to 0 are not shown.
Paths inside the scripts point to a session scratchpad: pass or edit the output folder before use.
Raw texts of other people's posts are not committed to this public repository.
