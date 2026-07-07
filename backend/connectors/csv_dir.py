"""CSV 폴더 커넥터 — dataPARC 내보내기 파일을 폴더에 쌓는 운용 방식.

wide 형식(Time,TAG1,TAG2,...)과 long 형식(Time,Tag,Value)을 자동 판별.
호출 시마다 폴더를 다시 읽으므로 새 파일을 떨어뜨리면 즉시 반영된다.
"""
from __future__ import annotations

import csv
import glob
import os
from datetime import datetime

from .base import Connector

TIME_KEYS = {"time", "timestamp", "datetime", "date", "시간", "시각"}
TAG_KEYS = {"tag", "tagname", "tag name", "name", "태그"}
VAL_KEYS = {"value", "val", "값"}


def _parse_time(s: str) -> float | None:
    s = s.strip().strip('"')
    if not s:
        return None
    try:
        if s.isdigit():
            n = int(s)
            return float(n if len(s) >= 13 else n * 1000)
        return datetime.fromisoformat(s.replace(" ", "T")).timestamp() * 1000
    except ValueError:
        for fmt in ("%m/%d/%Y %H:%M:%S", "%m/%d/%Y %H:%M", "%Y-%m-%d %H:%M:%S", "%d/%m/%Y %H:%M"):
            try:
                return datetime.strptime(s, fmt).timestamp() * 1000
            except ValueError:
                continue
    return None


class CsvDirConnector(Connector):
    name = "csv_dir"

    def __init__(self, cfg: dict):
        self.path = cfg.get("path", "./data")

    def _load_all(self) -> dict[str, dict]:
        series: dict[str, dict] = {}
        for fp in sorted(glob.glob(os.path.join(self.path, "*.csv"))):
            try:
                self._load_file(fp, series)
            except Exception:
                continue  # 손상 파일은 건너뜀
        for s in series.values():
            pair = sorted(zip(s["t"], s["v"]))
            s["t"] = [p[0] for p in pair]
            s["v"] = [p[1] for p in pair]
        return series

    def _load_file(self, fp: str, series: dict) -> None:
        with open(fp, newline="", encoding="utf-8-sig") as f:
            sample = f.read(4096)
            f.seek(0)
            delim = "\t" if "\t" in sample.split("\n")[0] else ","
            reader = csv.reader(f, delimiter=delim)
            header = next(reader, None)
            if not header:
                return
            lower = [h.strip().lower() for h in header]
            t_col = next((i for i, h in enumerate(lower) if h in TIME_KEYS), 0)
            tag_col = next((i for i, h in enumerate(lower) if h in TAG_KEYS), None)
            val_col = next((i for i, h in enumerate(lower) if h in VAL_KEYS), None)

            def push(tag, tms, raw):
                try:
                    val = float(raw)
                except (TypeError, ValueError):
                    return
                s = series.setdefault(tag, {"t": [], "v": []})
                s["t"].append(int(tms))
                s["v"].append(val)

            if tag_col is not None and val_col is not None:
                for row in reader:
                    if len(row) <= max(t_col, tag_col, val_col):
                        continue
                    tms = _parse_time(row[t_col])
                    if tms:
                        push(row[tag_col].strip(), tms, row[val_col])
            else:
                for row in reader:
                    if len(row) <= t_col:
                        continue
                    tms = _parse_time(row[t_col])
                    if not tms:
                        continue
                    for j, cell in enumerate(row):
                        if j == t_col or j >= len(header):
                            continue
                        push(header[j].strip(), tms, cell)

    async def list_tags(self) -> list[dict]:
        return [{"id": k, "desc": "", "unit": ""} for k in self._load_all()]

    async def read_raw(self, tag_ids, start, end):
        all_series = self._load_all()
        s_ms, e_ms = start.timestamp() * 1000, end.timestamp() * 1000
        out = {}
        for tid in tag_ids:
            s = all_series.get(tid)
            if not s:
                continue
            t, v = [], []
            for ts, val in zip(s["t"], s["v"]):
                if s_ms <= ts <= e_ms:
                    t.append(ts)
                    v.append(val)
            out[tid] = {"t": t, "v": v}
        return out
