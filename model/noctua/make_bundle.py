"""
noctua/make_bundle.py
=====================================================================
Seed `data/noctua_history.parquet` from the training data.

The served model needs 365 days of hourly history for `reg_rv_vs_year` (and
100 days for `mom_dist_ma100`, 90 for `mom_drawdown_90d`). Fetching that from
a public API every 30 minutes would be ~105 paginated requests; instead the
history ships with the repo and the cron only tops up the tail.

Crucially the bundle is built by the SAME `build_hourly` used in training, so
the served features are constructed identically to the trained ones rather than
merely similarly.

    python -m noctua.make_bundle --artifacts model/artifacts --days 400
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from serve.history import HOURLY_COLS, check_continuity, save_bundle  # noqa: E402


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Build the served history bundle")
    p.add_argument("--artifacts", type=Path, default=Path("model/artifacts"))
    p.add_argument("--days", type=int, default=400)
    p.add_argument("--out", type=Path, default=None)
    a = p.parse_args(argv)

    hourly = a.artifacts / "btcusd_1h.parquet"
    if not hourly.exists():
        raise SystemExit(
            f"{hourly} not found -- run `python -m noctua.episodes` first"
        )

    hours = pd.read_parquet(hourly)[HOURLY_COLS].sort_values("hour_ts", ignore_index=True)
    path = save_bundle(hours, a.out, days=a.days)

    written = pd.read_parquet(path)
    info = {
        "path": str(path),
        "size_kb": round(path.stat().st_size / 1024, 1),
        "rows": int(len(written)),
        "start_utc": str(pd.to_datetime(written.hour_ts.iloc[0], unit="s", utc=True)),
        "end_utc": str(pd.to_datetime(written.hour_ts.iloc[-1], unit="s", utc=True)),
        **check_continuity(written),
    }
    print(json.dumps(info, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
