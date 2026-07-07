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
    ("FT-431", "FV-101 유량PV", "m³/h"), ("ZT-432", "FV-101 개도", "%"), ("FY-433", "FV-101 OP", "%"),
    ("FT-441", "T-401 피드", "m³/h"), ("PDT-442", "T-401 상부dP", "kPa"), ("PDT-443", "T-401 하부dP", "kPa"),
    ("TT-444", "T-401 감온트레이", "°C"), ("TT-445", "T-401 탑정온도", "°C"), ("PT-446", "T-401 탑정압", "kg/cm²"),
    ("TT-451", "F-501 TMT", "°C"), ("TT-452", "F-501 COT", "°C"), ("FT-453", "F-501 연료", "Nm³/h"),
    ("AT-454", "F-501 O2", "%"), ("PT-455", "F-501 드래프트", "mmH2O"), ("TT-456", "F-501 스택온도", "°C"),
    ("TT-421", "TR-101 유온", "°C"), ("TT-422", "TR-101 권선온도", "°C"), ("IT-423", "TR-101 부하전류", "A"),
    ("LT-424", "TR-101 유위", "%"), ("TT-425", "TR-101 외기온도", "°C"), ("AT-426", "TR-101 H2", "ppm"),
    ("TT-411", "VFD-401 방열판", "°C"), ("ET-412", "VFD-401 DC버스", "V"), ("IT-413", "VFD-401 출력전류", "A"),
    ("ST-414", "VFD-401 주파수", "Hz"), ("JT-415", "VFD-401 전력", "kW"),
    ("IT-401", "M-401 전류", "A"), ("TT-403", "M-401 권선온도", "°C"), ("TT-404", "M-401 베어링", "°C"),
    ("VT-405", "M-401 진동", "mm/s"), ("ST-406", "M-401 회전수", "rpm"),
    ("XS-407", "M-401 운전상태 접점", ""), ("XA-408", "M-401 보호계전기 트립(86)", ""), ("XA-409", "M-401 열동 알람(49)", ""),
    ("THL-410", "M-401 열용량 사용률(49)", "%"),
    ("PT-471", "C-202 흡입압", "kg/cm²"), ("PT-472", "C-202 토출압", "kg/cm²"), ("TT-473", "C-202 흡입온도", "°C"),
    ("TT-474", "C-202 토출온도", "°C"), ("FT-475", "C-202 토출량", "Nm³/h"), ("TT-476", "C-202 패킹온도", "°C"),
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
    "FT-431": (97, 1.5), "ZT-432": (62, 0.8), "FY-433": (62, 0.9),
    "FT-441": (84, 1.4), "PDT-442": (3.6, 0.1), "PDT-443": (4.1, 0.1),
    "TT-444": (69, 0.5), "TT-445": (48, 0.4), "PT-446": (16.5, 0.08),
    "TT-451": (542, 2.5), "TT-452": (385, 1.2), "FT-453": (37, 0.7),
    "AT-454": (2.8, 0.22), "PT-455": (-1.2, 0.16), "TT-456": (316, 2.0),
    "TT-421": (58, 0.8), "TT-422": (72, 0.9), "IT-423": (880, 14),
    "LT-424": (47, 0.6), "TT-425": (18, 0.5), "AT-426": (10, 1.4),
    "TT-411": (57, 0.8), "ET-412": (650, 2.5), "IT-413": (88, 1.4),
    "ST-414": (51.9, 0.3), "JT-415": (52, 0.8),
    "IT-401": (85, 1.0), "TT-403": (104, 1.0), "TT-404": (49, 0.6),
    "VT-405": (1.65, 0.12), "ST-406": (1531, 3),
    "XS-407": (1, 0), "XA-408": (0, 0), "XA-409": (0, 0), "THL-410": (55, 1.2),
    "PT-471": (3.2, 0.05), "PT-472": (12.5, 0.12), "TT-473": (32, 0.5),
    "TT-474": (100, 1.0), "FT-475": (836, 9), "TT-476": (64, 0.7),
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
