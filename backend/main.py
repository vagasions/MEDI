"""MEDI PdM 게이트웨이 — 공장 PC에서 실행하는 데이터 브릿지.

역할: dataPARC(REST/OPC UA/PARCdata SQL/CSV) → 통일된 REST → 웹앱(index.html)

실행:
    cp config.example.yaml config.yaml   # 후 현장 환경에 맞게 수정
    pip install -r requirements.txt
    uvicorn main:app --host 0.0.0.0 --port 8137

웹앱 설정 화면에서 게이트웨이 URL을 http://<이PC>:8137 로 지정하면 된다.
"""
from __future__ import annotations

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
    series = await connector.read_raw(ids, s, e)
    return {"series": series}


@app.get("/api/v1/read/current")
async def read_current(tagIds: str = Query(...)):
    ids = [t.strip() for t in tagIds.split(",") if t.strip()]
    return {"values": await connector.read_current(ids)}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(config.get("server", {}).get("port", 8137)))
