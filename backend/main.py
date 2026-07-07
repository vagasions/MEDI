"""MEDI PdM 게이트웨이 — 공장 PC에서 실행하는 데이터 브릿지.

역할: dataPARC(REST/OPC UA/PARCdata SQL/CSV) → 통일된 REST → 웹앱(index.html)

실행:
    cp config.example.yaml config.yaml   # 후 현장 환경에 맞게 수정
    pip install -r requirements.txt
    uvicorn main:app --host 0.0.0.0 --port 8137

웹앱 설정 화면에서 게이트웨이 URL을 http://<이PC>:8137 로 지정하면 된다.
"""
from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import yaml
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

CONFIG_PATH = os.environ.get("MEDI_CONFIG", os.path.join(os.path.dirname(__file__), "config.yaml"))


def load_config() -> dict:
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    return {"connector": "simulator", "server": {}}


def build_connector(cfg: dict):
    kind = cfg.get("connector", "simulator")
    if kind == "dataparc_rest":
        from connectors.dataparc_rest import DataparcRestConnector
        return DataparcRestConnector(cfg.get("dataparc_rest", {}))
    if kind == "opcua":
        from connectors.opcua_conn import OpcuaConnector
        return OpcuaConnector(cfg.get("opcua", {}))
    if kind == "parcdata_sql":
        from connectors.parcdata_sql import ParcdataSqlConnector
        return ParcdataSqlConnector(cfg.get("parcdata_sql", {}))
    if kind == "csv_dir":
        from connectors.csv_dir import CsvDirConnector
        return CsvDirConnector(cfg.get("csv_dir", {}))
    from connectors.simulator import SimulatorConnector
    return SimulatorConnector(cfg.get("simulator", {}))


config = load_config()
connector = build_connector(config)
TS_OFFSET_MS = 0  # 오토파일럿이 검출한 타임존 보정 (read 응답에 적용)


async def _read_raw_retry(ids, s, e, tries: int = 3):
    """읽기 자동 재시도 (지수 백오프 1s/2s) — 일시 장애 자가 회복."""
    last = None
    for i in range(tries):
        try:
            return await connector.read_raw(ids, s, e)
        except Exception as ex:  # noqa: BLE001
            last = ex
            if i < tries - 1:
                await asyncio.sleep(2 ** i)
    raise HTTPException(502, f"원본 읽기 실패(재시도 {tries}회): {type(last).__name__}: {last}")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await connector.start()
    yield
    await connector.stop()


app = FastAPI(title="MEDI PdM Gateway", version="1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.get("server", {}).get("cors_origins", ["*"]),
    allow_methods=["GET"],
    allow_headers=["*"],
)


def _parse_dt(s: str) -> datetime:
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        raise HTTPException(400, f"잘못된 시각 형식: {s} (ISO8601 필요)")


@app.get("/api/v1/health")
async def health():
    tags = await connector.list_tags()
    return {"status": "ok", "connector": connector.name, "tags": len(tags)}


@app.get("/api/v1/tags")
async def tags():
    return {"tags": await connector.list_tags()}


@app.get("/api/v1/read/raw")
async def read_raw(
    tagIds: str = Query(..., description="쉼표구분 태그 ID"),
    start: str = Query(None),
    end: str = Query(None),
):
    ids = [t.strip() for t in tagIds.split(",") if t.strip()]
    if not ids:
        raise HTTPException(400, "tagIds 필요")
    e = _parse_dt(end) if end else datetime.now(timezone.utc)
    s = _parse_dt(start) if start else e - timedelta(days=7)
    if s >= e:
        raise HTTPException(400, "start는 end보다 앞서야 합니다")
    series = await _read_raw_retry(ids, s, e)
    if TS_OFFSET_MS:
        for sdata in series.values():
            if isinstance(sdata, dict) and sdata.get("t"):
                sdata["t"] = [t + TS_OFFSET_MS for t in sdata["t"]]
    return {"series": series, "tsOffsetMs": TS_OFFSET_MS}


@app.get("/api/v1/read/current")
async def read_current(tagIds: str = Query(...)):
    ids = [t.strip() for t in tagIds.split(",") if t.strip()]
    return {"values": await connector.read_current(ids)}


@app.get("/api/v1/diag")
async def diag():
    """단계별 자가진단 — 웹앱의 '연결 진단 마법사'가 호출.

    각 단계: {step, ok, detail, hint} — hint는 실패 시 현장에서 확인할 순서.
    """
    steps = []

    def add(step: str, ok: bool, detail: str = "", hint: str = ""):
        steps.append({"step": step, "ok": ok, "detail": detail, "hint": hint})

    # 1) 설정 파일
    cfg_exists = os.path.exists(CONFIG_PATH)
    add(
        "설정 파일(config.yaml)", True,
        f"{CONFIG_PATH} {'로드됨' if cfg_exists else '없음 — 내장 시뮬레이터로 동작 중'}",
        "" if cfg_exists else "cp config.example.yaml config.yaml 후 커넥터를 지정하세요",
    )
    # 2) 커넥터 종류
    add("커넥터", True, f"{connector.name} (connector: {config.get('connector', 'simulator')})",
        "실제 dataPARC 연동은 dataparc_rest(신형) 또는 opcua(범용 폴백)를 지정")

    # 3) 태그 목록
    tag_list = []
    try:
        tag_list = await connector.list_tags()
        add("태그 목록 조회", len(tag_list) > 0, f"{len(tag_list)}개",
            "" if tag_list else "커넥터는 살아있으나 태그가 0개 — 태그 매핑(config.yaml tags:) 또는 원본 권한 확인")
    except Exception as e:  # noqa: BLE001 — 진단 목적상 전체 포착
        add("태그 목록 조회", False, f"{type(e).__name__}: {e}",
            "dataparc_rest: base_url/포트(기본 12340)/TLS 인증서 · opcua: 51235 포트/보안정책 · SQL: 연결문자열/권한 확인")

    # 4) 샘플 원시 읽기 (첫 태그, 최근 1시간)
    if tag_list:
        tid = tag_list[0].get("id") if isinstance(tag_list[0], dict) else tag_list[0]
        try:
            e_dt = datetime.now(timezone.utc)
            s_dt = e_dt - timedelta(hours=1)
            series = await connector.read_raw([tid], s_dt, e_dt)
            pts = len((series.get(tid) or {}).get("t", [])) if isinstance(series, dict) else 0
            add("샘플 읽기 (최근 1시간)", pts > 0, f"{tid}: {pts}점",
                "" if pts else "히스토리 읽기 실패/0점 — 기간·아카이브 보존기간·히스토리 권한 확인. dataPARC 히스토리는 SQL이 아닌 파일 아카이브임에 유의")
            # 5) 타임스탬프 신선도/순서
            if pts:
                ts = series[tid]["t"]
                fresh_min = (e_dt.timestamp() * 1000 - ts[-1]) / 60000
                ordered = all(ts[i] <= ts[i + 1] for i in range(len(ts) - 1))
                add("타임스탬프 검증", ordered and fresh_min < 60,
                    f"마지막 값 {fresh_min:.0f}분 전, 순서 {'정상' if ordered else '역순 발견'}",
                    "" if ordered and fresh_min < 60 else "서버/수집기 타임존(UTC vs 로컬) 설정과 시각 동기(NTP) 확인")
        except Exception as e:  # noqa: BLE001
            add("샘플 읽기 (최근 1시간)", False, f"{type(e).__name__}: {e}",
                "인증(OAuth/사용자) 만료, 태그ID 형식(정수 ID vs 이름), 기간 파라미터 형식(ISO8601) 확인")

    ok_all = all(s["ok"] for s in steps)
    return {"ok": ok_all, "steps": steps, "gateway_time_utc": datetime.now(timezone.utc).isoformat()}


@app.get("/api/v1/autopilot")
async def autopilot_run(host: str = Query(None, description="dataPARC 서버 호스트 (미지정 시 config에서 추론)")):
    """자동 연결/트러블슈팅 — 포트 탐지, 경로 자동 선택, TLS/타임존 자동 보정, 요청문 생성."""
    global TS_OFFSET_MS
    from autopilot import run_autopilot
    # 호스트 추론: 파라미터 > dataparc_rest.base_url > opcua.endpoint
    h = host
    if not h:
        burl = (config.get("dataparc_rest") or {}).get("base_url", "")
        if "//" in burl:
            h = burl.split("//", 1)[1].split(":")[0].split("/")[0]
    if not h:
        ep = (config.get("opcua") or {}).get("endpoint", "")
        if "//" in ep:
            h = ep.split("//", 1)[1].split(":")[0]
    result = await run_autopilot(h or "", connector, config)
    off = result.get("ts_offset_ms", 0)
    if off:
        TS_OFFSET_MS = off
    result["applied_ts_offset_ms"] = TS_OFFSET_MS
    result["host"] = h or ""
    return result


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(config.get("server", {}).get("port", 8137)))
