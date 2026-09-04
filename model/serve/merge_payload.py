"""Merge noctua.json + kronos.json into one payload for the Worker KV push."""
import json, sys

noctua_path, kronos_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
n = json.load(open(noctua_path))
k = json.load(open(kronos_path))
merged = {**k, **n, "_source": "gh-actions-noctua"}
with open(out_path, "w") as f:
    json.dump(merged, f)
