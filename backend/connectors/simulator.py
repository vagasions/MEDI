"""시뮬레이터 커넥터 — 게이트웨이 모드 자체 테스트용.

프런트엔드 js/simulator.js와 동일한 태그 집합(P-101A/B, C-201, E-301)의
간이 버전. dataPARC 없이 게이트웨이 연동 경로(REST)를 검증할 때 쓴다.
"""
from __future__ import annotations

import math
import random
from datetime import datetime, timedelta, timezone

from .base import Connector

TAGS = [
    ("FT-101", "P-101A 토출유량", "m³/h"), ("PT-101", "P-101A 흡입압", "kg/cm²"),
    ("PT-102", "P-101A 토출압", "kg/cm²"), ("TT-103", "P-101A 베어링DE", "°C"),
    ("TT-104", "P-101A 베어링NDE", "°C"), ("VT-105", "P-101A 진동", "mm/s"),
    ("IT-106", "P-101A 모터전류", "A"), ("TT-107", "P-101A 권선온도", "°C"),
    ("FT-111", "P-101B 토출유량", "m³/h"), ("PT-111", "P-101B 흡입압", "kg/cm²"),
    ("PT-112", "P-101B 토출압", "kg/cm²"), ("TT-113", "P-101B 베어링DE", "°C"),
    ("VT-115", "P-101B 진동", "mm/s"), ("IT-116", "P-101B 모터전류", "A"),
    ("TT-117", "P-101B 권선온도", "°C"),
    ("FT-201", "C-201 흡입유량", "Nm³/h"), ("PT-201", "C-201 흡입압", "kg/cm²"),
    ("PT-202", "C-201 토출압", "kg/cm²"), ("TT-203", "C-201 토출온도", "°C"),
    ("VT-204", "C-201 진동", "mm/s"), ("TT-205", "C-201 베어링온도", "°C"),
    ("IT-206", "C-201 모터전류", "A"),
    ("TT-301", "E-301 HotIn", "°C"), ("TT-302", "E-301 HotOut", "°C"),
    ("TT-303", "E-301 ColdIn", "°C"), ("TT-304", "E-301 ColdOut", "°C"),
    ("FT-305", "E-301 유량", "m³/h"), ("PDT-306", "E-301 차압", "kg/cm²"),
]

BASE = {
    "FT-101": (195, 3), "PT-101": (2.6, 0.06), "PT-102": (16.5, 0.15),
    "TT-103": (62, 1.2), "TT-104": (56, 0.8), "VT-105": (2.3, 0.2),
    "IT-106": (69, 1.2), "TT-107": (96, 1.0),
    "FT-111": (180, 3), "PT-111": (2.6, 0.05), "PT-112": (16.2, 0.13),
    "TT-113": (56, 0.7), "VT-115": (1.9, 0.15), "IT-116": (63, 1.0), "TT-117": (94, 1.0),
    "FT-201": (4600, 60), "PT-201": (0.85, 0.02), "PT-202": (4.1, 0.06),
    "TT-203": (78, 0.9), "VT-204": (2.0, 0.14), "TT-205": (62, 0.7), "IT-206": (335, 5),
    "TT-301": (76, 0.6), "TT-302": (46, 0.6), "TT-303": (27.5, 0.5),
    "TT-304": (39, 0.5), "FT-305": (575, 9), "PDT-306": (0.33, 0.015),
}

# 데모 열화: 베어링 온도/진동 완만 상승
DRIFT = {"TT-103": 10.0, "VT-105": 2.0}


class SimulatorConnector(Connector):
    name = "simulator"

    def __init__(self, cfg: dict | None = None):
        self.step_min = (cfg or {}).get("step_min", 5)

    async def list_tags(self) -> list[dict]:
        return [{"id": t, "desc": d, "unit": u} for t, d, u in TAGS]

    async def read_raw(self, tag_ids, start, end):
        out = {}
        step = timedelta(minutes=self.step_min)
        horizon = datetime.now(timezone.utc) - timedelta(days=7)
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        if end.tzinfo is None:
            end = end.replace(tzinfo=timezone.utc)
        for tid in tag_ids:
            mu, sd = BASE.get(tid, (50, 1))
            rnd = random.Random(hash(tid) & 0xFFFF)
            t, v = [], []
            cur = max(start, horizon)
            while cur <= end:
                frac = max(0.0, min(1.0, (cur - horizon) / timedelta(days=7)))
                hours = cur.timestamp() / 3600
                load = 1 + 0.05 * math.sin(hours / 9.0) + 0.03 * math.sin(hours / 3.1)
                drift = DRIFT.get(tid, 0.0) * max(0.0, (frac - 0.45) / 0.55)
                val = mu * load + drift + rnd.gauss(0, sd)
                t.append(int(cur.timestamp() * 1000))
                v.append(round(val, 3))
                cur += step
            out[tid] = {"t": t, "v": v}
        return out
