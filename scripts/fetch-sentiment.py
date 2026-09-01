#!/usr/bin/env python3
"""
scripts/fetch-sentiment.py — FinBERT headline sentiment via HF Inference API.

Reads data/news.json, scores each headline with ProsusAI/finbert, and writes
data/sentiment.json. Needs HF_TOKEN env var; on failure exits 0 (soft exit)
so the workflow stays green and the dashboard falls back to keyword scoring.
Stdlib only.
"""
import json, os, sys, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NEWS = os.path.join(ROOT, "data", "news.json")
OUT  = os.path.join(ROOT, "data", "sentiment.json")
API  = "https://api-inference.huggingface.co/models/ProsusAI/finbert"

def soft_exit(msg):
    print(f"[fetch-sentiment] {msg} — skipping (soft exit)")
    sys.exit(0)

token = os.environ.get("HF_TOKEN", "").strip()
if not token or len(token) < 10:
    soft_exit("no HF_TOKEN secret configured")

try:
    with open(NEWS, encoding="utf-8") as f:
        items = json.load(f).get("items", [])
except Exception as e:
    soft_exit(f"cannot read news.json ({e})")

headlines = [i.get("headline", "")[:300] for i in items if i.get("headline")][:20]
if not headlines:
    soft_exit("no headlines to score")

req = urllib.request.Request(
    API,
    data=json.dumps({"inputs": headlines, "options": {"wait_for_model": True}}).encode(),
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
)

try:
    with urllib.request.urlopen(req, timeout=120) as r:
        result = json.load(r)
except Exception as e:
    soft_exit(f"HF API failed ({e})")

per_item, total = [], 0.0
for h, scores in zip(headlines, result if isinstance(result, list) else []):
    try:
        d = {s["label"].lower(): s["score"] for s in scores}
    except (TypeError, KeyError):
        continue
    v = d.get("positive", 0) - d.get("negative", 0)
    total += v
    per_item.append({"headline": h[:90], "score": round(v, 3)})

if not per_item:
    soft_exit(f"unexpected API shape: {str(result)[:200]}")

mean = total / len(per_item)
label = "bullish" if mean > 0.15 else "bearish" if mean < -0.15 else "neutral"
now = int(time.time() * 1000)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    json.dump({"score": round(mean, 3), "label": label, "n": len(per_item),
               "model": "ProsusAI/finbert", "perItem": per_item,
               "ts": now, "_updatedMs": now}, f, indent=1)

print(f"[fetch-sentiment] OK — {len(per_item)} headlines, mean {mean:+.3f} ({label})")
